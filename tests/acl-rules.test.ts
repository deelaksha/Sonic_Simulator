/** Pure tests of the ACL rule parser / matcher / renderers (lib/protocols/acl-rules.ts). */
import { describe, it, expect } from "vitest";
import { parseRule, ruleMatches, ruleData, ruleFields, implicitDenyApplies, AclParseError } from "../lib/protocols/acl-rules";
import { Frame } from "../lib/models/packet";

const base = (over: Partial<Frame>): Frame => ({
  id: "f",
  ethernet: { srcMac: "02:00:00:00:00:01", dstMac: "02:00:00:00:00:02", etherType: "IPv4" },
  meta: { sizeBytes: 100, summary: "t" },
  ...over,
});
const v6 = (src: string, dst: string, tcpDst?: number): Frame =>
  base({
    ethernet: { srcMac: "02:00:00:00:00:01", dstMac: "02:00:00:00:00:02", etherType: "IPv6" },
    ipv6: { srcIp: src, dstIp: dst, hopLimit: 64, nextHeader: tcpDst ? "TCP" : "ICMPv6" },
    ...(tcpDst ? { tcp: { srcPort: 5000, dstPort: tcpDst, seq: 0, ack: 0, flags: ["SYN"], window: 0 } } : { icmp6: { type: "echo-request", code: 0 } }),
  });

describe("ACL rule parsing and matching", () => {
  it("IPv6: prefix, host, tcp port, icmpv6; IPv4 rules never see IPv6", () => {
    const r = parseRule("ipv6", "tcp 2001:db8::/32 host 2001:db8:1::10 eq 443");
    expect(ruleMatches(r, v6("2001:db8:5::1", "2001:db8:1::10", 443), null)).toBe(true);
    expect(ruleMatches(r, v6("2001:db9::1", "2001:db8:1::10", 443), null)).toBe(false);
    expect(ruleMatches(r, v6("2001:db8:5::1", "2001:db8:1::10", 80), null)).toBe(false);
    expect(ruleMatches(parseRule("ipv6", "icmpv6 any any"), v6("::1", "::2"), null)).toBe(true);
    expect(ruleMatches(parseRule("ip", "ip any any"), v6("::1", "::2"), null)).toBe(false);
    expect(implicitDenyApplies("ipv6", v6("::1", "::2"))).toBe(true);
    expect(implicitDenyApplies("ip", v6("::1", "::2"))).toBe(false);
    expect(ruleData("ipv6", { seq: 1, action: "permit", match: "tcp 2001:0db8::/32 host 2001:db8:1::10 eq 443" })).toBe("permit tcp 2001:db8::/32 host 2001:db8:1::10 eq 443");
  });

  it("ARP is not matched by an IPv4 rule nor caught by the IPv4 implicit deny", () => {
    const arp = base({ ethernet: { srcMac: "02:00:00:00:00:01", dstMac: "FF:FF:FF:FF:FF:FF", etherType: "ARP" } });
    expect(ruleMatches(parseRule("ip", "ip any any"), arp, null)).toBe(false);
    expect(implicitDenyApplies("ip", arp)).toBe(false);
    expect(implicitDenyApplies("mac", arp)).toBe(false);
  });

  it("MAC: mask, ethertype, vlan, pcp", () => {
    const r = parseRule("mac", "02:00:00:00:00:00 ff:ff:ff:00:00:00 any ip vlan 10 pcp be");
    const f = base({ vlan: { vlanId: 10, priority: 0 } });
    expect(ruleMatches(r, f, null)).toBe(true);
    expect(ruleMatches(r, { ...f, vlan: { vlanId: 11, priority: 0 } }, null)).toBe(false);
    expect(ruleMatches(r, base({ ethernet: { srcMac: "04:00:00:00:00:01", dstMac: "x", etherType: "IPv4" } }), 10)).toBe(false);
    expect(ruleData("mac", { seq: 1, action: "deny", match: "02:00:00:00:00:00 ff:ff:ff:00:00:00 any ip vlan 10 pcp 0" })).toBe("deny 02:00:00:00:00:00 ff:ff:ff:00:00:00 any ip vlan 10 pcp be");
    expect(ruleFields("mac", { seq: 10, action: "deny", match: "host 02:00:00:00:00:01 any arp" })).toEqual({
      PRIORITY: "65526", PACKET_ACTION: "DROP", IP_TYPE: "ANY", SRC_MAC: "02:00:00:00:00:01", ETHER_TYPE: "0x0806",
    });
  });

  it("port operators map to CONFIG_DB ranges and render back as typed (sonic_cli_acl.py:389-414)", () => {
    const rule = { seq: 5, action: "permit", match: "udp any gt 1023 10.0.0.0/8 lt 100 dscp 46" };
    expect(ruleData("ip", rule)).toBe("permit udp any gt 1023 10.0.0.0/8 lt 100 dscp ef");
    expect(ruleFields("ip", rule)).toMatchObject({ L4_SRC_PORT_RANGE: "1024-65535", L4_DST_PORT_RANGE: "0-99", DSCP: "46", IP_PROTOCOL: "17" });
    expect(ruleFields("ip", { seq: 1, action: "deny", match: "tcp any any syn not-ack" }).TCP_FLAGS).toBe("0x02/0x12");
  });

  it("rejects invalid input", () => {
    expect(() => parseRule("ip", "tcp any any range 20 10")).toThrow(AclParseError);
    expect(() => parseRule("ip", "icmp any any eq 80")).toThrow(AclParseError); // ports only for tcp/udp
    expect(() => parseRule("ip", "ip 300.1.1.1/24 any")).toThrow(AclParseError);
    expect(() => parseRule("mac", "any any 0x0100")).toThrow(AclParseError);
  });
});
