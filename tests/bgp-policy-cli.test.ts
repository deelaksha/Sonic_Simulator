import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, byName, out } from "./control-helpers";
import { getBgpConfig } from "../lib/protocols/bgp";
import { peekBgpLists } from "../lib/protocols/bgp-policy";

const sh = (d: string, cmd: string) => out(S().execCommand(byName(d).id, cmd));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("bgp");
});
afterEach(() => vi.useRealTimers());

describe("BGP policy config (KLISH → Click → config store)", () => {
  it("neighbor AF policy, ipv6 activation, maximum-paths, redistribute with route-map land in the store", () => {
    S().runCliScript(byName("S1").id, [
      "configure terminal",
      "router bgp 65001",
      "bestpath as-path multipath-relax",
      "neighbor 10.0.12.2",
      "address-family ipv4 unicast",
      "route-map RM-IN in",
      "prefix-list PL-OUT out",
      "weight 100",
      "exit",
      "address-family ipv6 unicast",
      "activate",
      "route-map RM6 out",
      "exit",
      "exit",
      "address-family ipv4 unicast",
      "maximum-paths 4",
      "maximum-paths ibgp 2",
      "redistribute static route-map ST metric 50",
      "table-map TM",
      "exit",
      "address-family ipv6 unicast",
      "network 2001:DB8:1::1/64",
      "redistribute connected",
      "neighbor 10.0.13.2 activate",
      "end",
    ]);
    const cfg = getBgpConfig(byName("S1"))!;
    expect(cfg.multipathRelax).toBe(true);
    expect(cfg.neighbors.find((n) => n.peer === "10.0.12.2")).toMatchObject({ ipv6: true, af: { ipv4: { routeMapIn: "RM-IN", prefixListOut: "PL-OUT", weight: 100 }, ipv6: { routeMapOut: "RM6" } } });
    expect(cfg.neighbors.find((n) => n.peer === "10.0.13.2")!.ipv6).toBe(true);
    expect(cfg).toMatchObject({ maxPaths: 4, maxPathsIbgp: 2, tableMap: "TM", redist: { static: { routeMap: "ST", metric: 50 } } });
    expect(cfg.ipv6).toMatchObject({ networks: ["2001:db8:1::/64"], redist: { connected: {} } });
    // `no` forms
    S().runCliScript(byName("S1").id, ["configure terminal", "router bgp 65001", "neighbor 10.0.12.2", "address-family ipv4 unicast", "no route-map RM-IN in", "no weight", "end"]);
    expect(getBgpConfig(byName("S1"))!.neighbors.find((n) => n.peer === "10.0.12.2")!.af!.ipv4).toEqual({ prefixListOut: "PL-OUT" });
  });

  it("VRF instance enters a VRF-scoped view; community-list / as-path-list validation", () => {
    S().runCliScript(byName("S1").id, ["configure terminal", "router bgp 65009 vrf Vrf-blue", "neighbor 10.9.9.9", "remote-as 65010", "end"]);
    expect(getBgpConfig(byName("S1"), "Vrf-blue")).toMatchObject({ localAs: 65009, vrf: "Vrf-blue", neighbors: [{ peer: "10.9.9.9", remoteAs: 65010 }] });
    expect(getBgpConfig(byName("S1"))!.neighbors.some((n) => n.peer === "10.9.9.9")).toBe(false);
    sh("S1", "configure terminal");
    expect(sh("S1", "bgp community-list standard C1 permit 65001:100 no-export any")).not.toContain("%");
    expect(sh("S1", "bgp community-list standard C1 permit 70000:1")).toContain("% Malformed community-list value");
    expect(sh("S1", "bgp as-path-list A1 seq 10 permit ^65002$")).not.toContain("%");
    expect(sh("S1", "bgp as-path-list A1 permit (")).toContain("% Invalid AS path regular expression");
    expect(peekBgpLists(byName("S1"))).toMatchObject({ community: { C1: [{ seq: 5, action: "permit", members: ["65001:100", "no-export"], any: true }] }, aspath: { A1: [{ seq: 10, action: "permit", regex: "^65002$" }] } });
    expect(sh("S1", "ipv6 prefix-list P6 seq 5 permit 2001:db8::/32 ge 129")).toContain("Invalid input");
    expect(sh("S1", "ipv6 prefix-list P6 seq 5 permit 2001:db8::/32 ge 48")).not.toContain("%");
    sh("S1", "end");
    expect(sh("S1", "show bgp community-list C1")).toBe("Named Community standard list C1\n    permit 65001:100 no-export");
    expect(sh("S1", "show ipv6 prefix-list")).toBe("IPv6 prefix list P6:\nseq 5 permit 2001:db8::/32 ge 48 le 128");
  });
});
