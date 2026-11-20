/**
 * Flow-level (fluid) bandwidth + QoS model.
 *
 * WHY: the packet engine (lib/engine/simulation.ts) is synchronous — a frame
 * crosses the whole topology instantly and links have a speed but no capacity —
 * and the GUI generator can only emit a few thousand packets per second of wall
 * time. Congestion at 1-25 Gb/s therefore cannot come from simulated packets.
 * This model is layered ON TOP of the engine; packet-level traffic is untouched.
 *
 * FLOWS. A flow (iperf3 stream) has an offered application rate (bps; 0 = as
 * fast as possible), packet payload size, protocol (tcp = elastic, udp = open
 * loop) and DSCP. Its path is found by sending a real ICMP echo through the
 * engine on a CLONE of the network (so ARP/MAC/routes/ACL/LAG all apply and the
 * live counters are not polluted) and following the FRAME_SENT events from the
 * sender to the device owning the destination IP. Each hop = (device, ingress
 * port, egress port, peer). Paths are re-traced every TRACE_MS.
 *
 * QUEUE SELECTION on a SONiC switch hop (sonic-swss qosorch.cpp):
 *   DSCP -> TC   by the INGRESS port's dscp-tc map (PORT_QOS_MAP.dscp_to_tc_map);
 *                unbound = HwSKU default: DellEMC-S5248f-P-25G qos.json.j2:75-140
 *                maps EVERY DSCP to TC 0.
 *   TC -> queue  by the EGRESS port's tc-queue map; default identity
 *                (qos.json.j2:63-73 TC_TO_QUEUE_MAP).
 *   Scheduler    EGRESS port scheduler-policy (qosorch.cpp:1382/1390 DWRR|STRICT);
 *                queues not in a bound policy use qos.json.j2:143-174,184-222:
 *                DWRR weights q0..q7 = 1,2,3,4,5,10,25,50.
 *   WRED         EGRESS port wred-policy (QUEUE|<port>|q.wred_profile,
 *                qosorch.cpp:1707 applyWredProfileToQueue), green color only.
 *   PFC          queue q of an egress port is lossless when PFC priority q is
 *                enabled on that port (PORT_QOS_MAP.pfc_enable; priority->queue is
 *                identity, qos.json.j2:51-62; SONiC default lossless 3,4 is
 *                qos_config.j2:450-454 — not applied by this HwSKU).
 *   Host NIC and routers: one FIFO queue. A sending host never drops its own
 *   traffic (socket back-pressure), so its NIC hop is lossless.
 *
 * PER TICK (every TICK_MS of wall time, via the "qos" ControlDaemon):
 *   1. Every active flow offers load at each hop; per egress port the offered
 *      load is aggregated per queue, the scheduler serves strict queues first
 *      (highest index first) then water-fills the rest by DWRR weight; inside a
 *      queue flows share max-min fairly (FIFO approximation).
 *   2. TCP is elastic: its offered rate at a hop is the minimum it was granted
 *      at its OTHER hops (it converges to its bottleneck share). UDP offers its
 *      -b rate; what a lossy queue cannot serve is DROPPED; what a lossless
 *      (PFC) queue cannot serve is back-pressured to the upstream hops (paused,
 *      never dropped). Solved by Jacobi iteration (ITERATIONS rounds).
 *   3. TCP at a congested lossy queue loses TCP_CONGESTION_LOSS of its packets
 *      (sawtooth; shown as iperf3 Retr and queue drops).
 *   4. Queue occupancy: congested tail-drop queue = QUEUE_LIMIT_BYTES; with WRED
 *      it sits between min/max threshold according to the drop probability
 *      needed (p / max_p); a paused lossless queue sits at XOFF (=limit);
 *      otherwise one packet. Watermark = max occupancy since last clear.
 *   5. PFC: the queue is solved once more as if lossy; where it WOULD drop, the
 *      switch pauses the flow's ingress link at that priority:
 *      frames/s = 2 * pausedFraction * linkBps / (65535 quanta * 512 bit).
 *   6. Delivered/dropped packets update per-queue counters (features["qos-queues"]),
 *      PFC counters (features["qos-pfc"]), InterfaceStats tx/rx/txDropped on every
 *      hop (so port counters show utilisation) and drop counters (recordDrop
 *      "OTHER": SAI has no queue-drop reason in lib/control/drops.ts).
 *
 * Rates are L1 wire bits (frame + 20 B preamble/IFG), so a 1G TCP stream with
 * a 1448 B MSS reports 1448/1538 * 1000 = 941 Mbit/s goodput like real iperf3.
 * Link capacity = min(speed of both ends). TCP ACK return traffic is ignored.
 */
import { NetworkState, getPeer } from "../models/topology";
import { Device, interfaceByName, isSwitch } from "../models/device";
import { featureState, peekFeatureState } from "../models/feature-state";
import { recordDrop } from "../control/drops";
import { Simulation } from "../engine/simulation";
import { Frame } from "../models/packet";
import { l4Payload } from "../control/packet";
import { bytesToFrame } from "../packetgen/frame";
import { sendTrafficPacket } from "./traffic";
import type { QosState } from "../commands/sonic/qos";
import type { PfcState } from "../commands/sonic/qospfc";

export const TICK_MS = 100;
export const TRACE_MS = 2000;
export const L1_OVERHEAD = 20;
export const ETH_OVERHEAD = 18;
export const TCP_MSS = 1448;
export const UDP_DEFAULT_LEN = 1460;
export const QUEUE_LIMIT_BYTES = 1_048_576;
export const TCP_CONGESTION_LOSS = 0.0005;
/** DellEMC-S5248f-P-25G qos.json.j2:143-174 scheduler.0..7 DWRR weights. */
export const DEFAULT_DWRR_WEIGHTS = [1, 2, 3, 4, 5, 10, 25, 50];
const ITERATIONS = 40;
const PAUSE_QUANTA_BITS = 65535 * 512;
const EPS = 1e-9;

export interface FlowHop {
  dev: string;
  inIf?: string;
  outIf: string;
  peerDev: string;
  peerIf: string;
}

export interface QosFlow {
  id: string;
  stream: number;
  srcId: string;
  srcIp: string;
  srcPort: number;
  dstId: string;
  dstIp: string;
  dstPort: number;
  proto: "tcp" | "udp";
  /** Offered application bitrate (payload bits/s); 0 = unlimited. */
  rateBps: number;
  /** Application payload bytes per packet. */
  payload: number;
  /** L2 frame bytes per packet (incl. 14 B header + 4 B FCS) — what counters count. */
  frameBytes: number;
  dscp: number;
  startMs: number;
  endMs: number;
  /** Accounting cursor (wall ms). */
  lastMs: number;
  hops: FlowHop[];
  tracedMs: number;
  carry: number[];
  dropCarry: number[];
  sentPkts: number;
  deliveredPkts: number;
  lostPkts: number;
}

export interface FlowStore {
  flows: QosFlow[];
  seq: number;
}

export interface QueueCounter {
  pkts: number;
  bytes: number;
  dropPkts: number;
  dropBytes: number;
  wredDropPkts: number;
  /** Current occupancy (bytes) and watermark (max since clear). */
  occ: number;
  wm: number;
}

/** features["qos-queues"] on a switch: egress port -> UC0..UC7 counters. */
export type QueueCounters = Record<string, QueueCounter[]>;
/** features["qos-pfc"]: port -> pause frames per priority. */
export type PfcCounters = Record<string, { rx: number[]; tx: number[] }>;

// ---------------------------------------------------------------- framing

/** L2 frame bytes per packet for a payload (one IP packet, fragments for big UDP). */
export function frameBytesFor(proto: "tcp" | "udp", payload: number): number {
  if (proto === "tcp") return payload + 32 + 20 + ETH_OVERHEAD;
  const ipPayload = payload + 8;
  if (ipPayload <= 1480) return ipPayload + 20 + ETH_OVERHEAD;
  // Fragmented datagram: every fragment carries an IP + Ethernet header.
  return ipPayload + Math.ceil(ipPayload / 1480) * (20 + ETH_OVERHEAD);
}

const wireBytes = (f: QosFlow) => f.frameBytes + L1_OVERHEAD;
/** Wire bits/s -> application goodput bits/s. */
export const goodput = (f: QosFlow, wireBps: number) => (wireBps * f.payload) / wireBytes(f);

// ---------------------------------------------------------------- flow store

export function flowStore(device: Device): FlowStore {
  return featureState<FlowStore>(device, "qos-flows", () => ({ flows: [], seq: 0 }));
}

export function allFlows(state: NetworkState): QosFlow[] {
  const out: QosFlow[] = [];
  for (const d of Object.values(state.devices)) {
    const st = peekFeatureState<FlowStore>(d, "qos-flows");
    if (st) out.push(...st.flows);
  }
  return out;
}

export function queueCounters(device: Device): QueueCounters {
  return featureState<QueueCounters>(device, "qos-queues", () => ({}));
}

export function emptyQueue(): QueueCounter {
  return { pkts: 0, bytes: 0, dropPkts: 0, dropBytes: 0, wredDropPkts: 0, occ: 0, wm: 0 };
}

function portQueues(device: Device, ifName: string): QueueCounter[] {
  const c = queueCounters(device);
  return (c[ifName] ??= Array.from({ length: 8 }, emptyQueue));
}

function pfcPort(device: Device, ifName: string) {
  const c = featureState<PfcCounters>(device, "qos-pfc", () => ({}));
  return (c[ifName] ??= { rx: [0, 0, 0, 0, 0, 0, 0, 0], tx: [0, 0, 0, 0, 0, 0, 0, 0] });
}

// ---------------------------------------------------------------- path trace

export function deviceOwningIp(state: NetworkState, ip: string): Device | undefined {
  return Object.values(state.devices).find((d) => d.interfaces.some((i) => i.ipv4.some((a) => a.address === ip)));
}

/** The flow's own L4 header, so the trace meets the ACLs / policies that would act on it. */
export interface FlowProbe {
  proto: "tcp" | "udp";
  srcPort: number;
  dstPort: number;
}

/** Inner frame of a VXLAN packet (UDP/4789), so a flow is followed across the overlay. */
function vxlanInner(f: Frame): Frame | undefined {
  if (f.udp?.dstPort !== 4789) return undefined;
  const b = l4Payload(f);
  try {
    return b && b.length >= 8 + 14 ? bytesToFrame(b.slice(8), "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Forward path src -> dstIp: one ICMP echo through the real engine on a clone
 * (resolves ARP), then — given a probe — one packet with the flow's own L4
 * header; a DFS over that packet's FRAME_SENT edges (ignores flooded copies).
 */
export function traceFlowPath(state: NetworkState, srcId: string, dstIp: string, probe?: FlowProbe): FlowHop[] | null {
  const dst = deviceOwningIp(state, dstIp);
  if (!dst || dst.id === srcId) return null;
  const sim = new Simulation(structuredClone(state), { wallBase: 0 });
  sim.runPing(srcId, dstIp, { count: 1 });
  let from = 0;
  let isProbe = (f: Frame) => f.icmp?.type === "echo-request" && f.ipv4?.dstIp === dstIp;
  if (probe) {
    from = sim.events.length;
    const spec = { srcDeviceId: srcId, dstIp, protocol: probe.proto, srcPort: probe.srcPort, dstPort: probe.dstPort, size: 0, count: 1, intervalMs: 0, continuous: false };
    sendTrafficPacket(sim, sim.state.devices[srcId], spec, 1);
    isProbe = (f: Frame) => f.ipv4?.dstIp === dstIp && (probe.proto === "tcp" ? f.tcp?.dstPort : f.udp?.dstPort) === probe.dstPort;
  }
  const carries = (f: Frame) => isProbe(f) || (() => { const i = vxlanInner(f); return !!i && isProbe(i); })();
  const edges = sim.events
    .slice(from)
    .filter((e) => e.type === "FRAME_SENT" && e.link && e.frame && carries(e.frame))
    .map((e) => e.link!);
  const used = new Set<number>();
  const walk = (dev: string, from: number, inIfId?: string): FlowHop[] | null => {
    if (dev === dst.id) return [];
    for (let i = from; i < edges.length; i++) {
      const l = edges[i];
      if (l.fromDeviceId !== dev || used.has(i)) continue;
      used.add(i);
      const rest = walk(l.toDeviceId, i + 1, l.toInterfaceId);
      if (rest) {
        const d = state.devices[dev];
        const name = (id?: string) => d.interfaces.find((x) => x.id === id)?.name;
        const peer = state.devices[l.toDeviceId];
        return [
          {
            dev,
            inIf: name(inIfId),
            outIf: name(l.fromInterfaceId)!,
            peerDev: l.toDeviceId,
            peerIf: peer.interfaces.find((x) => x.id === l.toInterfaceId)!.name,
          },
          ...rest,
        ];
      }
    }
    return null;
  };
  const hops = walk(srcId, 0);
  return hops && hops.length ? hops : null;
}

// ---------------------------------------------------------------- QoS config

interface PortCfg {
  cap: number; // wire bits/s
  sched: { strict: boolean; weight: number }[];
  wred?: { min: number; max: number; maxp: number };
  lossless: Set<number>;
  qos: boolean; // SONiC switch port with 8 queues
}

function linkCap(state: NetworkState, h: FlowHop): number {
  const d = state.devices[h.dev];
  const p = state.devices[h.peerDev];
  const out = d && interfaceByName(d, h.outIf);
  const pin = p && interfaceByName(p, h.peerIf);
  if (!out || !pin || d.state === "down" || p.state === "down") return 0;
  if (out.adminState !== "up" || pin.adminState !== "up") return 0;
  const conn = getPeer(state, d.id, out.id);
  if (conn && conn.connection.state !== "up") return 0;
  return Math.min(out.speed, pin.speed) * 1e6;
}

function portCfg(state: NetworkState, h: FlowHop): PortCfg {
  const dev = state.devices[h.dev];
  const cap = linkCap(state, h);
  if (!isSwitch(dev.type)) return { cap, sched: DEFAULT_DWRR_WEIGHTS.map(() => ({ strict: false, weight: 1 })), lossless: new Set(), qos: false };
  const qs = peekFeatureState<QosState>(dev, "qos");
  const b = qs?.interfaces[h.outIf];
  const policy = b?.schedulerPolicy ? qs?.schedulers.find((p) => p.name === b.schedulerPolicy) : undefined;
  const sched = DEFAULT_DWRR_WEIGHTS.map((w, q) => {
    const e = policy?.queues.find((x) => x.queue === q);
    return e ? { strict: e.type === "strict", weight: e.weight ?? 1 } : { strict: false, weight: w };
  });
  const wp = b?.wredPolicy ? qs?.wredPolicies.find((p) => p.name === b.wredPolicy) : undefined;
  const green = wp?.colors.find((c) => c.color === "green");
  const wred = green ? { min: green.min * 1024, max: green.max * 1024, maxp: green.prob / 100 } : undefined;
  const pfc = peekFeatureState<PfcState>(dev, "pfc")?.interfaces[h.outIf]?.priorities ?? [];
  return { cap, sched, wred, lossless: new Set(pfc), qos: true };
}

/** DSCP -> TC (ingress port map) -> queue (egress port map) on a switch hop. */
export function classify(dev: Device, inIf: string | undefined, outIf: string, dscp: number): { tc: number; queue: number } {
  if (!isSwitch(dev.type)) return { tc: 0, queue: 0 };
  const qs = peekFeatureState<QosState>(dev, "qos");
  const inMap = inIf ? qs?.interfaces[inIf]?.dscpTc : undefined;
  const tc = inMap ? qs?.dscpTcMaps.find((m) => m.name === inMap)?.entries.find((e) => e.key === dscp)?.value ?? 0 : 0;
  const outMap = qs?.interfaces[outIf]?.tcQueue;
  const queue = outMap ? qs?.tcQueueMaps.find((m) => m.name === outMap)?.entries.find((e) => e.key === tc)?.value ?? tc : tc;
  return { tc, queue };
}

// ---------------------------------------------------------------- scheduler

/** Max-min fair split of `cap` among demands (water-filling, equal weights). */
export function fairShare(cap: number, demands: number[], weights?: number[]): number[] {
  const w = weights ?? demands.map(() => 1);
  const out = demands.map(() => 0);
  let active = demands.map((_, i) => i).filter((i) => demands[i] > 0 && w[i] > 0);
  let rem = cap;
  while (active.length && rem > EPS) {
    const wsum = active.reduce((s, i) => s + w[i], 0);
    const sat = active.filter((i) => demands[i] - out[i] <= (rem * w[i]) / wsum + EPS);
    if (!sat.length) {
      for (const i of active) out[i] += (rem * w[i]) / wsum;
      rem = 0;
      break;
    }
    for (const i of sat) {
      rem -= demands[i] - out[i];
      out[i] = demands[i];
    }
    active = active.filter((i) => !sat.includes(i));
  }
  return out;
}

/** Strict queues first (highest index first), then DWRR water-filling by weight. */
export function schedule(cap: number, demand: number[], sched: { strict: boolean; weight: number }[]): number[] {
  const served = demand.map(() => 0);
  let rem = cap;
  for (let q = demand.length - 1; q >= 0; q--) {
    if (!sched[q]?.strict) continue;
    served[q] = Math.min(demand[q], rem);
    rem -= served[q];
  }
  const idx = demand.map((_, q) => q).filter((q) => !sched[q]?.strict);
  const share = fairShare(Math.max(0, rem), idx.map((q) => demand[q]), idx.map((q) => sched[q]?.weight ?? 1));
  idx.forEach((q, i) => (served[q] = share[i]));
  return served;
}

// ---------------------------------------------------------------- solver

export interface HopResult {
  queue: number;
  lossless: boolean;
  offered: number;
  alloc: number;
  drop: number;
}

export interface FlowResult {
  /** Delivered wire bits/s at the receiver. */
  rate: number;
  /** Rate leaving the sender (wire bits/s). */
  sent: number;
  hops: HopResult[];
}

export interface QueueResult {
  offered: number;
  served: number;
  drop: number;
  wredDrop: number;
  occ: number;
  pausedFrac: number;
}

export interface PauseResult {
  dev: string;
  ifName: string;
  peerDev: string;
  peerIf: string;
  prio: number;
  fps: number;
}

export interface ModelResult {
  flows: Map<string, FlowResult>;
  ports: Map<string, { dev: string; ifName: string; cap: number; qos: boolean; queues: QueueResult[] }>;
  pauses: PauseResult[];
}

interface HopInfo {
  key: string;
  cfg: PortCfg;
  queue: number;
  lossless: boolean;
}

function solve(state: NetworkState, flows: QosFlow[], pfc: boolean, cfgCache: Map<string, PortCfg>) {
  const info: HopInfo[][] = flows.map((f) =>
    f.hops.map((h, k) => {
      const key = `${h.dev}|${h.outIf}`;
      let cfg = cfgCache.get(key);
      if (!cfg) cfgCache.set(key, (cfg = portCfg(state, h)));
      const dev = state.devices[h.dev];
      const { queue } = classify(dev, h.inIf, h.outIf, f.dscp);
      const nic = k === 0 && !isSwitch(dev.type);
      return { key, cfg, queue, lossless: nic || (pfc && cfg.qos && cfg.lossless.has(queue)) };
    }),
  );
  const base = flows.map((f) => (f.proto === "udp" && f.rateBps > 0 ? (f.rateBps * wireBytes(f)) / f.payload : Infinity));
  let A = flows.map((f) => f.hops.map(() => Infinity));
  // Previous-but-one grant: elastic offers use max(A, A2) so a transient low
  // grant cannot lock two hops of a TCP flow into a period-2 oscillation.
  let A2 = A;
  let O = A;
  const ports = new Map<string, { i: number; k: number }[]>();
  info.forEach((hs, i) => hs.forEach((h, k) => {
    const l = ports.get(h.key);
    if (l) l.push({ i, k });
    else ports.set(h.key, [{ i, k }]);
  }));
  const offeredAt = (i: number, k: number): number => {
    const a = A[i];
    const g = (j: number) => Math.max(a[j], A2[i][j]);
    if (flows[i].proto === "tcp") {
      let m = base[i];
      for (let j = 0; j < a.length; j++) if (j !== k) m = Math.min(m, g(j));
      return m;
    }
    let m = k === 0 ? base[i] : a[k - 1];
    for (let j = k + 1; j < a.length; j++) if (info[i][j].lossless) m = Math.min(m, g(j));
    return m;
  };
  for (let it = 0; it < ITERATIONS; it++) {
    const nA = flows.map((f) => f.hops.map(() => 0));
    const nO = flows.map((f) => f.hops.map(() => 0));
    for (const [key, entries] of ports) {
      const cfg = cfgCache.get(key)!;
      const byQ: { i: number; k: number; d: number }[][] = Array.from({ length: 8 }, () => []);
      for (const { i, k } of entries) {
        const d = offeredAt(i, k);
        nO[i][k] = d;
        byQ[info[i][k].queue].push({ i, k, d });
      }
      const served = schedule(cfg.cap, byQ.map((l) => l.reduce((s, e) => s + e.d, 0)), cfg.sched);
      byQ.forEach((l, q) => {
        const share = fairShare(served[q], l.map((e) => e.d));
        l.forEach((e, n) => (nA[e.i][e.k] = Math.min(e.d, share[n])));
      });
    }
    A2 = A;
    A = nA;
    O = nO;
  }
  /** Rate flow i could get at hop k if it wanted infinitely more (others unchanged). */
  const availableShare = (i: number, k: number): number => {
    const key = info[i][k].key;
    const cfg = cfgCache.get(key)!;
    const byQ: { i: number; d: number }[][] = Array.from({ length: 8 }, () => []);
    for (const e of ports.get(key)!) byQ[info[e.i][e.k].queue].push({ i: e.i, d: e.i === i && e.k === k ? Infinity : O[e.i][e.k] });
    const served = schedule(cfg.cap, byQ.map((l) => l.reduce((s, e) => s + e.d, 0)), cfg.sched);
    const l = byQ[info[i][k].queue];
    return fairShare(served[info[i][k].queue], l.map((e) => e.d))[l.findIndex((e) => e.i === i && e.d === Infinity)];
  };
  /**
   * Traffic a queue cannot serve for flow i at hop k: UDP = offered - granted;
   * TCP = TCP_CONGESTION_LOSS of its rate at its bottleneck hop (the first hop
   * with the smallest available share; a sender NIC bottleneck never drops).
   */
  const tcpBottleneck = flows.map((f, i) => {
    if (f.proto !== "tcp" || !f.hops.length) return -1;
    let best = 0;
    let bestShare = Infinity;
    f.hops.forEach((_, k) => {
      const s = availableShare(i, k);
      if (s < bestShare * (1 - 1e-6)) {
        bestShare = s;
        best = k;
      }
    });
    return best;
  });
  const excess = (i: number, k: number): number => {
    if (flows[i].proto === "udp") return O[i][k] > A[i][k] * (1 + 1e-6) + 1 ? O[i][k] - A[i][k] : 0;
    return k === tcpBottleneck[i] && !(k === 0 && !isSwitch(state.devices[flows[i].hops[0].dev].type)) ? A[i][k] * TCP_CONGESTION_LOSS : 0;
  };
  return { info, A, O, excess };
}

/** Solve the whole network for the given active flows. */
export function computeRates(state: NetworkState, flows: QosFlow[]): ModelResult {
  const cache = new Map<string, PortCfg>();
  const live = flows.filter((f) => f.hops.length > 0);
  const real = solve(state, live, true, cache);
  const anyLossless = [...cache.values()].some((c) => c.qos && c.lossless.size > 0);
  const lossy = anyLossless ? solve(state, live, false, cache) : real;

  const res: ModelResult = { flows: new Map(), ports: new Map(), pauses: [] };
  const portOf = (key: string, h: FlowHop) => {
    let p = res.ports.get(key);
    if (!p) {
      const cfg = cache.get(key)!;
      p = { dev: h.dev, ifName: h.outIf, cap: cfg.cap, qos: cfg.qos, queues: Array.from({ length: 8 }, () => ({ offered: 0, served: 0, drop: 0, wredDrop: 0, occ: 0, pausedFrac: 0 })) };
      res.ports.set(key, p);
    }
    return p;
  };
  const maxFrame = new Map<string, number>();
  const lossyDrop = new Map<string, { drop: number; offered: number }>();
  live.forEach((f, i) => {
    const hops: HopResult[] = f.hops.map((h, k) => {
      const inf = real.info[i][k];
      const offered = real.O[i][k];
      const alloc = real.A[i][k];
      const drop = inf.lossless ? 0 : real.excess(i, k);
      const q = portOf(inf.key, h).queues[inf.queue];
      q.offered += offered === Infinity ? alloc : offered;
      q.served += alloc;
      q.drop += drop;
      const mk = `${inf.key}|${inf.queue}`;
      maxFrame.set(mk, Math.max(maxFrame.get(mk) ?? 0, f.frameBytes));
      // What this queue would drop without PFC (for pause accounting).
      if (inf.lossless && inf.cfg.qos) {
        const lo = lossy.O[i][k];
        const la = lossy.A[i][k];
        const e = lossyDrop.get(mk) ?? { drop: 0, offered: 0 };
        e.drop += lossy.excess(i, k);
        e.offered += lo === Infinity ? la : lo;
        lossyDrop.set(mk, e);
      }
      return { queue: inf.queue, lossless: inf.lossless, offered, alloc, drop };
    });
    const sent = hops[0]?.alloc ?? 0;
    const rate = Math.max(0, hops.reduce((m, h) => Math.min(m, h.alloc), Infinity));
    res.flows.set(f.id, { rate: f.proto === "udp" ? hops[hops.length - 1].alloc : rate, sent, hops });
  });
  // Occupancy / WRED / PFC per queue.
  for (const [key, p] of res.ports) {
    if (!p.qos) continue;
    const cfg = cache.get(key)!;
    p.queues.forEach((q, n) => {
      const mk = `${key}|${n}`;
      const ld = lossyDrop.get(mk);
      if (ld && ld.drop > 0) {
        q.pausedFrac = Math.min(1, ld.drop / Math.max(ld.offered, EPS));
        q.occ = QUEUE_LIMIT_BYTES; // held at XOFF
      } else if (q.drop > 0) {
        const pDrop = q.drop / Math.max(q.offered, EPS);
        if (cfg.wred && cfg.wred.maxp > 0) {
          q.wredDrop = q.drop;
          q.occ = cfg.wred.min + (cfg.wred.max - cfg.wred.min) * Math.min(1, pDrop / cfg.wred.maxp);
        } else {
          q.occ = QUEUE_LIMIT_BYTES;
        }
      } else if (q.served > 0) {
        q.occ = maxFrame.get(mk) ?? 0;
      }
    });
  }
  // Pause frames: from the congested switch out of each paused flow's ingress port.
  const seen = new Set<string>();
  live.forEach((f, i) => {
    f.hops.forEach((h, k) => {
      const inf = real.info[i][k];
      if (!inf.lossless || !inf.cfg.qos || !h.inIf || k === 0) return;
      const q = res.ports.get(inf.key)!.queues[inf.queue];
      if (q.pausedFrac <= 0) return;
      const id = `${h.dev}|${h.inIf}|${inf.queue}`;
      if (seen.has(id)) return;
      seen.add(id);
      const up = f.hops[k - 1];
      const capIn = linkCap(state, up);
      res.pauses.push({ dev: h.dev, ifName: h.inIf, peerDev: up.dev, peerIf: up.outIf, prio: inf.queue, fps: (2 * q.pausedFrac * capIn) / PAUSE_QUANTA_BITS });
    });
  });
  return res;
}

// ---------------------------------------------------------------- accounting

/** Integer packets from a fractional amount, carrying the remainder. */
function take(carry: number[], k: number, x: number): number {
  const v = (carry[k] ?? 0) + x;
  const n = Math.floor(v);
  carry[k] = v - n;
  return n;
}

/** Retrace paths that are stale (or never traced). */
export function refreshPaths(state: NetworkState, flows: QosFlow[], nowMs: number): void {
  for (const f of flows) {
    if (f.hops.length && nowMs - f.tracedMs < TRACE_MS) continue;
    f.hops = traceFlowPath(state, f.srcId, f.dstIp, { proto: f.proto, srcPort: f.srcPort, dstPort: f.dstPort }) ?? [];
    f.tracedMs = nowMs;
    f.carry = f.hops.map(() => 0);
    f.dropCarry = f.hops.map(() => 0);
  }
}

/**
 * Advance the model to nowMs: account every active flow's packets since its
 * cursor on queue/port/drop/PFC counters, then retire finished flows.
 * Returns true when anything changed.
 */
export function accountTick(state: NetworkState, nowMs: number): boolean {
  const flows = allFlows(state);
  if (!flows.length) return false;
  const pending = flows.filter((f) => f.lastMs < Math.min(nowMs, f.endMs) && f.startMs < nowMs);
  if (!pending.length && !flows.some((f) => f.lastMs >= f.endMs)) return false;
  const active = flows.filter((f) => f.startMs < nowMs && f.lastMs < f.endMs);
  refreshPaths(state, active, nowMs);
  const res = computeRates(state, active);

  // Occupancy reflects the current tick only.
  for (const d of Object.values(state.devices)) {
    const qc = peekFeatureState<QueueCounters>(d, "qos-queues");
    if (qc) for (const qs of Object.values(qc)) for (const q of qs) q.occ = 0;
  }

  let dtTick = 0;
  for (const f of active) {
    const r = res.flows.get(f.id);
    const dt = (Math.min(nowMs, f.endMs) - Math.max(f.lastMs, f.startMs)) / 1000;
    dtTick = Math.max(dtTick, dt);
    f.lastMs = Math.min(nowMs, f.endMs);
    if (!r || dt <= 0) continue;
    const wb = wireBytes(f) * 8;
    f.hops.forEach((h, k) => {
      const hr = r.hops[k];
      const n = take(f.carry, k, (hr.alloc * dt) / wb);
      const nd = take(f.dropCarry, k, (hr.drop * dt) / wb);
      const dev = state.devices[h.dev];
      const peer = state.devices[h.peerDev];
      const out = interfaceByName(dev, h.outIf);
      const pin = peer && interfaceByName(peer, h.peerIf);
      if (out) {
        out.statistics.txFrames += n;
        out.statistics.txBytes += n * f.frameBytes;
        out.statistics.txDropped += nd;
      }
      if (pin) {
        pin.statistics.rxFrames += n;
        pin.statistics.rxBytes += n * f.frameBytes;
      }
      if (isSwitch(dev.type)) {
        const q = portQueues(dev, h.outIf)[hr.queue];
        q.pkts += n;
        q.bytes += n * f.frameBytes;
        q.dropPkts += nd;
        q.dropBytes += nd * f.frameBytes;
        const pq = res.ports.get(`${h.dev}|${h.outIf}`)?.queues[hr.queue];
        if (pq && pq.wredDrop > 0) q.wredDropPkts += nd;
        for (let x = 0; x < nd; x++) recordDrop(dev, h.outIf, "EGRESS_QUEUE");
      }
      if (k === 0) f.sentPkts += n;
      if (k === f.hops.length - 1) f.deliveredPkts += n;
      f.lostPkts += nd;
    });
  }

  for (const p of res.ports.values()) {
    if (!p.qos) continue;
    const qs = portQueues(state.devices[p.dev], p.ifName);
    p.queues.forEach((r, n) => {
      qs[n].occ = Math.round(r.occ);
      qs[n].wm = Math.max(qs[n].wm, qs[n].occ);
    });
  }
  for (const pz of res.pauses) {
    pfcPort(state.devices[pz.dev], pz.ifName).tx[pz.prio] += pz.fps * dtTick;
    const peer = state.devices[pz.peerDev];
    if (peer) pfcPort(peer, pz.peerIf).rx[pz.prio] += pz.fps * dtTick;
  }

  // Retire finished flows.
  for (const d of Object.values(state.devices)) {
    const st = peekFeatureState<FlowStore>(d, "qos-flows");
    if (st) st.flows = st.flows.filter((f) => f.lastMs < f.endMs);
  }
  if (!allFlows(state).length) {
    for (const d of Object.values(state.devices)) {
      const qc = peekFeatureState<QueueCounters>(d, "qos-queues");
      if (qc) for (const qs of Object.values(qc)) for (const q of qs) q.occ = 0;
    }
  }
  return true;
}
