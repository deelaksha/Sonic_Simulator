import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { Device } from "../lib/models/device";
import { BgpPath, comparePaths } from "../lib/protocols/bgp-daemon";
import { PolicyAttrs, applyRouteMap, asPathListPermits, communityListPermits, parseCommunity, prefixListPermits, communityStr, COMMUNITY } from "../lib/protocols/bgp-policy";

/** A device carrying only policy config, exactly as the CLI modules store it. */
function dev(features: Record<string, unknown>): Device {
  return { config: { features } } as unknown as Device;
}
const pl = (lists: Record<string, unknown[]>, lists6: Record<string, unknown[]> = {}) => ({ prefixlist: { lists, lists6 } });
const attrs = (o: Partial<PolicyAttrs> = {}): PolicyAttrs => ({ origin: 0, asPath: [65002], nextHop: "10.0.0.2", weight: 0, ...o });

describe("prefix-list (lib/plist.c semantics)", () => {
  const d = dev(
    pl(
      {
        P: [
          { seq: 10, action: "deny", prefix: "10.1.0.0/16", ge: 24, le: 24 },
          { seq: 20, action: "permit", prefix: "10.0.0.0/8", le: 24 },
          { seq: 30, action: "permit", prefix: "192.168.1.0/24" },
        ],
      },
      { P6: [{ seq: 5, action: "permit", prefix: "2001:db8::", ge: 48 }] },
    ),
  );
  it("exact match without ge/le, ge/le ranges, lowest seq wins, implicit deny", () => {
    expect(prefixListPermits(d, "P", "192.168.1.0/24", "ipv4")).toBe(true);
    expect(prefixListPermits(d, "P", "192.168.1.0/25", "ipv4")).toBe(false); // exact length only
    expect(prefixListPermits(d, "P", "10.1.5.0/24", "ipv4")).toBe(false); // seq 10 deny first
    expect(prefixListPermits(d, "P", "10.1.0.0/16", "ipv4")).toBe(true); // /16 not in ge 24 → seq 20
    expect(prefixListPermits(d, "P", "10.2.3.0/25", "ipv4")).toBe(false); // le 24 exceeded → no match → deny
    expect(prefixListPermits(d, "P", "172.16.0.0/16", "ipv4")).toBe(false); // implicit deny
    expect(prefixListPermits(d, "MISSING", "192.168.1.0/24", "ipv4")).toBe(false); // missing list denies
  });
  it("IPv6 lists", () => {
    const d6 = dev(pl({}, { P6: [{ seq: 5, action: "permit", prefix: "2001:db8::/32", ge: 48 }] }));
    expect(prefixListPermits(d6, "P6", "2001:db8:1::/48", "ipv6")).toBe(true);
    expect(prefixListPermits(d6, "P6", "2001:db8::/32", "ipv6")).toBe(false);
    expect(prefixListPermits(d6, "P6", "2001:db9::/48", "ipv6")).toBe(false);
  });
});

describe("community-list / as-path list / communities", () => {
  const d = dev({
    bgpclist: {
      community: {
        ALL: [{ seq: 5, action: "permit", members: ["65001:100", "65001:200"] }],
        ANY: [{ seq: 5, action: "permit", members: ["65001:100", "65001:200"], any: true }],
        DENY: [
          { seq: 5, action: "deny", members: ["no-export"] },
          { seq: 10, action: "permit", members: ["65001:100"] },
        ],
      },
      aspath: { FROM2: [{ seq: 5, action: "permit", regex: "^65002_" }], NOT3: [{ seq: 5, action: "deny", regex: "_65003_" }, { seq: 10, action: "permit", regex: ".*" }] },
    },
  });
  const c = (s: string) => parseCommunity(s)!;
  it("standard lists need all members (any with the KLISH flag); first match decides", () => {
    expect(communityListPermits(d, "ALL", [c("65001:100")])).toBe(false);
    expect(communityListPermits(d, "ALL", [c("65001:100"), c("65001:200"), c("65001:300")])).toBe(true);
    expect(communityListPermits(d, "ALL", [c("65001:100"), c("65001:200"), c("65001:300")], true)).toBe(false); // exact-match
    expect(communityListPermits(d, "ANY", [c("65001:200")])).toBe(true);
    expect(communityListPermits(d, "DENY", [c("65001:100"), COMMUNITY.NO_EXPORT])).toBe(false);
    expect(communityListPermits(d, "DENY", [c("65001:100")])).toBe(true);
    expect(communityListPermits(d, "NONE", [c("65001:100")])).toBe(false);
  });
  it("AS-path regex with FRR's _ delimiter", () => {
    expect(asPathListPermits(d, "FROM2", [65002, 65004])).toBe(true);
    expect(asPathListPermits(d, "FROM2", [65004, 65002])).toBe(false);
    expect(asPathListPermits(d, "FROM2", [650021])).toBe(false);
    expect(asPathListPermits(d, "NOT3", [65002, 65003, 65004])).toBe(false);
    expect(asPathListPermits(d, "NOT3", [65002])).toBe(true);
  });
  it("well-known community values and strings (RFC 1997, bgp_community.c)", () => {
    expect(parseCommunity("no-export")).toBe(0xffffff01);
    expect(parseCommunity("no-advertise")).toBe(0xffffff02);
    expect(parseCommunity("local-AS")).toBe(0xffffff03);
    expect(parseCommunity("65001:100")).toBe(((65001 << 16) | 100) >>> 0);
    expect(parseCommunity("70000:1")).toBeNull();
    expect(communityStr(0xffffff03)).toBe("local-AS");
  });
});

describe("route-map evaluation (lib/routemap.c route_map_apply_ext)", () => {
  const rm = (stmts: unknown[]) => ({ routemap: { maps: { RM: stmts } } });
  it("first matching statement decides; permit applies sets; no match is an implicit deny", () => {
    const d = dev({
      ...pl({ LAN: [{ seq: 5, action: "permit", prefix: "192.168.0.0/16", le: 24 }] }),
      ...rm([
        { seq: 10, action: "deny", match: ["ip address prefix-list LAN", "metric 99"], set: [] },
        { seq: 20, action: "permit", match: ["ip address prefix-list LAN"], set: ["local-preference 250", "metric 30", "weight 7", "community 65001:1 65001:2", "as-path prepend 65001 65001", "origin egp", "ip next-hop 10.9.9.9"] },
      ]),
    });
    const a = attrs({ med: 99 });
    expect(applyRouteMap(d, "RM", { prefix: "192.168.4.0/24", af: "ipv4" }, a)).toBe("deny");
    const b = attrs({ med: 5 });
    expect(applyRouteMap(d, "RM", { prefix: "192.168.4.0/24", af: "ipv4" }, b)).toBe("permit");
    expect(b).toMatchObject({ localPref: 250, med: 30, weight: 7, asPath: [65001, 65001, 65002], origin: 1, nextHop: "10.9.9.9", communities: [parseCommunity("65001:1"), parseCommunity("65001:2")] });
    expect(applyRouteMap(d, "RM", { prefix: "10.0.0.0/8", af: "ipv4" }, attrs())).toBe("deny"); // implicit deny
    expect(applyRouteMap(d, "MISSING", { prefix: "192.168.4.0/24", af: "ipv4" }, attrs())).toBe("deny");
  });
  it("set community additive / none, metric +/-, match as-path / community / peer / local-preference / origin", () => {
    const d = dev({
      bgpclist: { community: { C: [{ seq: 5, action: "permit", members: ["65001:9"] }] }, aspath: { A: [{ seq: 5, action: "permit", regex: "^65002$" }] } },
      ...rm([
        { seq: 10, action: "permit", match: ["as-path A", "community C"], set: ["community 65001:10 additive", "metric +5"] },
        { seq: 20, action: "permit", match: ["peer 10.0.0.9"], set: ["community none", "metric -50"] },
        { seq: 30, action: "permit", match: ["local-preference 100", "origin incomplete"], set: ["weight 1"] },
      ]),
    });
    const a = attrs({ communities: [parseCommunity("65001:9")!], med: 10 });
    expect(applyRouteMap(d, "RM", { prefix: "1.0.0.0/8", af: "ipv4" }, a)).toBe("permit");
    expect(a.communities).toEqual([parseCommunity("65001:9"), parseCommunity("65001:10")]);
    expect(a.med).toBe(15);
    const b = attrs({ asPath: [65003], communities: [1], med: 20 });
    expect(applyRouteMap(d, "RM", { prefix: "1.0.0.0/8", af: "ipv4", peer: "10.0.0.9" }, b)).toBe("permit");
    expect(b.communities).toBeUndefined();
    expect(b.med).toBe(0);
    const c = attrs({ asPath: [65003], origin: 2 });
    expect(applyRouteMap(d, "RM", { prefix: "1.0.0.0/8", af: "ipv4" }, c)).toBe("permit");
    expect(c.weight).toBe(1);
  });
});

describe("best path (bgp_path_info_cmp order)", () => {
  const p = (o: Partial<BgpPath>): BgpPath => ({ origin: 0, asPath: [65002], nextHop: "10.0.0.2", weight: 0, peer: "10.0.0.2", peerRid: "2.2.2.2", ebgp: true, sinceMs: 0, ...o });
  const better = (a: Partial<BgpPath>, b: Partial<BgpPath>, reason: string) => {
    const r = { r: "" };
    expect(comparePaths(p(a), p(b), r)).toBeLessThan(0);
    expect(r.r).toBe(reason);
  };
  it("each decision step in order", () => {
    better({ weight: 10, localPref: 50 }, { localPref: 500 }, "Weight");
    better({ localPref: 200, asPath: [1, 2, 3] }, { asPath: [1] }, "Local Pref");
    better({ peer: "0.0.0.0", asPath: [1, 2] }, { asPath: [] }, "Local Route");
    better({ asPath: [1], origin: 2 }, { asPath: [1, 2], origin: 0 }, "AS Path");
    better({ origin: 0, med: 100 }, { origin: 2, med: 0 }, "Origin");
    better({ asPath: [65002, 1], med: 5 }, { asPath: [65002, 2], med: 10 }, "MED");
    better({ ebgp: true }, { ebgp: false }, "Peer Type");
    better({ igpMetric: 10 }, { igpMetric: 20 }, "IGP Metric");
    better({ sinceMs: 1 }, { sinceMs: 2 }, "Older Path");
    better({ peerRid: "1.1.1.1", ebgp: false }, { peerRid: "3.3.3.3", ebgp: false }, "Router ID");
  });
  it("MED is only compared between paths from the same neighbour AS", () => {
    const r = { r: "" };
    comparePaths(p({ asPath: [65002], med: 50, sinceMs: 5 }), p({ asPath: [65003], med: 0, sinceMs: 1, peer: "10.0.0.3" }), r);
    expect(r.r).toBe("Older Path");
  });
});

const sh = (d: string, cmd: string) => out(S().execCommand(byName(d).id, cmd));
const cli = (d: string, lines: string[]) => S().runCliScript(byName(d).id, ["configure terminal", ...lines, "end"]);

describe("multipath (bgp_mpath.c) on the bgp-policy lab", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetAll();
    S().loadFeatureLab("bgp-policy");
    advance(300);
  });
  afterEach(() => vi.useRealTimers());

  it("multipath-relax makes the two exits equal-cost: '=' in show, two ECMP routes; maximum-paths 1 limits it", () => {
    cli("E1", ["router bgp 65001", "bestpath as-path multipath-relax"]);
    advance(200);
    expect(sh("E1", "show ip bgp")).toMatch(/^ \*>  192\.168\.4\.0\/24   10\.0\.12\.2 .*\n \*= {19}10\.0\.13\.2 /m);
    const routes = byName("E1").routingTable.filter((r) => r.type === "bgp" && r.destination === "192.168.4.0");
    expect(routes.map((r) => r.nextHop).sort()).toEqual(["10.0.12.2", "10.0.13.2"]);
    expect(sh("E1", "show ip bgp 192.168.4.0/24")).toMatch(/valid, external, multipath, best \(Older Path\)/);
    expect(sh("E1", "show ip route")).toMatch(/B>\* 192\.168\.4\.0\/24 \[20\/0\] via 10\.0\.12\.2[\s\S]*via 10\.0\.13\.2/);
    expect(sh("H1", "ping -c 1 192.168.4.10")).toMatch(/1 received/);
    cli("E1", ["router bgp 65001", "address-family ipv4 unicast", "maximum-paths 1"]);
    advance(200);
    expect(byName("E1").routingTable.filter((r) => r.type === "bgp" && r.destination === "192.168.4.0")).toHaveLength(1);
    expect(sh("E1", "show ip bgp")).not.toContain(" *= ");
  });

  it("redistribute static with a route-map and table-map filtering on install", () => {
    cli("REMOTE", ["ip route 172.16.0.0/16 192.168.4.10", "ip route 172.17.0.0/16 192.168.4.10", "ip prefix-list S16 seq 5 permit 172.16.0.0/16", "route-map STATIC permit 10", "match ip address prefix-list S16", "set metric 77", "exit", "router bgp 65004", "address-family ipv4 unicast", "redistribute static route-map STATIC"]);
    advance(200);
    const t = sh("REMOTE", "show ip bgp");
    expect(t).toMatch(/^ \*>  172\.16\.0\.0\/16    192\.168\.4\.10 {12}77 {9}32768 \?$/m);
    expect(t).not.toContain("172.17.0.0");
    expect(byName("E1").routingTable.some((r) => r.type === "bgp" && r.destination === "172.16.0.0")).toBe(true);
    // table-map deny keeps the route in BGP but out of E1's RIB
    cli("E1", ["ip prefix-list NO172 seq 5 deny 172.16.0.0/16", "ip prefix-list NO172 seq 10 permit 0.0.0.0/0 le 32", "route-map TM permit 10", "match ip address prefix-list NO172", "exit", "router bgp 65001", "address-family ipv4 unicast", "table-map TM"]);
    advance(200);
    expect(sh("E1", "show ip bgp")).toContain("172.16.0.0/16");
    expect(byName("E1").routingTable.some((r) => r.type === "bgp" && r.destination === "172.16.0.0")).toBe(false);
    expect(byName("E1").routingTable.some((r) => r.type === "bgp" && r.destination === "192.168.4.0")).toBe(true);
  });
});
