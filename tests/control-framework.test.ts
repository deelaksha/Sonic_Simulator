import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerDaemon } from "../lib/control";
import { registerLab } from "../lib/labs";
import { routedTriangle } from "../lib/labs/topologies";
import { transmitL2 } from "../lib/control/packet";
import { featureState } from "../lib/models/feature-state";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

registerLab("test-triangle", (api) => routedTriangle(api));

// A tiny daemon: every 1 s each switch sends a link-local frame out of every up port.
registerDaemon({
  id: "test-hello",
  nextDue: (d) => (d.type === "switch" ? (d.config.features?.["test-hello"] as { next?: number } | undefined)?.next ?? 0 : undefined),
  tick(ctx, d, now) {
    const st = featureState<{ next?: number; rx: string[] }>(d, "test-hello", () => ({ rx: [] }));
    st.next = now + 1000;
    for (const p of d.interfaces) if (!p.management && !p.logical && p.operState === "up") transmitL2(ctx, d, p, "01:80:C2:00:00:0E", 0x88b5, [1, 2, 3], "test hello");
    return true;
  },
  receiveL2(_ctx, d, ingress, f) {
    if (f.ethernet.typeCode !== 0x88b5) return false;
    featureState<{ rx: string[] }>(d, "test-hello", () => ({ rx: [] })).rx.push(`${ingress.name}<-${f.ethernet.srcMac}`);
    return true;
  },
  describe: (f) => (f.ethernet.typeCode === 0x88b5 ? "TEST-HELLO, length 3" : undefined),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("test-triangle");
});
afterEach(() => vi.useRealTimers());

describe("control-plane framework", () => {
  it("routed switch ports forward at L3; remote subnets need a routing protocol", () => {
    expect(out(S().execCommand(byName("H1").id, "ping -c 1 192.168.1.1"))).toMatch(/1 received/);
    S().execCommand(byName("S1").id, "exit");
    expect(out(S().execCommand(byName("S1").id, "ping -c 1 10.0.12.2"))).toMatch(/1 received/);
    expect(out(S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10"))).toMatch(/0 received|unreachable|100% packet loss/);
  });

  it("daemon ticks send link-local frames that neighbours consume and bridges never forward", () => {
    const s3 = byName("S3").id;
    S().execCommand(s3, "sudo tcpdump -i Ethernet0 -nn -c 1");
    advance(2500);
    const rx = (byName("S2").config.features?.["test-hello"] as { rx: string[] }).rx;
    expect(rx.some((r) => r.startsWith("Ethernet0<-"))).toBe(true);
    expect(rx.some((r) => r.startsWith("Ethernet1<-"))).toBe(true);
    // The MGMT L2 switch sends its own hellos to eth0 but never bridges S1's/S3's.
    const peerMacs = [byName("S1"), byName("S3")].flatMap((d) => d.interfaces.map((i) => i.mac));
    expect(rx.filter((r) => r.startsWith("eth0")).every((r) => !peerMacs.includes(r.split("<-")[1]))).toBe(true);
    expect((S().terminals[s3] ?? []).some((l) => /TEST-HELLO, length 3$/.test(l.text))).toBe(true);
  });

  it("controlTick does nothing (no commit) when no daemon is due", () => {
    advance(1500);
    const before = S().network;
    S().controlTick(); // same instant: nothing due
    expect(S().network).toBe(before);
  });
});
