import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekBgpRuntime, evpnTable } from "../lib/protocols/bgp-daemon";
import { peekVxlanRuntime, floodList } from "../lib/protocols/vxlan-daemon";
import { decodeMessages, UpdateMsg } from "../lib/protocols/bgp-wire";
import { ecListStr } from "../lib/protocols/evpn-wire";
import { l4Payload } from "../lib/control/packet";
import { formatPacket } from "../lib/commands/tcpdump";
import { bytesToFrame } from "../lib/packetgen/frame";
import { CaptureRecord } from "../lib/engine";

const sh = (sw: string, cmd: string) => out(S().execCommand(byName(sw).id, cmd));
const mac = (dev: string) => byName(dev).interfaces[0].mac;
const fdb = (sw: string, m: string) => byName(sw).macTable.find((e) => e.mac === m && e.vlan === 100);
const ping = (from: string, to: string, n = 2) => out(S().execCommand(byName(from).id, `ping -c ${n} ${to}`));

/** VXLAN packets a switch sent on the underlay, from capture index `since`. */
function vxlanTx(sw: string, since = 0): CaptureRecord[] {
  const id = byName(sw).id;
  return S().captures.slice(since).filter((c) => c.deviceId === id && c.dir === "tx" && c.frame.udp?.dstPort === 4789);
}
const inner = (c: CaptureRecord) => bytesToFrame(l4Payload(c.frame)!.slice(8), "");

/** EVPN UPDATEs a switch sent. */
function evpnUpdates(sw: string): UpdateMsg[] {
  const id = byName(sw).id;
  return S()
    .captures.filter((c) => c.deviceId === id && c.dir === "tx" && c.frame.tcp)
    .flatMap((c) => decodeMessages(l4Payload(c.frame) ?? new Uint8Array(), true))
    .filter((m): m is UpdateMsg => m.type === 2 && !!(m.evpnReach || m.evpnUnreach));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("vxlan");
});
afterEach(() => vi.useRealTimers());

describe("BGP EVPN control plane (vxlan lab: LEAF1 — SPINE — LEAF2)", () => {
  it("lab configures cleanly; underlay routes the loopbacks; EVPN AF negotiated on every session", () => {
    for (const d of ["SPINE", "LEAF1", "LEAF2"]) expect(S().terminals[byName(d).id].filter((l) => l.lineKind === "error")).toEqual([]);
    advance(3000);
    expect(byName("LEAF1").routingTable.find((r) => r.type === "bgp" && r.destination === "10.0.0.2")).toMatchObject({ nextHop: "10.0.11.2", prefix: 32 });
    const p = peekBgpRuntime(byName("SPINE"))!.peers["10.0.11.1"];
    expect(p.state).toBe("Established");
    expect(p.mpRcvd).toEqual(["1/1", "25/70"]);
    const sum = sh("LEAF1", "show bgp l2vpn evpn summary");
    expect(sum).toContain("L2VPN EVPN Summary:");
    expect(sum).toMatch(/^10\.0\.11\.2\s+4\s+65100\s+\d+\s+\d+\s+\d+\s+0\s+0\s+\S+\s+1\s+1 N\/A$/m);
    expect(sh("LEAF1", "show bgp neighbors 10.0.11.2")).toContain("    Address Family L2VPN EVPN: advertised and received");
  });

  it("type-3 IMET routes build the flood lists (RD RouterId:2, RT AS:VNI, PMSI ingress replication)", () => {
    advance(3000);
    expect(floodList(peekVxlanRuntime(byName("LEAF1")), 10100)).toEqual(["10.0.0.2"]);
    expect(floodList(peekVxlanRuntime(byName("LEAF2")), 10100)).toEqual(["10.0.0.1"]);
    const t3 = evpnUpdates("LEAF1").find((u) => u.evpnReach?.nlri[0].type === 3)!;
    expect(t3.evpnReach).toEqual({ nextHop: "10.0.0.1", nlri: [{ type: 3, rd: "10.0.0.1:2", ethTag: 0, origIp: "10.0.0.1" }] });
    expect(ecListStr(t3.attrs!.extComms!)).toBe("ET:8 RT:65001:10100");
    expect(t3.attrs!.pmsi).toEqual({ flags: 0, tunnelType: 6, vni: 10100, endpoint: "10.0.0.1" });
    // the spine relays with the next hop unchanged; received ext-communities are value-sorted
    const relayed = evpnTable(byName("LEAF2")).get("10.0.0.1:2|[3]:[0]:[32]:[10.0.0.1]")![0].path;
    expect(relayed).toMatchObject({ nextHop: "10.0.0.1", asPath: [65100, 65001] });
    expect(ecListStr(relayed.extComms)).toBe("RT:65001:10100 ET:8");
    const table = sh("LEAF1", "show bgp l2vpn evpn");
    expect(table).toContain("EVPN type-3 prefix: [3]:[EthTag]:[IPlen]:[OrigIP]");
    expect(table).toContain("   Network          Next Hop            Metric LocPrf Weight Path\n                    Extended Community");
    expect(table).toContain("Route Distinguisher: 10.0.0.1:2\n *>  [3]:[0]:[32]:[10.0.0.1]\n                    10.0.0.1                           32768 i\n                    ET:8 RT:65001:10100");
    expect(table).toContain("Route Distinguisher: 10.0.0.2:2\n *>  [3]:[0]:[32]:[10.0.0.2]\n                    10.0.0.2                               0 65100 65002 i\n                    RT:65002:10100 ET:8");
    expect(table).toContain("Displayed 2 prefixes (2 paths)");
    expect(sh("LEAF1", "show bgp l2vpn evpn route type macip")).toBe("No EVPN prefixes (of requested type) exist");
    expect(sh("LEAF1", "show vxlan remotevni all")).toContain("| Vlan100 | 10.0.0.2     | 10100 |");
    expect(sh("LEAF1", "show vxlan remotevtep")).toContain("| 10.0.0.1 | 10.0.0.2 | EVPN              | oper_up      |");
    expect(sh("LEAF1", "show evpn vni")).toMatch(/^10100\s+L2\s+vtep1-100\s+0\s+0\s+1\s+default/m);
  });

  it("H1 pings H2 over the overlay: ARP head-end replicated, replies/echoes unicast-encapsulated in VNI 10100", () => {
    advance(3000);
    const since = S().captures.length;
    expect(ping("H1", "172.16.100.12")).toContain("2 received");
    const l1 = vxlanTx("LEAF1", since);
    const l2 = vxlanTx("LEAF2", since);
    // LEAF1 → LEAF2: the ARP broadcast (flood list), then 2 echo requests (known MAC behind vtep:10.0.0.2)
    expect(l1.map((c) => inner(c).arp?.op ?? inner(c).icmp?.type)).toEqual(["request", "echo-request", "echo-request"]);
    expect(inner(l1[0]).ethernet.dstMac.toUpperCase()).toBe("FF:FF:FF:FF:FF:FF");
    // LEAF2 never re-floods the decapsulated broadcast into tunnels (split horizon): only unicast back
    expect(l2.map((c) => inner(c).arp?.op ?? inner(c).icmp?.type)).toEqual(["reply", "echo-reply", "echo-reply"]);
    for (const c of [...l1, ...l2]) {
      const b = l4Payload(c.frame)!;
      expect(b[0]).toBe(0x08); // I flag
      expect((b[4] << 16) | (b[5] << 8) | b[6]).toBe(10100);
      expect(c.frame.udp!.srcPort).toBeGreaterThanOrEqual(49152);
      expect(c.frame.ipv4!.ttl).toBe(64);
      expect(c.frame.vlan).toBeUndefined();
      expect(inner(c).vlan).toBeUndefined(); // inner frame untagged
      expect(c.frame.meta.sizeBytes).toBe(inner(c).meta.sizeBytes + 50); // 50-byte overhead
    }
    expect([l1[0].frame.ipv4!.srcIp, l1[0].frame.ipv4!.dstIp]).toEqual(["10.0.0.1", "10.0.0.2"]);
    // the outer packet crossed the spine as ordinary routed IP (TTL decremented once)
    const spineRx = S().captures.slice(since).find((c) => c.deviceId === byName("LEAF2").id && c.dir === "rx" && c.frame.udp?.dstPort === 4789)!;
    expect(spineRx.frame.ipv4!.ttl).toBe(63);
    // tcpdump -nn: VXLAN header line then the inner frame with its link header
    const td = formatPacket(l1[1].frame, {}).join("\n");
    expect(td).toMatch(/^IP 10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.4789: VXLAN, flags \[I\] \(0x08\), vni 10100\n/);
    expect(td).toContain(`${mac("H1").toLowerCase()} > ${mac("H2").toLowerCase()}, ethertype IPv4 (0x0800), length 98: 172.16.100.11 > 172.16.100.12: ICMP echo request, id`);
  });

  it("locally learned MACs are advertised as type-2 and installed as remote MACs on the other leaf", () => {
    advance(3000);
    ping("H1", "172.16.100.12", 1);
    advance(500);
    expect(fdb("LEAF2", mac("H1"))?.interfaceId).toBe("vtep:10.0.0.1");
    expect(fdb("LEAF1", mac("H2"))?.interfaceId).toBe("vtep:10.0.0.2");
    const t2 = evpnUpdates("LEAF1").find((u) => u.evpnReach?.nlri[0].type === 2)!;
    expect(t2.evpnReach!.nlri).toEqual([{ type: 2, rd: "10.0.0.1:2", ethTag: 0, mac: mac("H1").toLowerCase(), vni: 10100 }]);
    expect(t2.attrs!.pmsi).toBeUndefined();
    const m2 = mac("H2").toLowerCase();
    expect(sh("LEAF1", "show vxlan remotemac all")).toContain(`| Vlan100 | ${m2} | 10.0.0.2     | 10100 | dynamic |`);
    expect(sh("LEAF1", "show evpn mac vni 10100")).toContain(`${m2} remote       10.0.0.2                             0/0`);
    expect(sh("LEAF1", "show evpn mac vni 10100")).toContain(`${mac("H1").toLowerCase()} local        Ethernet2                      100   0/0`);
    expect(sh("LEAF1", "show mac")).toMatch(new RegExp(`100\\s+${mac("H2")}\\s+VxLAN DIP: 10\\.0\\.0\\.2\\s+Static`));
    expect(sh("LEAF2", "show bgp l2vpn evpn")).toContain(`Route Distinguisher: 10.0.0.1:2\n *>  [2]:[0]:[48]:[${mac("H1").toLowerCase()}]\n                    10.0.0.1                               0 65100 65001 i\n                    RT:65001:10100 ET:8`);
    // KLISH `show vxlan remote mac` renders the same table
    expect(sh("LEAF1", "show vxlan remote mac")).toContain(`| Vlan100 | ${m2} | 10.0.0.2     | 10100 | dynamic |`);
  });

  it("host move: MAC mobility seq 1 takes the MAC to LEAF1; LEAF2 repoints it and withdraws its own type-2", () => {
    advance(3000);
    ping("H1", "172.16.100.12", 1);
    advance(500);
    const m2 = mac("H2");
    const c = S().network.connections.find((x) => x.a.deviceId === byName("H2").id || x.b.deviceId === byName("H2").id)!;
    S().disconnect(c.id);
    S().connect(byName("H2").id, `${byName("H2").id}-if0`, byName("LEAF1").id, `${byName("LEAF1").id}-if3`);
    expect(ping("H2", "172.16.100.11", 1)).toContain("1 received");
    advance(500);
    expect(byName("LEAF1").interfaces.find((i) => i.id === fdb("LEAF1", m2)?.interfaceId)?.name).toBe("Ethernet3");
    expect(peekVxlanRuntime(byName("LEAF1"))!.seq[`10100|${m2}`]).toBe(1);
    expect(fdb("LEAF2", m2)?.interfaceId).toBe("vtep:10.0.0.1");
    const leaf2Rib = sh("LEAF2", "show bgp l2vpn evpn route type macip");
    expect(leaf2Rib).toContain(` *>  [2]:[0]:[48]:[${m2.toLowerCase()}]\n                    10.0.0.1                               0 65100 65001 i\n                    RT:65001:10100 ET:8 MM:1`);
    expect(leaf2Rib).not.toContain("Route Distinguisher: 10.0.0.2:2"); // LEAF2 withdrew its copy
    expect(evpnUpdates("LEAF2").some((u) => u.evpnUnreach?.some((r) => r.mac === m2.toLowerCase()))).toBe(true);
    expect(sh("LEAF1", "show evpn mac vni 10100")).toContain(`${m2.toLowerCase()} local        Ethernet3                      100   1/0`);
    expect(sh("LEAF1", "show vxlan remotemac all")).toContain("Total count : 0");
  });

  it("local MACs age out after 600 s without traffic and the remote leaf removes them", () => {
    advance(3000);
    ping("H1", "172.16.100.12", 1);
    advance(500);
    expect(fdb("LEAF2", mac("H1"))).toBeDefined();
    advance(590_000, 1000);
    expect(fdb("LEAF1", mac("H1"))).toBeDefined(); // not yet
    advance(30_000, 1000);
    expect(fdb("LEAF1", mac("H1"))).toBeUndefined();
    expect(fdb("LEAF2", mac("H1"))).toBeUndefined();
    expect(sh("LEAF2", "show vxlan remotemac all")).toContain("Total count : 0");
    expect(sh("LEAF2", "show bgp l2vpn evpn")).toContain("Displayed 2 prefixes (2 paths)"); // the two type-3s remain
  });

  it("a leaf going down: its routes are withdrawn, the flood list and remote MACs disappear", () => {
    advance(3000);
    ping("H1", "172.16.100.12", 1);
    advance(500);
    S().removeDevice(byName("LEAF2").id);
    advance(1000);
    expect(floodList(peekVxlanRuntime(byName("LEAF1")), 10100)).toEqual([]);
    expect(fdb("LEAF1", mac("H2"))).toBeUndefined();
    expect(sh("LEAF1", "show bgp l2vpn evpn")).not.toContain("10.0.0.2:2");
    expect(sh("LEAF1", "show vxlan remotevtep")).toContain("Total count : 0");
    expect(sh("LEAF1", "show evpn vni 10100")).toContain(" No remote VTEPs known for this VNI");
  });

  it("deactivating EVPN on a session resets it and stops the exchange (MP capability no longer sent)", () => {
    advance(3000);
    S().runCliScript(byName("SPINE").id, ["configure terminal", "router bgp 65100", "neighbor 10.0.11.1", "address-family l2vpn evpn", "no activate", "end"]);
    advance(3000);
    const p = peekBgpRuntime(byName("SPINE"))!.peers["10.0.11.1"];
    expect(p.state).toBe("Established");
    expect(p.lastReset?.reason).toBe("Address family activated");
    expect(peekBgpRuntime(byName("LEAF1"))!.peers["10.0.11.2"].mpRcvd).toEqual(["1/1"]);
    expect(floodList(peekVxlanRuntime(byName("LEAF1")), 10100)).toEqual([]);
    expect(sh("LEAF1", "show bgp l2vpn evpn summary")).toMatch(/^10\.0\.11\.2 .*NoNeg/m);
    expect(sh("SPINE", "show bgp l2vpn evpn summary")).not.toContain("10.0.11.1 ");
  });
});
