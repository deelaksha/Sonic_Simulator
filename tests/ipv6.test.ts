import { describe, it, expect } from "vitest";
import {
  parseIpv6,
  formatIpv6,
  normalizeIpv6,
  isValidIpv6,
  network6,
  networkAddress6,
  sameSubnet6,
  contains6,
  isLinkLocal6,
} from "../lib/models/ipv6";

describe("IPv6 address math", () => {
  it("parses and round-trips full + compressed forms", () => {
    expect(normalizeIpv6("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(normalizeIpv6("2001:DB8::0001")).toBe("2001:db8::1");
    expect(normalizeIpv6("::1")).toBe("::1");
    expect(normalizeIpv6("::")).toBe("::");
    expect(normalizeIpv6("fe80::200:ff:fe00:1")).toBe("fe80::200:ff:fe00:1");
  });

  it("round-trips through BigInt", () => {
    const n = parseIpv6("2001:db8:abcd:12::9")!;
    expect(formatIpv6(n)).toBe("2001:db8:abcd:12::9");
  });

  it("rejects malformed addresses", () => {
    expect(isValidIpv6("2001:db8:::1")).toBe(false); // double ::
    expect(isValidIpv6("gggg::1")).toBe(false);
    expect(isValidIpv6("1:2:3:4:5:6:7")).toBe(false); // too few groups, no ::
    expect(isValidIpv6("12345::1")).toBe(false); // group too long
  });

  it("computes network + subnet membership", () => {
    expect(networkAddress6("2001:db8:1:2::abcd", 64)).toBe("2001:db8:1:2::");
    expect(sameSubnet6("2001:db8::10", "2001:db8::20", 64)).toBe(true);
    expect(sameSubnet6("2001:db8:1::10", "2001:db8:2::10", 64)).toBe(false);
    expect(contains6("2001:db8::", 32, "2001:db8:ffff::1")).toBe(true);
    expect(contains6("2001:db8::", 32, "2001:db9::1")).toBe(false);
  });

  it("detects link-local fe80::/10", () => {
    expect(isLinkLocal6("fe80::1")).toBe(true);
    expect(isLinkLocal6("2001:db8::1")).toBe(false);
  });

  it("network() masks correctly at /64", () => {
    expect(formatIpv6(network6("2001:db8:0:1:aaaa:bbbb:cccc:dddd", 64))).toBe("2001:db8:0:1::");
  });
});
