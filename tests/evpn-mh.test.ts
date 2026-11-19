import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekVxlanRuntime } from "../lib/protocols/vxlan-daemon";
import { aliasVteps, isDf, localEss } from "../lib/protocols/evpn-mh";

/**
 * EVPN multihoming subset on the evpn-irb lab: CE (one LACP PortChannel, members to
 * LEAF1 Ethernet1 and LEAF3 Ethernet1) is multihomed with ESI 00:11:22:33:44:55:00:00:00:01;
 * H5 sits behind CE in VLAN 10, H6 on LEAF2 (VLAN 10 added there) is a single-homed host.
 */
const ESI = "00:11:22:33:44:55:00:00:00:01";
const sh = (sw: string, cmd: string) => out(S().execCommand(byName(sw).id, cmd));
const ping = (from: string, to: string, n = 1) => out(S().execCommand(byName(from).id, `ping -c ${n} ${to}`));

function setup(): void {
  const ce = S().addDevice("switch", { x: 420, y: 600 }, 4);
  S().renameDevice(ce, "CE");
  const h5 = S().addDevice("pc", { x: 420, y: 720 });
  S().renameDevice(h5, "H5");
  const h6 = S().addDevice("pc", { x: 520, y: 600 });
  S().renameDevice(h6, "H6");
  const [l1, l2, l3] = ["LEAF1", "LEAF2", "LEAF3"].map((n) => byName(n).id);
  S().connect(ce, `${ce}-if0`, l1, `${l1}-if1`);
  S().connect(ce, `${ce}-if1`, l3, `${l3}-if1`);
  S().connect(h5, `${h5}-if0`, ce, `${ce}-if2`);
  S().connect(h6, `${h6}-if0`, l2, `${l2}-if3`);
  S().setInterfaceIp(h5, `${h5}-if0`, "10.1.0.15", 24);
  S().setDefaultGateway(h5, "10.1.0.1");
  S().setInterfaceIp(h6, `${h6}-if0`, "10.1.0.16", 24);
  S().runCliScript(ce, ["configure terminal", "vlan 10", "interface PortChannel 1", "fast_rate", "switchport access Vlan 10", "exit", "interface Ethernet 0", "channel-group 1", "exit", "interface Ethernet 1", "channel-group 1", "exit", "interface Ethernet 2", "switchport access Vlan 10", "end"]);
  for (const l of [l1, l3]) {
    S().runCliScript(l, ["configure terminal", "interface PortChannel 1", "fast_rate", "switchport access Vlan 10", `evpn ethernet-segment ${ESI}`, "exit", "exit", "interface Ethernet 1", "channel-group 1", "end"]);
  }
  // Both leaves present one LACP system to the CE (EVPN-MH LAG system MAC).
  const pc = (n: string) => byName(n).interfaces.find((i) => i.name === "PortChannel1")!;
  pc("LEAF3").mac = pc("LEAF1").mac;
  S().runCliScript(l2, ["configure terminal", "vlan 10", "interface Ethernet 3", "switchport access Vlan 10", "end"]);
  S().execCommand(l2, "exit");
  S().execCommand(l2, "config vxlan map add vtep1 10 10010");
  S().execCommand(l2, "sonic-cli");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("evpn-irb");
  setup();
  advance(6000);
});
afterEach(() => vi.useRealTimers());

/** ARP requests from H6 that reached the CE, by the leaf they came from. */
function arpAtCe(since: number): string[] {
  const ce = byName("CE");
  return S()
    .captures.slice(since)
    .filter((c) => c.deviceId === ce.id && c.dir === "rx" && c.frame.arp?.op === "request" && c.frame.arp.senderIp === "10.1.0.16")
    .filter((c) => /^Ethernet[01]$/.test(ce.interfaces.find((i) => i.id === c.interfaceId)?.name ?? "")) // LAG members
    .map((c) => {
      const conn = S().network.connections.find((x) => (x.a.deviceId === ce.id && x.a.interfaceId === c.interfaceId) || (x.b.deviceId === ce.id && x.b.interfaceId === c.interfaceId))!;
      const peer = conn.a.deviceId === ce.id ? conn.b.deviceId : conn.a.deviceId;
      return S().network.devices[peer].name;
    });
}

describe("EVPN multihoming (basic): type-4 DF election, type-1, DF-only BUM, aliasing", () => {
  it("both ES ports come up; type-4 / type-1 routes carry ES-Import RT, DF preference and ESI label", () => {
    for (const l of ["LEAF1", "LEAF3"]) expect(localEss(byName(l))[0]).toMatchObject({ ifname: "PortChannel1", esi: ESI, up: true });
    const rib = sh("LEAF2", "show bgp l2vpn evpn");
    expect(rib).toContain(` *>  [4]:[${ESI}]:[32]:[10.0.0.1]\n                    10.0.0.1                               0 65100 65001 i\n                    ET:8 ES-Import-Rt:11:22:33:44:55:00 DF: (alg: 2, pref: 32767)`);
    expect(rib).toContain(` *>  [1]:[4294967295]:[${ESI}]:[32]:[0.0.0.0]:[0]\n                    10.0.0.3                               0 65100 65003 i\n                    RT:65003:10010 ET:8 ESI-label-Rt:AA`);
    expect(rib).toContain(`[1]:[0]:[${ESI}]:[32]:[0.0.0.0]:[0]`); // EAD per EVI
  });

  it("DF election: equal preference → lower VTEP IP (LEAF1) is DF; higher df-preference moves it to LEAF3", () => {
    expect(isDf(byName("LEAF1"), localEss(byName("LEAF1"))[0])).toBe(true);
    expect(isDf(byName("LEAF3"), localEss(byName("LEAF3"))[0])).toBe(false);
    expect(sh("LEAF1", "show evpn es")).toMatch(new RegExp(`^${ESI}\\s+LR\\s+PortChannel1\\s+10\\.0\\.0\\.3$`, "m"));
    expect(sh("LEAF3", "show evpn es")).toMatch(new RegExp(`^${ESI}\\s+LRN\\s+PortChannel1\\s+10\\.0\\.0\\.1$`, "m"));
    S().runCliScript(byName("LEAF3").id, ["configure terminal", "interface PortChannel 1", `evpn ethernet-segment ${ESI}`, "df-preference 50000", "end"]);
    advance(2000);
    expect(isDf(byName("LEAF3"), localEss(byName("LEAF3"))[0])).toBe(true);
    expect(isDf(byName("LEAF1"), localEss(byName("LEAF1"))[0])).toBe(false);
  });

  it("BUM from a remote VTEP reaches the ES only through the DF", () => {
    let since = S().captures.length;
    ping("H6", "10.1.0.15");
    expect(arpAtCe(since)).toEqual(["LEAF1"]);
    S().runCliScript(byName("LEAF3").id, ["configure terminal", "interface PortChannel 1", `evpn ethernet-segment ${ESI}`, "df-preference 50000", "end"]);
    advance(2000);
    S().execCommand(byName("H6").id, "ip neigh flush all");
    since = S().captures.length;
    ping("H6", "10.1.0.15");
    expect(arpAtCe(since)).toEqual(["LEAF3"]);
  });

  it("aliasing: H5's MAC (type-2 with the ESI) is reachable through both ES VTEPs", () => {
    expect(ping("H6", "10.1.0.15", 2)).toContain("2 received");
    advance(1000);
    const m = byName("H5").interfaces[0].mac;
    const r = peekVxlanRuntime(byName("LEAF2"))!.macs[`10|${m}`];
    expect(r.esi).toBe(ESI);
    expect(aliasVteps(byName("LEAF2"), ESI)).toEqual(["10.0.0.1", "10.0.0.3"]);
    expect(sh("LEAF2", "show bgp l2vpn evpn")).toMatch(new RegExp(`\\[2\\]:\\[0\\]:\\[48\\]:\\[${m.toLowerCase()}\\]`));
  });
});
