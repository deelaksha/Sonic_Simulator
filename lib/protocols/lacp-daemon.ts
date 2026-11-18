/**
 * LACP / PortChannel daemon — teamd's lacp runner (libteam 1.31 + SONiC patches)
 * as SONiC's teammgrd starts it, plus the LAG data plane (member selection for
 * receive, flow hashing for transmit).
 *
 * Sources (sonic-buildimage/src):
 *   sonic-swss/cfgmgr/teammgr.cpp:606-627   teamd config: hwaddr = system MAC, runner
 *       {"active":true,"name":"lacp"} + min_ports / fallback / fast_rate from PORTCHANNEL.
 *   sonic-swss/cfgmgr/teammgr.cpp:708-714   lacp_key "auto" = "1" + LAG digits (PortChannel1 → 11).
 *   libteam/teamd/teamd_runner_lacp.c (all line numbers below are this file):
 *     46-53     actor/partner state bits.  55-100  LACPDU layout (110 bytes after EtherType).
 *     200,262   defaults: system priority 0xffff, port priority 0xff.
 *     1275-1285 actor port id = EthernetN → N+1.
 *     1167-1171 periodic 1 s (fast) / 30 s (slow); timeout = 3 × interval.
 *     1178-1196 our partner timeout uses OUR fast_rate (or forced fast in EXPIRED).
 *     1198-1218 periodic tx interval follows the PARTNER's Timeout bit.
 *     1298-1321 actor state: Sync when selected into the selected aggregator,
 *               Collecting|Distributing only when the partner is also in Sync.
 *     629-651   member enabled (collecting/distributing in the data plane) when
 *               selected in the selected aggregator and partner Sync (or fallback).
 *     660-670   ports aggregate only with equal actor key, partner key, partner system.
 *     693-724   aggregator choice by LACP priority (higher-priority system's info).
 *     770-857   carrier (PortChannel oper up) when enabled ports ≥ min_ports.
 *     1328-1418 fallback: no port receiving LACPDUs → best defaulted port → FALLBACK.
 *     1420-1484 port state machine (DISABLED/CURRENT/EXPIRED/DEFAULTED/FALLBACK); every
 *               state change sends a LACPDU.
 *     1487-1514 link up → EXPIRED, link down → DISABLED.
 *     1592-1700 LACPDU receive: partner update, CURRENT, reply when the partner's
 *               view of us is wrong, restart the timeout.
 *     1734-1754 timeout: CURRENT → EXPIRED → DEFAULTED.
 *   libteam/patch/0006 admin-down PortChannel disables its members; 0013 removed member
 *       goes DISABLED (one last LACPDU).
 *   tcpdump print-slow.c (not in the tree; tcpdump 4.99 output format):
 *       "LACPv1, length 110" and the -v TLV lines.
 *
 * Simulator choices (documented, not from a source):
 *   - Aggregator selection is recomputed from scratch on every event instead of
 *     teamd's incremental agg_lead bookkeeping; the steady state is the same.
 *     Priority comparison is numeric (sys prio, system MAC, port prio, port).
 *   - "Send immediately when our actor state changed" (libteam patch 0007 is
 *     disabled in series, but teamd's refresh hook 0002 + set_state sends give the
 *     same effect for selection changes) — keeps convergence in a few PDUs.
 *   - LAG hashing is done by the ASIC in SONiC (SAI hash, lag_hash_seed 0 from
 *     dockers/docker-orchagent/switch.json.j2:31). Here: FNV-1a over
 *     src MAC, dst MAC, src IP, dst IP, IP protocol, L4 src/dst port (ARP: sender/
 *     target IP) + murmur3 fmix32, modulo the enabled members sorted by name. Deterministic: one flow
 *     always uses one member; different flows spread over members.
 *   - Static (mode on) LAGs are not modelled: this SONiC tree only supports
 *     `mode active` (interface.xml:394, teammgr.cpp:609 "active":true).
 */
import { registerDaemon } from "../control/daemon";
import { registerDataPlaneHook } from "../control/hooks";
import { transmitL2 } from "../control/packet";
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { SimContext } from "../engine/context";
import { generateMac } from "../models/mac";

export const SLOW_PROTOCOLS_MAC = "01:80:C2:00:00:02";
export const ETH_P_SLOW = 0x8809;
const PERIODIC_SHORT = 1000; // teamd_runner_lacp.c:1167
const PERIODIC_LONG = 30000; // :1168
const PERIODIC_MUL = 3; // :1171 (default retry count 3, :213)
const DFLT_SYS_PRIO = 0xffff; // :200
const DFLT_PORT_PRIO = 0xff; // :262

export const ST = {
  ACTIVITY: 0x01,
  TIMEOUT: 0x02,
  AGGREGATION: 0x04,
  SYNC: 0x08,
  COLLECTING: 0x10,
  DISTRIBUTING: 0x20,
  DEFAULTED: 0x40,
  EXPIRED: 0x80,
} as const;

export type PortState = "disabled" | "current" | "expired" | "defaulted" | "fallback";

export interface LacpInfo {
  sysPrio: number;
  system: string;
  key: number;
  portPrio: number;
  port: number;
  state: number;
}

export interface LacpPortRt {
  state: PortState;
  actor: LacpInfo;
  partner: LacpInfo;
  selected: boolean;
  /** Collecting + distributing in the data plane (teamd port enabled). */
  enabled: boolean;
  linkUp: boolean;
  nextTx?: number;
  timeoutAt?: number;
  tx: number;
  rx: number;
}

export interface LacpLagRt {
  ports: Record<string, LacpPortRt>;
  carrier: boolean;
}

export interface LacpRt {
  sig: string;
  lags: Record<string, LacpLagRt>;
}

/** Read-only view of the CONFIG_DB PORTCHANNEL state kept by lib/commands/sonic/lacp.ts. */
export interface LagCfg {
  name: string;
  members: string[];
  minLinks?: number;
  fallback?: boolean;
  fastRate?: boolean;
  mode?: string;
}

const RT = "teamd";
const ZERO_MAC = "00:00:00:00:00:00";
const zeroInfo = (state = 0): LacpInfo => ({ sysPrio: 0, system: ZERO_MAC, key: 0, portPrio: 0, port: 0, state });

export function lacpRuntime(d: Device): LacpRt | undefined {
  return peekFeatureState<LacpRt>(d, RT);
}

/** LAGs whose PortChannel interface exists: config entries + KLISH-created interfaces. */
export function lagConfigs(d: Device): LagCfg[] {
  const cfg = peekFeatureState<{ portchannels: LagCfg[] }>(d, "lacp")?.portchannels ?? [];
  const out: LagCfg[] = [];
  for (const i of d.interfaces) {
    if (!i.logical || !/^PortChannel\d+$/.test(i.name)) continue;
    out.push(cfg.find((c) => c.name === i.name) ?? { name: i.name, members: [] });
  }
  return out;
}

/**
 * The switch system MAC (DEVICE_METADATA mac). The simulator derives it from the
 * device id exactly like KLISH-created logical interfaces (sonic-cli.ts logicalMac),
 * so a PortChannel's hwaddr equals the system MAC (teammgr.cpp:607).
 */
export function systemMac(d: Device): string {
  let seed = 0x0e0000;
  for (const c of d.id) seed = (seed * 31 + c.charCodeAt(0)) & 0xffffff;
  return generateMac(seed);
}

/** teammgr.cpp:708-714 lacp_key "auto" → "1" + digits of the LAG name. */
export function lacpKey(lag: string): number {
  const digits = lag.slice(lag.search(/\d/));
  return Number(`1${digits}`) & 0xffff;
}

/** teamd_runner_lacp.c:1275-1285 EthernetN → N + 1. */
export function lacpPortId(name: string): number {
  const m = /^Ethernet(\d+)$/.exec(name);
  return m ? (Number(m[1]) + 1) & 0xffff : 0;
}

const ifByName = (d: Device, n: string) => d.interfaces.find((i) => i.name === n);
const lagIface = (d: Device, lag: string) => d.interfaces.find((i) => i.logical && i.name === lag);
const linkUp = (i: NetInterface | undefined) => !!i && i.adminState === "up" && i.operState === "up";
const minLinks = (c: LagCfg) => c.minLinks ?? 1;
const sameInfo = (a: LacpInfo, b: LacpInfo) =>
  a.sysPrio === b.sysPrio && a.system.toUpperCase() === b.system.toUpperCase() && a.key === b.key && a.portPrio === b.portPrio && a.port === b.port && a.state === b.state;

function signature(d: Device, lags: LagCfg[]): string {
  return lags
    .map((c) => {
      const pc = lagIface(d, c.name);
      const m = c.members.map((n) => `${n}:${linkUp(ifByName(d, n)) ? 1 : 0}`).join(",");
      return `${c.name}/${pc?.adminState}/${pc?.mac}/${minLinks(c)}/${c.fallback ? 1 : 0}/${c.fastRate ? 1 : 0}/${m}`;
    })
    .join(";");
}

// ---------- LACPDU wire format (teamd_runner_lacp.c:55-119) ----------

const macBytes = (m: string) => m.split(":").map((x) => parseInt(x, 16));
const hexMac = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(":");
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];

function infoBytes(i: LacpInfo): number[] {
  return [...u16(i.sysPrio), ...macBytes(i.system), ...u16(i.key), ...u16(i.portPrio), ...u16(i.port), i.state & 0xff];
}

/** The 110-byte LACPDU (after the EtherType), version 1. */
export function buildLacpdu(actor: LacpInfo, partner: LacpInfo): number[] {
  const out = [0x01, 0x01]; // subtype LACP, version 1
  out.push(0x01, 0x14, ...infoBytes(actor), 0, 0, 0);
  out.push(0x02, 0x14, ...infoBytes(partner), 0, 0, 0);
  out.push(0x03, 0x10, 0, 0, ...new Array(12).fill(0)); // collector, max delay 0
  out.push(0x00, 0x00, ...new Array(8).fill(0)); // terminator (v1)
  out.push(...new Array(42).fill(0));
  return out;
}

function parseInfo(b: number[], off: number): LacpInfo {
  return {
    sysPrio: (b[off] << 8) | b[off + 1],
    system: hexMac(b.slice(off + 2, off + 8)),
    key: (b[off + 8] << 8) | b[off + 9],
    portPrio: (b[off + 10] << 8) | b[off + 11],
    port: (b[off + 12] << 8) | b[off + 13],
    state: b[off + 14],
  };
}

export function parseLacpdu(bytes: ArrayLike<number>): { version: number; actor: LacpInfo; partner: LacpInfo; maxDelay: number } | null {
  const b = Array.from(bytes);
  if (b.length < 62 || b[0] !== 0x01) return null; // lacpdu_check: subtype must be LACP (:121-133)
  return { version: b[1], actor: parseInfo(b, 4), partner: parseInfo(b, 24), maxDelay: (b[44] << 8) | b[45] };
}

/** tcpdump print-slow.c state flag names. */
const STATE_NAMES: [number, string][] = [
  [ST.ACTIVITY, "Activity"], [ST.TIMEOUT, "Timeout"], [ST.AGGREGATION, "Aggregation"], [ST.SYNC, "Synchronization"],
  [ST.COLLECTING, "Collecting"], [ST.DISTRIBUTING, "Distributing"], [ST.DEFAULTED, "Default"], [ST.EXPIRED, "Expired"],
];
export const stateFlags = (s: number) => STATE_NAMES.filter(([b]) => s & b).map(([, n]) => n).join(", ");

// ---------- the runner ----------

function rtOf(d: Device): LacpRt {
  return featureState<LacpRt>(d, RT, () => ({ sig: "", lags: {} }));
}

interface Pending {
  iface: NetInterface;
  port: LacpPortRt;
}

function newPort(d: Device, lag: LagCfg, member: string): LacpPortRt {
  return {
    state: "disabled",
    actor: actorInit(d, lag, member),
    partner: zeroInfo(),
    selected: false,
    enabled: false,
    linkUp: false,
    tx: 0,
    rx: 0,
  };
}

/** lacp_port_actor_init (:1287-1296); system = the PortChannel (team device) hwaddr. */
function actorInit(d: Device, lag: LagCfg, member: string, state = 0): LacpInfo {
  return {
    sysPrio: DFLT_SYS_PRIO,
    system: (lagIface(d, lag.name)?.mac ?? ZERO_MAC).toUpperCase(),
    key: lacpKey(lag.name),
    portPrio: DFLT_PORT_PRIO,
    port: lacpPortId(member),
    state,
  };
}

const interval = (p: LacpPortRt) => (p.partner.state & ST.TIMEOUT ? PERIODIC_SHORT : PERIODIC_LONG);

/** lacp_port_set_state (:1420-1484). Returns true when the state changed (→ send). */
function setState(p: LacpPortRt, next: PortState, now: number, adminUp: boolean): boolean {
  if (next === p.state || (!adminUp && next !== "disabled")) return false;
  const oldInterval = interval(p);
  switch (next) {
    case "expired":
      p.partner.state = (p.partner.state | ST.TIMEOUT) & ~ST.SYNC;
      p.timeoutAt = now + PERIODIC_SHORT * PERIODIC_MUL; // timeout_set(fast_forced)
      break;
    case "defaulted":
    case "fallback":
      p.timeoutAt = undefined;
      p.partner = zeroInfo(ST.TIMEOUT);
      break;
    case "disabled":
      p.timeoutAt = undefined;
      p.partner = zeroInfo();
      break;
    case "current":
      break;
  }
  if (next === "disabled") p.nextTx = undefined; // periodic off
  else if (p.nextTx === undefined || interval(p) !== oldInterval) p.nextTx = now + interval(p);
  p.state = next;
  return true;
}

function prioTuple(p: LacpPortRt): [number, string, number, number] {
  // get_lacp_port_prio_info (:693-714): the info of the higher-priority system.
  const a = p.actor;
  const b = p.partner;
  const actorFirst = a.sysPrio < b.sysPrio || (a.sysPrio === b.sysPrio && a.system.toUpperCase() < b.system.toUpperCase());
  const i = actorFirst ? a : b;
  return [i.sysPrio, i.system.toUpperCase(), i.portPrio, i.port];
}

function better(a: LacpPortRt, b: LacpPortRt | undefined): boolean {
  if (!b) return true;
  const x = prioTuple(a);
  const y = prioTuple(b);
  for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] < y[k];
  return false;
}

const aggKey = (p: LacpPortRt) => `${p.actor.key}|${p.partner.key}|${p.partner.system.toUpperCase()}`;

/**
 * Selection + fallback + actor state + enabled + carrier for one LAG. Ports whose
 * actor info changed are added to `send`.
 */
function recompute(d: Device, lag: LagCfg, lr: LacpLagRt, now: number, send: Set<string>): void {
  const adminUp = lagIface(d, lag.name)?.adminState === "up";
  const ports = Object.entries(lr.ports).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  // Fallback (:1353-1418) may move a port DEFAULTED ↔ FALLBACK; loop until stable.
  for (let guard = 0; guard < 4; guard++) {
    if (!lag.fallback) {
      for (const [n, p] of ports) if (p.state === "fallback" && setState(p, "defaulted", now, adminUp)) send.add(n);
      break;
    }
    let have = false;
    let cur: [string, LacpPortRt] | undefined;
    let best: [string, LacpPortRt] | undefined;
    for (const e of ports) {
      const p = e[1];
      if (p.state === "disabled") continue;
      if (p.state === "current" || p.state === "expired") {
        have = true;
        continue;
      }
      if (p.state === "fallback") cur = e;
      // lacp_port_better_for_fallback (:1328-1351): lower system, higher port prio, lower port.
      if (!best || p.actor.portPrio > best[1].actor.portPrio || (p.actor.portPrio === best[1].actor.portPrio && p.actor.port < best[1].actor.port)) best = e;
    }
    const want = have ? undefined : best;
    if (cur?.[0] === want?.[0]) break;
    if (cur) {
      if (setState(cur[1], "defaulted", now, adminUp)) send.add(cur[0]);
    } else if (want && setState(want[1], "fallback", now, adminUp)) send.add(want[0]);
  }

  // lacp_port_agg_update (:1116-1133): unselect / select.
  for (const [, p] of ports) {
    const loopFree = p.actor.system.toUpperCase() !== p.partner.system.toUpperCase();
    const selectable = (p.state === "current" || p.state === "fallback") && loopFree;
    const unselectable = p.state === "disabled" || p.state === "defaulted";
    if (p.selected && (unselectable || !loopFree)) p.selected = false;
    if (!p.selected && selectable) p.selected = true;
  }
  // lacp_get_best_agg_by_best_port: aggregator of the best selected port.
  let bestPort: LacpPortRt | undefined;
  for (const [, p] of ports) if (p.selected && better(p, bestPort)) bestPort = p;
  const chosen = bestPort ? aggKey(bestPort) : undefined;

  let enabled = 0;
  for (const [n, p] of ports) {
    const aggSelected = p.selected && aggKey(p) === chosen;
    // lacp_port_actor_update (:1298-1321)
    let s = ST.ACTIVITY;
    if (lag.fastRate) s |= ST.TIMEOUT;
    if (aggSelected) {
      s |= ST.SYNC;
      if (p.partner.state & ST.SYNC) s |= ST.COLLECTING | ST.DISTRIBUTING;
    }
    if (p.state === "expired") s |= ST.EXPIRED;
    if (p.state === "defaulted" || p.state === "fallback") s |= ST.DEFAULTED;
    s |= ST.AGGREGATION;
    const actor = actorInit(d, lag, n, s);
    if (!sameInfo(actor, p.actor)) {
      p.actor = actor;
      if (p.state !== "disabled") send.add(n);
    }
    p.enabled = aggSelected && (!!(p.partner.state & ST.SYNC) || p.state === "fallback") && p.linkUp;
    if (p.enabled) enabled++;
  }
  lr.carrier = adminUp && enabled >= minLinks(lag);
}

function txPdu(ctx: SimContext, d: Device, lag: string, member: NetInterface, p: LacpPortRt): void {
  if (lagIface(d, lag)?.adminState !== "up") return; // lacpdu_send: admin down → nothing (:1524-1526)
  p.tx++;
  transmitL2(ctx, d, member, SLOW_PROTOCOLS_MAC, ETH_P_SLOW, buildLacpdu(p.actor, p.partner), `LACPv1 actor ${p.actor.system} key ${p.actor.key} port ${p.actor.port} [${stateFlags(p.actor.state)}]`);
}

/** Queue a LACPDU for every port in `send` (sent after all state is updated). */
function queue(d: Device, lr: LacpLagRt, send: Set<string>, out: Pending[]): void {
  for (const n of send) {
    const iface = ifByName(d, n);
    const p = lr.ports[n];
    if (iface && p) out.push({ iface, port: p });
  }
}

/** Apply the LAG's carrier/speed to its PortChannel interface. */
function applyCarrier(d: Device, lag: LagCfg, lr: LacpLagRt): boolean {
  const pc = lagIface(d, lag.name);
  if (!pc) return false;
  const oper = lr.carrier ? "up" : "down";
  const speed = Object.entries(lr.ports).filter(([, p]) => p.enabled).reduce((s, [n]) => s + (ifByName(d, n)?.speed ?? 0), 0);
  let changed = false;
  if (pc.operState !== oper) {
    pc.operState = oper;
    changed = true;
  }
  if (speed > 0 && pc.speed !== speed) {
    pc.speed = speed;
    changed = true;
  }
  return changed;
}

function sendAll(ctx: SimContext, d: Device, items: { lag: string; out: Pending[] }[]): void {
  for (const { lag, out } of items) for (const { iface, port } of out) txPdu(ctx, d, lag, iface, port);
}

function tickDevice(ctx: SimContext, d: Device, now: number): boolean {
  const lags = lagConfigs(d);
  const rt = rtOf(d);
  let changed = false;
  // KLISH `no interface PortChannel N` removed the netdev: drop its PORTCHANNEL row too.
  const cfg = peekFeatureState<{ portchannels: LagCfg[] }>(d, "lacp");
  if (cfg && cfg.portchannels.some((p) => !lagIface(d, p.name))) {
    cfg.portchannels = cfg.portchannels.filter((p) => lagIface(d, p.name));
    changed = true;
  }
  // LAGs that disappeared (PortChannel deleted): teamd exits and removes its ports,
  // each going DISABLED with one last LACPDU without Sync (patch 0013).
  const finals: Pending[] = [];
  for (const name of Object.keys(rt.lags)) {
    if (lags.some((l) => l.name === name)) continue;
    for (const [n, p] of Object.entries(rt.lags[name].ports)) {
      const iface = ifByName(d, n);
      if (p.state === "disabled" || !iface) continue;
      p.actor = { ...p.actor, state: p.actor.state & (ST.ACTIVITY | ST.TIMEOUT | ST.AGGREGATION) };
      finals.push({ iface, port: p });
    }
    delete rt.lags[name];
    changed = true;
  }
  for (const { iface, port } of finals) {
    port.tx++;
    transmitL2(ctx, d, iface, SLOW_PROTOCOLS_MAC, ETH_P_SLOW, buildLacpdu(port.actor, port.partner), `LACPv1 actor ${port.actor.system} (port removed)`);
  }
  const sends: { lag: string; out: Pending[] }[] = [];
  for (const lag of lags) {
    const lr = (rt.lags[lag.name] ??= { ports: {}, carrier: false });
    const adminUp = lagIface(d, lag.name)?.adminState === "up";
    const send = new Set<string>();
    const out: Pending[] = [];
    // Removed members: one DISABLED LACPDU, then forget (patch 0013).
    for (const n of Object.keys(lr.ports)) {
      if (lag.members.includes(n)) continue;
      const p = lr.ports[n];
      if (setState(p, "disabled", now, adminUp)) {
        p.actor = actorInit(d, lag, n, ST.ACTIVITY | ST.AGGREGATION | (lag.fastRate ? ST.TIMEOUT : 0));
        const iface = ifByName(d, n);
        if (iface) out.push({ iface, port: p });
      }
      delete lr.ports[n];
      changed = true;
    }
    for (const n of lag.members) {
      const iface = ifByName(d, n);
      if (!iface) continue;
      const p = (lr.ports[n] ??= newPort(d, lag, n));
      // Link watch (ethtool): lacp_port_link_update (:1487-1514). Admin-down LAG → members disabled (patch 0006).
      const up = linkUp(iface) && adminUp;
      if (up !== p.linkUp) {
        p.linkUp = up;
        changed = true;
        if (setState(p, up ? "expired" : "disabled", now, adminUp)) send.add(n);
      }
      // Timeout callback (:1734-1754).
      if (p.timeoutAt !== undefined && p.timeoutAt <= now) {
        p.timeoutAt = undefined;
        changed = true;
        if (p.state === "current" && setState(p, "expired", now, adminUp)) send.add(n);
        else if (p.state === "expired" && setState(p, "defaulted", now, adminUp)) send.add(n);
      }
      // Periodic callback (:1769-1776): only while periodic is on (not DISABLED).
      if (p.nextTx !== undefined && p.nextTx <= now) {
        p.nextTx = now + interval(p);
        send.add(n);
        changed = true;
      }
    }
    recompute(d, lag, lr, now, send);
    if (applyCarrier(d, lag, lr)) changed = true;
    queue(d, lr, send, out);
    if (out.length) changed = true;
    sends.push({ lag: lag.name, out });
  }
  rt.sig = signature(d, lags);
  sendAll(ctx, d, sends); // after every state mutation: replies may re-enter receiveL2
  return changed;
}

function receive(ctx: SimContext, d: Device, ingress: NetInterface, frame: Frame): boolean {
  if (frame.ethernet.typeCode !== ETH_P_SLOW || !frame.rawL3) return false;
  const pdu = parseLacpdu(frame.rawL3);
  if (!pdu) return false;
  if (!isSwitch(d.type)) return false;
  const lag = lagConfigs(d).find((l) => l.members.includes(ingress.name));
  if (!lag) return false; // not a teamd port: nobody listens on the slow-protocols address
  const rt = rtOf(d);
  const lr = rt.lags[lag.name];
  const p = lr?.ports[ingress.name];
  const pc = lagIface(d, lag.name);
  if (!lr || !p || pc?.adminState !== "up" || p.state === "disabled") return true; // lacpdu_recv: admin down → ignore
  const now = ctx.wallNow();
  p.rx++;
  const send = new Set<string>();
  // :1603-1611 partner info update.
  if (!sameInfo(pdu.actor, p.partner)) {
    const oldInterval = interval(p);
    p.partner = { ...pdu.actor, system: pdu.actor.system.toUpperCase() };
    if (interval(p) !== oldInterval) p.nextTx = now + interval(p); // lacp_port_periodic_set
  }
  if (setState(p, "current", now, true)) send.add(ingress.name);
  recompute(d, lag, lr, now, send);
  // :1685-1690 the other side has wrong info about us → reply.
  if (!sameInfo(pdu.partner, p.actor)) send.add(ingress.name);
  // :1692-1698 restart the timeout with OUR rate.
  p.timeoutAt = now + (lag.fastRate ? PERIODIC_SHORT : PERIODIC_LONG) * PERIODIC_MUL;
  applyCarrier(d, lag, lr);
  const out: Pending[] = [];
  queue(d, lr, send, out);
  sendAll(ctx, d, [{ lag: lag.name, out }]);
  return true;
}

registerDaemon({
  id: "lacp",
  nextDue(d, now) {
    if (!isSwitch(d.type)) return undefined;
    const rt = lacpRuntime(d);
    const lags = lagConfigs(d);
    const stale = peekFeatureState<{ portchannels: LagCfg[] }>(d, "lacp")?.portchannels.some((p) => !lagIface(d, p.name));
    if (stale) return now;
    if (!lags.length) return rt && Object.keys(rt.lags).length ? now : undefined;
    if (!rt || rt.sig !== signature(d, lags)) return now;
    let due: number | undefined;
    for (const lr of Object.values(rt.lags)) {
      for (const p of Object.values(lr.ports)) {
        for (const t of [p.nextTx, p.timeoutAt]) if (t !== undefined && (due === undefined || t < due)) due = t;
      }
    }
    return due;
  },
  tick: (ctx, d, now) => tickDevice(ctx, d, now),
  receiveL2: receive,
  describe(frame: Frame, verbose: boolean) {
    if (frame.ethernet.typeCode !== ETH_P_SLOW || !frame.rawL3) return undefined;
    const pdu = parseLacpdu(frame.rawL3);
    if (!pdu) return undefined;
    const head = `LACPv${pdu.version}, length ${frame.rawL3.length}`;
    if (!verbose) return head;
    const info = (name: string, type: number, i: LacpInfo) => [
      `\t${name} Information TLV (0x${type.toString(16).padStart(2, "0")}), length 20`,
      `\t  System ${i.system.toLowerCase()}, System Priority ${i.sysPrio}, Key ${i.key}, Port ${i.port}, Port Priority ${i.portPrio}`,
      `\t  State Flags [${stateFlags(i.state)}]`,
    ];
    return [
      head,
      ...info("Actor", 1, pdu.actor),
      ...info("Partner", 2, pdu.partner),
      "\tCollector Information TLV (0x03), length 16",
      `\t  Max Delay ${pdu.maxDelay}`,
      "\tTerminator TLV (0x00), length 0",
    ].join("\n");
  },
});

// ---------- data plane ----------

function memberRt(d: Device, iface: NetInterface): { lag: string; port?: LacpPortRt } | undefined {
  if (iface.logical || iface.management) return undefined;
  const cfg = peekFeatureState<{ portchannels: LagCfg[] }>(d, "lacp")?.portchannels;
  const lag = cfg?.find((l) => l.members.includes(iface.name));
  if (!lag || !lagIface(d, lag.name)) return undefined;
  return { lag: lag.name, port: lacpRuntime(d)?.lags[lag.name]?.ports[iface.name] };
}

/** FNV-1a + murmur3 fmix32 finalizer (FNV's low bit alone is a byte parity → bad for `% 2`). */
function flowHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Flow key hashed for member selection (see header). */
export function flowKey(f: Frame): string {
  const l4 = f.tcp ?? f.udp;
  const srcIp = f.ipv4?.srcIp ?? f.arp?.senderIp ?? "";
  const dstIp = f.ipv4?.dstIp ?? f.arp?.targetIp ?? "";
  const proto = f.ipv4 ? (f.ipv4.protocolNumber ?? f.ipv4.protocol) : f.ethernet.etherType;
  return [f.ethernet.srcMac.toUpperCase(), f.ethernet.dstMac.toUpperCase(), srcIp, dstIp, proto, l4?.srcPort ?? "", l4?.dstPort ?? ""].join("|");
}

/** Enabled (collecting/distributing) members of a LAG, sorted by name. */
export function activeMembers(d: Device, lag: string): NetInterface[] {
  const lr = lacpRuntime(d)?.lags[lag];
  if (!lr) return [];
  return Object.entries(lr.ports)
    .filter(([n, p]) => p.enabled && linkUp(ifByName(d, n)))
    .map(([n]) => ifByName(d, n)!)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

registerDataPlaneHook({
  id: "lacp",
  lagOf(d, iface) {
    const m = memberRt(d, iface);
    if (!m) return undefined;
    if (!m.port?.enabled) return null;
    return lagIface(d, m.lag) ?? null;
  },
  egressMember(d, logical, frame) {
    if (!logical.logical || !lacpRuntime(d)?.lags[logical.name]) return undefined; // not a teamd LAG
    const members = activeMembers(d, logical.name);
    if (!members.length) return null;
    return members[flowHash(flowKey(frame)) % members.length];
  },
});
