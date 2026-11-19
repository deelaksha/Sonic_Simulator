import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs";
import { routedTriangle } from "../lib/labs/topologies";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { linkLocalFromMac, slaacAddress } from "../lib/models/ipv6";
import { decodeMessages, UpdateMsg } from "../lib/protocols/bgp-wire";
import { l4Payload } from "../lib/control/packet";
import { peekBgpRuntime } from "../lib/protocols/bgp-daemon";

const sh = (d: string, cmd: string) => out(S().execCommand(byName(d).id, cmd));
const cli = (d: string, lines: string[]) => S().runCliScript(byName(d).id, ["configure terminal", ...lines, "end"]);
const iface = (d: string, name: string) => byName(d).interfaces.find((i) => i.name === name)!;
const bgp6 = (d: string, dest: string) => byName(d).routingTable6.filter((r) => r.type === "bgp" && r.destination === dest);

// routedTriangle dual-stacked on the S1–S3 link and both LANs (no IGP for IPv6: BGP carries it).
registerLab("test-bgp6", (api) => {
  const t = routedTriangle(api);
  const link = (n: number, a: string) => [`interface Ethernet ${n}`, `ipv6 address ${a}`, "ipv6 nd suppress-ra", "exit"];
  const lan = (n: number, a: string) => [`interface Ethernet ${n}`, `ipv6 address ${a}`, "exit"];
  api.runCliScript(t.s1, ["configure terminal", ...link(1, "2001:db8:13::1/64"), ...lan(2, "2001:db8:1::1/64"), "end"]);
  api.runCliScript(t.s3, ["configure terminal", ...link(0, "2001:db8:13::2/64"), ...lan(2, "2001:db8:3::1/64"), "end"]);
  const bgp = (as: number, rid: string, peer: string, ras: number, net: string) => [
    "configure terminal",
    `router bgp ${as}`,
    `router-id ${rid}`,
    `neighbor ${peer}`,
    `remote-as ${ras}`,
    "address-family ipv6 unicast",
    "activate",
    "exit",
    "exit",
    "address-family ipv6 unicast",
    `network ${net}`,
    "end",
  ];
  api.runCliScript(t.s1, bgp(65001, "1.1.1.1", "10.0.13.2", 65003, "2001:db8:1::/64"));
  api.runCliScript(t.s3, bgp(65003, "3.3.3.3", "10.0.13.1", 65001, "2001:db8:3::/64"));
  api.finish("test bgp6", t.s1);
});

registerLab("test-bgp-vrf", (api) => {
  routedTriangle(api);
});

describe("MP-BGP IPv6 unicast over an IPv4 session (RFC 4760 / RFC 2545)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetAll();
    S().loadFeatureLab("test-bgp6");
    advance(1000);
  });
  afterEach(() => vi.useRealTimers());

  it("negotiates AFI 2/SAFI 1, carries routes in MP_REACH with global + link-local next hop, installs them in routingTable6", () => {
    const p = peekBgpRuntime(byName("S1"))!.peers["10.0.13.2"];
    expect(p.state).toBe("Established");
    expect(p.mpRcvd).toContain("2/1");
    const s3ll = linkLocalFromMac(iface("S3", "Ethernet0").mac);
    // the UPDATE S3 sent: MP_REACH_NLRI, next hop length 32 (global + link-local, shared network)
    const ups = S()
      .captures.filter((c) => c.deviceId === byName("S3").id && c.dir === "tx" && c.frame.ipv4?.dstIp === "10.0.13.1" && c.frame.tcp)
      .flatMap((c) => decodeMessages(l4Payload(c.frame) ?? new Uint8Array(), true))
      .filter((m): m is UpdateMsg => m.type === 2 && !!m.v6Reach);
    // (the link-local appears once radvd brings it up; the UPDATE is re-sent with it)
    const last = ups[ups.length - 1];
    expect(last.v6Reach).toEqual({ nextHop: "2001:db8:13::2", nextHopLL: s3ll, nlri: ["2001:db8:3::/64"] });
    expect(last.attrs).toMatchObject({ origin: 0, asPath: [65003] });
    expect(last.nlri).toEqual([]); // nothing in the IPv4 NLRI field
    const r = bgp6("S1", "2001:db8:3::");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ prefix: 64, nextHop: s3ll, interfaceId: iface("S1", "Ethernet1").id, distance: 20 });
    // the IPv4 table is untouched by IPv6 routes
    expect(byName("S1").routingTable.some((x) => x.type === "bgp" && x.destination.includes(":"))).toBe(false);
  });

  it("show bgp ipv6 unicast [summary | <prefix>] and ping6 H1 → H3 over the BGP route", () => {
    const t = sh("S1", "show bgp ipv6 unicast");
    expect(t).toMatch(/^ \*>  2001:db8:1::\/64  :: {23}0 {9}32768 i$/m);
    expect(t).toMatch(/^ \*>  2001:db8:3::\/64  fe80::[0-9a-f:]+ +0 {13}0 65003 i$/m);
    const sum = sh("S1", "show bgp ipv6 unicast summary");
    expect(sum).toContain("IPv6 Unicast Summary:");
    expect(sum).toMatch(/^10\.0\.13\.2 .* {12}1 {8}1 N\/A$/m);
    const d = sh("S1", "show bgp ipv6 unicast 2001:db8:3::/64");
    expect(d).toContain("BGP routing table entry for 2001:db8:3::/64");
    expect(d).toMatch(/ {4}2001:db8:13::2 from 10\.0\.13\.2 \(3\.3\.3\.3\)\n {4}\(fe80::[0-9a-f:]+\) \(used\)/);
    expect(sh("S1", "show ip bgp neighbors 10.0.13.2")).toContain("    Address Family IPv6 Unicast: advertised and received");
    const h3 = slaacAddress("2001:db8:3::", iface("H3", "eth0").mac);
    expect(sh("H1", `ping6 -c 2 ${h3}`)).toMatch(/2 received/);
  });

  it("IPv6 prefix-list in a route-map filters per neighbor; deactivation withdraws (session reset)", () => {
    cli("S1", ["ipv6 prefix-list NO3 seq 5 deny 2001:db8:3::/64", "ipv6 prefix-list NO3 seq 10 permit ::/0 le 128", "route-map V6IN permit 10", "match ipv6 address prefix-list NO3", "exit", "router bgp 65001", "neighbor 10.0.13.2", "address-family ipv6 unicast", "route-map V6IN in"]);
    advance(200);
    expect(bgp6("S1", "2001:db8:3::")).toHaveLength(0);
    expect(sh("S1", "show ipv6 prefix-list NO3")).toContain("seq 5 deny 2001:db8:3::/64");
    cli("S1", ["router bgp 65001", "neighbor 10.0.13.2", "address-family ipv6 unicast", "no route-map V6IN in"]);
    advance(200);
    expect(bgp6("S1", "2001:db8:3::")).toHaveLength(1);
    cli("S3", ["router bgp 65003", "neighbor 10.0.13.1", "no address-family ipv6 unicast"]);
    advance(3000);
    expect(peekBgpRuntime(byName("S1"))!.peers["10.0.13.2"].state).toBe("Established");
    expect(bgp6("S1", "2001:db8:3::")).toHaveLength(0);
    expect(sh("S1", "show bgp ipv6 unicast summary")).toMatch(/^10\.0\.13\.2 .* {8}NoNeg {4}NoNeg N\/A$/m);
  });
});

describe("BGP in a VRF (router bgp <as> vrf <vrf>)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    resetAll();
    S().loadFeatureLab("test-bgp-vrf");
    // S1: Vrf-red = Ethernet1 (to S3) + Ethernet2 (H1 LAN); Ethernet0 (to S2) stays in default.
    cli("S1", [
      "ip vrf Vrf-red",
      "interface Ethernet 2",
      "ip vrf forwarding Vrf-red",
      "exit",
      "interface Ethernet 1",
      "ip vrf forwarding Vrf-red",
      "exit",
      "router bgp 65001",
      "router-id 1.1.1.1",
      "neighbor 10.0.12.2",
      "remote-as 65002",
      "exit",
      "exit",
      "router bgp 65001 vrf Vrf-red",
      "neighbor 10.0.13.2",
      "remote-as 65003",
      "exit",
      "address-family ipv4 unicast",
      "network 192.168.1.0/24",
    ]);
    cli("S2", ["router bgp 65002", "neighbor 10.0.12.1", "remote-as 65001", "exit", "address-family ipv4 unicast", "redistribute connected"]);
    cli("S3", ["router bgp 65003", "neighbor 10.0.13.1", "remote-as 65001", "exit", "address-family ipv4 unicast", "network 192.168.3.0/24"]);
    advance(500);
  });
  afterEach(() => vi.useRealTimers());

  it("sessions per instance; routes tagged with the VRF; the default VRF stays isolated", () => {
    expect(peekBgpRuntime(byName("S1"), "Vrf-red")!.peers["10.0.13.2"].state).toBe("Established");
    expect(peekBgpRuntime(byName("S1"))!.peers["10.0.12.2"].state).toBe("Established");
    expect(peekBgpRuntime(byName("S1"))!.peers["10.0.13.2"]).toBeUndefined();
    const s1 = byName("S1").routingTable.filter((r) => r.type === "bgp");
    expect(s1.find((r) => r.destination === "192.168.3.0")).toMatchObject({ vrf: "Vrf-red", nextHop: "10.0.13.2" });
    expect(s1.find((r) => r.destination === "10.0.23.0")).toMatchObject({ nextHop: "10.0.12.2" });
    expect(s1.find((r) => r.destination === "10.0.23.0")!.vrf).toBeUndefined();
    // isolation: S2 never learns the Vrf-red LAN, Vrf-red never sees S2's routes
    expect(byName("S2").routingTable.some((r) => r.type === "bgp" && r.destination === "192.168.1.0")).toBe(false);
    expect(s1.some((r) => r.destination === "10.0.23.0" && r.vrf === "Vrf-red")).toBe(false);
    expect(sh("H1", "ping -c 1 192.168.3.10")).toMatch(/1 received/);
    expect(sh("S1", "show ip route vrf Vrf-red")).toMatch(/B>\* 192\.168\.3\.0\/24 \[20\/0\] via 10\.0\.13\.2, Ethernet1/);
  });

  it("show ip bgp vrf <vrf> [summary], router-id from the VRF's interfaces, ADJCHANGE in vrf", () => {
    const sum = sh("S1", "show ip bgp vrf Vrf-red summary");
    expect(sum).toMatch(/BGP router identifier 192\.168\.1\.1, local AS number 65001 VRF Vrf-red vrf-id 1/);
    expect(sum).toMatch(/^10\.0\.13\.2 /m);
    expect(sum).not.toMatch(/^10\.0\.12\.2 /m);
    const t = sh("S1", "show bgp vrf Vrf-red ipv4 unicast");
    expect(t).toContain("local router ID is 192.168.1.1, vrf id 1");
    expect(t).toMatch(/192\.168\.3\.0\/24 +10\.0\.13\.2/);
    expect(sh("S1", "show ip bgp")).not.toContain("192.168.3.0/24");
    expect(sh("S1", "show ip bgp vrf Vrf-red 192.168.3.0/24")).toContain("Paths: (1 available, best #1, vrf Vrf-red)");
    expect(sh("S1", "show logging")).toMatch(/%ADJCHANGE: neighbor 10\.0\.13\.2\(S3\) in vrf Vrf-red Up/);
    // the default instance cannot be removed while a VRF instance exists
    expect(sh("S1", "configure terminal")).toBeDefined();
    expect(sh("S1", "no router bgp")).toContain("% Cannot delete default BGP instance. Dependent VRF instances exist");
    sh("S1", "end");
    expect(peekBgpRuntime(byName("S1"))).toBeDefined();
    // removing the VRF instance withdraws its routes only
    cli("S1", ["no router bgp 65001 vrf Vrf-red"]);
    advance(100);
    expect(byName("S1").routingTable.some((r) => r.type === "bgp" && r.vrf === "Vrf-red")).toBe(false);
    expect(byName("S1").routingTable.some((r) => r.type === "bgp" && r.destination === "10.0.23.0")).toBe(true);
  });
});
