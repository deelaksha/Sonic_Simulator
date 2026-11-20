/**
 * Layer-2 integration: each L2 protocol doing its job in a live scenario, and the
 * state changes of one protocol being seen by the ones that depend on it
 * (VLAN ↔ LAG ↔ STP ↔ errdisable ↔ FDB ↔ snooping ↔ LLDP ↔ LST ↔ MCLAG).
 * Topologies are built through the store the way a learner builds them, or
 * taken from a feature lab.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { getStpBridgeOper, getStpPortState } from "../lib/protocols/stp-daemon";
import { isErrdisabled, errdisabledPorts } from "../lib/protocols/errdisable";
import { lacpRuntime } from "../lib/protocols/lacp-daemon";
import { lldpRuntime } from "../lib/protocols/lldp-daemon";
import { peekSnoopState } from "../lib/protocols/dhcp-snooping";
import { mclagRuntime } from "../lib/protocols/mclag-daemon";
import { peekStormState } from "../lib/protocols/storm-control";

// ---------- helpers ----------

const id = (name: string) => byName(name).id;
const port = (dev: string, name: string) => byName(dev).interfaces.find((i) => i.name === name)!;
const sh = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const ping = (from: string, ip: string, n = 2) => sh(from, `ping -c ${n} ${ip}`);
const klish = (dev: string, lines: string[]) => {
  const errs = S().runCliScript(id(dev), ["configure terminal", ...lines, "end"], { silent: true });
  expect(errs.map((e) => e.text)).toEqual([]);
};
const ifn = (name: string) => name.replace(/(\d+)$/, " $1"); // Ethernet3 → "Ethernet 3"

function addSwitch(name: string, ports = 8): string {
  const d = S().addDevice("switch", { x: 0, y: 0 }, ports);
  S().renameDevice(d, name);
  return d;
}
function addPc(name: string, ip: string): string {
  const d = S().addDevice("pc", { x: 0, y: 0 });
  S().renameDevice(d, name);
  S().setInterfaceIp(d, `${d}-if0`, ip, 24);
  return d;
}
/** Cable switch a EthernetI ↔ switch b EthernetJ (or a PC's NIC when j is omitted). */
function cable(a: string, i: number, b: string, j?: number): void {
  S().connect(id(a), `${id(a)}-if${i}`, id(b), j === undefined ? `${id(b)}-if0` : `${id(b)}-if${j}`);
}
const connOf = (dev: string, ifname: string) => {
  const p = port(dev, ifname);
  return S().network.connections.find(
    (c) => (c.a.deviceId === id(dev) && c.a.interfaceId === p.id) || (c.b.deviceId === id(dev) && c.b.interfaceId === p.id),
  )!.id;
};
const stpState = (dev: string, ifname: string) => getStpPortState(byName(dev), port(dev, ifname).id, S().network);
const stpPorts = (dev: string) => Object.values(getStpBridgeOper(S().network, byName(dev)).ports);
const fdbPort = (sw: string, mac: string) => {
  const d = byName(sw);
  const e = d.macTable.find((m) => m.mac.toUpperCase() === mac.toUpperCase());
  return e && d.interfaces.find((i) => i.id === e.interfaceId)?.name;
};
const macOf = (h: string) => byName(h).interfaces[0].mac;

/** Most times one switch port transmitted an ARP request since capture index `from` (> 1 = loop). */
function maxArpTxPerPort(from: number): number {
  const n = new Map<string, number>();
  for (const c of S().captures.slice(from)) {
    const dev = S().network.devices[c.deviceId];
    if (dev?.type !== "switch" || c.dir !== "tx" || c.frame.arp?.op !== "request") continue;
    const name = dev.interfaces.find((i) => i.id === c.interfaceId)?.name ?? "";
    if (name.startsWith("PortChannel")) continue; // counted on the member it leaves on
    const k = `${c.deviceId}/${c.interfaceId}/${c.frame.arp.senderIp}>${c.frame.arp.targetIp}`;
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return Math.max(0, ...n.values());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().newLab();
});
afterEach(() => vi.useRealTimers());

// ---------- VLAN ----------

describe("VLAN access / trunk / native", () => {
  /** SW1 ═ trunk (Ethernet0) ═ SW2; A1/B1 on SW1, A2/B2 on SW2; A* VLAN 10, B* VLAN 20. */
  function build() {
    addSwitch("SW1");
    addSwitch("SW2");
    addPc("A1", "10.0.0.1");
    addPc("B1", "10.0.0.11");
    addPc("A2", "10.0.0.2");
    addPc("B2", "10.0.0.12");
    cable("SW1", 0, "SW2", 0);
    cable("SW1", 1, "A1");
    cable("SW1", 2, "B1");
    cable("SW2", 1, "A2");
    cable("SW2", 2, "B2");
    for (const s of ["SW1", "SW2"])
      klish(s, [
        "interface Vlan 10", "exit", "interface Vlan 20", "exit",
        "interface Ethernet 1", "switchport access Vlan 10", "exit",
        "interface Ethernet 2", "switchport access Vlan 20", "exit",
        "interface Ethernet 0", "switchport trunk allowed Vlan 10,20", "exit",
      ]);
  }

  it("same-VLAN hosts talk across the trunk (tagged), different VLANs do not", () => {
    build();
    const from = S().captures.length;
    expect(ping("A1", "10.0.0.2")).toMatch(/2 received/);
    expect(ping("B1", "10.0.0.12")).toMatch(/2 received/);
    expect(ping("A1", "10.0.0.12")).toMatch(/0 received/);
    const onTrunk = S().captures.slice(from).filter((c) => c.deviceId === id("SW1") && c.interfaceId === port("SW1", "Ethernet0").id && c.dir === "tx" && c.frame.icmp);
    expect(onTrunk.length).toBeGreaterThan(0);
    expect(new Set(onTrunk.map((c) => c.frame.vlan?.vlanId))).toEqual(new Set([10, 20]));
  });

  it("removing VLAN 20 from the trunk cuts only VLAN 20", () => {
    build();
    expect(ping("B1", "10.0.0.12")).toMatch(/2 received/);
    klish("SW1", ["interface Ethernet 0", "switchport trunk allowed Vlan remove 20", "exit"]);
    advance(500);
    expect(ping("A1", "10.0.0.2")).toMatch(/2 received/);
    expect(ping("B1", "10.0.0.12", 1)).toMatch(/0 received/);
  });
});

// ---------- STP ----------

describe("STP", () => {
  /** Triangle SW1–SW2–SW3, one PC per switch, all VLAN 1. */
  function triangle() {
    for (const s of ["SW1", "SW2", "SW3"]) addSwitch(s);
    cable("SW1", 0, "SW2", 0);
    cable("SW2", 1, "SW3", 1);
    cable("SW3", 2, "SW1", 2);
    addPc("H1", "10.1.0.1");
    addPc("H2", "10.1.0.2");
    addPc("H3", "10.1.0.3");
    cable("SW1", 4, "H1");
    cable("SW2", 4, "H2");
    cable("SW3", 4, "H3");
  }
  const blocked = () =>
    ["SW1", "SW2", "SW3"].flatMap((s) => stpPorts(s).filter((p) => p.peerDeviceId && p.state === "BLOCKING").map((p) => `${s}:${p.interfaceName}`));

  it("a triangle blocks exactly one port; broadcasts do not loop; every host reaches every other", () => {
    triangle();
    advance(2500);
    expect(blocked()).toHaveLength(1);
    const from = S().captures.length;
    expect(ping("H1", "10.1.0.2")).toMatch(/2 received/);
    expect(ping("H1", "10.1.0.3")).toMatch(/2 received/);
    expect(ping("H2", "10.1.0.3")).toMatch(/2 received/);
    expect(maxArpTxPerPort(from)).toBe(1);
  });

  it("KLISH `spanning-tree priority` decides the root bridge", () => {
    triangle();
    klish("SW3", ["spanning-tree priority 4096"]);
    expect(getStpBridgeOper(S().network, byName("SW3")).isRoot).toBe(true);
    expect(getStpBridgeOper(S().network, byName("SW1")).rootBridgeId).toBe(getStpBridgeOper(S().network, byName("SW3")).bridgeId);
  });

  it("a forwarding link failing unblocks the alternate path; stale FDB entries are flushed so traffic recovers", () => {
    triangle();
    klish("SW1", ["spanning-tree priority 4096"]); // SW1 root: SW2–SW3 link is the blocked one
    advance(2500);
    expect(blocked()).toEqual([expect.stringMatching(/^SW[23]:Ethernet1$/)]);
    expect(ping("H2", "10.1.0.3")).toMatch(/2 received/); // H2 → SW2 → SW1 → SW3 → H3
    expect(fdbPort("SW2", macOf("H3"))).toBe("Ethernet0");
    S().disconnect(connOf("SW1", "Ethernet2")); // SW1–SW3 cut
    advance(2500);
    expect(blocked()).toEqual([]);
    // SW2 must not keep H3 behind Ethernet0 (towards SW1, which no longer reaches SW3).
    expect(ping("H2", "10.1.0.3")).toMatch(/2 received/);
    expect(ping("H1", "10.1.0.3")).toMatch(/2 received/);
  });

  it("an err-disabled port leaves the spanning tree (the redundant link takes over)", () => {
    addSwitch("SW1");
    addSwitch("SW2");
    cable("SW1", 0, "SW2", 0);
    cable("SW1", 1, "SW2", 1);
    addPc("H1", "10.1.0.1");
    addPc("H2", "10.1.0.2");
    cable("SW1", 4, "H1");
    cable("SW2", 4, "H2");
    klish("SW1", ["spanning-tree priority 4096"]);
    advance(2500);
    expect(stpState("SW2", "Ethernet1")).toBe("BLOCKING");
    // BPDU guard on SW2's root port: SW1's BPDUs err-disable it.
    klish("SW2", ["interface Ethernet 0", "spanning-tree bpduguard port-shutdown", "exit"]);
    advance(4500);
    expect(isErrdisabled(byName("SW2"), "Ethernet0")).toBe(true);
    expect(port("SW2", "Ethernet0").operState).toBe("down");
    expect(stpState("SW2", "Ethernet1")).toBe("FORWARDING");
    expect(ping("H1", "10.1.0.2")).toMatch(/2 received/);
  });
});

describe("BPDU guard → errdisable → recovery", () => {
  function build() {
    addSwitch("SW1");
    addSwitch("SW2");
    cable("SW1", 0, "SW2", 0);
    addPc("H1", "10.1.0.1");
    addPc("H2", "10.1.0.2");
    cable("SW1", 4, "H1");
    cable("SW2", 4, "H2");
  }

  it("a BPDU on a guarded port err-disables it: the link stops forwarding; recovery restores it", () => {
    build();
    klish("SW1", ["spanning-tree priority 4096"]);
    klish("SW2", ["interface Ethernet 0", "spanning-tree bpduguard port-shutdown", "exit", "errdisable recovery cause bpduguard", "errdisable recovery interval 30"]);
    advance(4500);
    expect(errdisabledPorts(byName("SW2")).Ethernet0?.cause).toBe("bpduguard");
    expect(port("SW1", "Ethernet0").operState).toBe("down"); // carrier lost on both ends
    expect(ping("H1", "10.1.0.2", 1)).toMatch(/0 received/);
    expect(sh("SW2", "show spanning-tree bpdu-guard")).toMatch(/^Ethernet0 +Yes +Yes$/m);
    // Operator removes the guard; the recovery timer brings the port back.
    klish("SW2", ["interface Ethernet 0", "no spanning-tree bpduguard", "exit"]);
    advance(31_000);
    expect(isErrdisabled(byName("SW2"), "Ethernet0")).toBe(false);
    expect(port("SW2", "Ethernet0").operState).toBe("up");
    expect(ping("H1", "10.1.0.2")).toMatch(/2 received/);
  });

  it("the guard trips whichever side is designated (an STP switch on a guarded edge port)", () => {
    build();
    // SW2 is the root: its Ethernet0 is Designated; SW1's guarded port is SW1's root port side.
    klish("SW2", ["spanning-tree priority 4096"]);
    klish("SW1", ["interface Ethernet 0", "spanning-tree bpduguard port-shutdown", "exit"]);
    advance(4500);
    expect(isErrdisabled(byName("SW1"), "Ethernet0")).toBe(true);
    // ... and the other way round: SW2 (root, designated) guarding its port towards SW1.
    S().newLab();
    build();
    klish("SW2", ["spanning-tree priority 4096", "interface Ethernet 0", "spanning-tree bpduguard port-shutdown", "exit"]);
    advance(4500);
    expect(isErrdisabled(byName("SW2"), "Ethernet0")).toBe(true);
  });

  it("without port-shutdown the guard does not disable the port", () => {
    build();
    klish("SW2", ["interface Ethernet 0", "spanning-tree bpduguard", "exit"]);
    advance(4500);
    expect(isErrdisabled(byName("SW2"), "Ethernet0")).toBe(false);
  });
});

// ---------- LAG ----------

describe("PortChannel (LACP) with VLAN / STP / LLDP / FDB", () => {
  beforeEach(() => {
    S().loadFeatureLab("lacp");
    advance(3500);
  });

  it("a member going down keeps traffic flowing; the FDB stays on the PortChannel", () => {
    expect(ping("H1", "192.168.10.13")).toMatch(/2 received/);
    S().disconnect(S().network.connections.find((c) => c.a.interfaceId === `${id("S1")}-if0` || c.b.interfaceId === `${id("S1")}-if0`)!.id);
    advance(3500);
    expect(port("S1", "PortChannel1").operState).toBe("up");
    expect(ping("H1", "192.168.10.13")).toMatch(/2 received/);
    expect(ping("H2", "192.168.10.14")).toMatch(/2 received/);
    expect(fdbPort("S2", macOf("H1"))).toBe("PortChannel1");
  });

  it("a VLAN added on the LAG (trunk) carries traffic; VLANs not on the LAG do not", () => {
    for (const s of ["S1", "S2"])
      klish(s, ["vlan 20", "interface Ethernet 3", "switchport access Vlan 20", "exit", "interface PortChannel 1", "switchport trunk allowed Vlan 20", "exit"]);
    advance(500);
    expect(ping("H2", "192.168.10.14")).toMatch(/2 received/); // VLAN 20 over the LAG, tagged
    expect(ping("H1", "192.168.10.13")).toMatch(/2 received/); // VLAN 10 still untagged
    expect(ping("H1", "192.168.10.14", 1)).toMatch(/0 received/);
    for (const s of ["S1", "S2"]) klish(s, ["interface PortChannel 1", "switchport trunk allowed Vlan remove 20", "exit"]);
    advance(500);
    expect(ping("H2", "192.168.10.14", 1)).toMatch(/0 received/);
  });

  it("LLDP sees the neighbour on each LAG member port", () => {
    advance(31_000);
    const nb = lldpRuntime(byName("S1"))!;
    const peers = JSON.stringify(nb);
    expect(peers).toContain("Ethernet0");
    expect(peers).toContain("Ethernet1");
    sh("S1", "exit");
    const t = sh("S1", "show lldp table");
    expect(t).toMatch(/^Ethernet0 +S2 +Ethernet0/m);
    expect(t).toMatch(/^Ethernet1 +S2 +Ethernet1/m);
  });

  it("STP counts the LAG as one port: its members are not blocked against each other", () => {
    const names = stpPorts("S2").map((p) => p.interfaceName);
    expect(names).toContain("PortChannel1");
    expect(names).not.toContain("Ethernet0");
    expect(names).not.toContain("Ethernet1");
    expect(stpState("S2", "PortChannel1")).toBe("FORWARDING");
  });

  it("STP over a PortChannel: a loop through the LAG and a third switch blocks one port, broadcasts do not loop", () => {
    // S3 joins S1 (Ethernet2→ S3 Ethernet0) and S2 (Ethernet3 → S3 Ethernet1): loop S1═S2–S3–S1. S3 is root,
    // so the S1═S2 PortChannel is the redundant link and must block (it carries VLAN 10 untagged).
    S().disconnect(connOf("S1", "Ethernet3"));
    S().disconnect(connOf("S2", "Ethernet3"));
    addSwitch("S3", 4);
    for (const [s, p] of [["S1", 3], ["S2", 3]] as const) klish(s, [`interface ${ifn(`Ethernet${p}`)}`, "switchport access Vlan 10", "exit"]);
    cable("S1", 3, "S3", 0);
    cable("S2", 3, "S3", 1);
    klish("S3", ["vlan 10", "interface Ethernet 0", "switchport access Vlan 10", "exit", "interface Ethernet 1", "switchport access Vlan 10", "exit", "spanning-tree priority 4096"]);
    advance(2500);
    const pcStates = [stpState("S1", "PortChannel1"), stpState("S2", "PortChannel1")];
    expect(pcStates.filter((s) => s === "BLOCKING")).toHaveLength(1);
    const from = S().captures.length;
    expect(ping("H1", "192.168.10.13")).toMatch(/2 received/);
    expect(maxArpTxPerPort(from)).toBe(1);
  });
});

describe("static LAG", () => {
  it("static PortChannel forwards over both members and survives a member failure", () => {
    addSwitch("S1", 4);
    addSwitch("S2", 4);
    addPc("H1", "10.2.0.1");
    addPc("H2", "10.2.0.2");
    cable("S1", 0, "S2", 0);
    cable("S1", 1, "S2", 1);
    cable("S1", 2, "H1");
    cable("S2", 2, "H2");
    for (const s of ["S1", "S2"])
      klish(s, ["interface PortChannel 1 mode on", "exit", "interface Ethernet 0", "channel-group 1", "exit", "interface Ethernet 1", "channel-group 1", "exit"]);
    advance(2000);
    expect(port("S1", "PortChannel1").operState).toBe("up");
    expect(ping("H1", "10.2.0.2")).toMatch(/2 received/);
    S().disconnect(connOf("S1", "Ethernet1"));
    advance(1000);
    expect(ping("H1", "10.2.0.2")).toMatch(/2 received/);
    S().disconnect(connOf("S1", "Ethernet0"));
    advance(1000);
    expect(port("S1", "PortChannel1").operState).toBe("down");
    expect(ping("H1", "10.2.0.2", 1)).toMatch(/0 received/);
  });
});

// ---------- FDB ----------

describe("FDB", () => {
  it("a port going down flushes the entries learned on it (the host is reachable once it moves)", () => {
    addSwitch("SW1", 4);
    addPc("H1", "10.3.0.1");
    addPc("H2", "10.3.0.2");
    cable("SW1", 0, "H1");
    cable("SW1", 1, "H2");
    expect(ping("H1", "10.3.0.2")).toMatch(/2 received/);
    expect(fdbPort("SW1", macOf("H2"))).toBe("Ethernet1");
    S().disconnect(connOf("SW1", "Ethernet1"));
    advance(300);
    expect(fdbPort("SW1", macOf("H2"))).toBeUndefined();
    // H2 recabled on Ethernet2: H1's cached ARP still works (unknown unicast is flooded).
    cable("SW1", 2, "H2");
    expect(ping("H1", "10.3.0.2")).toMatch(/2 received/);
    expect(fdbPort("SW1", macOf("H2"))).toBe("Ethernet2");
  });

  it("a port changing VLAN flushes its FDB entries", () => {
    addSwitch("SW1", 4);
    addPc("H1", "10.3.0.1");
    addPc("H2", "10.3.0.2");
    cable("SW1", 0, "H1");
    cable("SW1", 1, "H2");
    expect(ping("H1", "10.3.0.2")).toMatch(/2 received/);
    klish("SW1", ["interface Vlan 30", "exit", "interface Ethernet 1", "switchport access Vlan 30", "exit"]);
    advance(300);
    expect(byName("SW1").macTable.some((e) => e.vlan === 1 && e.mac.toUpperCase() === macOf("H2").toUpperCase())).toBe(false);
  });
});

// ---------- l2-protect lab: snooping, storm control, LST, UDLD ----------

describe("l2-protect lab interactions", () => {
  beforeEach(() => S().loadFeatureLab("l2-protect"));

  it("DHCP snooping: untrusted server dropped, the binding table fills", () => {
    expect(sh("Client", "dhclient")).toContain("from 192.168.10.1");
    const st = peekSnoopState(byName("SW1"))!;
    expect(st.drops.Ethernet1).toBeGreaterThan(0);
    expect(st.bindings.map((b) => [b.iface, b.vlan])).toEqual([["Ethernet0", 10]]);
  });

  it("storm control drops broadcast beyond the rate on the attacker port", () => {
    sh("Attacker", "arping -b -c 50 192.168.10.1");
    expect(peekStormState(byName("SW1"))!.drops["Ethernet3|broadcast"]).toBeGreaterThan(0);
  });

  it("link-state tracking: upstream down → downstream down → client loses link; recovery restores it", () => {
    S().setAdminState(id("SW2"), port("SW2", "Ethernet5").id, false);
    advance(300);
    expect(port("SW1", "Ethernet0").operState).toBe("down");
    expect(byName("Client").interfaces[0].operState).toBe("down");
    S().setAdminState(id("SW2"), port("SW2", "Ethernet5").id, true);
    advance(11_000);
    expect(port("SW1", "Ethernet0").operState).toBe("up");
  });
});

describe("DHCP snooping on a PortChannel uplink", () => {
  it("trust on the PortChannel lets the server's replies through and builds the binding; untrusted LAG drops them", () => {
    S().loadFeatureLab("lacp");
    advance(3500);
    // A DHCP server on S2 (VLAN 10), the client H1 on S1; snooping on S1 with PortChannel1 trusted.
    const srv = S().addDevice("dhcp-server", { x: 0, y: 0 });
    S().renameDevice(srv, "DHCP");
    S().setInterfaceIp(srv, `${srv}-if0`, "192.168.10.1", 24);
    S().disconnect(connOf("S2", "Ethernet3"));
    S().connect(srv, `${srv}-if0`, id("S2"), port("S2", "Ethernet3").id);
    klish("S1", ["ip dhcp snooping", "ip dhcp snooping Vlan10"]);
    // Untrusted uplink: the OFFER is dropped on S1.
    expect(sh("H1", "dhclient")).not.toContain("DHCPACK");
    expect(Object.values(peekSnoopState(byName("S1"))?.drops ?? {}).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    klish("S1", ["interface PortChannel 1", "ip dhcp snooping trust", "exit"]);
    expect(sh("H1", "dhclient")).toContain("from 192.168.10.1");
    expect(peekSnoopState(byName("S1"))!.bindings.map((b) => [b.iface, b.vlan])).toEqual([["Ethernet2", 10]]);
  });
});

describe("IGMP snooping over a PortChannel", () => {
  it("a report arriving on a LAG member is snooped in the PortChannel's VLAN, on the PortChannel", () => {
    S().loadFeatureLab("lacp");
    advance(3500);
    klish("S2", ["interface Vlan 10", "ip igmp snooping", "exit"]);
    sh("H1", "mcast join 239.1.1.1");
    const t = sh("S2", "show ip igmp snooping groups");
    expect(t).toContain("Vlan ID: 10");
    expect(t).toContain("Outgoing Ports: PortChannel1");
  });
});

describe("link-state tracking with a PortChannel downstream", () => {
  it("the upstream failing takes the downstream LAG down on both ends; it comes back after the timeout", () => {
    S().loadFeatureLab("lacp");
    advance(3500);
    klish("S1", ["link state track UP", "timeout 5", "exit", "interface Ethernet 2", "link state track UP upstream", "exit", "interface PortChannel 1", "link state track UP downstream", "exit"]);
    advance(300);
    S().setAdminState(id("H1"), byName("H1").interfaces[0].id, false);
    advance(3500);
    expect(port("S1", "PortChannel1").operState).toBe("down");
    expect(port("S2", "PortChannel1").operState).toBe("down");
    S().setAdminState(id("H1"), byName("H1").interfaces[0].id, true);
    advance(9000);
    expect(port("S2", "PortChannel1").operState).toBe("up");
    expect(ping("H2", "192.168.10.14")).toMatch(/2 received/);
  });
});

describe("link-state tracking with a PortChannel upstream", () => {
  it("the LAG losing all members downs the tracked downstream host port", () => {
    S().loadFeatureLab("lacp");
    advance(3500);
    klish("S1", ["link state track UP", "timeout 5", "exit", "interface PortChannel 1", "link state track UP upstream", "exit", "interface Ethernet 2", "link state track UP downstream", "exit"]);
    advance(300);
    expect(port("S1", "Ethernet2").operState).toBe("up");
    S().disconnect(connOf("S1", "Ethernet0"));
    S().disconnect(connOf("S1", "Ethernet1"));
    advance(1000);
    expect(port("S1", "PortChannel1").operState).toBe("down");
    expect(port("S1", "Ethernet2").operState).toBe("down");
    expect(byName("H1").interfaces[0].operState).toBe("down");
  });
});

// ---------- MCLAG ----------

describe("MCLAG", () => {
  beforeEach(() => {
    S().loadFeatureLab("mclag");
    advance(4000);
  });

  it("peers sync MACs: a host learned on one peer appears on the other", () => {
    expect(ping("H1", "192.168.10.13")).toMatch(/2 received/);
    expect(ping("H2", "192.168.10.13")).toMatch(/2 received/);
    advance(2000);
    expect(fdbPort("P2", macOf("H1"))).toBe("Ethernet1"); // orphan on P1 → via the peer-link
    expect(fdbPort("P1", macOf("H3"))).toBe("PortChannel1");
    expect(fdbPort("P2", macOf("H3"))).toBe("PortChannel1");
  });

  it("an MLAG member link failure: traffic to the dual-homed host continues over the peer-link", () => {
    expect(ping("H1", "192.168.10.13")).toMatch(/2 received/);
    S().disconnect(connOf("P1", "Ethernet0"));
    advance(4000);
    expect(ping("H1", "192.168.10.13")).toMatch(/2 received/);
    expect(ping("H2", "192.168.10.13")).toMatch(/2 received/);
  });

  it("peer-link failure: the session stays up over the keepalive link; MACs pointing at the peer-link are removed", () => {
    expect(ping("H1", "192.168.10.13")).toMatch(/2 received/);
    advance(2000);
    expect(fdbPort("P2", macOf("H1"))).toBe("Ethernet1");
    S().disconnect(connOf("P1", "Ethernet1"));
    advance(4000);
    expect(mclagRuntime(byName("P1"))!.session).toBe(true);
    expect(mclagRuntime(byName("P2"))!.session).toBe(true);
    // iccpd mlacp_peerlink_down_handler: entries on the peer-link are deleted from the ASIC.
    expect(byName("P2").macTable.some((e) => e.interfaceId === port("P2", "Ethernet1").id)).toBe(false);
    // H3 is still reached through P1's local MLAG member.
    expect(fdbPort("P1", macOf("H3"))).toBe("PortChannel1");
  });
});
