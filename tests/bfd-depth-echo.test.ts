/**
 * BFD echo function (FRR bfdd echo-mode): UDP 3785 packets with src = dst = our
 * address, looped back by the peer's forwarding plane; echo-based detection; and
 * `config feature state bgp disabled` stopping bfdd.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { findSession } from "../lib/protocols/bfd-daemon";

const klish = (dev: string, lines: string[]) => S().runCliScript(byName(dev).id, lines);
const bash = (dev: string, cmd: string) => {
  S().execCommand(byName(dev).id, "exit");
  return out(S().execCommand(byName(dev).id, cmd));
};
const sess = (dev: string, peer: string) => findSession(byName(dev), peer)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetAll();
  S().loadFeatureLab("bfd");
  advance(3000);
});
afterEach(() => vi.useRealTimers());

const enableEcho = () => klish("S1", ["configure terminal", "bfd", "peer 10.0.12.2 interface Ethernet0", "echo-mode", "end"]);

describe("BFD echo mode", () => {
  it("S1 sends echoes that S2's data plane loops back; counters, RTT and show fields", () => {
    expect(sess("S1", "10.0.12.2").state).toBe(3);
    enableEcho();
    advance(1000);
    const s = sess("S1", "10.0.12.2");
    expect(s.echoActive).toBe(true);
    expect(s.echoXmtTO).toBe(50); // max(remote required min echo rx 50, desired 50)
    expect(s.echoDetectTO).toBe(150);
    expect(s.stats.txEcho).toBeGreaterThanOrEqual(9);
    expect(s.stats.rxEcho).toBe(s.stats.txEcho);
    expect(sess("S2", "10.0.12.1").stats.rxEcho).toBe(0); // bfdd on S2 never sees them
    // On the wire: src = dst = 10.0.12.1, UDP 3785, TTL 255 out of S1, 254 back from S2.
    const s1 = byName("S1").id;
    const s2 = byName("S2").id;
    const echo = (dev: string, dir: string) =>
      S().captures.filter((c) => c.deviceId === dev && c.dir === dir && c.frame.udp?.dstPort === 3785).map((c) => c.frame.ipv4!);
    expect(echo(s1, "tx")[0]).toMatchObject({ srcIp: "10.0.12.1", dstIp: "10.0.12.1", ttl: 255 });
    expect(echo(s2, "tx")[0]).toMatchObject({ srcIp: "10.0.12.1", dstIp: "10.0.12.1", ttl: 254 });

    const peer = bash("S1", "show bfd peer 10.0.12.2");
    expect(peer).toContain("\t\t\tEcho transmission interval: 50ms");
    expect(peer).toMatch(/\t\tRTT min\/avg\/max: \d+\/\d+\/\d+ usec/);
    const counters = bash("S1", "show bfd peer 10.0.12.2 counters");
    expect(counters).toMatch(new RegExp(`Echo packet input: ${s.stats.rxEcho} packets`));
    // The peer without echo-mode still prints "disabled".
    expect(bash("S2", "show bfd peer 10.0.12.1")).toContain("\t\t\tEcho transmission interval: disabled");
  });

  it("echo-interval raises the echo rate floor; no echo-mode stops it", () => {
    enableEcho();
    klish("S1", ["configure terminal", "bfd", "peer 10.0.12.2 interface Ethernet0", "echo-interval 200", "end"]);
    advance(1000);
    expect(sess("S1", "10.0.12.2").echoXmtTO).toBe(200);
    expect(sess("S1", "10.0.12.2").requiredMinEchoRx).toBe(200);
    klish("S1", ["configure terminal", "bfd", "peer 10.0.12.2 interface Ethernet0", "no echo-mode", "end"]);
    const before = sess("S1", "10.0.12.2").stats.txEcho;
    advance(1000);
    expect(sess("S1", "10.0.12.2").echoActive).toBe(false);
    expect(sess("S1", "10.0.12.2").stats.txEcho).toBe(before);
  });

  it("echo detection (3 × 50 ms) brings the session down with diag 'echo function failed' before control detection", () => {
    enableEcho();
    advance(500);
    // S2 stops forwarding on Ethernet0 (admin down: frames to it are dropped).
    bash("S2", "sudo config interface shutdown Ethernet0");
    const t0 = Date.now();
    let downAt = 0;
    for (let i = 0; i < 20 && !downAt; i++) {
      advance(100);
      if (sess("S1", "10.0.12.2").state === 1) downAt = Date.now();
    }
    expect(downAt - t0).toBeLessThan(500); // control detection alone would take 900 ms
    expect(sess("S1", "10.0.12.2").localDiag).toBe(2);
    expect(sess("S1", "10.0.12.2").echoActive).toBe(false);
    expect(bash("S1", "show bfd peer 10.0.12.2")).toContain("\t\tDiagnostics: echo function failed");
  });
});

describe("feature bgp disabled stops bfdd", () => {
  it("sessions vanish on S1 (no packets), S2 detects the loss; re-enable re-forms them", () => {
    bash("S1", "sudo config feature state bgp disabled");
    advance(200);
    expect(findSession(byName("S1"), "10.0.12.2")).toBeUndefined();
    const tx = () => S().captures.filter((c) => c.deviceId === byName("S1").id && c.dir === "tx" && c.frame.udp?.dstPort === 3784).length;
    const before = tx();
    advance(1500);
    expect(tx()).toBe(before);
    expect(sess("S2", "10.0.12.1").state).toBe(1);
    expect(sess("S2", "10.0.12.1").localDiag).toBe(1);
    bash("S1", "sudo config feature state bgp enabled");
    advance(3000);
    expect(sess("S1", "10.0.12.2").state).toBe(3);
    expect(sess("S2", "10.0.12.1").state).toBe(3);
  });
});
