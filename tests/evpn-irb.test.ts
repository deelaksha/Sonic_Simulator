import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekVxlanRuntime } from "../lib/protocols/vxlan-daemon";
import { l4Payload } from "../lib/control/packet";
import { bytesToFrame } from "../lib/packetgen/frame";
import { formatPacket } from "../lib/commands/tcpdump";
import { CaptureRecord } from "../lib/engine";

const sh = (sw: string, cmd: string) => out(S().execCommand(byName(sw).id, cmd));
const mac = (dev: string) => byName(dev).interfaces[0].mac;
const rmac = (sw: string) => byName(sw).interfaces.find((i) => i.name === "Vlan500")!.mac.toLowerCase();
const ping = (from: string, to: string, n = 2) => out(S().execCommand(byName(from).id, `ping -c ${n} ${to}`));
const SAG_MAC = "00:00:5e:00:01:01";

/** VXLAN packets a switch sent on the underlay, from capture index `since`. */
function vxlanTx(sw: string, since = 0): CaptureRecord[] {
  const id = byName(sw).id;
  return S().captures.slice(since).filter((c) => c.deviceId === id && c.dir === "tx" && c.frame.udp?.dstPort === 4789);
}
const vni = (c: CaptureRecord) => {
  const b = l4Payload(c.frame)!;
  return (b[4] << 16) | (b[5] << 8) | b[6];
};
const inner = (c: CaptureRecord) => bytesToFrame(l4Payload(c.frame)!.slice(8), "");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("evpn-irb");
});
afterEach(() => vi.useRealTimers());

describe("EVPN symmetric IRB (evpn-irb lab: LEAF1/LEAF2/LEAF3 — SPINE, Vrf-red L3 VNI 50000)", () => {
  it("lab configures cleanly; L3 VNI is up with the Vlan500 SVI MAC as router MAC", () => {
    for (const d of ["SPINE", "LEAF1", "LEAF2", "LEAF3"]) expect(S().terminals[byName(d).id].filter((l) => l.lineKind === "error")).toEqual([]);
    advance(3000);
    const det = sh("LEAF1", "show evpn vni 50000");
    expect(det).toContain("VNI: 50000\n  Type: L3\n  Tenant VRF: Vrf-red\n  Vlan: 500\n  Bridge: Bridge\n  Local Vtep Ip: 10.0.0.1\n  Vxlan-Intf: vtep1-500\n  SVI-If: Vlan500\n  State: Up");
    expect(det).toContain(`  Router MAC: ${rmac("LEAF1")}\n  L2 VNIs: 10010 `);
    const all = sh("LEAF1", "show evpn vni");
    expect(all).toMatch(/^10010\s+L2\s+vtep1-10\s+\d+\s+\d+\s+1\s+Vrf-red/m);
    expect(all).toMatch(/^50000\s+L3\s+vtep1-500\s+2\s+2\s+n\/a\s+Vrf-red/m);
    expect(sh("LEAF1", "show vxlan vrfvnimap")).toMatch(/\| Vrf-red\s+\|\s+50000 \|/);
  });

  it("inter-subnet ping across VTEPs: routed on LEAF1, VXLAN vni 50000 between router MACs, routed again on LEAF2", () => {
    advance(3000);
    ping("H1", "10.2.0.22", 1); // first packet may take the type-5 ECMP route; LEAF2 learns H2 → /32
    advance(1000);
    const since = S().captures.length;
    expect(ping("H1", "10.2.0.22")).toContain("2 received");
    const tx = vxlanTx("LEAF1", since).filter((c) => vni(c) === 50000);
    expect(tx.length).toBeGreaterThan(0);
    const c = tx[tx.length - 1];
    expect([c.frame.ipv4!.srcIp, c.frame.ipv4!.dstIp]).toEqual(["10.0.0.1", "10.0.0.2"]);
    const f = inner(c);
    expect(f.ethernet.srcMac.toLowerCase()).toBe(rmac("LEAF1"));
    expect(f.ethernet.dstMac.toLowerCase()).toBe(rmac("LEAF2"));
    expect([f.ipv4!.srcIp, f.ipv4!.dstIp, f.ipv4!.ttl]).toEqual(["10.1.0.11", "10.2.0.22", 63]); // routed once on LEAF1
    expect(formatPacket(c.frame, {}).join("\n")).toMatch(/^IP 10\.0\.0\.1\.\d+ > 10\.0\.0\.2\.4789: VXLAN, flags \[I\] \(0x08\), vni 50000\n/);
    // H2 receives the echo after the second routing hop (TTL 62)
    const h2rx = S().captures.slice(since).find((x) => x.deviceId === byName("H2").id && x.dir === "rx" && x.frame.icmp?.type === "echo-request")!;
    expect(h2rx.frame.ipv4!.ttl).toBe(62);
    expect(h2rx.frame.ethernet.srcMac.toLowerCase()).toBe(byName("LEAF2").interfaces.find((i) => i.name === "Vlan20")!.mac.toLowerCase());
  });

  it("type-2 MAC+IP carries L2 + L3 VNI, RT of both and Rmac; installed as /32 in the VRF via the VTEP", () => {
    advance(3000);
    ping("H1", "10.2.0.22", 1);
    advance(1000);
    const m2 = mac("H2").toLowerCase();
    const rib = sh("LEAF1", "show bgp l2vpn evpn");
    expect(rib).toContain(` *>  [2]:[0]:[48]:[${m2}]:[32]:[10.2.0.22]\n                    10.0.0.2                               0 65100 65002 i\n                    RT:65002:10020 RT:65002:50000 ET:8 Rmac:${rmac("LEAF2")}`);
    const rt = byName("LEAF1").routingTable.find((r) => r.vrf === "Vrf-red" && r.destination === "10.2.0.22")!;
    expect(rt).toMatchObject({ prefix: 32, nextHop: "10.0.0.2", type: "bgp", distance: 20 });
    expect(byName("LEAF1").interfaces.find((i) => i.id === rt.interfaceId)!.name).toBe("Vlan500");
    expect(sh("LEAF1", "show ip route vrf Vrf-red")).toMatch(/B>\* 10\.2\.0\.22\/32 \[20\/0\] via 10\.0\.0\.2, Vlan500/);
    // zebra: RMAC + next-hop neighbour; fdbsyncd: RMAC behind the tunnel in VLAN 500
    expect(sh("LEAF1", "show evpn rmac vni 50000")).toContain(`${rmac("LEAF2")} 10.0.0.2`);
    expect(sh("LEAF1", "show evpn next-hops vni 50000")).toContain(`10.0.0.2        ${rmac("LEAF2")}`);
    expect(sh("LEAF1", "show vxlan remotemac all")).toContain(`| Vlan500 | ${rmac("LEAF2")} | 10.0.0.2     | 50000 | dynamic |`);
    expect(byName("LEAF1").arpTable.find((a) => a.ip === "10.0.0.2")?.mac.toLowerCase()).toBe(rmac("LEAF2"));
    expect(sh("LEAF1", "show vxlan remotevtep")).toMatch(/\| 10\.0\.0\.1 \| 10\.0\.0\.2 \| EVPN\s+\| oper_up\s+\|/); // L3-only remote VTEP
    // the L2 VNI detail now shows the tenant VRF, SVI and the neighbour count
    expect(sh("LEAF2", "show evpn vni detail")).toContain("VNI: 10020\n Type: L2\n Vlan: 20\n Bridge: Bridge\n Tenant VRF: Vrf-red");
    expect(sh("LEAF2", "show evpn arp-cache vni 10020")).toMatch(new RegExp(`^10\\.2\\.0\\.22\\s+local\\s+active\\s+${m2}`, "m"));
  });

  it("type-5: connected subnets of the VRF are advertised with `advertise ipv4 unicast` and imported as ECMP", () => {
    advance(3000);
    const rib = sh("LEAF1", "show bgp l2vpn evpn");
    expect(rib).toContain(`Route Distinguisher: 10.0.0.2:3\n *>  [5]:[0]:[24]:[10.2.0.0]\n                    10.0.0.2                               0 65100 65002 i\n                    RT:65002:50000 ET:8 Rmac:${rmac("LEAF2")}`);
    expect(rib).toContain(`Route Distinguisher: 10.0.0.1:3\n *>  [5]:[0]:[24]:[10.1.0.0]\n                    10.0.0.1                           32768 i\n                    ET:8 RT:65001:50000 Rmac:${rmac("LEAF1")}`);
    const routes = sh("LEAF1", "show ip route vrf Vrf-red");
    expect(routes).toMatch(/B>\* 10\.2\.0\.0\/24 \[20\/0\] via 10\.0\.0\.2, Vlan500.*\n  \*\s+via 10\.0\.0\.3, Vlan500/);
    expect(routes).toMatch(/C>\* 10\.1\.0\.0\/24 is directly connected, Vlan10/); // connected beats the remote type-5
    // H4 (LEAF3, no host route yet) is reached through the type-5 route
    expect(ping("H1", "10.2.0.24")).toMatch(/[12] received/);
    // withdraw: `no advertise ipv4 unicast` in LEAF2's VRF instance
    S().runCliScript(byName("LEAF2").id, ["configure terminal", "router bgp 65002 vrf Vrf-red", "address-family l2vpn evpn", "no advertise ipv4 unicast", "end"]);
    advance(2000);
    expect(sh("LEAF1", "show bgp l2vpn evpn")).not.toContain("10.0.0.2:3");
    expect(byName("LEAF1").routingTable.filter((r) => r.vrf === "Vrf-red" && r.destination === "10.2.0.0").map((r) => r.nextHop)).toEqual(["10.0.0.3"]);
  });

  it("static anycast gateway: same gateway IP + MAC on every leaf, ARP answered locally, never tunnelled", () => {
    advance(3000);
    for (const l of ["LEAF1", "LEAF3"]) {
      const s = sh(l, "show ip static-anycast-gateway");
      expect(s).toContain(`Configured Anycast Gateway MAC address: ${SAG_MAC}`);
      expect(s).toMatch(/Vlan10\s+10\.1\.0\.1\/24/);
    }
    const since = S().captures.length;
    expect(ping("H1", "10.1.0.1", 1)).toContain("1 received"); // the gateway itself answers
    expect(ping("H3", "10.1.0.1", 1)).toContain("1 received");
    for (const h of ["H1", "H3"]) expect(byName(h).arpTable.find((a) => a.ip === "10.1.0.1")?.mac.toLowerCase()).toBe(SAG_MAC);
    const arpTunnelled = [...vxlanTx("LEAF1", since), ...vxlanTx("LEAF3", since)].filter((c) => inner(c).arp?.targetIp === "10.1.0.1");
    expect(arpTunnelled).toEqual([]);
    // routed traffic to the anycast MAC: H3 → H2 via LEAF3's gateway
    expect(ping("H3", "10.2.0.22")).toContain("2 received");
  });

  it("host mobility: H3 moves from LEAF3 to LEAF1 and keeps using the same gateway MAC", () => {
    advance(3000);
    expect(ping("H3", "10.2.0.22", 1)).toContain("1 received");
    const gwBefore = byName("H3").arpTable.find((a) => a.ip === "10.1.0.1")!.mac;
    const c = S().network.connections.find((x) => x.a.deviceId === byName("H3").id || x.b.deviceId === byName("H3").id)!;
    S().disconnect(c.id);
    const l1 = byName("LEAF1").id;
    S().connect(byName("H3").id, `${byName("H3").id}-if0`, l1, `${l1}-if3`);
    S().runCliScript(l1, ["configure terminal", "interface Ethernet 3", "switchport access Vlan 10", "end"]);
    expect(ping("H3", "10.2.0.22")).toContain("2 received");
    expect(byName("H3").arpTable.find((a) => a.ip === "10.1.0.1")!.mac).toBe(gwBefore); // no re-ARP needed
    advance(1000);
    const e = byName("LEAF1").macTable.find((x) => x.mac === mac("H3") && x.vlan === 10)!;
    expect(byName("LEAF1").interfaces.find((i) => i.id === e.interfaceId)?.name).toBe("Ethernet3");
    expect(peekVxlanRuntime(byName("LEAF1"))!.seq[`10010|${mac("H3")}`]).toBe(1); // MAC mobility
  });

  it("ARP suppression: LEAF1 answers H1's ARP for H3 from the type-2 MAC+IP; no ARP request crosses the fabric", () => {
    advance(3000);
    ping("H3", "10.1.0.1", 1); // LEAF3 learns H3 (ARP for the gateway) → type-2 MAC+IP
    advance(1000);
    expect(peekVxlanRuntime(byName("LEAF1"))!.neighs["10|10.1.0.13"]?.vtep).toBe("10.0.0.3");
    expect(sh("LEAF1", "show evpn arp-cache vni 10010")).toMatch(new RegExp(`^10\\.1\\.0\\.13\\s+remote\\s+active\\s+${mac("H3").toLowerCase()}\\s+10\\.0\\.0\\.3`, "m"));
    expect(sh("LEAF1", "show neighbor-suppress-status")).toMatch(/\| Vlan10\s+\| on\s+\|/);
    const since = S().captures.length;
    expect(ping("H1", "10.1.0.13", 1)).toContain("1 received");
    expect(byName("H1").arpTable.find((a) => a.ip === "10.1.0.13")?.mac).toBe(mac("H3"));
    const tunnelledArp = vxlanTx("LEAF1", since).filter((c) => inner(c).arp?.op === "request");
    expect(tunnelledArp).toEqual([]);
    expect(peekVxlanRuntime(byName("LEAF1"))!.suppressed).toBe(1);
    // the ICMP itself is bridged over the L2 VNI
    expect(vxlanTx("LEAF1", since).some((c) => vni(c) === 10010 && inner(c).icmp?.type === "echo-request")).toBe(true);
    // without suppression the request is head-end replicated to LEAF3
    S().runCliScript(byName("LEAF1").id, ["configure terminal", "interface Vlan 10", "no neigh-suppress", "end"]);
    S().execCommand(byName("H1").id, "ip neigh flush all");
    const s2 = S().captures.length;
    ping("H1", "10.1.0.13", 1);
    expect(vxlanTx("LEAF1", s2).some((c) => inner(c).arp?.targetIp === "10.1.0.13")).toBe(true);
  });
});
