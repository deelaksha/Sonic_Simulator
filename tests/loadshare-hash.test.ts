/** `ip load-share hash ...` drives ECMP next-hop selection (lib/protocols/loadshare-hash.ts). */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";
import { klish } from "./nat-helpers";
import { ecmpFlowHash } from "../lib/protocols/loadshare-hash";
import { flowHash5 } from "../lib/models/route";
import { createDevice } from "../lib/models/factory";
import { cpSet } from "../lib/commands/sonic-cli/config-plane";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(30_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

/** UDP packets S1 sends out of Ethernet0 / Ethernet1 for 24 flows H1 → 10.0.23.2 (different source ports). */
function spread(): { e0: number; e1: number } {
  const s1 = byName("S1");
  const port = (n: string) => s1.interfaces.find((i) => i.name === n)!.id;
  const before = S().captures.length;
  for (let p = 0; p < 24; p++) {
    S().startTraffic({ srcDeviceId: byName("H1").id, dstIp: "10.0.23.2", protocol: "udp", srcPort: 41000 + p, dstPort: 5001, size: 64, count: 1, intervalMs: 0, continuous: false });
    vi.advanceTimersByTime(100);
  }
  const sent = S().captures.slice(before).filter((c) => c.deviceId === s1.id && c.dir === "tx" && c.frame.udp?.dstPort === 5001);
  return { e0: sent.filter((c) => c.interfaceId === port("Ethernet0")).length, e1: sent.filter((c) => c.interfaceId === port("Ethernet1")).length };
}

describe("ECMP load-share hash fields", () => {
  it("excluding the L4 ports puts every flow between two hosts on one path", () => {
    S().loadFeatureLab("ospf");
    advance(25_000);
    const all = spread();
    expect(all.e0).toBeGreaterThan(0);
    expect(all.e1).toBeGreaterThan(0);

    klish("S1", "configure terminal", "no ip load-share hash ipv4 ipv4-l4-src-port", "no ip load-share hash ipv4 ipv4-l4-dst-port", "end");
    expect(klish("S1", "show ip load-share")).toContain("IPv4 Hash Fields      : ipv4-src-ip, ipv4-dst-ip, ipv4-ip-proto");
    const l3 = spread();
    expect(l3.e0 + l3.e1).toBe(24);
    expect(Math.min(l3.e0, l3.e1)).toBe(0);

    klish("S1", "configure terminal", "ip load-share hash ipv4 ipv4-l4-src-port", "end");
    const back = spread();
    expect(back.e0).toBeGreaterThan(0);
    expect(back.e1).toBeGreaterThan(0);
  });
});

describe("ecmpFlowHash", () => {
  const dev = () => createDevice({ id: "sw", type: "switch", name: "SW", x: 0, y: 0, ports: 2 });

  it("is the plain 5-tuple hash without config (backwards compatible)", () => {
    const d = dev();
    expect(ecmpFlowHash(d, "10.0.0.1", "10.0.0.2", "UDP", 1000, 2000)).toBe(flowHash5("10.0.0.1", "10.0.0.2", "UDP", 1000, 2000));
    cpSet(d, "loadshare", "algorithm", "crc"); // stored-only parameters do not change the hash
    expect(ecmpFlowHash(d, "10.0.0.1", "10.0.0.2", "UDP", 1000, 2000)).toBe(flowHash5("10.0.0.1", "10.0.0.2", "UDP", 1000, 2000));
  });

  it("a hash seed reshuffles flows; symmetric hashes both directions alike", () => {
    const d = dev();
    const pick = (p: number) => ecmpFlowHash(d, "10.0.0.1", "10.0.0.2", "UDP", 40000 + p, 5001) % 2;
    const before = Array.from({ length: 32 }, (_, p) => pick(p));
    cpSet(d, "loadshare", "seed", "12345");
    const after = Array.from({ length: 32 }, (_, p) => pick(p));
    expect(after).not.toEqual(before);
    expect(ecmpFlowHash(d, "10.0.0.1", "10.0.0.2", "TCP", 1, 2)).not.toBe(ecmpFlowHash(d, "10.0.0.2", "10.0.0.1", "TCP", 2, 1));
    cpSet(d, "loadshare", "ipv4", ["ipv4-src-ip", "ipv4-dst-ip", "ipv4-ip-proto", "ipv4-l4-src-port", "ipv4-l4-dst-port", "symmetric"].map((field) => ({ field })));
    expect(ecmpFlowHash(d, "10.0.0.1", "10.0.0.2", "TCP", 1, 2)).toBe(ecmpFlowHash(d, "10.0.0.2", "10.0.0.1", "TCP", 2, 1));
  });
});
