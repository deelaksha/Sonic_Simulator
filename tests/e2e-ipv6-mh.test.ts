/**
 * End-to-end IPv6, EVPN multihoming and static anycast gateway: each scenario
 * configures in KLISH and/or Click, lets the daemons converge on fake time,
 * sends real host traffic, and checks both CLIs plus CONFIG_DB / APPL_DB.
 *
 *   ipvx lab      static IPv6 routes (KLISH `ipv6 route` + Click `config route`),
 *                 the ND cache and link down, SLAAC after `ip link set down`,
 *                 IPv6 in a VRF, IPv6 ACLs
 *   evpn-irb lab  IPv6 SAG on two leaves (ND answered locally with the anycast MAC),
 *                 EVPN-MH with an ES on LEAF1/LEAF3: losing the CE's link to one leaf,
 *                 and losing a leaf's fabric uplink with `downstream all-evpn-es`
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { linkLocalFromMac, slaacAddress } from "../lib/models/ipv6";
import { aliasVteps, isDf, localEss } from "../lib/protocols/evpn-mh";

const id = (n: string) => byName(n).id;
/** Run at the bash prompt (switches boot into KLISH: `exit` drops to bash). */
function bash(n: string, cmd: string): string {
  if (byName(n).type === "switch" && (S().cliMode[id(n)] ?? ["exec"]).length) S().execCommand(id(n), "exit");
  return out(S().execCommand(id(n), cmd));
}
/** Run in KLISH exec mode. */
function klish(n: string, cmd: string): string {
  if (byName(n).type === "switch" && !(S().cliMode[id(n)] ?? ["exec"]).length) S().execCommand(id(n), "sonic-cli");
  return out(S().execCommand(id(n), cmd));
}
/** KLISH configuration lines, each line's output joined. */
function cfg(n: string, ...lines: string[]): string {
  klish(n, "end");
  return ["configure terminal", ...lines, "end"].map((l) => out(S().execCommand(id(n), l))).join("\n");
}
const host = (n: string, cmd: string) => out(S().execCommand(id(n), cmd));
const iface = (n: string, name: string) => byName(n).interfaces.find((i) => i.name === name)!;
/** `sonic-db-cli <DB> HGETALL <key>` → object (the CLI prints a Python dict). */
function hgetall(n: string, db: string, key: string): Record<string, string> {
  const txt = bash(n, `sonic-db-cli ${db} HGETALL '${key}'`);
  return Object.fromEntries([...txt.matchAll(/'([^']*)': '([^']*)'/g)].map((m) => [m[1], m[2]]));
}
const keys = (n: string, db: string, pat: string) => bash(n, `sonic-db-cli ${db} KEYS '${pat}'`).split("\n").filter((l) => l && l !== "(empty array)");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
describe("IPv6 on the dual-stack triangle (ipvx lab)", () => {
  const h1 = () => slaacAddress("2001:db8:1::", iface("H1", "eth0").mac);
  const h3 = () => slaacAddress("2001:db8:3::", iface("H3", "eth0").mac);
  beforeEach(() => {
    S().loadFeatureLab("ipvx");
    advance(12_000);
  });

  it("static IPv6 route: KLISH `ipv6 route` installs S>*, reaches CONFIG_DB/APPL_DB/running-config and carries H1's ping6; Click del withdraws it", () => {
    // S2 owns 2001:db8:99::1 on a loopback that OSPFv3 does not advertise.
    cfg("S2", "interface Loopback 0", "ipv6 address 2001:db8:99::1/128");
    advance(500);
    expect(host("H1", "ping6 -c 1 2001:db8:99::1")).toMatch(/0 received/);
    expect(cfg("S1", "ipv6 route 2001:db8:99::/64 2001:db8:12::2")).not.toMatch(/Unrecognized|Error/);
    advance(500);
    expect(klish("S1", "show ipv6 route")).toMatch(/^S>\* 2001:db8:99::\/64 \[1\/0\] via 2001:db8:12::2, Ethernet0, weight 1, \d\d:\d\d:\d\d$/m);
    expect(bash("S1", "show ipv6 route static")).toMatch(/^S>\* 2001:db8:99::\/64 \[1\/0\] via 2001:db8:12::2, Ethernet0/m);
    expect(hgetall("S1", "CONFIG_DB", "STATIC_ROUTE|2001:db8:99::/64")).toMatchObject({ nexthop: "2001:db8:12::2", ifname: "Ethernet0" });
    expect(hgetall("S1", "APPL_DB", "ROUTE_TABLE:2001:db8:99::/64")).toMatchObject({ nexthop: "2001:db8:12::2", ifname: "Ethernet0" });
    expect(klish("S1", "show running-configuration")).toContain("ipv6 route 2001:db8:99::/64 2001:db8:12::2");
    const ping = host("H1", "ping6 -c 2 2001:db8:99::1");
    expect(ping).toMatch(/2 received/);
    expect(ping).toContain("bytes from 2001:db8:99::1: icmp_seq=1 hlim=63"); // S2 answers; the reply crosses S1 (OSPFv3 route back)
    // Click removes it again (config route del prefix <v6> nexthop <v6>).
    bash("S1", "config route del prefix 2001:db8:99::/64 nexthop 2001:db8:12::2");
    expect(byName("S1").routingTable6.some((r) => r.type === "static")).toBe(false);
    expect(keys("S1", "CONFIG_DB", "STATIC_ROUTE*")).toEqual([]);
    expect(host("H1", "ping6 -c 1 2001:db8:99::1")).toMatch(/0 received/);
  });

  it("Click `config route add` IPv6 (distance 1) beats OSPFv3 (110): traceroute6 H1 → H3 goes via S2; deleting falls back to S1–S3", () => {
    bash("S1", "config route add prefix 2001:db8:3::/64 nexthop 2001:db8:12::2");
    const rib = bash("S1", "show ipv6 route 2001:db8:3::/64");
    expect(rib).toMatch(/^S>\* 2001:db8:3::\/64 \[1\/0\] via 2001:db8:12::2, Ethernet0/m);
    expect(rib).toMatch(/^O {3}2001:db8:3::\/64 \[110\/8\] via fe80::/m);
    let tr = host("H1", `traceroute6 ${h3()}`).split("\n");
    expect(tr[2]).toMatch(/^ 2 {2}2001:db8:12::2 /);
    expect(tr[4]).toMatch(new RegExp(`^ 4  ${h3()} `)); // S1 → S2 → S3 → H3
    bash("S1", "config route del prefix 2001:db8:3::/64 nexthop 2001:db8:12::2");
    tr = host("H1", `traceroute6 ${h3()}`).split("\n");
    expect(tr[2]).toMatch(/^ 2 {2}2001:db8:13::2 /);
    // A next hop that is on no connected IPv6 subnet is refused (not silently installed).
    expect(bash("S1", "config route add prefix 2001:db8:77::/64 nexthop 2001:db8:5555::1")).toMatch(/not on a connected subnet/);
  });

  it("ND cache: ping6 fills show ndp / KLISH show ipv6 neighbors / APPL_DB NEIGH_TABLE; shutting the port flushes all three", () => {
    expect(host("H1", `ping6 -c 1 ${h3()}`)).toMatch(/1 received/);
    const mac = iface("H1", "eth0").mac.toUpperCase();
    const row = new RegExp(`^${h1()}\\s+${mac}\\s+Ethernet2\\s+reachable$`, "m");
    expect(bash("S1", "show ndp")).toMatch(row);
    expect(klish("S1", "show ipv6 neighbors")).toMatch(row);
    expect(keys("S1", "APPL_DB", "NEIGH_TABLE:Ethernet2:*")).toEqual([`NEIGH_TABLE:Ethernet2:${h1()}`]);
    cfg("S1", "interface Ethernet 2", "shutdown");
    advance(500);
    expect(bash("S1", "show ndp")).not.toContain(h1());
    expect(klish("S1", "show ipv6 neighbors")).not.toContain(h1());
    expect(keys("S1", "APPL_DB", "NEIGH_TABLE:Ethernet2:*")).toEqual([]);
    // The connected route goes and OSPFv3 withdraws H1's prefix from S3.
    expect(byName("S3").routingTable6.some((r) => r.destination === "2001:db8:1::")).toBe(false);
    cfg("S1", "interface Ethernet 2", "no shutdown");
    advance(3000);
    expect(host("H1", `ping6 -c 1 ${h3()}`)).toMatch(/1 received/);
    expect(bash("S1", "show ndp")).toMatch(row);
  });

  it("host `ip link set eth0 down` drops its RA default route and SLAAC address; link up → RS → RA → SLAAC again", () => {
    expect(host("H1", "ip -6 route")).toMatch(/^default via fe80::\S+ dev eth0 proto ra /m);
    host("H1", "ip link set eth0 down");
    advance(500);
    expect(host("H1", "ip -6 route")).not.toMatch(/^default/m);
    expect(host("H1", "ip -6 addr")).not.toContain(h1());
    expect(host("H1", `ping6 -c 1 ${h3()}`)).toMatch(/0 received/);
    host("H1", "ip link set eth0 up");
    advance(3000); // RTR_SOLICITATION_DELAY, then the RA answering the RS
    expect(host("H1", "ip -6 route")).toMatch(new RegExp(`^default via ${linkLocalFromMac(iface("S1", "Ethernet2").mac)} dev eth0 proto ra `, "m"));
    expect(host("H1", "ip -6 addr")).toContain(`inet6 ${h1()}/64 scope global dynamic`);
    expect(host("H1", `ping6 -c 1 ${h3()}`)).toMatch(/1 received/);
  });

  it("IPv6 in a VRF: S1's host port moves to Vrf-red with its connected route; OSPFv3 withdraws it; ping6 works only inside the VRF", () => {
    cfg("S1", "ip vrf Vrf-red", "interface Ethernet 2", "ip vrf forwarding Vrf-red");
    advance(2000);
    const vrfRib = klish("S1", "show ipv6 route vrf Vrf-red");
    expect(vrfRib).toContain("IPv6 unicast VRF Vrf-red:");
    expect(vrfRib).toMatch(/^C>\* 2001:db8:1::\/64 is directly connected, Ethernet2, /m);
    expect(vrfRib).toMatch(/^L>\* 2001:db8:1::1\/128 is directly connected, Ethernet2, /m);
    expect(vrfRib).toMatch(/^C>\* fe80::\/64 is directly connected, Ethernet2, /m);
    const def = bash("S1", "show ipv6 route");
    expect(def).not.toContain("2001:db8:1::/64");
    expect(def).not.toMatch(/fe80::\/64 is directly connected, Ethernet2/);
    expect(bash("S1", "show ipv6 interfaces")).toMatch(/^Ethernet2\s+Vrf-red\s+2001:db8:1::1\/64\s+up\/up/m);
    // ospf6d (default VRF) stops advertising it: S3 loses the route.
    expect(byName("S3").routingTable6.some((r) => r.destination === "2001:db8:1::")).toBe(false);
    // H1 still reaches its gateway (the reply is routed in Vrf-red) but not H3.
    expect(host("H1", "ping6 -c 1 2001:db8:1::1")).toMatch(/1 received/);
    expect(host("H1", `ping6 -c 1 ${h3()}`)).toMatch(/0 received/);
    // From the switch: only a VRF-bound ping6 finds H1.
    expect(bash("S1", `ping6 -c 1 ${h1()}`)).toMatch(/0 received/);
    expect(bash("S1", `ping6 -c 1 -I Vrf-red ${h1()}`)).toMatch(/1 received/);
    expect(klish("S1", `ping6 vrf Vrf-red -c 1 ${h1()}`)).toMatch(/1 received/);
    expect(bash("S1", "ping6 -c 1 -I Vrf-blue 2001:db8:1::1")).toMatch(/unknown VRF/);
    // Unbinding brings the route back to the default VRF and OSPFv3.
    cfg("S1", "interface Ethernet 2", "no ip vrf forwarding Vrf-red");
    advance(2000);
    expect(host("H1", `ping6 -c 1 ${h3()}`)).toMatch(/1 received/);
  });

  it("IPv6 ACL: `ipv6 access-list` denying ICMPv6 on S1's host port drops ping6 (counted) while IPv4 still passes; CONFIG_DB L3V6", () => {
    cfg("S1", "ipv6 access-list V6DENY", "seq 10 deny icmpv6 any any", "seq 20 permit ipv6 any any", "exit", "interface Ethernet 2", "ipv6 access-group V6DENY in");
    expect(host("H1", `ping6 -c 2 ${h3()}`)).toMatch(/0 received/);
    expect(host("H1", "ping -c 1 192.168.3.10")).toMatch(/1 received/);
    expect(klish("S1", "show ipv6 access-lists V6DENY")).toMatch(/seq 10 deny icmpv6 any any \(2 packets\)/);
    expect(hgetall("S1", "CONFIG_DB", "ACL_TABLE|V6DENY")).toMatchObject({ type: "L3V6", stage: "INGRESS" });
    expect(hgetall("S1", "CONFIG_DB", "ACL_RULE|V6DENY|RULE_10")).toMatchObject({ PACKET_ACTION: "DROP" });
    cfg("S1", "interface Ethernet 2", "no ipv6 access-group V6DENY in");
    expect(host("H1", `ping6 -c 1 ${h3()}`)).toMatch(/1 received/);
  });

  it("KLISH running-config lists configured IPv6 addresses only (the kernel link-local is not configuration)", () => {
    const rc = klish("S1", "show running-configuration interface Ethernet 2");
    expect(rc).toContain(" ipv6 address 2001:db8:1::1/64");
    expect(rc).not.toContain("fe80::");
  });
});

// ---------------------------------------------------------------------------
describe("IPv6 static anycast gateway on two leaves (evpn-irb lab: Vlan10 on LEAF1 and LEAF3, Vrf-red)", () => {
  const SAG_MAC = "00:00:5E:00:01:01"; // the lab's `ip anycast-mac-address`
  beforeEach(() => {
    S().loadFeatureLab("evpn-irb");
    advance(6000);
    for (const [leaf, own] of [["LEAF1", "2001:db8:10::2/64"], ["LEAF3", "2001:db8:10::3/64"]]) {
      cfg(leaf, "interface Vlan 10", `ipv6 address ${own}`, "ipv6 anycast-address 2001:db8:10::1/64", "ipv6 nd suppress-ra");
    }
    for (const [h, a] of [["H1", "2001:db8:10::11/64"], ["H3", "2001:db8:10::13/64"]]) {
      host(h, `ip -6 addr add ${a} dev eth0`);
      host(h, "ip -6 route add default via 2001:db8:10::1");
    }
    advance(1000);
  });

  it("each leaf answers its own hosts' Neighbor Solicitation for the gateway with the anycast MAC; the NS never enters the fabric", () => {
    expect(host("H1", "ip -6 route")).toContain("default via 2001:db8:10::1 dev eth0 metric 1024 pref medium");
    const since = S().captures.length;
    expect(host("H1", "ping6 -c 2 2001:db8:10::1")).toMatch(/2 received/);
    expect(host("H3", "ping6 -c 1 2001:db8:10::1")).toMatch(/1 received/);
    for (const h of ["H1", "H3"]) expect(byName(h).ndpTable.find((e) => e.ip === "2001:db8:10::1")?.mac).toBe(SAG_MAC);
    const ns = S().captures.slice(since).filter((c) => c.frame.icmp6?.type === "neighbor-solicitation" && c.frame.icmp6.targetAddr === "2001:db8:10::1");
    expect(ns.length).toBeGreaterThan(0);
    expect(ns.every((c) => ["H1", "H3", "LEAF1", "LEAF3"].includes(S().network.devices[c.deviceId].name))).toBe(true); // not at SPINE / LEAF2
    const na = S().captures.slice(since).filter((c) => c.dir === "tx" && c.frame.icmp6?.type === "neighbor-advertisement" && c.frame.icmp6.targetAddr === "2001:db8:10::1");
    expect(na.map((c) => S().network.devices[c.deviceId].name).sort()).toEqual(["LEAF1", "LEAF3"]);
    expect(na.every((c) => c.frame.ethernet.srcMac === SAG_MAC && c.frame.icmp6!.linkLayerAddr === SAG_MAC)).toBe(true);
    // Both CLIs / the VRF RIB agree: the leaf learnt H1, the SVI subnet sits in Vrf-red.
    expect(klish("LEAF1", "show ipv6 static-anycast-gateway")).toMatch(/^Vlan10\s+2001:db8:10::1\/64/m);
    expect(bash("LEAF1", "show ndp")).toMatch(/^2001:db8:10::11\s+\S+\s+Vlan10\s+reachable$/m);
    expect(klish("LEAF1", "show ipv6 route vrf Vrf-red")).toMatch(/^C>\* 2001:db8:10::\/64 is directly connected, Vlan10, /m);
    // Same VLAN across the VXLAN fabric: H1 ↔ H3 bridged over VNI 10010.
    expect(host("H1", "ping6 -c 1 2001:db8:10::13")).toMatch(/1 received/);
  });

  it("host mobility: H3 moves from LEAF3 to LEAF1 and keeps its gateway ND entry (same IP, same MAC)", () => {
    expect(host("H3", "ping6 -c 1 2001:db8:10::1")).toMatch(/1 received/);
    const h3 = byName("H3");
    const c = S().network.connections.find((x) => x.a.deviceId === h3.id || x.b.deviceId === h3.id)!;
    S().disconnect(c.id);
    const l1 = id("LEAF1");
    S().runCliScript(l1, ["configure terminal", "interface Ethernet 3", "switchport access Vlan 10", "end"], { silent: true });
    S().connect(h3.id, `${h3.id}-if0`, l1, `${l1}-if3`);
    advance(1000);
    expect(host("H3", "ping6 -c 2 2001:db8:10::1")).toMatch(/2 received/);
    expect(byName("H3").ndpTable.find((e) => e.ip === "2001:db8:10::1")?.mac).toBe(SAG_MAC);
  });

  it("`ipv6 anycast-address disable` turns the IPv6 gateway off (IPv4 SAG untouched)", () => {
    cfg("LEAF1", "ipv6 anycast-address disable");
    byName("H1").ndpTable = [];
    expect(host("H1", "ping6 -c 1 2001:db8:10::1")).toMatch(/0 received/);
    expect(klish("LEAF1", "show ipv6 static-anycast-gateway")).toContain("IPv6 Anycast Gateway MAC address: disable");
    expect(host("H1", "ping -c 1 10.1.0.1")).toMatch(/1 received/);
  });
});

// ---------------------------------------------------------------------------
describe("EVPN multihoming failures (evpn-irb lab + CE dual-homed to LEAF1/LEAF3 on ESI ...:01)", () => {
  const ESI = "00:11:22:33:44:55:00:00:00:01";
  const ping = (from: string, to: string, n = 1) => host(from, `ping -c ${n} ${to}`);
  const es = (leaf: string) => localEss(byName(leaf))[0];
  /** CE (LACP PortChannel1 over Ethernet0→LEAF1, Ethernet1→LEAF3), H5 behind CE, H6 single-homed on LEAF2 (as evpn-mh.test.ts). */
  function setup(): void {
    const ce = S().addDevice("switch", { x: 420, y: 600 }, 4);
    S().renameDevice(ce, "CE");
    const h5 = S().addDevice("pc", { x: 420, y: 720 });
    S().renameDevice(h5, "H5");
    const h6 = S().addDevice("pc", { x: 520, y: 600 });
    S().renameDevice(h6, "H6");
    const [l1, l2, l3] = ["LEAF1", "LEAF2", "LEAF3"].map(id);
    S().connect(ce, `${ce}-if0`, l1, `${l1}-if1`);
    S().connect(ce, `${ce}-if1`, l3, `${l3}-if1`);
    S().connect(h5, `${h5}-if0`, ce, `${ce}-if2`);
    S().connect(h6, `${h6}-if0`, l2, `${l2}-if3`);
    S().setInterfaceIp(h5, `${h5}-if0`, "10.1.0.15", 24);
    S().setDefaultGateway(h5, "10.1.0.1");
    S().setInterfaceIp(h6, `${h6}-if0`, "10.1.0.16", 24);
    S().runCliScript(ce, ["configure terminal", "vlan 10", "interface PortChannel 1", "fast_rate", "switchport access Vlan 10", "exit", "interface Ethernet 0", "channel-group 1", "exit", "interface Ethernet 1", "channel-group 1", "exit", "interface Ethernet 2", "switchport access Vlan 10", "end"]);
    for (const l of [l1, l3]) S().runCliScript(l, ["configure terminal", "interface PortChannel 1", "fast_rate", "switchport access Vlan 10", `evpn ethernet-segment ${ESI}`, "exit", "exit", "interface Ethernet 1", "channel-group 1", "end"]);
    const pc = (n: string) => byName(n).interfaces.find((i) => i.name === "PortChannel1")!;
    pc("LEAF3").mac = pc("LEAF1").mac; // one LACP system towards the CE
    S().runCliScript(l2, ["configure terminal", "vlan 10", "interface Ethernet 3", "switchport access Vlan 10", "end"]);
    bash("LEAF2", "config vxlan map add vtep1 10 10010");
  }
  beforeEach(() => {
    S().loadFeatureLab("evpn-irb");
    setup();
    advance(6000);
    expect(isDf(byName("LEAF1"), es("LEAF1"))).toBe(true);
  });

  it("the CE's link to LEAF1 fails: LEAF1's ES goes down and withdraws, LEAF3 becomes DF and the only alias; bridged and routed traffic continue", () => {
    const ce = byName("CE");
    const c = S().network.connections.find((x) => [x.a.deviceId, x.b.deviceId].includes(ce.id) && [x.a.deviceId, x.b.deviceId].includes(id("LEAF1")))!;
    S().disconnect(c.id);
    advance(3000);
    expect(es("LEAF1").up).toBe(false);
    expect(isDf(byName("LEAF1"), es("LEAF1"))).toBe(false);
    expect(isDf(byName("LEAF3"), es("LEAF3"))).toBe(true);
    expect(aliasVteps(byName("LEAF2"), ESI)).toEqual(["10.0.0.3"]);
    expect(klish("LEAF3", "show evpn es")).toMatch(new RegExp(`^${ESI}\\s+L\\s+PortChannel1\\s*$`, "m")); // no remote VTEP left
    expect(klish("LEAF2", "show bgp l2vpn evpn")).not.toContain(`[4]:[${ESI}]:[32]:[10.0.0.1]`);
    host("H6", "ip neigh flush all");
    expect(ping("H6", "10.1.0.15", 3)).toMatch(/3 received/);
    expect(ping("H5", "10.2.0.22", 2)).toMatch(/2 received/); // routed via the anycast gateway on LEAF3
  });

  it("LEAF1 loses its only fabric uplink: `link state track` with `downstream all-evpn-es` takes its ES PortChannel down so the CE fails over to LEAF3; recovery after the timeout", () => {
    cfg("LEAF1", "link state track UPL", "downstream all-evpn-es", "timeout 10", "exit", "interface Ethernet 0", "link state track UPL upstream");
    cfg("LEAF1", "interface Ethernet 0", "shutdown");
    advance(3000);
    const po = (n: string) => byName(n).interfaces.find((i) => i.name === "PortChannel1")!;
    expect(po("LEAF1").operState).toBe("down");
    expect(iface("CE", "Ethernet0").operState).toBe("down"); // the CE's member to LEAF1 lost carrier: LACP uses LEAF3 only
    expect(isDf(byName("LEAF3"), es("LEAF3"))).toBe(true);
    expect(aliasVteps(byName("LEAF2"), ESI)).toEqual(["10.0.0.3"]);
    expect(bash("LEAF1", "show logging")).toMatch(/lstmgrd.*Link state tracking group UPL: all upstream interfaces down, bringing down PortChannel1 /);
    host("H6", "ip neigh flush all");
    expect(ping("H6", "10.1.0.15", 4)).toMatch(/4 received/);
    expect(ping("H5", "10.2.0.22", 2)).toMatch(/2 received/);
    // Uplink back: the ES comes up after the 10 s recovery timeout and LEAF1 rejoins (DF again).
    cfg("LEAF1", "interface Ethernet 0", "no shutdown");
    advance(5000);
    expect(po("LEAF1").operState).toBe("down");
    advance(30_000);
    expect(po("LEAF1").operState).toBe("up");
    expect(aliasVteps(byName("LEAF2"), ESI)).toEqual(["10.0.0.1", "10.0.0.3"]);
    expect(isDf(byName("LEAF1"), es("LEAF1"))).toBe(true);
    expect(ping("H6", "10.1.0.15", 2)).toMatch(/2 received/);
  });
});
