/**
 * Layer-3 integration: routing protocols doing their job in live scenarios and
 * working with each other (redistribution, administrative distance, BFD clients,
 * ECMP, VRF, VRRP tracking, IP SLA, PBR, interface/SVI state).
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs";
import { routedTriangle } from "../lib/labs/topologies";
import { ospfRuntime } from "../lib/protocols/ospf-daemon";
import { routeDistance } from "../lib/models/route";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

const id = (n: string) => byName(n).id;
const cli = (n: string, lines: string[]) => S().runCliScript(id(n), ["configure terminal", ...lines, "end"], { silent: true });
const bash = (n: string, cmd: string) => {
  if ((S().cliMode[id(n)] ?? ["exec"]).length) S().execCommand(id(n), "exit");
  return out(S().execCommand(id(n), cmd));
};
const sh = (n: string, cmd: string) => out(S().execCommand(id(n), cmd));
const ping = (from: string, dst: string, n = 1) => sh(from, `ping -c ${n} ${dst}`);
const routes = (n: string, dest: string, prefix?: number, vrf = "default") =>
  byName(n).routingTable.filter((r) => r.destination === dest && (prefix === undefined || r.prefix === prefix) && (r.vrf ?? "default") === vrf);
const best = (n: string, dest: string, prefix: number, vrf = "default") => {
  const rs = routes(n, dest, prefix, vrf);
  const key = (r: (typeof rs)[number]) => routeDistance(r) * 1e9 + r.metric;
  const min = Math.min(...rs.map(key));
  return rs.filter((r) => key(r) === min);
};
const ospfNbrs = (n: string, vrf?: string) => (ospfRuntime(byName(n), vrf)?.oifs ?? []).flatMap((o) => o.nbrs);
const conn = (a: string, aIf: string, b: string, bIf: string) =>
  S().network.connections.find(
    (c) =>
      (c.a.interfaceId === `${id(a)}-${aIf}` && c.b.interfaceId === `${id(b)}-${bIf}`) ||
      (c.b.interfaceId === `${id(a)}-${aIf}` && c.a.interfaceId === `${id(b)}-${bIf}`),
  )!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
describe("OSPF on the routed triangle", () => {
  beforeEach(() => {
    S().loadFeatureLab("ospf");
    advance(12_000);
  });

  it("ospf: learns the remote LAN and H1 pings H3 across it", () => {
    expect(best("S1", "192.168.3.0", 24)[0]).toMatchObject({ type: "ospf", nextHop: "10.0.13.2" });
    expect(ping("H1", "192.168.3.10", 2)).toMatch(/2 received/);
  });

  it("redistribute static/connected into OSPF: S1 gets O E2 routes and traffic follows them", () => {
    cli("S3", ["interface Loopback 0", "ip address 10.255.0.3/32", "exit", "ip route 172.16.0.0/24 192.168.3.10", "router ospf", "redistribute connected", "redistribute static", "exit"]);
    advance(2_000);
    const lo = best("S1", "10.255.0.3", 32);
    expect(lo).toHaveLength(1);
    expect(lo[0]).toMatchObject({ type: "ospf", nextHop: "10.0.13.2" });
    expect(best("S1", "172.16.0.0", 24)[0]).toMatchObject({ type: "ospf", nextHop: "10.0.13.2" });
    expect(bash("S1", "show ip route")).toMatch(/O>\* 172\.16\.0\.0\/24 \[110\/20\] via 10\.0\.13\.2/);
    expect(ping("H1", "10.255.0.3")).toMatch(/1 received/);
    // Withdrawn when the static goes away.
    cli("S3", ["no ip route 172.16.0.0/24 192.168.3.10"]);
    advance(2_000);
    expect(routes("S1", "172.16.0.0", 24)).toHaveLength(0);
  });

  it("administrative distance: static (1) beats OSPF (110); a floating static (200) loses; removing the static restores OSPF", () => {
    cli("S1", ["ip route 192.168.3.0/24 10.0.12.2"]);
    advance(500);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ type: "static", nextHop: "10.0.12.2" }]);
    expect(sh("H1", "traceroute -n 192.168.3.10")).toMatch(/ 2 +10\.0\.12\.2 /); // S1 → S2 → S3
    cli("S1", ["no ip route 192.168.3.0/24 10.0.12.2", "ip route 192.168.3.0/24 10.0.12.2 200"]);
    advance(500);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ type: "ospf", nextHop: "10.0.13.2" }]);
    expect(sh("H1", "traceroute -n 192.168.3.10")).toMatch(/ 2 +10\.0\.13\.2 /);
    expect(bash("S1", "show ip route")).toMatch(/S +192\.168\.3\.0\/24 \[200\/0\] via 10\.0\.12\.2/);
  });

  it("interface shutdown removes the connected route and the OSPF neighbour on it; no shutdown restores", () => {
    cli("S1", ["interface Ethernet 1", "shutdown", "exit"]);
    advance(300);
    expect(routes("S1", "10.0.13.0", 30).filter((r) => r.type === "connected")).toHaveLength(0);
    expect(ospfNbrs("S1").map((n) => n.rid)).toEqual(["2.2.2.2"]);
    expect(ospfNbrs("S3").map((n) => n.rid)).toEqual(["2.2.2.2"]);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ type: "ospf", nextHop: "10.0.12.2" }]);
    expect(ping("H1", "192.168.3.10")).toMatch(/1 received/);
    cli("S1", ["interface Ethernet 1", "no shutdown", "exit"]);
    advance(12_000);
    expect(routes("S1", "10.0.13.0", 30).filter((r) => r.type === "connected")).toHaveLength(1);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ type: "ospf", nextHop: "10.0.13.2" }]);
  });

  it("ECMP over two equal OSPF paths spreads flows; losing one path keeps traffic flowing", () => {
    cli("S1", ["interface Ethernet 1", "ip ospf cost 8", "exit"]);
    advance(1_000);
    const nh = best("S1", "192.168.3.0", 24).map((r) => r.nextHop).sort();
    expect(nh).toEqual(["10.0.12.2", "10.0.13.2"]);
    expect(ping("H1", "192.168.3.10", 3)).toMatch(/3 received/);
    S().disconnect(conn("S1", "if1", "S3", "if0").id);
    advance(300);
    expect(best("S1", "192.168.3.0", 24).map((r) => r.nextHop)).toEqual(["10.0.12.2"]);
    expect(ping("H1", "192.168.3.10", 3)).toMatch(/3 received/);
  });
});

// ---------------------------------------------------------------------------
// S1 is the border: OSPF towards S3 (area 0, H3's LAN), eBGP towards S2 (AS65002,
// loopbacks 172.20.0.1/32 and 172.21.0.1/32). The S2–S3 link runs no protocol.
registerLab("l3-ospf-bgp", (api) => {
  const t = routedTriangle(api);
  api.runCliScript(t.s1, [
    "configure terminal",
    "interface Ethernet 1", "ip ospf network point-to-point", "exit",
    "router ospf", "ospf router-id 1.1.1.1", "network 10.0.13.0/30 area 0", "exit",
    "router bgp 65001", "router-id 1.1.1.1", "neighbor 10.0.12.2", "remote-as 65002", "exit", "exit",
    "end",
  ]);
  api.runCliScript(t.s3, [
    "configure terminal",
    "interface Ethernet 0", "ip ospf network point-to-point", "exit",
    "router ospf", "ospf router-id 3.3.3.3", "network 10.0.13.0/30 area 0", "network 192.168.3.0/24 area 0", "passive-interface Ethernet2", "exit",
    "end",
  ]);
  api.runCliScript(t.s2, [
    "configure terminal",
    "interface Loopback 0", "ip address 172.20.0.1/32", "exit",
    "interface Loopback 1", "ip address 172.21.0.1/32", "exit",
    "router bgp 65002", "router-id 2.2.2.2", "neighbor 10.0.12.1", "remote-as 65001", "exit",
    "address-family ipv4 unicast", "network 172.20.0.1/32", "network 172.21.0.1/32", "exit",
    "end",
  ]);
  api.finish("L3 mix: OSPF S1–S3, eBGP S1–S2", t.s1);
});

describe("OSPF ⇄ BGP on a border router", () => {
  beforeEach(() => {
    S().loadFeatureLab("l3-ospf-bgp");
    advance(15_000);
  });

  it("bgp: eBGP learns S2's loopbacks; ospf: S1 learns H3's LAN", () => {
    expect(best("S1", "172.20.0.1", 32)).toMatchObject([{ type: "bgp", nextHop: "10.0.12.2", distance: 20 }]);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ type: "ospf", nextHop: "10.0.13.2" }]);
  });

  it("OSPF → BGP and BGP → OSPF redistribution: H3 reaches S2's loopback end to end", () => {
    cli("S1", ["router bgp 65001", "address-family ipv4 unicast", "redistribute ospf", "exit", "exit", "router ospf", "redistribute bgp", "exit"]);
    advance(5_000);
    expect(best("S2", "192.168.3.0", 24)).toMatchObject([{ type: "bgp", nextHop: "10.0.12.1" }]);
    expect(best("S3", "172.20.0.1", 32)).toMatchObject([{ type: "ospf", nextHop: "10.0.13.1" }]);
    expect(ping("H3", "172.20.0.1", 2)).toMatch(/2 received/);
    // Removing redistribution withdraws both directions.
    cli("S1", ["router bgp 65001", "address-family ipv4 unicast", "no redistribute ospf", "exit", "exit", "router ospf", "no redistribute bgp", "exit"]);
    advance(5_000);
    expect(routes("S2", "192.168.3.0", 24)).toHaveLength(0);
    expect(routes("S3", "172.20.0.1", 32)).toHaveLength(0);
  });

  it("route-map on `redistribute ospf` into BGP denies one prefix (match ip address prefix-list)", () => {
    cli("S3", ["interface Loopback 0", "ip address 10.33.0.1/32", "exit", "router ospf", "network 10.33.0.1/32 area 0", "exit"]);
    cli("S1", [
      "ip prefix-list NO-H3 seq 5 permit 192.168.3.0/24",
      "route-map OSPF2BGP deny 10", "match ip address prefix-list NO-H3", "exit",
      "route-map OSPF2BGP permit 20", "exit",
      "router bgp 65001", "address-family ipv4 unicast", "redistribute ospf route-map OSPF2BGP", "exit", "exit",
    ]);
    advance(5_000);
    expect(best("S1", "10.33.0.1", 32)).toMatchObject([{ type: "ospf" }]);
    expect(best("S2", "10.33.0.1", 32)).toMatchObject([{ type: "bgp", nextHop: "10.0.12.1" }]);
    expect(routes("S2", "192.168.3.0", 24)).toHaveLength(0);
  });

  it("route-map on `redistribute bgp` into OSPF filters a prefix and sets the metric", () => {
    cli("S1", [
      "ip prefix-list LO20 seq 5 permit 172.20.0.1/32",
      "route-map BGP2OSPF permit 10", "match ip address prefix-list LO20", "set metric 50", "exit",
      "router ospf", "redistribute bgp route-map BGP2OSPF", "exit",
    ]);
    advance(5_000);
    expect(best("S3", "172.20.0.1", 32)).toMatchObject([{ type: "ospf", nextHop: "10.0.13.1" }]);
    expect(bash("S3", "show ip route")).toMatch(/O>\* 172\.20\.0\.1\/32 \[110\/50\] via 10\.0\.13\.1/);
    expect(routes("S3", "172.21.0.1", 32)).toHaveLength(0);
    expect(sh("S1", "show running-configuration ospf")).toMatch(/redistribute bgp route-map BGP2OSPF/);
    // Editing the prefix-list re-evaluates redistribution at once.
    cli("S1", ["ip prefix-list LO20 seq 10 permit 172.21.0.1/32"]);
    advance(2_000);
    expect(best("S3", "172.21.0.1", 32)).toMatchObject([{ type: "ospf", metric: 50 }]);
  });

  it("prefix-list on an eBGP neighbour denies one prefix", () => {
    cli("S1", [
      "ip prefix-list FROM-S2 seq 5 deny 172.21.0.1/32",
      "ip prefix-list FROM-S2 seq 10 permit 0.0.0.0/0 le 32",
      "router bgp 65001", "neighbor 10.0.12.2", "address-family ipv4 unicast", "prefix-list FROM-S2 in", "exit", "exit", "exit",
    ]);
    advance(2_000);
    expect(best("S1", "172.20.0.1", 32)).toMatchObject([{ type: "bgp" }]);
    expect(routes("S1", "172.21.0.1", 32)).toHaveLength(0);
  });

  it("administrative distance: eBGP (20) beats OSPF (110) for the same prefix; withdrawing BGP falls back to OSPF", () => {
    // H1's LAN goes into both protocols so the return paths exist.
    cli("S1", ["router ospf", "redistribute connected", "exit", "router bgp 65001", "address-family ipv4 unicast", "network 192.168.1.0/24", "exit", "exit"]);
    cli("S2", ["ip route 192.168.3.0/24 10.0.23.2", "router bgp 65002", "address-family ipv4 unicast", "network 192.168.3.0/24", "exit", "exit"]);
    advance(3_000);
    const rs = routes("S1", "192.168.3.0", 24);
    expect(rs.map((r) => r.type).sort()).toEqual(["bgp", "ospf"]);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ type: "bgp", nextHop: "10.0.12.2" }]);
    expect(bash("S1", "show ip route")).toMatch(/O {3}192\.168\.3\.0\/24 \[110\/8\] via 10\.0\.13\.2.*\nB>\* 192\.168\.3\.0\/24 \[20\/0\] via 10\.0\.12\.2/);
    expect(sh("H1", "traceroute -n 192.168.3.10")).toMatch(/ 2 +10\.0\.12\.2 /);
    cli("S2", ["router bgp 65002", "address-family ipv4 unicast", "no network 192.168.3.0/24", "exit", "exit"]);
    advance(3_000);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ type: "ospf", nextHop: "10.0.13.2" }]);
    expect(sh("H1", "traceroute -n 192.168.3.10")).toMatch(/ 2 +10\.0\.13\.2 /);
  });
});

// ---------------------------------------------------------------------------
// S1 and S2 meet through an L2 switch (L2SW), so a failure behind it does not
// drop S1's carrier; the backup path runs S1 – S3 – S2.
//
//   H1 ─ S1 Ethernet0 10.0.12.1 ─ L2SW ─ 10.0.12.2 Ethernet0 S2 ─ H2
//        S1 Ethernet1 10.0.13.1 ─ S3 ─ 10.0.23.1 Ethernet1 S2
registerLab("l3-bfd", (api) => {
  api.newLab();
  const s1 = api.addDevice("switch", { x: 100, y: 100 }, 4);
  const s2 = api.addDevice("switch", { x: 500, y: 100 }, 4);
  const s3 = api.addDevice("switch", { x: 300, y: 300 }, 4);
  const l2 = api.addDevice("switch", { x: 300, y: 50 }, 4);
  const h1 = api.addDevice("pc", { x: 0, y: 200 });
  const h2 = api.addDevice("pc", { x: 600, y: 200 });
  [["S1", s1], ["S2", s2], ["S3", s3], ["L2SW", l2], ["H1", h1], ["H2", h2]].forEach(([n, d]) => api.rename(d, n));
  for (const s of [s1, s2, s3]) api.setPortSpeed(s, 25000);
  const ip = (d: string, i: number, a: string, p: number) => api.setInterfaceIp(d, `${d}-if${i}`, a, p);
  ip(s1, 0, "10.0.12.1", 30);
  ip(s2, 0, "10.0.12.2", 30);
  ip(s1, 1, "10.0.13.1", 30);
  ip(s3, 0, "10.0.13.2", 30);
  ip(s2, 1, "10.0.23.1", 30);
  ip(s3, 1, "10.0.23.2", 30);
  ip(s1, 2, "192.168.1.1", 24);
  ip(s2, 2, "192.168.2.1", 24);
  ip(h1, 0, "192.168.1.10", 24);
  ip(h2, 0, "192.168.2.10", 24);
  api.setDefaultGateway(h1, "192.168.1.1");
  api.setDefaultGateway(h2, "192.168.2.1");
  api.connect(s1, `${s1}-if0`, l2, `${l2}-if0`);
  api.connect(s2, `${s2}-if0`, l2, `${l2}-if1`);
  api.connect(s1, `${s1}-if1`, s3, `${s3}-if0`);
  api.connect(s2, `${s2}-if1`, s3, `${s3}-if1`);
  api.connect(h1, `${h1}-if0`, s1, `${s1}-if2`);
  api.connect(h2, `${h2}-if0`, s2, `${s2}-if2`);
  for (const i of [0, 1]) api.setAccessVlan(l2, `${l2}-if${i}`, 10);
  const p2p = (ifs: number[]) => ifs.flatMap((i) => [`interface Ethernet ${i}`, "ip ospf network point-to-point", "exit"]);
  api.runCliScript(s1, ["configure terminal", ...p2p([0, 1]), "router ospf", "ospf router-id 1.1.1.1", "network 10.0.12.0/30 area 0", "network 10.0.13.0/30 area 0", "network 192.168.1.0/24 area 0", "passive-interface Ethernet2", "end"]);
  api.runCliScript(s2, ["configure terminal", ...p2p([0, 1]), "router ospf", "ospf router-id 2.2.2.2", "network 10.0.12.0/30 area 0", "network 10.0.23.0/30 area 0", "network 192.168.2.0/24 area 0", "passive-interface Ethernet2", "end"]);
  api.runCliScript(s3, ["configure terminal", ...p2p([0, 1]), "router ospf", "ospf router-id 3.3.3.3", "network 10.0.13.0/30 area 0", "network 10.0.23.0/30 area 0", "end"]);
  api.finish("L3 BFD: S1–L2SW–S2 with backup via S3", s1);
});

const l2swPortToS2Down = () => cli("L2SW", ["interface Ethernet 1", "shutdown", "exit"]);

describe("BFD clients over a path with an L2 switch in the middle", () => {
  beforeEach(() => {
    S().loadFeatureLab("l3-bfd");
    advance(12_000);
  });

  it("baseline: without BFD, OSPF keeps the dead neighbour until the 40 s dead interval", () => {
    expect(best("S1", "192.168.2.0", 24)).toMatchObject([{ nextHop: "10.0.12.2" }]);
    l2swPortToS2Down();
    advance(5_000);
    expect(byName("S1").interfaces[0].operState).toBe("up"); // carrier stays up behind the L2 switch
    expect(ospfNbrs("S1").find((n) => n.rid === "2.2.2.2")?.state).toBe("Full");
    // S2 lost carrier and withdrew its link to S1, so SPF's two-way check already avoids it.
    expect(best("S1", "192.168.2.0", 24)).toMatchObject([{ nextHop: "10.0.13.2" }]);
    advance(40_000);
    expect(ospfNbrs("S1").find((n) => n.rid === "2.2.2.2")).toBeUndefined();
    expect(ping("H1", "192.168.2.10")).toMatch(/1 received/);
  });

  it("ip ospf bfd: the real BFD session detects the failure in < 1 s, OSPF drops the neighbour and traffic reroutes via S3", () => {
    cli("S1", ["interface Ethernet 0", "ip ospf bfd", "exit"]);
    cli("S2", ["interface Ethernet 0", "ip ospf bfd", "exit"]);
    advance(5_000);
    expect(bash("S1", "show bfd peers brief")).toMatch(/10\.0\.12\.2.*up/i);
    l2swPortToS2Down();
    advance(1_200);
    expect(ospfNbrs("S1").find((n) => n.rid === "2.2.2.2")).toBeUndefined();
    expect(best("S1", "192.168.2.0", 24)).toMatchObject([{ type: "ospf", nextHop: "10.0.13.2" }]);
    expect(ping("H1", "192.168.2.10", 2)).toMatch(/2 received/);
    // Repair: BFD comes back, the adjacency re-forms and the direct path returns.
    cli("L2SW", ["interface Ethernet 1", "no shutdown", "exit"]);
    advance(15_000);
    expect(ospfNbrs("S1").find((n) => n.rid === "2.2.2.2")?.state).toBe("Full");
    expect(best("S1", "192.168.2.0", 24)).toMatchObject([{ nextHop: "10.0.12.2" }]);
  });

  it("neighbor bfd: the real BFD session takes the eBGP session down in < 1 s and the route is withdrawn", () => {
    cli("S1", ["router bgp 65001", "router-id 1.1.1.1", "neighbor 10.0.12.2", "remote-as 65002", "bfd", "exit", "address-family ipv4 unicast", "network 192.168.1.0/24", "exit", "exit"]);
    cli("S2", ["interface Loopback 0", "ip address 172.20.0.1/32", "exit", "router bgp 65002", "router-id 2.2.2.2", "neighbor 10.0.12.1", "remote-as 65001", "bfd", "exit", "address-family ipv4 unicast", "network 172.20.0.1/32", "exit", "exit"]);
    advance(8_000);
    expect(best("S1", "172.20.0.1", 32)).toMatchObject([{ type: "bgp", nextHop: "10.0.12.2" }]);
    expect(bash("S1", "show bfd peers brief")).toMatch(/10\.0\.12\.2.*up/i);
    l2swPortToS2Down();
    advance(1_200);
    expect(routes("S1", "172.20.0.1", 32)).toHaveLength(0);
    expect(bash("S1", "show ip bgp summary")).not.toMatch(/10\.0\.12\.2 .* 1 +1 /);
  });
});

// ---------------------------------------------------------------------------
registerLab("l3-triangle", (api) => {
  const t = routedTriangle(api);
  api.finish("bare triangle", t.s1);
});

describe("VRF", () => {
  beforeEach(() => {
    S().loadFeatureLab("l3-triangle");
    // S1: Vrf-red = Ethernet1 (to S3) + Ethernet2 (H1); Ethernet0 (to S2) stays in the default VRF.
    cli("S1", ["ip vrf Vrf-red", "interface Ethernet 1", "ip vrf forwarding Vrf-red", "exit", "interface Ethernet 2", "ip vrf forwarding Vrf-red", "exit"]);
  });

  it("the same prefix lives in two VRFs with different next hops; each VRF forwards with its own", () => {
    cli("S1", ["ip route 172.16.0.0/24 10.0.12.2", "ip route vrf Vrf-red 172.16.0.0/24 10.0.13.2"]);
    expect(routes("S1", "172.16.0.0", 24)).toMatchObject([{ nextHop: "10.0.12.2" }]);
    expect(routes("S1", "172.16.0.0", 24, "Vrf-red")).toMatchObject([{ nextHop: "10.0.13.2" }]);
    expect(bash("S1", "show ip route vrf Vrf-red")).toMatch(/S>\* 172\.16\.0\.0\/24 \[1\/0\] via 10\.0\.13\.2, Ethernet1/);
    expect(bash("S1", "show ip route")).toMatch(/S>\* 172\.16\.0\.0\/24 \[1\/0\] via 10\.0\.12\.2, Ethernet0/);
  });

  it("OSPF inside Vrf-red learns H3's LAN only into Vrf-red; H1 reaches H3 and not S2", () => {
    cli("S1", ["interface Ethernet 1", "ip ospf network point-to-point", "exit", "router ospf vrf Vrf-red", "ospf router-id 1.1.1.1", "network 10.0.13.0/30 area 0", "network 192.168.1.0/24 area 0", "passive-interface Ethernet2", "exit"]);
    cli("S3", ["interface Ethernet 0", "ip ospf network point-to-point", "exit", "router ospf", "ospf router-id 3.3.3.3", "network 10.0.13.0/30 area 0", "network 192.168.3.0/24 area 0", "passive-interface Ethernet2", "exit"]);
    advance(12_000);
    expect(routes("S1", "192.168.3.0", 24, "Vrf-red")).toMatchObject([{ type: "ospf", nextHop: "10.0.13.2", vrf: "Vrf-red" }]);
    expect(routes("S1", "192.168.3.0", 24)).toHaveLength(0);
    expect(ping("H1", "192.168.3.10", 2)).toMatch(/2 received/);
    expect(ping("H1", "10.0.12.2")).toMatch(/0 received/);
  });

  it("BGP inside Vrf-red: routes land in Vrf-red only", () => {
    cli("S1", ["router bgp 65001 vrf Vrf-red", "router-id 1.1.1.1", "neighbor 10.0.13.2", "remote-as 65003", "exit", "address-family ipv4 unicast", "network 192.168.1.0/24", "exit", "exit"]);
    cli("S3", ["router bgp 65003", "router-id 3.3.3.3", "neighbor 10.0.13.1", "remote-as 65001", "exit", "address-family ipv4 unicast", "network 192.168.3.0/24", "exit", "exit"]);
    advance(5_000);
    expect(routes("S1", "192.168.3.0", 24, "Vrf-red")).toMatchObject([{ type: "bgp", nextHop: "10.0.13.2" }]);
    expect(routes("S1", "192.168.3.0", 24)).toHaveLength(0);
    expect(routes("S3", "192.168.1.0", 24)).toMatchObject([{ type: "bgp", nextHop: "10.0.13.1" }]);
    expect(ping("H1", "192.168.3.10", 2)).toMatch(/2 received/);
  });
});

// ---------------------------------------------------------------------------
describe("VRRP with OSPF uplinks", () => {
  beforeEach(() => {
    S().loadFeatureLab("vrrp");
    advance(15_000);
  });

  it("tracked uplink down: S2 takes over the VIP and H1 still reaches H2; uplink back: S1 preempts", () => {
    cli("S1", ["interface Vlan 10", "vrrp 10 address-family ipv4", "track-interface Ethernet 1 weight 30", "exit", "exit"]);
    advance(2_000);
    expect(bash("S1", "show vrrp")).toMatch(/Master/);
    expect(ping("H1", "192.168.20.100", 2)).toMatch(/2 received/);
    cli("S1", ["interface Ethernet 1", "shutdown", "exit"]);
    advance(5_000);
    expect(bash("S2", "show vrrp")).toMatch(/Master/);
    expect(bash("S1", "show vrrp")).toMatch(/Backup/);
    expect(ping("H1", "192.168.20.100", 2)).toMatch(/2 received/);
    cli("S1", ["interface Ethernet 1", "no shutdown", "exit"]);
    advance(15_000);
    expect(bash("S1", "show vrrp")).toMatch(/Master/);
    expect(ping("H1", "192.168.20.100", 2)).toMatch(/2 received/);
  });

  it("master's SVI loses its only member port: S2 becomes master; the SVI's connected route and OSPF stub leave S1", () => {
    cli("S1", ["interface Ethernet 0", "shutdown", "exit"]);
    advance(5_000);
    expect(bash("S2", "show vrrp")).toMatch(/Master/);
    expect(routes("S1", "192.168.10.0", 24).filter((r) => r.type === "connected")).toHaveLength(0);
    // S3 now reaches 192.168.10.0/24 only through S2.
    expect(best("S3", "192.168.10.0", 24)).toMatchObject([{ type: "ospf", nextHop: "10.0.23.1" }]);
    expect(ping("H1", "192.168.20.100", 2)).toMatch(/2 received/);
  });
});

// ---------------------------------------------------------------------------
registerLab("l3-svi", (api) => {
  api.newLab();
  const s1 = api.addDevice("switch", { x: 100, y: 100 }, 4);
  const s2 = api.addDevice("switch", { x: 500, y: 100 }, 4);
  const h1 = api.addDevice("pc", { x: 0, y: 200 });
  const h2 = api.addDevice("pc", { x: 600, y: 200 });
  [["S1", s1], ["S2", s2], ["H1", h1], ["H2", h2]].forEach(([n, d]) => api.rename(d, n));
  api.setInterfaceIp(h1, `${h1}-if0`, "192.168.1.10", 24);
  api.setInterfaceIp(h2, `${h2}-if0`, "192.168.2.10", 24);
  api.setDefaultGateway(h1, "192.168.1.1");
  api.setDefaultGateway(h2, "192.168.2.1");
  api.connect(s1, `${s1}-if0`, s2, `${s2}-if0`);
  api.connect(h1, `${h1}-if0`, s1, `${s1}-if2`);
  api.connect(h2, `${h2}-if0`, s2, `${s2}-if2`);
  api.setAccessVlan(s1, `${s1}-if0`, 100);
  api.setAccessVlan(s2, `${s2}-if0`, 100);
  api.setAccessVlan(s1, `${s1}-if2`, 10);
  api.setAccessVlan(s2, `${s2}-if2`, 20);
  api.runCliScript(s1, ["configure terminal", "interface Vlan 10", "ip address 192.168.1.1/24", "exit", "interface Vlan 100", "ip address 10.0.100.1/24", "exit",
    "router ospf", "ospf router-id 1.1.1.1", "network 10.0.100.0/24 area 0", "network 192.168.1.0/24 area 0", "passive-interface Vlan10", "end"]);
  api.runCliScript(s2, ["configure terminal", "interface Vlan 20", "ip address 192.168.2.1/24", "exit", "interface Vlan 100", "ip address 10.0.100.2/24", "exit",
    "router ospf", "ospf router-id 2.2.2.2", "network 10.0.100.0/24 area 0", "network 192.168.2.0/24 area 0", "passive-interface Vlan20", "end"]);
  api.finish("SVI routing", s1);
});

describe("SVIs: inter-VLAN routing and autostate", () => {
  beforeEach(() => {
    S().loadFeatureLab("l3-svi");
    advance(45_000); // broadcast network: DR election after the 40 s Wait timer
  });

  it("OSPF forms over the transit SVI and hosts in different VLANs reach each other", () => {
    expect(ospfNbrs("S1").map((n) => [n.rid, n.state])).toEqual([["2.2.2.2", "Full"]]);
    expect(best("S1", "192.168.2.0", 24)).toMatchObject([{ type: "ospf", nextHop: "10.0.100.2" }]);
    expect(ping("H1", "192.168.2.10", 2)).toMatch(/2 received/);
  });

  it("the SVI goes down with its last member port: connected route and OSPF adjacency go; the port back restores both", () => {
    cli("S1", ["interface Ethernet 0", "shutdown", "exit"]);
    advance(500);
    const vlan100 = byName("S1").interfaces.find((i) => i.name === "Vlan100")!;
    expect(vlan100.operState).toBe("down");
    expect(routes("S1", "10.0.100.0", 24).filter((r) => r.type === "connected")).toHaveLength(0);
    expect(ospfNbrs("S1")).toHaveLength(0);
    expect(ospfNbrs("S2")).toHaveLength(0);
    expect(routes("S1", "192.168.2.0", 24)).toHaveLength(0);
    // The host-facing SVI keeps its own member and stays up.
    expect(routes("S1", "192.168.1.0", 24).filter((r) => r.type === "connected")).toHaveLength(1);
    cli("S1", ["interface Ethernet 0", "no shutdown", "exit"]);
    advance(500);
    expect(byName("S1").interfaces.find((i) => i.name === "Vlan100")!.operState).toBe("up");
    expect(routes("S1", "10.0.100.0", 24).filter((r) => r.type === "connected")).toHaveLength(1);
    advance(45_000);
    expect(ping("H1", "192.168.2.10")).toMatch(/1 received/);
  });

  it("host-facing SVI: shutting its only member port removes 192.168.1.0/24 from S2's OSPF routes", () => {
    cli("S1", ["interface Ethernet 2", "shutdown", "exit"]);
    advance(500);
    expect(routes("S1", "192.168.1.0", 24).filter((r) => r.type === "connected")).toHaveLength(0);
    advance(2_000);
    expect(routes("S2", "192.168.1.0", 24)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("IP SLA, PBR and iBGP on the OSPF triangle", () => {
  beforeEach(() => {
    S().loadFeatureLab("ospf");
    advance(12_000);
  });

  it("IP SLA failing removes the tracked static, and OSPF stops redistributing it", () => {
    // SLA probes H3 (reached over OSPF); the tracked route's next hop stays resolvable throughout.
    cli("S1", ["ip sla 1", "frequency 5", "threshold 2", "timeout 2", "icmp-echo 192.168.3.10", "exit", "exit",
      "ip route 172.16.0.0/24 10.0.12.2 track 1", "router ospf", "redistribute static", "exit"]);
    advance(8_000);
    expect(best("S1", "172.16.0.0", 24)).toMatchObject([{ type: "static", nextHop: "10.0.12.2" }]);
    // E2 with forwarding address 10.0.12.2: S3 reaches it over both S1 and S2 (ECMP).
    expect(best("S3", "172.16.0.0", 24).map((r) => r.type)).toEqual(["ospf", "ospf"]);
    S().disconnect(conn("H3", "if0", "S3", "if2").id);
    advance(20_000);
    expect(sh("S1", "show ip sla")).toMatch(/^1\s+ICMP-echo\s+Down/m);
    expect(routes("S1", "172.16.0.0", 24)).toHaveLength(0);
    expect(routes("S3", "172.16.0.0", 24)).toHaveLength(0);
  });

  it("PBR overrides the RIB: H1's traffic to H3 goes via S2 although OSPF prefers S3; an unusable PBR next hop falls back to OSPF", () => {
    cli("S1", ["class-map H1 match-type fields match-all", "match source-address ip 192.168.1.0/24", "exit",
      "policy-map VIA-S2 type forwarding", "class H1 priority 10", "set ip next-hop 10.0.12.2 priority 10", "exit", "exit",
      "interface Ethernet 2", "service-policy type forwarding in VIA-S2", "exit"]);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ nextHop: "10.0.13.2" }]);
    expect(sh("H1", "traceroute -n 192.168.3.10")).toMatch(/ 2 +10\.0\.12\.2 /);
    expect(ping("H1", "192.168.3.10")).toMatch(/1 received/);
    S().disconnect(conn("S1", "if0", "S2", "if0").id);
    advance(300);
    expect(sh("H1", "traceroute -n 192.168.3.10")).toMatch(/ 2 +10\.0\.13\.2 /);
  });

  it("iBGP (200) over an OSPF underlay: OSPF (110) wins for the same prefix; iBGP-only prefixes resolve via OSPF", () => {
    cli("S3", ["interface Loopback 0", "ip address 10.33.0.1/32", "exit",
      "router bgp 65000", "router-id 3.3.3.3", "neighbor 10.0.13.1", "remote-as 65000", "exit",
      "address-family ipv4 unicast", "network 192.168.3.0/24", "network 10.33.0.1/32", "exit", "exit"]);
    cli("S1", ["router bgp 65000", "router-id 1.1.1.1", "neighbor 10.0.13.2", "remote-as 65000", "exit"]);
    advance(5_000);
    const rs = routes("S1", "192.168.3.0", 24);
    expect(rs.map((r) => [r.type, routeDistance(r)]).sort()).toEqual([["bgp", 200], ["ospf", 110]]);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ type: "ospf" }]);
    expect(best("S1", "10.33.0.1", 32)).toMatchObject([{ type: "bgp", nextHop: "10.0.13.2", distance: 200 }]);
    expect(ping("H1", "10.33.0.1")).toMatch(/1 received/);
  });

  it("redistribution only exports the route zebra selected: a floating static shadowed by OSPF is not redistributed into BGP", () => {
    cli("S1", ["ip route 192.168.3.0/24 10.0.12.2 250", "router bgp 65001", "router-id 1.1.1.1", "neighbor 10.0.12.2", "remote-as 65002", "exit",
      "address-family ipv4 unicast", "redistribute static", "exit", "exit"]);
    cli("S2", ["router bgp 65002", "router-id 2.2.2.2", "neighbor 10.0.12.1", "remote-as 65001", "exit"]);
    advance(5_000);
    expect(best("S1", "192.168.3.0", 24)).toMatchObject([{ type: "ospf" }]);
    expect(routes("S2", "192.168.3.0", 24).filter((r) => r.type === "bgp")).toHaveLength(0);
  });
});

describe("OSPFv3", () => {
  it("interface shutdown drops the OSPFv3 neighbour and IPv6 reroutes via S2", async () => {
    const { slaacAddress } = await import("../lib/models/ipv6");
    const { ospf6Runtime } = await import("../lib/protocols/ospf6-daemon");
    S().loadFeatureLab("ipvx");
    advance(15_000);
    const h3 = slaacAddress("2001:db8:3::", byName("H3").interfaces[0].mac);
    expect(sh("H1", `ping6 -c 1 ${h3}`)).toMatch(/hlim=62/);
    cli("S1", ["interface Ethernet 1", "shutdown", "exit"]);
    advance(300);
    expect(ospf6Runtime(byName("S1"))!.oifs.flatMap((o) => o.nbrs).map((n) => n.rid)).toEqual(["2.2.2.2"]);
    expect(sh("H1", `ping6 -c 1 ${h3}`)).toMatch(/hlim=61/);
  });
});

describe("link down on the far side", () => {
  it("shutting S1's port takes the carrier down on S3 too: S3 withdraws the connected /30 and stops redistributing it", () => {
    S().loadFeatureLab("ospf");
    cli("S3", ["router ospf", "redistribute connected", "exit"]);
    advance(12_000);
    cli("S1", ["interface Ethernet 1", "shutdown", "exit"]);
    advance(300);
    expect(byName("S3").interfaces.find((i) => i.name === "Ethernet0")!.operState).toBe("down");
    expect(routes("S3", "10.0.13.0", 30).filter((r) => r.type === "connected")).toHaveLength(0);
    expect(bash("S3", "show ip route")).not.toMatch(/C>\* 10\.0\.13\.0\/30/);
    advance(2_000);
    expect(routes("S2", "10.0.13.0", 30)).toHaveLength(0);
    cli("S1", ["interface Ethernet 1", "no shutdown", "exit"]);
    advance(300);
    expect(routes("S3", "10.0.13.0", 30).filter((r) => r.type === "connected")).toHaveLength(1);
  });

  it("an address on a shut interface is no longer local: H1 cannot ping S1's 10.0.13.1 while Ethernet1 is down", () => {
    S().loadFeatureLab("ospf");
    advance(12_000);
    expect(ping("H1", "10.0.13.1")).toMatch(/1 received/);
    cli("S1", ["interface Ethernet 1", "shutdown", "exit"]);
    advance(300);
    expect(ping("H1", "10.0.13.1")).toMatch(/0 received/);
  });
});

describe("OSPF areas", () => {
  it("stub area gets a default from the ABR, the NSSA external is translated, and H1 pings EXT across three areas", () => {
    S().loadFeatureLab("ospf-areas");
    advance(15_000);
    expect(best("S1", "0.0.0.0", 0)).toMatchObject([{ type: "ospf", nextHop: "10.1.12.2" }]);
    expect(routes("S1", "198.51.100.0", 24)).toHaveLength(0); // no externals in a stub area
    expect(best("S2", "198.51.100.0", 24)).toMatchObject([{ type: "ospf", nextHop: "10.0.23.2" }]);
    expect(best("S4", "10.1.0.0", 16)).toMatchObject([{ type: "ospf" }]); // area 1 range
    expect(ping("H1", "198.51.100.10", 2)).toMatch(/2 received/);
  });
});

describe("inter-VLAN routing on one switch", () => {
  it("two SVIs on S1 route between their VLANs; a routed port and an SVI route to each other", () => {
    S().loadFeatureLab("l3-svi");
    cli("S1", ["interface Vlan 30", "ip address 192.168.30.1/24", "exit", "interface Ethernet 3", "switchport access Vlan 30", "exit"]);
    // Move H2 next to H1 on S1 Ethernet3 (VLAN 30).
    S().disconnect(conn("H2", "if0", "S2", "if2").id);
    S().connect(id("H2"), `${id("H2")}-if0`, id("S1"), `${id("S1")}-if3`);
    sh("H2", "ip addr flush dev eth0");
    sh("H2", "ip addr add 192.168.30.10/24 dev eth0");
    sh("H2", "ip route add default via 192.168.30.1");
    advance(1_000);
    expect(ping("H1", "192.168.30.10", 2)).toMatch(/2 received/);
    expect(sh("H1", "traceroute -n 192.168.30.10")).toMatch(/ 1 +192\.168\.1\.1 [\s\S]* 2 +192\.168\.30\.10 /);
  });
});
