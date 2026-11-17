/**
 * sFlow data plane + agent for a simulated SONiC switch, modelled on the SONiC
 * sources (sonic-buildimage, branch 202505-smci-dev-oc) and checked against the
 * live SONiC-VS switch (data/device-capture/sflow-live/):
 *
 *   sflowmgrd (sonic-swss/cfgmgr/sflowmgr.cpp) — CONFIG_DB → APPL_DB sessions:
 *     - global enable + "all" (default on) gives EVERY port a session
 *     - per-port default rate = port speed in Mbps (findSamplingRate)
 *     - the global SFLOW|global sample_rate is stored/shown but NEVER applied
 *     - global disable deletes every session
 *   vslib (VirtualSwitchSaiInterfacePort.cpp) — ingress:
 *     `tc filter … matchall action sample rate 1/N group 1` on the port's tap.
 *     Egress (sample_direction tx/both, swss "Egress Sflow Support") exists in
 *     the source but VS cannot realise it; the simulator samples egress too so
 *     the feature can be learned.
 *   hsflowd (src/sflow/hsflowd, mod_sonic.c / readPackets.c):
 *     - sub-agent id 100000; agent IP = agent_id interface, else best address
 *     - ifIndex from PORT_INDEX_TABLE: EthernetN → N+1
 *     - flow sample: input = ingress ifIndex, output = 0 (psample gives no oif),
 *       sample_pool += rate per sample, sampled header ≤ 128 bytes, stripped 4
 *     - counter polling of every port each polling-interval (default 20, 0 =
 *       off, minimum 5): port-name (1005) + generic (1) records
 *     - samples packed into ≤1400-byte datagrams, flushed once per second
 *
 * Not modelled: hsflowd host-datasource records (2000-2010; their values are
 * host CPU/memory figures the simulator has no source for) and drop-monitor.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { cidrContains } from "../models/ip";
import { isBroadcast, isMulticast } from "../models/mac";
import { SimContext } from "../engine/context";
import { resolveArp } from "../protocols/arp";
import { buildFrame } from "../protocols/ethernet";
import { frameToBytes } from "./wire";
import {
  CounterSample,
  FlowSample,
  HEADER_PROTO_ETHERNET,
  SFLOW_VERSION,
  encodeDatagram,
  encodeSample,
  packSamples,
} from "./datagram";

// ------------------------------------------------- CONFIG_DB-shaped config

export interface SflowCollector {
  /** CONFIG_DB key: `{ip}_{port}_{vrf}` (xfmr_sflow.go). */
  name: string;
  ip: string;
  port: number;
  vrf: string;
}

export interface SflowInterface {
  /** Local admin config (SFLOW_SESSION|<port> admin_state); undefined = not set. */
  enabled?: boolean;
  /** Local rate (SFLOW_SESSION|<port> sample_rate); undefined = port speed. */
  sampleRate?: number;
  /** Local direction (SFLOW_SESSION|<port> sample_direction); undefined = global. */
  direction?: SampleDirection;
}

export type SampleDirection = "rx" | "tx" | "both";

export interface SflowState {
  enabled: boolean;
  collectors: SflowCollector[];
  agentId: string | undefined;
  pollingInterval: number | undefined;
  /** SFLOW|global sample_rate — displayed, never applied (sflowmgr ignores it). */
  sampleRate?: number;
  /** SFLOW_SESSION|all admin_state; undefined/true = every port auto-enabled. */
  allInterfaces?: boolean;
  /** SFLOW|global sample_direction (default rx). */
  direction?: SampleDirection;
  /** SFLOW_SESSION|all sample_direction. */
  allDirection?: SampleDirection;
  interfaces: Record<string, SflowInterface>;
}

export const DEFAULT_COLLECTOR_PORT = 6343;
export const DEFAULT_POLLING_INTERVAL = 20;
export const MIN_POLLING_INTERVAL = 5;
export const SUB_AGENT_ID = 100000;
export const DEFAULT_HEADER_BYTES = 128;
const IF_TYPE_ETHERNET = 6;
const PENDING_CAP = 4000;

export function sflowState(device: Device): SflowState {
  return featureState<SflowState>(device, "sflow", () => ({
    enabled: false,
    collectors: [],
    agentId: undefined,
    pollingInterval: undefined,
    interfaces: {},
  }));
}

export function peekSflowState(device: Device): SflowState | undefined {
  return peekFeatureState<SflowState>(device, "sflow");
}

/** Front-panel ports (the PORT table): not mgmt, not logical. */
export function frontPanelPorts(device: Device): NetInterface[] {
  return device.interfaces.filter((i) => !i.management && !i.logical);
}

/** SONiC port_util.get_index_from_str: EthernetN→N+1, PortChannelN→N+1000, VlanN→N+2000, ethN→N+10000. */
export function sflowIfIndex(name: string): number | undefined {
  const m = /^(Ethernet|PortChannel|Vlan|eth)(\d+)$/.exec(name);
  if (!m) return undefined;
  const n = Number(m[2]);
  return { Ethernet: n + 1, PortChannel: n + 1000, Vlan: n + 2000, eth: n + 10000 }[m[1]];
}

// --------------------------------------------- sflowmgrd → APPL_DB sessions

export interface SflowSession {
  port: string;
  adminState: "up" | "down";
  sampleRate: number;
  rateSource: "port-speed" | "configured";
  direction: SampleDirection;
}

/** APPL_DB SFLOW_SESSION_TABLE as sflowmgrd would write it. */
export function sflowSessions(device: Device): SflowSession[] {
  const st = peekSflowState(device);
  if (!st?.enabled) return [];
  const all = st.allInterfaces !== false;
  const out: SflowSession[] = [];
  for (const iface of frontPanelPorts(device)) {
    const local = st.interfaces[iface.name];
    // sflowmgr.cpp: m_gEnable && (m_intfAllConf || (local_admin && admin == "up"))
    if (!all && local?.enabled !== true) continue;
    out.push({
      port: iface.name,
      adminState: local?.enabled === false ? "down" : "up",
      sampleRate: local?.sampleRate ?? iface.speed,
      rateSource: local?.sampleRate !== undefined ? "configured" : "port-speed",
      direction: local?.direction ?? st.allDirection ?? st.direction ?? "rx",
    });
  }
  return out;
}

// --------------------------------------------------- hsflowd agent address

export interface AgentAddress {
  ip?: string;
  iface?: string;
  reason?: string;
}

function isRfc1918(ip: string): boolean {
  return cidrContains("10.0.0.0", 8, ip) || cidrContains("172.16.0.0", 12, ip) || cidrContains("192.168.0.0", 16, ip);
}

/**
 * hsflowd agent-address selection (hsflowconfig.c / hsflowd.h priorities):
 * agent_id pins the interface (output suppressed if it has no address);
 * otherwise public IPv4 > RFC1918 IPv4 > VLAN-device IPv4, ties → lower ifIndex.
 */
export function selectAgentAddress(device: Device): AgentAddress {
  const st = peekSflowState(device);
  const agentId = st?.agentId;
  if (agentId) {
    const name = /^Management(\d+)$/.exec(agentId) ? `eth${/\d+/.exec(agentId)![0]}` : agentId;
    const iface = device.interfaces.find((i) => i.name === name);
    if (!iface) return { reason: `agent-id ${agentId}: interface not found — hsflowd suppresses output` };
    const ip = iface.ipv4[0]?.address;
    if (!ip) return { reason: `agent-id ${agentId}: no IPv4 address — hsflowd suppresses output` };
    return { ip, iface: iface.name };
  }
  const ranked = device.interfaces
    .filter((i) => i.ipv4.length && i.adminState === "up")
    .map((i) => {
      const ip = i.ipv4[0].address;
      const vlanDev = /^Vlan\d+$/.test(i.name);
      const prio = vlanDev ? 2 : isRfc1918(ip) ? 1 : 0;
      return { ip, iface: i.name, prio, idx: sflowIfIndex(i.name) ?? Number.MAX_SAFE_INTEGER };
    })
    .sort((a, b) => a.prio - b.prio || a.idx - b.idx);
  if (!ranked.length) return { reason: "switch has no IPv4 address to use as the sFlow agent address" };
  return { ip: ranked[0].ip, iface: ranked[0].iface };
}

// ---------------------------------------------------------------- runtime

export interface SflowAgentStats {
  /** Frames that crossed a port in a sampled direction of an active session. */
  sampledPortPackets: number;
  flowSamples: number;
  counterSamples: number;
  datagramsSent: number;
  samplesDiscarded: number;
  lastError?: string;
  lastExportAtMs?: number;
}

export interface SflowRuntime {
  startedAtMs: number;
  datagramSeq: number;
  rng: number;
  srcPort: number;
  samplers: Record<string, { seq: number; pool: number }>;
  pollers: Record<string, { seq: number; nextDueMs: number; interval: number }>;
  /** Encoded flow samples awaiting the next one-second flush. */
  pending: number[][];
  stats: SflowAgentStats;
}

export function peekSflowRuntime(device: Device): SflowRuntime | undefined {
  return peekFeatureState<SflowRuntime>(device, "sflow-agent");
}

function runtime(device: Device, nowMs: number): SflowRuntime {
  return featureState<SflowRuntime>(device, "sflow-agent", () => {
    const seed = (nowMs ^ 0x9e3779b9) >>> 0 || 1;
    return {
      startedAtMs: nowMs,
      datagramSeq: 0,
      rng: seed,
      srcPort: 32768 + (seed % 28000),
      samplers: {},
      pollers: {},
      pending: [],
      stats: { sampledPortPackets: 0, flowSamples: 0, counterSamples: 0, datagramsSent: 0, samplesDiscarded: 0 },
    };
  });
}

/** mulberry32 — deterministic PRNG whose state lives in the (serializable) runtime. */
function random(rt: SflowRuntime): number {
  rt.rng = (rt.rng + 0x6d2b79f5) >>> 0;
  let t = rt.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ------------------------------------------------------ ingress sampling

/**
 * Called for every frame entering (rx) or leaving (tx) a switch front-panel
 * port. Mirrors the tc/psample sample action: each frame in a sampled direction
 * is taken with probability 1/rate.
 */
export function sflowSample(ctx: SimContext, sw: Device, iface: NetInterface, frame: Frame, dir: "rx" | "tx"): void {
  const st = peekSflowState(sw);
  if (!st?.enabled) return;
  const session = sflowSessions(sw).find((s) => s.port === iface.name);
  if (!session || session.adminState !== "up") return;
  if (session.direction !== "both" && session.direction !== dir) return;
  const ifIndex = sflowIfIndex(iface.name);
  if (ifIndex === undefined) return;

  const rt = runtime(sw, ctx.wallNow());
  rt.stats.sampledPortPackets += 1;
  if (random(rt) >= 1 / session.sampleRate) return;

  const sampler = (rt.samplers[iface.name] ??= { seq: 0, pool: 0 });
  sampler.seq += 1;
  sampler.pool += session.sampleRate;
  const bytes = frameToBytes(frame);
  const sample: FlowSample = {
    kind: "flow",
    seq: sampler.seq,
    dsClass: 0,
    dsIndex: ifIndex,
    samplingRate: session.sampleRate,
    samplePool: sampler.pool >>> 0,
    drops: 0,
    // psample reports the port the sample was taken on; the other side is unknown (0).
    input: dir === "rx" ? ifIndex : 0,
    output: dir === "tx" ? ifIndex : 0,
    header: {
      protocol: HEADER_PROTO_ETHERNET,
      frameLength: frame.meta.sizeBytes,
      stripped: 4,
      bytes: bytes.slice(0, DEFAULT_HEADER_BYTES),
    },
  };
  rt.stats.flowSamples += 1;
  if (rt.pending.length < PENDING_CAP) rt.pending.push(encodeSample(sample));
  else rt.stats.samplesDiscarded += 1;
  ctx.emit({
    type: "SFLOW_SAMPLE",
    deviceId: sw.id,
    deviceName: sw.name,
    interfaceId: iface.id,
    interfaceName: iface.name,
    message: `${sw.name}: sFlow sampled ${dir === "rx" ? "ingress" : "egress"} frame on ${iface.name} (1/${session.sampleRate}, pool ${sampler.pool})`,
    osiLayers: [2],
    frame,
  });
}

// ------------------------------------------------- counter polling + export

function counterSample(rt: SflowRuntime, iface: NetInterface, ifIndex: number): CounterSample {
  const poller = rt.pollers[iface.name];
  poller.seq += 1;
  const s = iface.statistics;
  const rxM = s.rxMulticast ?? 0;
  const rxB = s.rxBroadcast ?? 0;
  const txM = s.txMulticast ?? 0;
  const txB = s.txBroadcast ?? 0;
  return {
    kind: "counter",
    seq: poller.seq,
    dsClass: 0,
    dsIndex: ifIndex,
    portName: iface.name,
    otherRecords: [],
    generic: {
      ifIndex,
      ifType: IF_TYPE_ETHERNET,
      ifSpeed: iface.speed * 1_000_000,
      ifDirection: 0, // as captured from the live VS agent
      ifStatus: (iface.adminState === "up" ? 1 : 0) | (iface.operState === "up" && iface.adminState === "up" ? 2 : 0),
      inOctets: s.rxBytes,
      inUcast: Math.max(0, s.rxFrames - rxM - rxB),
      inMulticast: rxM,
      inBroadcast: rxB,
      inDiscards: s.rxDropped,
      inErrors: 0,
      inUnknownProtos: 0,
      outOctets: s.txBytes,
      outUcast: Math.max(0, s.txFrames - txM - txB),
      outMulticast: txM,
      outBroadcast: txB,
      outDiscards: s.txDropped,
      outErrors: 0,
      promiscuous: 0,
    },
  };
}

/** Egress interface the switch kernel would use to reach a collector (connected routes). */
function collectorEgress(sw: Device, c: SflowCollector): NetInterface | undefined {
  return sw.interfaces
    .filter((i) => i.adminState === "up" && (i.management || i.logical) && (c.vrf !== "mgmt" || i.management))
    .flatMap((i) => i.ipv4.filter((a) => cidrContains(a.address, a.prefix, c.ip)).map((a) => ({ i, prefix: a.prefix })))
    .sort((a, b) => b.prefix - a.prefix)[0]?.i;
}

export interface SflowTickResult {
  flowSamples: number;
  counterSamples: number;
  datagrams: number;
  errors: string[];
}

/**
 * One hsflowd tick (call ~once per second of wall time): poll due counters,
 * flush pending flow samples, and send the datagrams to every collector.
 */
export function sflowAgentTick(ctx: SimContext, sw: Device, nowMs: number): SflowTickResult {
  const result: SflowTickResult = { flowSamples: 0, counterSamples: 0, datagrams: 0, errors: [] };
  const st = peekSflowState(sw);
  if (!st?.enabled) {
    // `service hsflowd stop`: the agent and its counters go away.
    if (sw.config.features?.["sflow-agent"]) delete sw.config.features["sflow-agent"];
    return result;
  }
  const rt = runtime(sw, nowMs);

  const polling = st.pollingInterval ?? DEFAULT_POLLING_INTERVAL;
  const counters: number[][] = [];
  if (polling > 0) {
    const interval = Math.max(MIN_POLLING_INTERVAL, polling);
    for (const iface of frontPanelPorts(sw)) {
      const ifIndex = sflowIfIndex(iface.name);
      if (ifIndex === undefined) continue;
      let p = rt.pollers[iface.name];
      if (!p || p.interval !== interval) {
        // hsflowd staggers pollers across the interval.
        p = rt.pollers[iface.name] = { seq: p?.seq ?? 0, interval, nextDueMs: nowMs + (1 + Math.floor(random(rt) * interval)) * 1000 };
      }
      if (nowMs < p.nextDueMs) continue;
      p.nextDueMs = Math.max(p.nextDueMs + interval * 1000, nowMs + 1000);
      counters.push(encodeSample(counterSample(rt, iface, ifIndex)));
    }
  }

  const flows = rt.pending;
  rt.pending = [];
  result.flowSamples = flows.length;
  result.counterSamples = counters.length;
  rt.stats.counterSamples += counters.length;
  const samples = [...flows, ...counters];
  if (!samples.length) return result;

  const fail = (msg: string) => {
    rt.stats.samplesDiscarded += samples.length;
    rt.stats.lastError = msg;
    result.errors.push(msg);
    return result;
  };
  if (!st.collectors.length) return fail("no sFlow collector configured — samples discarded");
  const agent = selectAgentAddress(sw);
  if (!agent.ip) return fail(agent.reason ?? "no agent address");

  const datagrams = packSamples(samples).map((group) => {
    rt.datagramSeq += 1;
    return encodeDatagram(
      { version: SFLOW_VERSION, agentIp: agent.ip!, subAgentId: SUB_AGENT_ID, seq: rt.datagramSeq, uptimeMs: nowMs - rt.startedAtMs },
      group,
    );
  });

  for (const c of st.collectors) {
    const egress = collectorEgress(sw, c);
    if (!egress) {
      result.errors.push(`no route to collector ${c.ip} (vrf ${c.vrf}) — configure an SVI or eth0 address in its subnet`);
      continue;
    }
    const srcIp = egress.ipv4[0].address;
    const dstMac = resolveArp(ctx, sw, egress, c.ip);
    if (!dstMac) {
      result.errors.push(`collector ${c.ip}: ARP unresolved via ${egress.name} — collector unreachable`);
      continue;
    }
    for (const d of datagrams) {
      const frame = buildFrame(
        {
          srcMac: egress.mac,
          dstMac,
          etherType: "IPv4",
          payloadBytes: 20 + 8 + d.length,
          summary: `sFlowv5, IPv4 agent ${agent.ip}, agent-id ${SUB_AGENT_ID}, length ${d.length}`,
        },
        {
          ipv4: { srcIp, dstIp: c.ip, ttl: 64, protocol: "UDP", identification: rt.datagramSeq & 0xffff },
          udp: { srcPort: rt.srcPort, dstPort: c.port, length: 8 + d.length },
        },
      );
      frame.sflow = { datagram: d };
      ctx.transmit(sw.id, egress.id, frame);
      result.datagrams += 1;
      rt.stats.datagramsSent += 1;
    }
  }
  if (result.errors.length) rt.stats.lastError = result.errors[result.errors.length - 1];
  else delete rt.stats.lastError;
  rt.stats.lastExportAtMs = nowMs;
  return result;
}

/** Count broadcast/multicast frames for the generic counter record split. */
export function countCast(stats: NetInterface["statistics"], dir: "rx" | "tx", dstMac: string): void {
  if (isBroadcast(dstMac)) {
    if (dir === "rx") stats.rxBroadcast = (stats.rxBroadcast ?? 0) + 1;
    else stats.txBroadcast = (stats.txBroadcast ?? 0) + 1;
  } else if (isMulticast(dstMac)) {
    if (dir === "rx") stats.rxMulticast = (stats.rxMulticast ?? 0) + 1;
    else stats.txMulticast = (stats.txMulticast ?? 0) + 1;
  }
}
