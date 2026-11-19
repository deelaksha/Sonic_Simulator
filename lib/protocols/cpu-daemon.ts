/**
 * CPU (control-plane) path of a SONiC switch: hostif traps → trap group → CoPP
 * policer → CPU queue.
 *
 * The engine calls trapToCpu() (lib/control/hooks.ts) for every frame that
 * reaches a device's CPU; our toCpu hook, on SONiC switches only:
 *   1. classifies the frame into SAI hostif trap ids (cpu-traps.ts),
 *   2. picks the installed trap and its trap group — the KLISH policy-map
 *      binding if one claims the trap id, else copp_cfg.j2's COPP_TRAP/GROUP
 *      (copporch: trap → hostif trap group → policer, copporch.cpp:729-800),
 *   3. runs the group's single-rate token-bucket policer (sr_tcm, cir/cbs in
 *      packets or bytes per meter_type; red_action drop) — a red packet is
 *      dropped and the engine reports it as COPP_POLICER,
 *   4. counts per trap (show copp counters: COUNTERS_TRAP_NAME_MAP flow
 *      counters, xfmr_copp.go:157-238), per trap group, and per CPU queue
 *      (features["cpu-queues"], rendered by `show queue counters CPU`).
 * Trap actions drop/deny discard the packet. A packet whose receiving process
 * lives in a container whose FEATURE is disabled (`config feature state`) is
 * dropped after the policer (no listener: the container is stopped).
 *
 * Routers and hosts are not SONiC: the hook lets everything through.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { featureState, peekFeatureState } from "../models/feature-state";
import { registerDataPlaneHook } from "../control/hooks";
import { registerDaemon } from "../control/daemon";
import { classifyTrap, isSonicSwitch, trapFor, CoppGroup } from "./cpu-traps";
import { featureEnabled } from "./cpu-features";

export interface PktCounter {
  pkts: number;
  bytes: number;
  dropPkts: number;
  dropBytes: number;
}

/** features["cpu-queues"]: contract with the QoS agent (`show queue counters CPU`). */
export type CpuQueues = Record<string, PktCounter>;

export interface TrapCounter {
  pkts: number;
  bytes: number;
  pps: number;
  /** pkts at the last rate sample. */
  lastPkts: number;
}

interface Bucket {
  tokens: number;
  lastMs: number;
  cir: number;
  cbs: number;
  meterType: string;
}

export interface CoppRuntime {
  traps: Record<string, TrapCounter>;
  groups: Record<string, PktCounter & { queue: number }>;
  buckets: Record<string, Bucket>;
  rateMs?: number;
}

export const RATE_INTERVAL_MS = 1000;

export function coppRuntime(device: Device): CoppRuntime {
  return featureState<CoppRuntime>(device, "copp-runtime", () => ({ traps: {}, groups: {}, buckets: {} }));
}

export function peekCoppRuntime(device: Device): CoppRuntime | undefined {
  return peekFeatureState<CoppRuntime>(device, "copp-runtime");
}

const zero = (): PktCounter => ({ pkts: 0, bytes: 0, dropPkts: 0, dropBytes: 0 });

/** sr_tcm with red_action drop: true = green (conforming). Re-seeds when cir/cbs/meter change. */
function police(rt: CoppRuntime, group: string, p: CoppGroup, size: number, now: number): boolean {
  if (p.cir === undefined) return true; // no policer on this trap group
  const cbs = p.cbs ?? p.cir;
  let b = rt.buckets[group];
  if (!b || b.cir !== p.cir || b.cbs !== cbs || b.meterType !== p.meterType) {
    b = rt.buckets[group] = { tokens: cbs, lastMs: now, cir: p.cir, cbs, meterType: p.meterType };
  }
  if (now > b.lastMs) {
    b.tokens = Math.min(cbs, b.tokens + ((now - b.lastMs) * p.cir) / 1000);
    b.lastMs = now;
  }
  const cost = p.meterType === "bytes" ? size : 1;
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}

/** The toCpu decision; exported for tests. */
export function cpuReceive(ctx: SimContext, device: Device, frame: Frame): boolean | string {
  if (!isSonicSwitch(device)) return true;
  const c = classifyTrap(device, frame);
  const trap = trapFor(device, c);
  if (!trap) return false; // link-local frame with no installed trap: not trapped, never bridged
  const size = frame.meta.sizeBytes;
  const rt = coppRuntime(device);
  const t = (rt.traps[trap.trapId] ??= { pkts: 0, bytes: 0, pps: 0, lastPkts: 0 });
  t.pkts += 1;
  t.bytes += size;
  const q = String(trap.params.queue);
  const queues = featureState<CpuQueues>(device, "cpu-queues", () => ({}));
  const qc = (queues[q] ??= zero());
  const gc = (rt.groups[trap.group] ??= { ...zero(), queue: trap.params.queue });
  gc.queue = trap.params.queue;
  const action = trap.params.trapAction;
  const pass = action !== "drop" && action !== "deny" && police(rt, trap.group, trap.params, size, ctx.wallNow());
  if (!pass) {
    qc.dropPkts += 1;
    qc.dropBytes += size;
    gc.dropPkts += 1;
    gc.dropBytes += size;
    return false;
  }
  qc.pkts += 1;
  qc.bytes += size;
  gc.pkts += 1;
  gc.bytes += size;
  if (c.owner && !featureEnabled(device, c.owner)) return `trapped to CPU, no listener (feature ${c.owner} disabled)`;
  return true;
}

registerDataPlaneHook({
  id: "copp",
  toCpu: (ctx, device: Device, _iface: NetInterface, frame: Frame) => cpuReceive(ctx, device, frame),
});

/** Trap flow-counter rates (RATES:<oid> RX_PPS), sampled every second while traffic flows. */
registerDaemon({
  id: "copp-rates",
  nextDue(device, now) {
    const rt = peekCoppRuntime(device);
    if (!rt || !isSonicSwitch(device)) return undefined;
    const busy = Object.values(rt.traps).some((t) => t.pkts !== t.lastPkts || t.pps !== 0);
    if (!busy) return undefined;
    return (rt.rateMs ?? now - RATE_INTERVAL_MS) + RATE_INTERVAL_MS;
  },
  tick(_ctx, device, now) {
    const rt = coppRuntime(device);
    const dt = Math.max(1, now - (rt.rateMs ?? now - RATE_INTERVAL_MS)) / 1000;
    for (const t of Object.values(rt.traps)) {
      t.pps = (t.pkts - t.lastPkts) / dt;
      t.lastPkts = t.pkts;
    }
    rt.rateMs = now;
    return true;
  },
});
