/**
 * Overlay and network-service features working together with each other and
 * with the L2/L3 underneath: VXLAN/EVPN, DHCP relay, NAT, ACL, CoPP, mirroring,
 * multicast, QoS and sFlow — each scenario driven through the store on a lab.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekVxlanRuntime, floodList } from "../lib/protocols/vxlan-daemon";
import { peekFeatureState } from "../lib/models/feature-state";
import { AclState } from "../lib/protocols/acl-rules";
import { l4Payload } from "../lib/control/packet";
import { bytesToFrame } from "../lib/packetgen/frame";
import { CaptureRecord } from "../lib/engine";
import { peekNat } from "../lib/protocols/nat";
import { QueueCounters } from "../lib/protocols/qos-model";
import { peekCoppRuntime } from "../lib/protocols/cpu-daemon";
import { peekTrafficSink } from "../lib/protocols/traffic";
import { peekCollector } from "../lib/sflow/collector";
import { decodeDatagram, decodeEthernetHeader } from "../lib/sflow/datagram";

const id = (n: string) => byName(n).id;
const sh = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"], { silent: true });
const ping = (from: string, to: string, n = 2) => out(S().execCommand(id(from), `ping -c ${n} ${to}`));
const received = (from: string, to: string, n = 2) => Number(ping(from, to, n).match(/(\d+) (packets )?received/)?.[1] ?? -1);
const mac = (dev: string) => byName(dev).interfaces[0].mac;
const ifName = (dev: string, ifId: string) => byName(dev).interfaces.find((i) => i.id === ifId)?.name;
const aclHits = (dev: string, key: string) => peekFeatureState<AclState>(byName(dev), "acl")?.counters?.[key]?.packets ?? 0;
/** Run a bash/Click command on a switch (terminals boot into KLISH). */
function bash(dev: string, cmd: string): string {
  if (byName(dev).type === "switch" && (S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}
function addHost(name: string, type: "pc" | "server" | "dhcp-server", sw: string, port: number, ip?: string, prefix = 24, gw?: string): string {
  const h = S().addDevice(type, { x: 0, y: 0 });
  S().renameDevice(h, name);
  if (ip) S().setInterfaceIp(h, `${h}-if0`, ip, prefix);
  if (gw) S().setDefaultGateway(h, gw);
  S().connect(h, `${h}-if0`, id(sw), `${id(sw)}-if${port}`, { autoDhcp: false });
  return h;
}
const rxAt = (dev: string, since: number, pred: (c: CaptureRecord) => boolean) =>
  S().captures.slice(since).filter((c) => c.deviceId === id(dev) && c.dir === "rx" && pred(c));
const inner = (c: CaptureRecord) => bytesToFrame(l4Payload(c.frame)!.slice(8), "");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => {
  S().stopTraffic();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe("VXLAN / BGP EVPN with the underlay (vxlan lab)", () => {
  beforeEach(() => {
    S().loadFeatureLab("vxlan");
    advance(3000);
  });

  it("type-2 routes come from real host traffic and H1 reaches H2 across the VTEPs", () => {
    expect(received("H1", "172.16.100.12")).toBe(2);
    advance(500);
    expect(byName("LEAF1").macTable.find((e) => e.mac === mac("H2"))?.interfaceId).toBe("vtep:10.0.0.2");
    expect(sh("LEAF1", "show bgp l2vpn evpn route type macip")).toContain(`[2]:[0]:[48]:[${mac("H2").toLowerCase()}]`);
  });

  it("underlay redundancy: losing the preferred underlay path reconverges BGP and the overlay keeps working", () => {
    // A direct LEAF1–LEAF2 link with its own eBGP session (shorter AS path for the loopbacks).
    S().setInterfaceIp(id("LEAF1"), `${id("LEAF1")}-if1`, "10.0.99.1", 30);
    S().setInterfaceIp(id("LEAF2"), `${id("LEAF2")}-if1`, "10.0.99.2", 30);
    S().connect(id("LEAF1"), `${id("LEAF1")}-if1`, id("LEAF2"), `${id("LEAF2")}-if1`);
    const peer = (as: number, ip: string, peerAs: number) => [`router bgp ${as}`, `neighbor ${ip}`, `remote-as ${peerAs}`, "address-family l2vpn evpn", "activate", "exit", "exit"];
    klish("LEAF1", peer(65001, "10.0.99.2", 65002));
    klish("LEAF2", peer(65002, "10.0.99.1", 65001));
    advance(10_000);
    const lo2 = () => byName("LEAF1").routingTable.filter((r) => r.type === "bgp" && r.destination === "10.0.0.2").map((r) => r.nextHop);
    expect(lo2()).toEqual(["10.0.99.2"]);
    expect(received("H1", "172.16.100.12")).toBe(2);

    klish("LEAF1", ["interface Ethernet 1", "shutdown"]);
    advance(5000);
    expect(lo2()).toEqual(["10.0.11.2"]); // via the spine again
    expect(floodList(peekVxlanRuntime(byName("LEAF1")), 10100)).toEqual(["10.0.0.2"]);
    expect(received("H1", "172.16.100.12")).toBe(2);
  });

  it("no underlay path at all tears the overlay down; restoring the link brings it back", () => {
    expect(received("H1", "172.16.100.12")).toBe(2);
    klish("SPINE", ["interface Ethernet 1", "shutdown"]);
    advance(5000);
    expect(byName("LEAF1").routingTable.some((r) => r.destination === "10.0.0.2")).toBe(false);
    expect(floodList(peekVxlanRuntime(byName("LEAF1")), 10100)).toEqual([]);
    expect(byName("LEAF1").macTable.find((e) => e.mac === mac("H2"))).toBeUndefined();
    expect(received("H1", "172.16.100.12")).toBe(0);
    klish("SPINE", ["interface Ethernet 1", "no shutdown"]);
    advance(40_000); // BGP ConnectRetry, then EVPN re-exchange
    expect(floodList(peekVxlanRuntime(byName("LEAF1")), 10100)).toEqual(["10.0.0.2"]);
    expect(received("H1", "172.16.100.12")).toBe(2);
  });

  it("MAC move: H2 moves behind LEAF1 and EVPN repoints the MAC on both leaves", () => {
    expect(received("H1", "172.16.100.12")).toBe(2);
    const c = S().network.connections.find((x) => x.a.deviceId === id("H2") || x.b.deviceId === id("H2"))!;
    S().disconnect(c.id);
    S().connect(id("H2"), `${id("H2")}-if0`, id("LEAF1"), `${id("LEAF1")}-if3`);
    expect(received("H2", "172.16.100.11")).toBe(2);
    advance(500);
    expect(ifName("LEAF1", byName("LEAF1").macTable.find((e) => e.mac === mac("H2"))!.interfaceId)).toBe("Ethernet3");
    expect(byName("LEAF2").macTable.find((e) => e.mac === mac("H2"))?.interfaceId).toBe("vtep:10.0.0.1");
  });

  it("an ingress ACL on a VTEP access port drops overlay traffic and counts it", () => {
    klish("LEAF1", ["ip access-list BLOCK", "seq 10 deny icmp any host 172.16.100.12", "seq 20 permit ip any any", "exit", "interface Ethernet 2", "ip access-group BLOCK in"]);
    const since = S().captures.length;
    expect(received("H1", "172.16.100.12")).toBe(0);
    expect(aclHits("LEAF1", "BLOCK|RULE_10")).toBe(2);
    expect(S().captures.slice(since).filter((c) => c.deviceId === id("LEAF1") && c.dir === "tx" && c.frame.udp?.dstPort === 4789 && inner(c).icmp)).toEqual([]);
  });

  it("DHCP across the L2 stretch: a server behind LEAF2 leases H1 an address over VXLAN (BUM replication)", () => {
    addHost("SRV", "dhcp-server", "LEAF2", 3, "172.16.100.1");
    S().execCommand(id("H1"), "ip addr flush dev eth0");
    const r = out(S().execCommand(id("H1"), "dhclient"));
    expect(r).toMatch(/bound to 172\.16\.100\.1\d\d\/24/);
  });
});

// ---------------------------------------------------------------------------
describe("EVPN symmetric IRB with DHCP relay (evpn-irb lab)", () => {
  beforeEach(() => {
    S().loadFeatureLab("evpn-irb");
    advance(3000);
  });

  it("IRB routes between two VNIs (VLAN 10 on LEAF1 ↔ VLAN 20 on LEAF2)", () => {
    expect(received("H1", "10.2.0.22")).toBeGreaterThanOrEqual(1);
    expect(received("H1", "10.2.0.22")).toBe(2);
  });

  it("DHCP relay on a VRF SVI: H1 leases from a server in another subnet behind another VTEP", () => {
    const srv = addHost("SRV", "dhcp-server", "LEAF2", 3, "10.2.0.50", 24, "10.2.0.1");
    klish("LEAF2", ["interface Ethernet 3", "switchport access Vlan 20"]);
    S().network.devices[srv].config.features = {
      dhcpServer: { gateway: "10.2.0.1", dns: "10.2.0.50", prefix: 24, leases: {}, pools: [{ subnet: "10.1.0.0", prefix: 24, gateway: "10.1.0.1", dns: "10.2.0.50", leases: {} }] },
    };
    klish("LEAF1", ["interface Vlan 10", "ip dhcp-relay 10.2.0.50"]);
    expect(received("SRV", "10.1.0.11", 1)).toBe(1); // tenant reachability first
    S().execCommand(id("H1"), "ip addr flush dev eth0");
    const r = out(S().execCommand(id("H1"), "dhclient"));
    expect(r).toMatch(/bound to 10\.1\.0\.1\d\d\/24 -- gateway 10\.1\.0\.1/);
  });
});

// ---------------------------------------------------------------------------
describe("NAT with ACLs, verified at the far side (l3-services lab)", () => {
  beforeEach(() => {
    S().loadFeatureLab("l3-services");
    advance(6000); // IP SLA up → tracked default route
  });
  const webRx = (since: number) => rxAt("WEB", since, (c) => !!c.frame.tcp || !!c.frame.icmp);

  it("the far side only sees the pool address; the reply is translated back to the inside host", () => {
    const since = S().captures.length;
    expect(received("H1", "203.0.113.10")).toBe(2);
    const seen = webRx(since);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((c) => c.frame.ipv4!.srcIp))).toEqual(new Set(["100.64.0.1"]));
    expect(rxAt("H1", since, (c) => c.frame.icmp?.type === "echo-reply").every((c) => c.frame.ipv4!.dstIp === "192.168.1.10")).toBe(true);
  });

  it("an ingress ACL on the inside port drops before NAT: no translation is created", () => {
    klish("S1", ["ip access-list NO-WEB", "seq 10 deny tcp any host 203.0.113.10 eq 80", "seq 20 permit ip any any", "exit", "interface Ethernet 2", "ip access-group NO-WEB in"]);
    const since = S().captures.length;
    bash("H1", "nc -w 1 203.0.113.10 80 hello");
    expect(webRx(since).filter((c) => c.frame.tcp)).toEqual([]);
    expect(aclHits("S1", "NO-WEB|RULE_10")).toBeGreaterThan(0);
    expect(peekNat(byName("S1"))?.entries.some((e) => e.proto === "tcp" && e.inIp === "192.168.1.10") ?? false).toBe(false);
    expect(received("H1", "203.0.113.10")).toBe(2); // ICMP still permitted and translated
  });

  it("an egress ACL on the outside port matches the translated (post-NAT) source", () => {
    klish("S1", ["ip access-list OUT", "seq 10 deny tcp host 100.64.0.1 any eq 80", "seq 20 permit ip any any", "exit", "interface Ethernet 0", "ip access-group OUT out"]);
    const since = S().captures.length;
    bash("H1", "nc -w 1 203.0.113.10 80 hello");
    expect(webRx(since).filter((c) => c.frame.tcp)).toEqual([]);
    expect(aclHits("S1", "OUT|RULE_10")).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("CoPP protects the CPU without touching transit (copp lab)", () => {
  it("an ICMP flood at the switch is policed in its own group; ARP to the gateway and routed traffic still work", () => {
    S().loadFeatureLab("copp");
    S().startTraffic({ srcDeviceId: id("H1"), dstIp: "192.168.1.1", protocol: "icmp", srcPort: 0, dstPort: 0, size: 56, count: 600, intervalMs: 0, continuous: false });
    vi.advanceTimersByTime(250);
    const rt = peekCoppRuntime(byName("S1"))!;
    expect(rt.groups["copp-lab-ip2me"].dropPkts).toBeGreaterThan(400);
    expect(rt.groups["queue4_group2"]?.dropPkts ?? 0).toBe(0); // the ARP group is not affected
    S().execCommand(id("H1"), "ip neigh flush all");
    expect(received("H1", "192.168.2.10")).toBe(2); // ARP for the gateway is trapped in its own group
    S().startTraffic({ srcDeviceId: id("H1"), dstIp: "192.168.2.10", protocol: "udp", srcPort: 40000, dstPort: 5001, size: 64, count: 300, intervalMs: 0, continuous: false });
    vi.advanceTimersByTime(200);
    expect(peekTrafficSink(byName("H2"))?.udp.packets).toBe(300);
  });
});

// ---------------------------------------------------------------------------
describe("Mirroring real routed traffic (ospf lab)", () => {
  beforeEach(() => {
    S().loadFeatureLab("ospf");
    advance(45_000);
  });

  it("SPAN: an analyzer on S1 Ethernet3 receives copies of H1's routed ping in both directions", () => {
    addHost("ANALYZER", "pc", "S1", 3);
    klish("S1", ["mirror-session SPAN1", "destination Ethernet3 source Ethernet2 direction both"]);
    expect(sh("S1", "show mirror-session")).toMatch(/SPAN1\s+active/);
    const since = S().captures.length;
    expect(received("H1", "192.168.3.10")).toBe(2);
    const copies = rxAt("ANALYZER", since, (c) => !!c.frame.icmp).map((c) => c.frame.icmp!.type);
    expect(copies.filter((t) => t === "echo-request")).toHaveLength(2);
    expect(copies.filter((t) => t === "echo-reply")).toHaveLength(2);
  });

  it("ERSPAN reaches a collector over the routed path and follows an OSPF reroute", () => {
    klish("S1", ["mirror-session ER1", "destination erspan dst-ip 192.168.3.10 src-ip 192.168.1.1 dscp 8 ttl 64 gre 0x88be source Ethernet2 direction rx"]);
    expect(sh("S1", "show mirror-session ER1")).toMatch(/ER1\s+active/);
    const gre = (since: number) => rxAt("H3", since, (c) => c.frame.ipv4?.protocolNumber === 47);
    const greTxPort = (since: number) => S().captures.slice(since).filter((c) => c.deviceId === id("S1") && c.dir === "tx" && c.frame.ipv4?.protocolNumber === 47).map((c) => ifName("S1", c.interfaceId));
    let since = S().captures.length;
    expect(received("H1", "192.168.3.10")).toBe(2);
    expect(gre(since).length).toBeGreaterThanOrEqual(2);
    expect(new Set(greTxPort(since))).toEqual(new Set(["Ethernet1"]));

    klish("S1", ["interface Ethernet 1", "shutdown"]);
    advance(5000);
    since = S().captures.length;
    expect(received("H1", "192.168.3.10")).toBe(2);
    expect(gre(since).length).toBeGreaterThanOrEqual(2);
    expect(new Set(greTxPort(since))).toEqual(new Set(["Ethernet0"])); // via S2 now
  });
});

// ---------------------------------------------------------------------------
describe("Multicast with ACLs and unicast changes (multicast lab)", () => {
  const G = "239.1.1.1";
  const streamAt = (dev: string, since: number) => rxAt(dev, since, (c) => c.frame.ipv4?.dstIp === G && !!c.frame.udp).length;
  beforeEach(() => {
    S().loadFeatureLab("multicast");
    advance(2000);
    out(S().execCommand(id("H3"), `mcast join ${G}`));
  });

  it("IGMP join → PIM → the stream reaches only the joined receiver", () => {
    const since = S().captures.length;
    out(S().execCommand(id("H1"), `mcast send ${G} -c 4 -t 16`));
    expect(streamAt("H3", since)).toBeGreaterThanOrEqual(4);
    expect(streamAt("H4", since)).toBe(0);
    expect(streamAt("H5", since)).toBe(0);
  });

  it("an ingress ACL on the first-hop router blocks the group's stream and counts it", () => {
    klish("S1", ["ip access-list NO-MC", `seq 10 deny udp any host ${G}`, "seq 20 permit ip any any", "exit", "interface Ethernet 2", "ip access-group NO-MC in"]);
    const since = S().captures.length;
    out(S().execCommand(id("H1"), `mcast send ${G} -c 3 -t 16`));
    expect(streamAt("H3", since)).toBe(0);
    expect(aclHits("S1", "NO-MC|RULE_10")).toBe(3);
  });

  it("losing the RPF link moves the tree to the backup unicast path and the stream keeps flowing", () => {
    klish("S3", ["ip route 192.168.1.0/24 10.0.23.1 200"]);
    out(S().execCommand(id("H1"), `mcast send ${G} -c 3 -t 16`));
    klish("S3", ["interface Ethernet 0", "shutdown"]);
    advance(65_000);
    const since = S().captures.length;
    out(S().execCommand(id("H1"), `mcast send ${G} -c 3 -t 16`));
    expect(streamAt("H3", since)).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
describe("QoS on the real forwarding path", () => {
  const queues = (dev: string, port: string) => peekFeatureState<QueueCounters>(byName(dev), "qos-queues")?.[port] ?? [];

  it("DSCP → TC → queue on the egress port shows in the queue counters (qos lab)", () => {
    S().loadFeatureLab("qos");
    out(S().execCommand(id("H3"), "iperf3 -s"));
    out(S().execCommand(id("H1"), "iperf3 -c 192.168.3.10 -u -b 10M -S 184 -t 1"));
    advance(1500);
    expect(queues("S1", "Ethernet2")[5]?.pkts ?? 0).toBeGreaterThan(0);
    expect(queues("S1", "Ethernet2")[0]?.pkts ?? 0).toBe(0);
  });

  it("classification on a VTEP's access port selects the queue of the VXLAN uplink (vxlan lab)", () => {
    S().loadFeatureLab("vxlan");
    advance(3000);
    expect(received("H1", "172.16.100.12", 1)).toBe(1);
    bash("LEAF1", "config qos map dscp-tc add OV 46 5");
    bash("LEAF1", "config qos interface bind Ethernet2 dscp-tc OV");
    out(S().execCommand(id("H2"), "iperf3 -s"));
    const r = out(S().execCommand(id("H1"), "iperf3 -c 172.16.100.12 -u -b 10M -S 184 -t 1"));
    expect(r).toMatch(/receiver/);
    advance(1500);
    expect(queues("LEAF1", "Ethernet0")[5]?.pkts ?? 0).toBeGreaterThan(0);
  });

  it("an ACL denying the flow stops it: no throughput and no queue counts (acl lab)", () => {
    S().loadFeatureLab("acl");
    klish("S1", ["ip access-list NO-IPERF", "seq 10 deny tcp any any eq 5201", "seq 20 permit ip any any", "exit", "interface Ethernet 2", "ip access-group NO-IPERF in"]);
    out(S().execCommand(id("H3"), "iperf3 -s"));
    const r = out(S().execCommand(id("H1"), "iperf3 -c 192.168.3.10 -t 2"));
    advance(2500);
    expect(r).toContain("Connection timed out");
    expect(queues("S1", "Ethernet1")[0]?.pkts ?? 0).toBe(0);
    klish("S1", ["interface Ethernet 2", "no ip access-group NO-IPERF in"]);
    expect(out(S().execCommand(id("H1"), "iperf3 -c 192.168.3.10 -t 1"))).toMatch(/9\d\d Mbits\/sec\s+receiver/);
  });
});

// ---------------------------------------------------------------------------
describe("sFlow samples forwarded traffic (acl lab, collector on the management network)", () => {
  it("1-in-256 samples of a routed H1 → H3 flow reach the NMS collector, decoded", () => {
    S().loadFeatureLab("acl");
    S().setCollector(id("NMS"), true, 6343);
    klish("S1", ["sflow enable", "sflow collector 192.168.100.250 6343", "interface Ethernet 2", "sflow sampling-rate 256", "exit"]);
    S().startTraffic({ srcDeviceId: id("H1"), dstIp: "192.168.3.10", protocol: "udp", srcPort: 40000, dstPort: 5001, size: 100, count: 3000, intervalMs: 0, continuous: false });
    for (let s = 0; s < 6; s++) {
      vi.advanceTimersByTime(1000);
      S().sflowTick();
    }
    expect(peekTrafficSink(byName("H3"))?.udp.packets).toBe(3000);
    const flows = peekCollector(byName("NMS"))!.recent.flatMap((d) => decodeDatagram(d.bytes).samples).filter((x) => x.kind === "flow");
    expect(flows.length).toBeGreaterThan(0);
    const f = flows[0];
    if (f.kind !== "flow") throw new Error("unreachable");
    expect(f.samplingRate).toBe(256);
    expect(decodeEthernetHeader(f.header!.bytes)).toMatchObject({ srcIp: "192.168.1.10", dstIp: "192.168.3.10", dstPort: 5001 });
  });
});

// ---------------------------------------------------------------------------
describe("More overlay / service interactions", () => {
  it("DHCP relay on a default-VRF SVI: the PC leases from a server behind a routed port; the DHCP trap is counted by CoPP", () => {
    S().loadFeatureLab("copp");
    klish("S1", ["vlan 10", "interface Vlan 10", "ip address 10.10.0.1/24", "ip dhcp-relay 192.168.5.10", "exit", "interface Ethernet 3", "switchport access Vlan 10", "exit", "interface Ethernet 2", "ip address 192.168.5.1/24"]);
    const srv = addHost("SRV", "dhcp-server", "S1", 2, "192.168.5.10", 24, "192.168.5.1");
    S().network.devices[srv].config.features = {
      dhcpServer: { gateway: "192.168.5.1", dns: "192.168.5.10", prefix: 24, leases: {}, pools: [{ subnet: "10.10.0.0", prefix: 24, gateway: "10.10.0.1", dns: "192.168.5.10", leases: {} }] },
    };
    addHost("PC", "pc", "S1", 3);
    expect(out(S().execCommand(id("PC"), "dhclient"))).toMatch(/bound to 10\.10\.0\.1\d\d\/24 -- gateway 10\.10\.0\.1/);
    expect(peekCoppRuntime(byName("S1"))!.traps["dhcp"]?.pkts ?? 0).toBeGreaterThanOrEqual(2); // DISCOVER + REQUEST
    expect(received("PC", "192.168.2.10")).toBe(2); // the leased address routes
  });

  it("L2 multicast in a stretched VLAN is head-end replicated to the remote VTEP (vxlan lab)", () => {
    S().loadFeatureLab("vxlan");
    advance(3000);
    const since = S().captures.length;
    out(S().execCommand(id("H1"), "mcast send 239.2.2.2 -c 2"));
    expect(rxAt("H2", since, (c) => c.frame.ipv4?.dstIp === "239.2.2.2").length).toBe(2);
  });

  it("SPAN on a VTEP uplink copies the encapsulated VXLAN packets (vxlan lab)", () => {
    S().loadFeatureLab("vxlan");
    advance(3000);
    addHost("ANALYZER", "pc", "LEAF1", 1);
    klish("LEAF1", ["mirror-session SPAN1", "destination Ethernet1 source Ethernet0 direction tx"]);
    const since = S().captures.length;
    expect(received("H1", "172.16.100.12")).toBe(2);
    const copies = rxAt("ANALYZER", since, (c) => c.frame.udp?.dstPort === 4789);
    expect(copies.filter((c) => inner(c).icmp?.type === "echo-request")).toHaveLength(2);
  });

  it("sFlow on a VTEP access port samples the tenant flow before encapsulation (vxlan lab)", () => {
    S().loadFeatureLab("vxlan");
    advance(3000);
    const col = addHost("COL", "server", "LEAF1", 1, "10.9.9.10", 24, "10.9.9.1");
    S().setInterfaceIp(id("LEAF1"), `${id("LEAF1")}-if1`, "10.9.9.1", 24);
    S().setCollector(col, true, 6343);
    klish("LEAF1", ["sflow enable", "sflow agent-id Loopback 0", "sflow collector 10.9.9.10 6343", "interface Ethernet 2", "sflow sampling-rate 256", "exit"]);
    S().startTraffic({ srcDeviceId: id("H1"), dstIp: "172.16.100.12", protocol: "udp", srcPort: 40000, dstPort: 5001, size: 100, count: 3000, intervalMs: 0, continuous: false });
    for (let s = 0; s < 6; s++) {
      vi.advanceTimersByTime(1000);
      S().sflowTick();
    }
    expect(peekTrafficSink(byName("H2"))?.udp.packets).toBe(3000);
    const flows = peekCollector(byName("COL"))!.recent.flatMap((d) => decodeDatagram(d.bytes).samples).filter((x) => x.kind === "flow");
    expect(flows.length).toBeGreaterThan(0);
    const f = flows[0];
    if (f.kind !== "flow") throw new Error("unreachable");
    expect(decodeEthernetHeader(f.header!.bytes)).toMatchObject({ srcIp: "172.16.100.11", dstIp: "172.16.100.12", dstPort: 5001 });
  });
});
