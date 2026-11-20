/**
 * Flow-level bandwidth / QoS model on fake time, driven through the QoS lab:
 * H1, H2 (1G NICs) → S1 (25G, routed) → Ethernet2 → H3 (1G).
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";
import { iperf, sw, summaryRate } from "./qos-helpers";
import { peekFeatureState } from "../lib/models/feature-state";
import { peekDrops } from "../lib/control/drops";
import { QueueCounters, PfcCounters, fairShare, schedule } from "../lib/protocols/qos-model";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(40_000_000);
  resetAll();
  S().loadFeatureLab("qos");
  iperf(byName("H3").id, "iperf3 -s");
});
afterEach(() => vi.useRealTimers());

const H1 = () => byName("H1").id;
const H2 = () => byName("H2").id;
const S1 = () => byName("S1").id;
const queues = (port = "Ethernet2") => peekFeatureState<QueueCounters>(byName("S1"), "qos-queues")?.[port] ?? [];
const port = (name: string) => byName("S1").interfaces.find((i) => i.name === name)!;

describe("scheduler primitives", () => {
  it("water-filling and strict/DWRR scheduling", () => {
    expect(fairShare(10, [2, Infinity, Infinity])).toEqual([2, 4, 4]);
    expect(schedule(12, [Infinity, Infinity], [{ strict: false, weight: 1 }, { strict: false, weight: 5 }])).toEqual([2, 10]);
    expect(schedule(10, [Infinity, 3], [{ strict: false, weight: 1 }, { strict: true, weight: 1 }])).toEqual([7, 3]);
  });
});

describe("bottleneck throughput", () => {
  it("a single TCP flow gets the bottleneck rate (1G NIC → 941 Mbit/s goodput)", () => {
    const r = iperf(H1(), "iperf3 -c 192.168.3.10 -t 5");
    expect(summaryRate(r, "sender")).toBeGreaterThan(930);
    expect(summaryRate(r, "sender")).toBeLessThan(950);
    expect(r).toMatch(/\[  5\]\s+4\.00-5\.00\s+sec\s+112 MBytes\s+941 Mbits\/sec\s+0/);
  });

  it("lowering the egress port speed lowers TCP throughput to that link", () => {
    expect(sw(S1(), "config interface speed Ethernet2 100")).not.toMatch(/Error/);
    const r = iperf(H1(), "iperf3 -c 192.168.3.10 -t 3");
    expect(summaryRate(r, "receiver")).toBeGreaterThan(92);
    expect(summaryRate(r, "receiver")).toBeLessThan(95);
  });

  it("port counters show utilisation on every hop", () => {
    iperf(H1(), "iperf3 -c 192.168.3.10 -t 10");
    advance(1000);
    const tx0 = port("Ethernet2").statistics.txBytes;
    const rx0 = port("Ethernet0").statistics.rxBytes;
    advance(2000);
    const bps = ((port("Ethernet2").statistics.txBytes - tx0) * 8) / 2;
    // 941 Mbit/s goodput ≈ 987 Mbit/s of L2 frames (1518 of 1538 wire bytes).
    expect(bps / 1e6).toBeGreaterThan(960);
    expect(bps / 1e6).toBeLessThan(1000);
    expect(port("Ethernet0").statistics.rxBytes - rx0).toBeCloseTo(port("Ethernet2").statistics.txBytes - tx0, -5);
  });
});

describe("scheduling between competing flows", () => {
  it("two TCP flows share the congested egress per DWRR weight (UC1 w2 : UC5 w10)", () => {
    iperf(H1(), "iperf3 -c 192.168.3.10 -S 40 -t 20"); // DSCP 10 → TC1 → UC1
    const r = iperf(H2(), "iperf3 -c 192.168.3.10 -S 184 -t 10"); // DSCP 46 → TC5 → UC5
    expect(summaryRate(r, "sender")).toBeGreaterThan(770); // 10/12 of 941
    expect(summaryRate(r, "sender")).toBeLessThan(800);
    const before = Array.from({ length: 8 }, (_, i) => queues()[i]?.bytes ?? 0);
    advance(5000);
    const d1 = queues()[1].bytes - before[1];
    const d5 = queues()[5].bytes - before[5];
    expect(d5 / d1).toBeGreaterThan(4.8);
    expect(d5 / d1).toBeLessThan(5.2);
  });

  it("strict priority serves UC5 first; the DWRR queue gets the remainder", () => {
    sw(S1(), "config qos interface bind Ethernet2 scheduler-policy LAB-STRICT");
    iperf(H1(), "iperf3 -c 192.168.3.10 -u -b 300M -S 184 -t 20");
    const tcp = iperf(H2(), "iperf3 -c 192.168.3.10 -S 40 -t 5");
    // 300M UDP payload = 313.6M on the wire, leaving ~686M wire → ~646M TCP goodput.
    expect(summaryRate(tcp, "sender")).toBeGreaterThan(630);
    expect(summaryRate(tcp, "sender")).toBeLessThan(660);
    // A greedy TCP flow in the strict queue starves the other queue.
    const strictTcp = iperf(H1(), "iperf3 -c 192.168.3.10 -S 184 -t 5");
    expect(summaryRate(strictTcp, "sender")).toBeGreaterThan(600);
  });

  it("finished flows retire and the queue drains", () => {
    iperf(H1(), "iperf3 -c 192.168.3.10 -t 2");
    iperf(H2(), "iperf3 -c 192.168.3.10 -t 2");
    advance(1000);
    expect(queues()[0].occ).toBeGreaterThan(0);
    advance(2000);
    expect(queues()[0].occ).toBe(0);
    expect(queues()[0].wm).toBeGreaterThan(0);
    expect(peekFeatureState<{ flows: unknown[] }>(byName("H1"), "qos-flows")!.flows).toHaveLength(0);
  });
});

describe("drops, WRED and PFC", () => {
  it("UDP over capacity shows receiver loss, queue drops, txDropped and drop counters", () => {
    sw(S1(), "config interface speed Ethernet2 100");
    const r = iperf(H1(), "iperf3 -c 192.168.3.10 -u -b 200M -t 5");
    const m = /(\d+)\/(\d+) \((\d+)%\)\s+receiver/.exec(r)!;
    expect(Number(m[3])).toBeGreaterThanOrEqual(45);
    expect(Number(m[3])).toBeLessThanOrEqual(55);
    expect(summaryRate(r, "receiver")).toBeGreaterThan(93);
    advance(2000);
    expect(queues()[0].dropPkts).toBeGreaterThan(10000);
    expect(queues()[0].dropBytes).toBe(queues()[0].dropPkts * 1506);
    expect(port("Ethernet2").statistics.txDropped).toBe(queues()[0].dropPkts);
    expect(peekDrops(byName("S1"))?.Ethernet2?.EGRESS_QUEUE).toBe(queues()[0].dropPkts);
    expect(queues()[0].occ).toBe(1_048_576); // tail drop: queue full
  });

  it("WRED drops early and holds the queue near its max threshold", () => {
    sw(S1(), "config interface speed Ethernet2 100");
    sw(S1(), "config qos interface bind Ethernet2 wred-policy LAB-WRED"); // green 100-600 KB, 20%
    iperf(H1(), "iperf3 -c 192.168.3.10 -u -b 110M -t 5"); // ~10% over → p 0.1 < max_p 0.2
    advance(1000);
    const occ = queues()[0].occ;
    expect(occ).toBeGreaterThan(100 * 1024);
    expect(occ).toBeLessThan(600 * 1024);
    expect(queues()[0].wredDropPkts).toBe(queues()[0].dropPkts);
    expect(queues()[0].dropPkts).toBeGreaterThan(0);
  });

  it("a PFC-enabled queue pauses the senders instead of dropping", () => {
    sw(S1(), "config pfc priority Ethernet2 3 on");
    iperf(H1(), "iperf3 -c 192.168.3.10 -u -b 800M -S 104 -t 20"); // DSCP 26 → TC3 → UC3
    const r = iperf(H2(), "iperf3 -c 192.168.3.10 -u -b 800M -S 104 -t 5");
    expect(r).toMatch(/ 0\/\d+ \(0%\)\s+receiver/);
    expect(summaryRate(r, "sender")).toBeLessThan(500); // paused to half the 1G egress
    advance(3000);
    expect(queues()[3].dropPkts).toBe(0);
    expect(queues()[3].pkts).toBeGreaterThan(100000);
    const pfc = peekFeatureState<PfcCounters>(byName("S1"), "qos-pfc")!;
    expect(pfc.Ethernet0.tx[3]).toBeGreaterThan(10);
    expect(pfc.Ethernet1.tx[3]).toBeGreaterThan(10);
    expect(pfc.Ethernet0.tx[0]).toBe(0);
    // the same load on a lossy queue drops
    iperf(H1(), "iperf3 -c 192.168.3.10 -u -b 800M -t 3");
    const lossy = iperf(H2(), "iperf3 -c 192.168.3.10 -u -b 800M -t 3");
    expect(lossy).not.toMatch(/ 0\/\d+ \(0%\)\s+receiver/);
  });
});

describe("DSCP → TC → queue", () => {
  it("maps by the ingress dscp-tc map, the egress tc-queue map, and the HwSKU default (all TC 0)", () => {
    const sent = (tos: number, host = H1()) => {
      const before = Array.from({ length: 8 }, (_, i) => queues()[i]?.pkts ?? 0);
      iperf(host, `iperf3 -c 192.168.3.10 -u -b 10M -S ${tos} -t 1`);
      advance(1200);
      return queues().map((q, i) => q.pkts - before[i]).findIndex((d) => d > 0);
    };
    expect(sent(104)).toBe(3); // DSCP 26
    expect(sent(184)).toBe(5); // DSCP 46
    expect(sent(72)).toBe(0); // DSCP 18: not in LAB-DSCP → TC 0
    sw(S1(), "config qos map tc-queue add TQ 5 6");
    sw(S1(), "config qos interface bind Ethernet2 tc-queue TQ");
    expect(sent(184)).toBe(6);
    sw(S1(), "config qos interface unbind Ethernet0 dscp-tc");
    expect(sent(104)).toBe(0); // HwSKU default DSCP_TO_TC_MAP: every DSCP → 0
  });
});

describe("multi-hop path", () => {
  it("traces through routed switches and counts the queue on every switch hop", () => {
    S().loadFeatureLab("acl"); // H1 → S1 Ethernet1 → S3 Ethernet2 → H3 (static routes)
    iperf(byName("H3").id, "iperf3 -s");
    const r = iperf(byName("H1").id, "iperf3 -c 192.168.3.10 -t 3");
    expect(summaryRate(r, "sender")).toBeGreaterThan(930);
    advance(1500);
    const q = (dev: string, p: string) => peekFeatureState<QueueCounters>(byName(dev), "qos-queues")?.[p]?.[0].pkts ?? 0;
    expect(q("S1", "Ethernet1")).toBeGreaterThan(50000);
    expect(q("S3", "Ethernet2")).toBe(q("S1", "Ethernet1"));
  });
});
