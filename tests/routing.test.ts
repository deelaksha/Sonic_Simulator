import { describe, it, expect } from "vitest";
import { longestPrefixMatch, Route } from "../lib/models/route";
import { sameSubnet, cidrContains, networkAddress } from "../lib/models/ip";

const table: Route[] = [
  { destination: "192.168.1.0", prefix: 24, nextHop: null, interfaceId: "e0", type: "connected", metric: 0 },
  { destination: "10.0.0.0", prefix: 8, nextHop: "192.168.1.2", interfaceId: "e0", type: "static", metric: 1 },
  { destination: "10.1.0.0", prefix: 16, nextHop: "192.168.1.3", interfaceId: "e0", type: "static", metric: 1 },
  { destination: "0.0.0.0", prefix: 0, nextHop: "192.168.1.254", interfaceId: "e0", type: "default", metric: 1 },
];

describe("routing (spec §9)", () => {
  it("prefers the most specific (longest) prefix", () => {
    const m = longestPrefixMatch(table, "10.1.2.3");
    expect(m?.route.prefix).toBe(16);
    expect(m?.nextHopIp).toBe("192.168.1.3");
  });

  it("falls back to the default route", () => {
    const m = longestPrefixMatch(table, "8.8.8.8");
    expect(m?.route.type).toBe("default");
    expect(m?.nextHopIp).toBe("192.168.1.254");
  });

  it("treats a connected route as on-link (next hop = destination)", () => {
    const m = longestPrefixMatch(table, "192.168.1.50");
    expect(m?.route.type).toBe("connected");
    expect(m?.nextHopIp).toBe("192.168.1.50");
  });

  it("returns null when there is no matching route", () => {
    const noDefault = table.filter((r) => r.type !== "default");
    expect(longestPrefixMatch(noDefault, "8.8.8.8")).toBeNull();
  });

  it("subnet math", () => {
    expect(sameSubnet("192.168.1.10", "192.168.1.20", 24)).toBe(true);
    expect(sameSubnet("192.168.1.10", "192.168.2.20", 24)).toBe(false);
    expect(cidrContains("10.0.0.0", 8, "10.9.9.9")).toBe(true);
    expect(networkAddress("192.168.1.77", 24)).toBe("192.168.1.0");
  });
});
