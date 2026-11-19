import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { longestPrefixMatch, flowHash5, Route } from "../lib/models/route";
import { peekDrops } from "../lib/control/drops";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(30_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

const r = (nh: string, iface: string): Route => ({ destination: "10.0.23.0", prefix: 30, nextHop: nh, interfaceId: iface, type: "ospf", metric: 8, distance: 110 });

describe("ECMP flow hashing", () => {
  it("equal-cost routes are chosen per flow: stable for a flow, spread across flows", () => {
    const table = [r("10.0.12.2", "e0"), r("10.0.13.2", "e1")];
    const pick = (sport: number) => longestPrefixMatch(table, "10.0.23.1", "default", flowHash5("192.168.1.10", "10.0.23.1", "UDP", sport, 5001))!.route.interfaceId;
    expect(pick(40000)).toBe(pick(40000));
    const used = new Set(Array.from({ length: 32 }, (_, i) => pick(40000 + i)));
    expect(used).toEqual(new Set(["e0", "e1"]));
    expect(longestPrefixMatch(table, "10.0.23.1")!.route.interfaceId).toBe("e0"); // no flow key → first
  });

  it("on the OSPF triangle, flows to S2–S3 link spread over both uplinks of S1", () => {
    S().loadFeatureLab("ospf");
    advance(25_000);
    const s1 = byName("S1");
    S().execCommand(s1.id, "exit");
    expect(out(S().execCommand(s1.id, "show ip route"))).toMatch(/O>\* 10\.0\.23\.0\/30 \[110\/8\] via 10\.0\.1[23]\.2[\s\S]*\*\s+via 10\.0\.1[23]\.2/);
    const tx0 = () => byName("S1").interfaces.find((i) => i.name === "Ethernet0")!.statistics.txFrames;
    const tx1 = () => byName("S1").interfaces.find((i) => i.name === "Ethernet1")!.statistics.txFrames;
    const [a0, a1] = [tx0(), tx1()];
    for (let p = 0; p < 24; p++) {
      S().startTraffic({ srcDeviceId: byName("H1").id, dstIp: "10.0.23.2", protocol: "udp", srcPort: 41000 + p, dstPort: 5001, size: 64, count: 5, intervalMs: 0, continuous: false });
      vi.advanceTimersByTime(100);
    }
    expect(tx0() - a0).toBeGreaterThan(10);
    expect(tx1() - a1).toBeGreaterThan(10);
  });
});

describe("drop counters, hardware data plane, protocol timeline, FDB timestamps", () => {
  it("drops are counted per interface with SAI drop reasons", () => {
    S().loadFeatureLab("ospf");
    advance(25_000);
    S().execCommand(byName("H1").id, "ping -c 2 203.0.113.9"); // no route on S1
    const d = peekDrops(byName("S1"))!;
    const total = Object.values(d).reduce((n, row) => n + (row.LPM4_MISS ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("hardware mode: tcpdump on a front-panel port shows CPU traffic only, not transit", () => {
    S().loadFeatureLab("ospf");
    advance(25_000);
    const s2 = byName("S2").id;
    S().setDataplaneMode(s2, "hardware");
    S().execCommand(s2, "sudo tcpdump -i Ethernet0 -nn");
    S().execCommand(byName("H1").id, "ping -c 2 10.0.12.2"); // to S2's own Ethernet0 address: trapped (IP2ME)
    advance(11_000); // OSPF Hellos to S2 (multicast → trapped)
    S().stopLiveCapture(s2);
    const lines = (S().terminals[s2] ?? []).map((l) => l.text).join("\n");
    expect(lines).toMatch(/ICMP echo request/);
    expect(lines).toMatch(/OSPFv2, Hello/);

    // VS mode on S1 shows transit ICMP; hardware mode on S1 hides it (S1 only forwards H1→H3).
    const s1 = byName("S1").id;
    S().setDataplaneMode(s1, "hardware");
    S().execCommand(s1, "sudo tcpdump -i Ethernet1 -nn icmp");
    S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10");
    S().stopLiveCapture(s1);
    const s1Lines = (S().terminals[s1] ?? []).map((l) => l.text).join("\n");
    expect(s1Lines).not.toMatch(/192\.168\.1\.10 > 192\.168\.3\.10: ICMP echo request/);
    expect(s1Lines).toContain("0 packets captured");
  });

  it("protocol daemon events populate the protocol timeline; MAC entries carry lastSeen", () => {
    S().loadFeatureLab("lacp");
    advance(5_000);
    expect(S().controlEvents.length).toBeGreaterThan(0);
    S().execCommand(byName("H1").id, "ping -c 1 192.168.10.13");
    const e = byName("S1").macTable.find((m) => m.mac === byName("H1").interfaces[0].mac);
    expect(Math.abs((e?.lastSeenMs ?? 0) - Date.now())).toBeLessThan(100);
  });
});
