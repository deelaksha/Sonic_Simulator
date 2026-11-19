/**
 * View model for the 3D switch view (components/switch3d): everything a learner
 * sees on the faceplate, the "lid off" internals and the inspectors is derived
 * here from the live simulated device — nothing is invented. Pure functions
 * (peek* only, never featureState) so rendering can't mutate the network.
 */
import { Device, isSwitch } from "../models/device";
import { NetworkState } from "../models/topology";
import { NetInterface, InterfaceStats } from "../models/interface";
import { peekFeatureState } from "../models/feature-state";
import { peekCounters, PortRate } from "../protocols/counters-daemon";
import { lldpRuntime, LldpNeighbor } from "../protocols/lldp-daemon";
import { lacpRuntime } from "../protocols/lacp-daemon";
import { peekDrops } from "../control/drops";
import { featureRows } from "../protocols/cpu-features";
import { peekCoppRuntime, CpuQueues } from "../protocols/cpu-daemon";
import type { PortChannel } from "../commands/sonic/lacp";
import type { CaptureRecord } from "../engine";

export type LedColor = "green" | "amber" | "off";
/** Physical form factor drawn on the faceplate. */
export type PortKind = "sfp" | "rj45";

export interface PortPeer {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  ifName: string;
  connectionId?: string;
}

export interface PortView {
  id: string;
  name: string;
  /** Front-panel label (1-based, in EthernetN order). */
  label: number;
  kind: PortKind;
  admin: "up" | "down";
  oper: "up" | "down";
  speedMbps: number;
  speedLabel: string;
  /** Link LED: green = high speed (≥10G), amber = lower speed, off = no link. */
  led: LedColor;
  peer?: PortPeer;
  mac: string;
  ipv4: string[];
  vlan: string;
  lag?: { name: string; selected: boolean; static: boolean };
  lldp?: LldpNeighbor;
  stats: InterfaceStats;
  rate?: PortRate;
  /** Drops on this port by SAI drop reason (lib/control/drops.ts). */
  drops: Record<string, number>;
}

export const speedLabel = (mbps: number): string => (mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);

/** Front-panel (non-management, non-logical) ports in EthernetN order. */
export function frontPorts(d: Device): NetInterface[] {
  const num = (n: string) => Number(n.match(/(\d+)$/)?.[1] ?? 0);
  return d.interfaces.filter((i) => !i.management && !i.logical).sort((a, b) => num(a.name) - num(b.name));
}

export function peerOf(net: NetworkState, d: Device, iface: NetInterface): PortPeer | undefined {
  const conn = net.connections.find(
    (c) => (c.a.deviceId === d.id && c.a.interfaceId === iface.id) || (c.b.deviceId === d.id && c.b.interfaceId === iface.id),
  );
  const far = conn ? (conn.a.deviceId === d.id && conn.a.interfaceId === iface.id ? conn.b : conn.a) : iface.connectedTo;
  if (!far) return undefined;
  const pd = net.devices[far.deviceId];
  const pi = pd?.interfaces.find((i) => i.id === far.interfaceId);
  if (!pd || !pi) return undefined;
  return { deviceId: pd.id, deviceName: pd.name, deviceType: pd.type, ifName: pi.name, connectionId: conn?.id };
}

function vlanText(iface: NetInterface): string {
  const v = iface.vlan;
  if (iface.ipv4.length) return "routed";
  if (v.mode === "trunk") return `trunk ${v.allowedVlans.join(",") || "-"}${v.nativeVlan ? ` (native ${v.nativeVlan})` : ""}`;
  return `access ${v.accessVlan}`;
}

function lagOfPort(d: Device, port: string): PortView["lag"] {
  const pcs = peekFeatureState<{ portchannels: PortChannel[] }>(d, "lacp")?.portchannels ?? [];
  const pc = pcs.find((p) => p.members.includes(port));
  if (!pc) return undefined;
  const rt = lacpRuntime(d)?.lags[pc.name]?.ports[port];
  return { name: pc.name, selected: !!(pc.static ? rt?.linkUp ?? true : rt?.selected), static: !!pc.static };
}

export function portViews(d: Device, net: NetworkState): PortView[] {
  const counters = peekCounters(d);
  const drops = peekDrops(d) ?? {};
  const lldp = lldpRuntime(d)?.neighbors ?? {};
  return frontPorts(d).map((iface, idx) => {
    const up = iface.operState === "up";
    return {
      id: iface.id,
      name: iface.name,
      label: idx + 1,
      kind: iface.speed >= 10_000 ? "sfp" : "rj45",
      admin: iface.adminState,
      oper: iface.operState,
      speedMbps: iface.speed,
      speedLabel: speedLabel(iface.speed),
      led: !up ? "off" : iface.speed >= 10_000 ? "green" : "amber",
      peer: peerOf(net, d, iface),
      mac: iface.mac,
      ipv4: iface.ipv4.map((a) => `${a.address}/${a.prefix}`),
      vlan: vlanText(iface),
      lag: lagOfPort(d, iface.name),
      lldp: lldp[iface.name]?.[0],
      stats: iface.statistics,
      rate: counters?.ports[iface.name],
      drops: Object.fromEntries(Object.entries(drops[iface.name] ?? {}).filter(([, n]) => (n ?? 0) > 0)) as Record<string, number>,
    };
  });
}

/** Total frames seen on a port — the activity LED blinks when this changes. */
export const activityOf = (s: InterfaceStats): number => s.rxFrames + s.txFrames;

export interface CpuView {
  /** CPU queues the hostif traps land in (CoPP): queue → counters. */
  queues: { queue: string; pkts: number; bytes: number; dropPkts: number }[];
  /** Trap groups with their queue and counters (copp_cfg.j2 groups). */
  groups: { group: string; queue: number; pkts: number; dropPkts: number }[];
  /** Individual traps (arp_req, bgp, lacp, …) with their packet rate. */
  traps: { trap: string; pkts: number; pps: number }[];
  /** SONiC containers (FEATURE table) and their processes. */
  containers: { name: string; state: string; processes: string[] }[];
  totalTrapped: number;
  totalPoliced: number;
}

export function cpuView(d: Device): CpuView {
  const q = peekFeatureState<CpuQueues>(d, "cpu-queues") ?? {};
  const rt = peekCoppRuntime(d);
  const queues = Object.entries(q)
    .map(([queue, c]) => ({ queue, pkts: c.pkts, bytes: c.bytes, dropPkts: c.dropPkts }))
    .sort((a, b) => Number(a.queue) - Number(b.queue));
  const groups = Object.entries(rt?.groups ?? {})
    .map(([group, c]) => ({ group, queue: c.queue, pkts: c.pkts, dropPkts: c.dropPkts }))
    .sort((a, b) => b.pkts - a.pkts);
  const traps = Object.entries(rt?.traps ?? {})
    .map(([trap, c]) => ({ trap, pkts: c.pkts, pps: c.pps }))
    .sort((a, b) => b.pkts - a.pkts);
  return {
    queues,
    groups,
    traps,
    containers: isSwitch(d.type) ? featureRows(d).map((f) => ({ name: f.name, state: f.state, processes: f.processes })) : [],
    totalTrapped: queues.reduce((n, x) => n + x.pkts, 0),
    totalPoliced: queues.reduce((n, x) => n + x.dropPkts, 0),
  };
}

/** Most recent captured frames on one port (newest first) — "what is on this wire". */
export function recentFrames(captures: readonly CaptureRecord[], deviceId: string, ifaceId: string, n = 12): CaptureRecord[] {
  const out: CaptureRecord[] = [];
  for (let i = captures.length - 1; i >= 0 && out.length < n; i--) {
    const c = captures[i];
    if (c.deviceId === deviceId && c.interfaceId === ifaceId) out.push(c);
  }
  return out;
}

export const fmtBps = (bps?: number): string => {
  if (bps === undefined) return "—";
  const bits = bps * 8;
  return bits >= 1e9 ? `${(bits / 1e9).toFixed(2)} Gb/s` : bits >= 1e6 ? `${(bits / 1e6).toFixed(2)} Mb/s` : bits >= 1e3 ? `${(bits / 1e3).toFixed(1)} kb/s` : `${bits.toFixed(0)} b/s`;
};
