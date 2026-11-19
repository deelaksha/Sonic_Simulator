/**
 * Drop accounting. The engine already explains every drop as a FRAME_DROPPED /
 * ICMP_UNREACHABLE / ICMP_TIME_EXCEEDED event; Simulation.emit passes those here
 * and they are counted per interface under a drop reason. Reasons use the SAI
 * names SONiC's debug counters accept (sonic-swss orchagent/debug_counter/
 * drop_counter.cpp:20-88, drop_reasons.h); a few simulator-only reasons
 * (PORT_DOWN, LAG_MEMBER_NOT_COLLECTING, …) explain drops SAI has no name for.
 *
 * On top of the raw per-reason table this module keeps the drop-counter
 * CONFIG_DB (DEBUG_COUNTER / DEBUG_COUNTER_DROP_REASON, written by Click
 * `config dropcounters …` and KLISH `dropcounters <name>`) and the
 * `sonic-clear dropcounters` checkpoint, so dropstat can render
 * standard + configured columns (sonic-utilities scripts/dropstat).
 */
import { Device } from "../models/device";
import { featureState, peekFeatureState } from "../models/feature-state";

export type DropReason =
  | "INGRESS_STP_FILTER"
  | "INGRESS_VLAN_FILTER"
  | "VLAN_TAG_NOT_ALLOWED"
  | "L2_LOOPBACK_FILTER"
  | "ACL_ANY"
  | "ACL_EGRESS_PORT"
  | "LPM4_MISS"
  | "TTL"
  | "UNRESOLVED_NEXT_HOP"
  | "L3_EGRESS_LINK_DOWN"
  | "PORT_DOWN"
  | "LAG_MEMBER_NOT_COLLECTING"
  | "LINK_LOCAL_NOT_FORWARDED"
  | "COPP_POLICER"
  | "DIP_LOCAL_NO_LISTENER"
  | "STORM_CONTROL"
  | "DHCP_SNOOPING"
  | "OTHER";

/** Per-interface drop counters: { [ifaceName]: { [reason]: count } }. */
export type DropCounters = Record<string, Partial<Record<DropReason, number>>>;

const RULES: [RegExp, DropReason][] = [
  [/STP port in BLOCKING/i, "INGRESS_STP_FILTER"],
  [/not allowed on trunk/i, "INGRESS_VLAN_FILTER"],
  [/tagged frame arrived on access port/i, "VLAN_TAG_NOT_ALLOWED"],
  [/known on ingress port/i, "L2_LOOPBACK_FILTER"],
  [/dropped on egress by/i, "ACL_EGRESS_PORT"],
  // storm-control policer / DHCP snooping hooks (lib/protocols/storm-control.ts, dhcp-snooping.ts)
  [/dropped on ingress by storm-control/i, "STORM_CONTROL"],
  [/dropped on ingress by dhcp-snooping/i, "DHCP_SNOOPING"],
  [/dropped on ingress by copp|CoPP|policer/i, "COPP_POLICER"],
  [/dropped on ingress by/i, "ACL_ANY"],
  [/no route to|no-route/i, "LPM4_MISS"],
  [/TTL expired|hop-limit exceeded/i, "TTL"],
  [/arp-failed|ndp-failed|could not forward/i, "UNRESOLVED_NEXT_HOP"],
  // engine transmit(): egress port admin down / no cable / link down
  [/link is down|no cable connected|interface administratively down/i, "L3_EGRESS_LINK_DOWN"],
  [/ingress interface down/i, "PORT_DOWN"],
  [/LAG member not collecting|no active member/i, "LAG_MEMBER_NOT_COLLECTING"],
  [/link-local control frame/i, "LINK_LOCAL_NOT_FORWARDED"],
  [/no listener/i, "DIP_LOCAL_NO_LISTENER"],
];

export function classifyDrop(message: string): DropReason {
  for (const [re, r] of RULES) if (re.test(message)) return r;
  return "OTHER";
}

export function recordDrop(device: Device, ifaceName: string, reason: DropReason): void {
  const c = featureState<DropCounters>(device, "drops", () => ({}));
  const row = (c[ifaceName] ??= {});
  row[reason] = (row[reason] ?? 0) + 1;
}

export function peekDrops(device: Device): DropCounters | undefined {
  return peekFeatureState<DropCounters>(device, "drops");
}

// --- port discards (SAI_PORT_STAT_IF_IN/OUT_DISCARDS) -------------------------

/** Drops the simulator attributes to the egress port (counted as TX discards). */
export const EGRESS_REASONS: readonly DropReason[] = ["ACL_EGRESS_PORT", "L3_EGRESS_LINK_DOWN"];
/** CPU-path drops (CoPP policer, no socket) are not port discards on an ASIC. */
const NOT_PORT_DISCARDS: readonly DropReason[] = ["COPP_POLICER", "DIP_LOCAL_NO_LISTENER"];

/** IF_IN_DISCARDS / IF_OUT_DISCARDS of one port, from the per-reason table. */
export function portDiscards(device: Device, ifaceName: string): { rx: number; tx: number } {
  const row = peekDrops(device)?.[ifaceName] ?? {};
  let rx = 0;
  let tx = 0;
  for (const [r, n] of Object.entries(row) as [DropReason, number][]) {
    if (NOT_PORT_DISCARDS.includes(r)) continue;
    if (EGRESS_REASONS.includes(r)) tx += n;
    else rx += n;
  }
  return { rx, tx };
}

// --- drop-counter configuration (DEBUG_COUNTER) --------------------------------

export const COUNTER_TYPES = ["PORT_INGRESS_DROPS", "PORT_EGRESS_DROPS", "SWITCH_INGRESS_DROPS", "SWITCH_EGRESS_DROPS"] as const;
export type CounterType = (typeof COUNTER_TYPES)[number];

/**
 * Simulated STATE_DB DEBUG_COUNTER_CAPABILITIES: the reasons the engine can
 * actually attribute (no fabricated ASIC capabilities), 3 counters per type.
 */
const INGRESS_CAP: DropReason[] = [
  "ACL_ANY",
  "INGRESS_STP_FILTER",
  "INGRESS_VLAN_FILTER",
  "L2_LOOPBACK_FILTER",
  "L3_EGRESS_LINK_DOWN",
  "LPM4_MISS",
  "TTL",
  "UNRESOLVED_NEXT_HOP",
  "VLAN_TAG_NOT_ALLOWED",
];
const EGRESS_CAP: DropReason[] = ["ACL_EGRESS_PORT", "L3_EGRESS_LINK_DOWN"];
export const CAPABILITIES: Record<CounterType, { count: number; reasons: DropReason[] }> = {
  PORT_INGRESS_DROPS: { count: 3, reasons: INGRESS_CAP },
  PORT_EGRESS_DROPS: { count: 3, reasons: EGRESS_CAP },
  SWITCH_INGRESS_DROPS: { count: 3, reasons: INGRESS_CAP },
  SWITCH_EGRESS_DROPS: { count: 3, reasons: EGRESS_CAP },
};

export interface DebugCounter {
  name: string;
  type?: string;
  alias?: string;
  group?: string;
  desc?: string;
  /** KLISH-only fields (dropcounters.xml sub-view). */
  mirror?: string;
  enabled?: boolean;
  reasons: string[];
  /** Per-reason drop totals at the moment the reason was attached (counter starts at 0). */
  base: Record<string, number>;
}

interface DropCfg {
  counters: DebugCounter[];
  /** `sonic-clear dropcounters` checkpoint: { [row]: { [column]: count } } (dropstat port-stats file). */
  ckpt?: Record<string, Record<string, number>>;
}

function dropCfg(device: Device): DropCfg {
  return featureState<DropCfg>(device, "dropcounters-cfg", () => ({ counters: [] }));
}

export function debugCounters(device: Device): DebugCounter[] {
  return peekFeatureState<DropCfg>(device, "dropcounters-cfg")?.counters ?? [];
}

export function getDebugCounter(device: Device, name: string): DebugCounter | undefined {
  return debugCounters(device).find((c) => c.name === name);
}

/** Total recorded drops of one reason (all interfaces, or one). */
function reasonTotal(device: Device, reason: string, ifaceName?: string): number {
  const d = peekDrops(device) ?? {};
  const rows = ifaceName ? [d[ifaceName] ?? {}] : Object.values(d);
  return rows.reduce((n, row) => n + ((row as Record<string, number>)[reason] ?? 0), 0);
}

function baseKey(reason: string, ifaceName?: string): string {
  return ifaceName ? `${ifaceName}|${reason}` : reason;
}

/** Create-or-update a counter's fields (KLISH sub-view writes one field at a time). */
export function upsertDebugCounter(device: Device, name: string, patch: Partial<Omit<DebugCounter, "name" | "base">>): DebugCounter {
  const cfg = dropCfg(device);
  let c = cfg.counters.find((x) => x.name === name);
  if (!c) {
    c = { name, reasons: [], base: {} };
    cfg.counters.push(c);
  }
  const { reasons, ...rest } = patch;
  Object.assign(c, rest);
  if (reasons) setReasons(device, c, reasons);
  return c;
}

/** Replace the reason list; newly attached reasons start counting from now. */
function setReasons(device: Device, c: DebugCounter, reasons: string[]): void {
  for (const r of reasons) {
    if (c.reasons.includes(r)) continue;
    c.base[baseKey(r)] = reasonTotal(device, r);
    for (const ifn of Object.keys(peekDrops(device) ?? {})) c.base[baseKey(r, ifn)] = reasonTotal(device, r, ifn);
  }
  for (const k of Object.keys(c.base)) if (!reasons.includes(k.split("|").pop()!)) delete c.base[k];
  c.reasons = [...reasons];
}

export function addCounterReasons(device: Device, name: string, reasons: string[]): void {
  const c = getDebugCounter(device, name);
  if (c) setReasons(device, c, [...c.reasons, ...reasons.filter((r) => !c.reasons.includes(r))]);
}

export function removeCounterReasons(device: Device, name: string, reasons: string[]): void {
  const c = getDebugCounter(device, name);
  if (c) setReasons(device, c, c.reasons.filter((r) => !reasons.includes(r)));
}

export function deleteDebugCounter(device: Device, name: string): void {
  const cfg = dropCfg(device);
  cfg.counters = cfg.counters.filter((c) => c.name !== name);
}

/** Current value of a configured counter on one port (PORT_*) or switch-wide (SWITCH_*). */
export function debugCounterValue(device: Device, c: DebugCounter, ifaceName?: string): number {
  return c.reasons.reduce((n, r) => n + Math.max(0, reasonTotal(device, r, ifaceName) - (c.base[baseKey(r, ifaceName)] ?? 0)), 0);
}

export function dropCheckpoint(device: Device): Record<string, Record<string, number>> {
  return peekFeatureState<DropCfg>(device, "dropcounters-cfg")?.ckpt ?? {};
}

export function setDropCheckpoint(device: Device, ckpt: Record<string, Record<string, number>>): void {
  dropCfg(device).ckpt = ckpt;
}
