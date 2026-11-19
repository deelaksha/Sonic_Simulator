/**
 * PIM-SM + IGMP router (FRR pimd model) on SONiC switches/routers, driven by the
 * stored KLISH config (lib/commands/sonic-cli/features/pim.ts):
 *   PIM_INTERFACE  `ip pim sparse-mode` / `drpriority` / `hello`
 *   PIM_GLOBALS    `ip pim rp-address`, `spt-threshold infinity`,
 *                  `join-prune-interval`, `keep-alive-timer`
 *   IGMP_INTERFACE_QUERY `ip igmp` / `ip igmp version|query-interval|…`
 *
 * Control plane (real packets, lib/protocols/mcast-wire.ts):
 *   Hello      every hello interval (30 s) to 224.0.0.13; holdtime 3.5 × hello;
 *              a new neighbour triggers an immediate Hello (RFC 7761 §4.3.1);
 *              DR = highest DR priority, then highest address (§4.3.2).
 *   IGMP       querier per interface (pim_igmp.c): startup queries (robustness 2)
 *              every qi/4, then every query interval (125 s); a query from a lower
 *              address makes us non-querier for 2×qi + mrt/2; groups age after
 *              the GMI 2×qi + mrt; a v2 Leave makes the querier send
 *              last-member-query-count Group-Specific Queries every LMQI and
 *              drop the group after LMQC×LMQI (pim_igmpv2.c igmp_v2_recv_leave).
 *   Join/Prune (pim_join.c, pim_jp_agg.c) to the RPF neighbour, triggered on every
 *              state change and refreshed every join-prune-interval (60 s),
 *              holdtime 3.5 × that (210 s):
 *                (*,G) join toward the RP (S|W|R bits, source = RP address) while
 *                  the (*,G) olist (PIM joins + local IGMP members on DR
 *                  interfaces) is non-empty and we are not the RP;
 *                (S,G) join toward S for SPT state (S bit);
 *                (S,G,rpt) prune toward the RP once the SPT bit is set and
 *                  RPF(S) ≠ RPF(RP) (RFC 7761 §4.5.7, pim_upstream_switch_to_spt).
 *   Register   (pim_register.c) the DR of a directly connected source creates
 *              (S,G) (flags F) and unicasts every packet encapsulated in a PIM
 *              Register to the RP until a Register-Stop; then Register-Suppression
 *              60 s with a Null-Register probe 5 s before it ends.
 *              The RP decapsulates onto the (*,G) olist, joins (S,G) toward S,
 *              and answers Register-Stop once native packets arrive (SPT bit) or
 *              when nobody downstream wants the group.
 *   SPT switch the last-hop router (local members) switches on the first packet
 *              received down the RPT (FRR default: spt-switchover immediate),
 *              unless `ip pim spt-threshold infinity`.
 *
 * Data plane (l3Ingress hook): routed multicast is consumed and replicated out
 * the olist with an RPF check (the packet must arrive on RPF(S) for (S,G), on
 * RPF(RP) for (*,G); RPT packets are dropped once the SPT bit is set) and a TTL
 * decrement; TTL ≤ 1 is dropped without an ICMP error (RFC 1812 §5.3.1).
 * 224.0.0.0/24 is never routed. (S,G) state created by data ages after the
 * keep-alive timer (210 s) without traffic.
 */
import { Device, interfaceByName } from "../models/device";
import { NetInterface, ownsIp, primaryIpv4 } from "../models/interface";
import { Frame, cloneFrame } from "../models/packet";
import { SimContext } from "../engine/context";
import { featureState, peekFeatureState } from "../models/feature-state";
import { longestPrefixMatch } from "../models/route";
import { cidrContains } from "../models/ip";
import { registerDaemon } from "../control/daemon";
import { registerDataPlaneHook } from "../control/hooks";
import { multicastMac, ownsAddress, sendIpv4 } from "../control/packet";
import { cpList } from "../commands/sonic-cli/config-plane";
import { buildFrame, DOT1Q_BYTES } from "./ethernet";
import { nextFrameId } from "../engine/ids";
import { inetChecksum } from "../sflow/wire";
import {
  ALL_HOSTS, ALL_PIM_ROUTERS, IPPROTO_IGMP, IPPROTO_PIM, JpGroup, SRC_RPT, SRC_S, SRC_WC,
  V3_CHANGE_TO_INCLUDE, V3_MODE_IS_INCLUDE,
  controlFrame, decodeIgmp, decodePim, describePim, encodeIgmp, encodePim, hash32, ipCmp, ipProtoOf, isLinkLocalGroup, isMulticastIp, isSsmGroup, l3Payload,
} from "./mcast-wire";

export const PIMD_KEY = "_pimd";

// ---------------------------------------------------------------------------
// Config (CONFIG_DB as stored by the KLISH modules)

export interface PimIfCfg {
  iface: string;
  sparseMode?: boolean;
  drPriority?: number;
  helloInterval?: number;
}
export interface IgmpIfCfg {
  iface: string;
  enabled?: boolean;
  version?: number;
  queryInterval?: number;
  queryMaxResponseTime?: number;
  lastMemberQueryCount?: number;
  /** deciseconds */
  lastMemberQueryInterval?: number;
}
interface PimGlobalCfg {
  vrf: string;
  joinPruneInterval?: number;
  keepAliveTimer?: number;
  sptInfinity?: boolean;
}

export const pimIfCfgs = (d: Device) => (cpList(d, "pim", "interfaces") as unknown as PimIfCfg[]).filter((c) => c.sparseMode);
export const igmpIfCfgs = (d: Device) => (cpList(d, "igmp", "interfaces") as unknown as IgmpIfCfg[]).filter((c) => c.enabled);
const pimGlobal = (d: Device) => (cpList(d, "pim", "globals") as unknown as PimGlobalCfg[]).find((g) => g.vrf === "default");
export function rpAddress(d: Device): string | undefined {
  return (cpList(d, "pim", "rps") as { vrf: string; rp: string }[]).find((r) => r.vrf === "default")?.rp;
}
const helloMs = (c: PimIfCfg | undefined) => (c?.helloInterval ?? 30) * 1000;
const jpIntervalMs = (d: Device) => (pimGlobal(d)?.joinPruneInterval ?? 60) * 1000;
const jpHoldtime = (d: Device) => Math.floor(3.5 * (pimGlobal(d)?.joinPruneInterval ?? 60));
const katMs = (d: Device) => (pimGlobal(d)?.keepAliveTimer ?? 210) * 1000;
const qiMs = (c: IgmpIfCfg) => (c.queryInterval ?? 125) * 1000;
const qmrtMs = (c: IgmpIfCfg) => (c.queryMaxResponseTime ?? 10) * 1000;
const lmqiMs = (c: IgmpIfCfg) => (c.lastMemberQueryInterval ?? 10) * 100;
const lmqc = (c: IgmpIfCfg) => c.lastMemberQueryCount ?? 2;
const REGISTER_SUPPRESSION_MS = 60_000;
const REGISTER_PROBE_MS = 5_000;

// ---------------------------------------------------------------------------
// Runtime state (device.config.features._pimd — runtime, never saved)

export interface PimNbr {
  iface: string;
  addr: string;
  sinceMs: number;
  expiresMs: number;
  holdtime: number;
  drPriority: number;
  genId: number;
}
export interface IgmpIf {
  querier: string;
  otherUntil?: number;
  nextQueryMs: number;
  startupLeft: number;
  sinceMs: number;
}
export interface IgmpGroup {
  iface: string;
  group: string;
  sinceMs: number;
  expiresMs: number;
  version: number;
  lastReporter: string;
  lmqLeft?: number;
  lmqNextMs?: number;
}
/** Downstream PIM join state on an interface: (*,G) when src is "*". */
export interface IfChannel {
  iface: string;
  src: string;
  group: string;
  sinceMs: number;
  expiresMs: number;
}
export interface SgState {
  src: string;
  group: string;
  sinceMs: number;
  /** FHR: the source's interface (directly connected). */
  iif?: string;
  fhr?: boolean;
  /** Last-hop router switched to the SPT. */
  sptSwitch?: boolean;
  /** RP: state created by a Register; regFrom = the registering DR. */
  fromRegister?: boolean;
  regFrom?: string;
  sptBit?: boolean;
  regState?: "Join" | "Prune";
  regStopUntil?: number;
  nullRegAt?: number;
  lastDataMs: number;
  packets: number;
}
interface AdvEntry {
  nbr: string;
  iface: string;
  group: string;
  src: string;
  flags: number;
  prune: boolean;
}
export interface Pimd {
  helloNext: Record<string, number>;
  nbrs: PimNbr[];
  igmpIf: Record<string, IgmpIf>;
  groups: IgmpGroup[];
  ifch: IfChannel[];
  rptPrunes: IfChannel[];
  sg: SgState[];
  starSince: Record<string, number>;
  adv: AdvEntry[];
  jpNextMs?: number;
  /** Per-interface PIM packet counters [rx, tx]. */
  stats: Record<string, { helloRx: number; helloTx: number; jpRx: number; jpTx: number; regRx: number; regTx: number; regStopRx: number; regStopTx: number }>;
}

export function pimd(device: Device): Pimd {
  return featureState<Pimd>(device, PIMD_KEY, () => ({ helloNext: {}, nbrs: [], igmpIf: {}, groups: [], ifch: [], rptPrunes: [], sg: [], starSince: {}, adv: [], stats: {} }));
}
export function peekPimd(device: Device): Pimd | undefined {
  return peekFeatureState<Pimd>(device, PIMD_KEY);
}
function stat(st: Pimd, iface: string) {
  return (st.stats[iface] ??= { helloRx: 0, helloTx: 0, jpRx: 0, jpTx: 0, regRx: 0, regTx: 0, regStopRx: 0, regStopTx: 0 });
}

const isL3Device = (d: Device) => d.type === "switch" || d.type === "router" || d.type === "firewall";
export function hasMcastConfig(d: Device): boolean {
  return isL3Device(d) && (pimIfCfgs(d).length > 0 || igmpIfCfgs(d).length > 0);
}
const usable = (i: NetInterface | undefined): i is NetInterface => !!i && i.adminState === "up" && i.operState === "up" && i.ipv4.length > 0;
const addrOf = (i: NetInterface) => primaryIpv4(i)?.address ?? "0.0.0.0";
const pimCfg = (d: Device, iface: string) => pimIfCfgs(d).find((c) => c.iface === iface);
const igmpCfg = (d: Device, iface: string) => igmpIfCfgs(d).find((c) => c.iface === iface);
const uniq = (xs: string[]) => [...new Set(xs)];
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// ---------------------------------------------------------------------------
// Derived state (RFC 7761 §4.1 macros)

export interface Rpf {
  iface: string;
  nbr?: string;
  local: boolean;
}

/** RPF interface / neighbour for an address (unicast RIB lookup). */
export function rpfOf(device: Device, addr: string): Rpf | undefined {
  const owner = device.interfaces.find((i) => ownsIp(i, addr));
  if (owner) return { iface: owner.name, local: true };
  const m = longestPrefixMatch(device.routingTable, addr, "default");
  const iface = m && device.interfaces.find((i) => i.id === m.route.interfaceId);
  if (!m || !iface) return undefined;
  return { iface: iface.name, nbr: m.route.nextHop ?? addr, local: false };
}

export function iAmRp(device: Device): boolean {
  const rp = rpAddress(device);
  return !!rp && ownsAddress(device, rp);
}

function liveNbrs(st: Pimd, iface: string, now: number): PimNbr[] {
  return st.nbrs.filter((n) => n.iface === iface && n.expiresMs > now);
}

/** The DR on an interface (highest priority, then highest address). */
export function drOf(device: Device, iface: string, now: number): string {
  const st = peekPimd(device);
  const i = interfaceByName(device, iface);
  let best = { prio: pimCfg(device, iface)?.drPriority ?? 1, addr: i ? addrOf(i) : "0.0.0.0" };
  for (const n of st ? liveNbrs(st, iface, now) : []) {
    if (n.drPriority > best.prio || (n.drPriority === best.prio && ipCmp(n.addr, best.addr) > 0)) best = { prio: n.drPriority, addr: n.addr };
  }
  return best.addr;
}
function amDr(device: Device, iface: string, now: number): boolean {
  const i = interfaceByName(device, iface);
  return !!i && drOf(device, iface, now) === addrOf(i);
}

/** Interfaces with local IGMP members for G (only where we are DR, if PIM runs there). */
export function localMembers(device: Device, st: Pimd, group: string, now: number): string[] {
  return uniq(st.groups.filter((g) => g.group === group && g.expiresMs > now).map((g) => g.iface)).filter((i) => !pimCfg(device, i) || amDr(device, i, now));
}
const joinsOf = (st: Pimd, src: string, group: string, now: number) => uniq(st.ifch.filter((c) => c.src === src && c.group === group && c.expiresMs > now).map((c) => c.iface));
const rptPrunedOf = (st: Pimd, src: string, group: string, now: number) => uniq(st.rptPrunes.filter((c) => c.src === src && c.group === group && c.expiresMs > now).map((c) => c.iface));

export function oilStar(device: Device, st: Pimd, group: string, now: number): string[] {
  return uniq([...joinsOf(st, "*", group, now), ...localMembers(device, st, group, now)]).sort(byName);
}
export function iifOf(device: Device, sg: SgState): string | undefined {
  return sg.fhr ? sg.iif : rpfOf(device, sg.src)?.iface;
}
/** inherited_olist(S,G): (S,G) joins + (*,G) olist − (S,G,rpt) prunes, minus the iif. */
export function oilSg(device: Device, st: Pimd, sg: SgState, now: number): string[] {
  const pruned = rptPrunedOf(st, sg.src, sg.group, now);
  const iif = iifOf(device, sg);
  return uniq([...joinsOf(st, sg.src, sg.group, now), ...oilStar(device, st, sg.group, now).filter((i) => !pruned.includes(i))])
    .filter((i) => i !== iif)
    .sort(byName);
}
export function oifProto(device: Device, st: Pimd, src: string, group: string, iface: string, now: number): string {
  if (joinsOf(st, src, group, now).includes(iface)) return "PIM";
  if (src !== "*") return "STAR";
  return localMembers(device, st, group, now).includes(iface) ? "IGMP" : "PIM";
}
function joinDesiredSg(device: Device, st: Pimd, sg: SgState, now: number): boolean {
  if (sg.fhr) return false;
  if (joinsOf(st, sg.src, sg.group, now).length) return true;
  return (!!sg.sptSwitch || !!sg.fromRegister) && oilSg(device, st, sg, now).length > 0;
}
const findSg = (st: Pimd, src: string, group: string) => st.sg.find((s) => s.src === src && s.group === group);

/** Groups with any (*,G) state on this router. */
export function starGroups(device: Device, st: Pimd, now: number): string[] {
  return uniq([...st.groups.map((g) => g.group), ...st.ifch.filter((c) => c.src === "*").map((c) => c.group)])
    .filter((g) => oilStar(device, st, g, now).length > 0)
    .sort(ipCmp);
}

// ---------------------------------------------------------------------------
// Join/Prune: desired upstream state, reconciled against what was advertised.

function desired(device: Device, st: Pimd, now: number): AdvEntry[] {
  const out: AdvEntry[] = [];
  const rp = rpAddress(device);
  const isNbr = (r: Rpf | undefined): r is Rpf & { nbr: string } => !!r?.nbr && liveNbrs(st, r.iface, now).some((n) => n.addr === r.nbr);
  const groups = uniq([...starGroups(device, st, now), ...st.sg.map((s) => s.group), ...st.rptPrunes.map((p) => p.group)]);
  for (const g of groups) {
    if (isSsmGroup(g)) continue;
    const rpRpf = rp ? rpfOf(device, rp) : undefined;
    if (rp && !iAmRp(device) && oilStar(device, st, g, now).length && isNbr(rpRpf)) {
      out.push({ nbr: rpRpf.nbr, iface: rpRpf.iface, group: g, src: rp, flags: SRC_S | SRC_WC | SRC_RPT, prune: false });
      const sources = uniq([...st.sg.filter((s) => s.group === g).map((s) => s.src), ...st.rptPrunes.filter((p) => p.group === g).map((p) => p.src)]);
      for (const s of sources) {
        const sg = findSg(st, s, g);
        const sRpf = rpfOf(device, s);
        const onSpt = !!sg?.sptBit && sRpf?.nbr !== rpRpf.nbr;
        const propagate = rptPrunedOf(st, s, g, now).length > 0 && (sg ? oilSg(device, st, sg, now).length === 0 && !joinDesiredSg(device, st, sg, now) : oilStar(device, st, g, now).every((i) => rptPrunedOf(st, s, g, now).includes(i)));
        if (onSpt || propagate) out.push({ nbr: rpRpf.nbr, iface: rpRpf.iface, group: g, src: s, flags: SRC_S | SRC_RPT, prune: true });
      }
    }
    for (const sg of st.sg.filter((s) => s.group === g)) {
      const r = rpfOf(device, sg.src);
      if (joinDesiredSg(device, st, sg, now) && isNbr(r)) out.push({ nbr: r.nbr, iface: r.iface, group: g, src: sg.src, flags: SRC_S, prune: false });
    }
  }
  return out;
}

function sendJp(ctx: SimContext, device: Device, iface: string, nbr: string, groups: JpGroup[]): void {
  const i = interfaceByName(device, iface);
  if (!usable(i) || !groups.length) return;
  const st = pimd(device);
  stat(st, iface).jpTx += 1;
  const payload = encodePim({ kind: "joinprune", upstream: nbr, holdtime: jpHoldtime(device), groups });
  const desc = groups.map((g) => `${g.group} J:${g.joins.length} P:${g.prunes.length}`).join(" ");
  ctx.transmit(device.id, i.id, controlFrame({ srcMac: i.mac, dstMac: multicastMac(ALL_PIM_ROUTERS), src: addrOf(i), dst: ALL_PIM_ROUTERS, proto: IPPROTO_PIM, ttl: 1, payload, summary: `PIMv2 Join/Prune → ${nbr} ${desc}` }));
}

function jpGroups(entries: AdvEntry[], removed: AdvEntry[] = []): JpGroup[] {
  const map = new Map<string, JpGroup>();
  const get = (g: string) => map.get(g) ?? map.set(g, { group: g, joins: [], prunes: [] }).get(g)!;
  for (const e of entries) (e.prune ? get(e.group).prunes : get(e.group).joins).push({ addr: e.src, flags: e.flags });
  for (const e of removed) if (!e.prune) get(e.group).prunes.push({ addr: e.src, flags: e.flags });
  return [...map.values()];
}

/**
 * Re-evaluate upstream state after any change: triggered Joins for new state,
 * Prunes for state no longer wanted; (*,G)/(S,G) bookkeeping.
 */
export function reconcile(ctx: SimContext, device: Device, now: number): void {
  const st = pimd(device);
  // (*,G) entry uptime + data-driven (S,G) expiry (keep-alive timer).
  for (const g of starGroups(device, st, now)) st.starSince[g] ??= now;
  for (const g of Object.keys(st.starSince)) if (!oilStar(device, st, g, now).length) delete st.starSince[g];
  st.sg = st.sg.filter((s) => s.lastDataMs + katMs(device) > now || joinsOf(st, s.src, s.group, now).length > 0);

  const next = desired(device, st, now);
  const prev = st.adv;
  const key = (e: AdvEntry) => `${e.nbr}|${e.iface}|${e.group}|${e.src}|${e.flags}|${e.prune}`;
  const nextKeys = new Set(next.map(key));
  const prevKeys = new Set(prev.map(key));
  const added = next.filter((e) => !prevKeys.has(key(e)));
  const removed = prev.filter((e) => !nextKeys.has(key(e)));
  st.adv = next; // before sending: the neighbour may answer synchronously
  if (next.length && st.jpNextMs === undefined) st.jpNextMs = now + jpIntervalMs(device);
  if (!next.length) st.jpNextMs = undefined;
  const nbrs = uniq([...added, ...removed].map((e) => `${e.iface}|${e.nbr}`));
  for (const n of nbrs) {
    const [iface, nbr] = n.split("|");
    const touched = new Set([...added, ...removed].filter((e) => e.iface === iface && e.nbr === nbr).map((e) => e.group));
    const cur = next.filter((e) => e.iface === iface && e.nbr === nbr && touched.has(e.group));
    const gone = removed.filter((e) => e.iface === iface && e.nbr === nbr);
    sendJp(ctx, device, iface, nbr, jpGroups(cur, gone));
  }
}

function processJoinPrune(st: Pimd, ingress: NetInterface, holdtime: number, groups: JpGroup[], now: number): void {
  const exp = now + holdtime * 1000;
  const setCh = (list: IfChannel[], src: string, group: string) => {
    const c = list.find((x) => x.iface === ingress.name && x.src === src && x.group === group);
    if (c) c.expiresMs = exp;
    else list.push({ iface: ingress.name, src, group, sinceMs: now, expiresMs: exp });
  };
  for (const g of groups) {
    const wcJoin = g.joins.some((j) => j.flags & SRC_WC);
    if (wcJoin) {
      setCh(st.ifch, "*", g.group);
      // End of message: (S,G,rpt) prunes not repeated alongside the (*,G) join lapse.
      const keep = new Set(g.prunes.filter((p) => p.flags & SRC_RPT).map((p) => p.addr));
      st.rptPrunes = st.rptPrunes.filter((p) => !(p.iface === ingress.name && p.group === g.group && !keep.has(p.src)));
    }
    for (const j of g.joins) {
      if (j.flags & SRC_WC) continue;
      if (j.flags & SRC_RPT) st.rptPrunes = st.rptPrunes.filter((p) => !(p.iface === ingress.name && p.src === j.addr && p.group === g.group));
      else {
        setCh(st.ifch, j.addr, g.group);
        if (!findSg(st, j.addr, g.group)) st.sg.push({ src: j.addr, group: g.group, sinceMs: now, lastDataMs: now, packets: 0 });
      }
    }
    for (const p of g.prunes) {
      if (p.flags & SRC_WC) {
        st.ifch = st.ifch.filter((c) => !(c.iface === ingress.name && c.src === "*" && c.group === g.group));
        st.rptPrunes = st.rptPrunes.filter((c) => !(c.iface === ingress.name && c.group === g.group));
      } else if (p.flags & SRC_RPT) setCh(st.rptPrunes, p.addr, g.group);
      else st.ifch = st.ifch.filter((c) => !(c.iface === ingress.name && c.src === p.addr && c.group === g.group));
    }
  }
}

// ---------------------------------------------------------------------------
// Hello / IGMP sending

function sendHello(ctx: SimContext, device: Device, iface: NetInterface): void {
  const cfg = pimCfg(device, iface.name);
  const payload = encodePim({
    kind: "hello",
    holdtime: Math.floor((3.5 * helloMs(cfg)) / 1000),
    drPriority: cfg?.drPriority ?? 1,
    genId: hash32(`${device.id}|${iface.name}`),
    propagationDelay: 500,
    overrideInterval: 2500,
  });
  stat(pimd(device), iface.name).helloTx += 1;
  ctx.transmit(device.id, iface.id, controlFrame({ srcMac: iface.mac, dstMac: multicastMac(ALL_PIM_ROUTERS), src: addrOf(iface), dst: ALL_PIM_ROUTERS, proto: IPPROTO_PIM, ttl: 1, payload, summary: `PIMv2 Hello ${iface.name}` }));
}

function sendQuery(ctx: SimContext, device: Device, iface: NetInterface, cfg: IgmpIfCfg, group = "0.0.0.0"): void {
  const v = cfg.version === 2 ? 2 : 3;
  const general = group === "0.0.0.0";
  const maxRespDs = general ? qmrtMs(cfg) / 100 : lmqiMs(cfg) / 100;
  const payload = encodeIgmp({ kind: "query", version: v, maxRespDs, group, qqic: cfg.queryInterval ?? 125 });
  const dst = general ? ALL_HOSTS : group;
  ctx.transmit(device.id, iface.id, controlFrame({ srcMac: iface.mac, dstMac: multicastMac(dst), src: addrOf(iface), dst, proto: IPPROTO_IGMP, ttl: 1, ra: true, payload, summary: `IGMPv${v} ${general ? "general" : `group-specific ${group}`} query ${iface.name}` }));
}

// ---------------------------------------------------------------------------
// Receive: IGMP (router side) and PIM

function igmpJoin(st: Pimd, iface: string, group: string, cfg: IgmpIfCfg, version: number, from: string, now: number): boolean {
  if (isLinkLocalGroup(group)) return false;
  const gmi = 2 * qiMs(cfg) + qmrtMs(cfg);
  const g = st.groups.find((x) => x.iface === iface && x.group === group);
  if (g) {
    g.expiresMs = now + gmi;
    g.lastReporter = from;
    g.version = version;
    g.lmqLeft = g.lmqNextMs = undefined;
    return false;
  }
  st.groups.push({ iface, group, sinceMs: now, expiresMs: now + gmi, version, lastReporter: from });
  return true;
}

function igmpLeave(ctx: SimContext, device: Device, st: Pimd, iface: NetInterface, group: string, cfg: IgmpIfCfg, now: number): void {
  const g = st.groups.find((x) => x.iface === iface.name && x.group === group);
  const q = st.igmpIf[iface.name];
  if (!g || !q || q.querier !== addrOf(iface)) return; // only the querier acts on a Leave
  g.expiresMs = Math.min(g.expiresMs, now + lmqc(cfg) * lmqiMs(cfg));
  g.lmqLeft = lmqc(cfg) - 1;
  g.lmqNextMs = g.lmqLeft > 0 ? now + lmqiMs(cfg) : undefined;
  sendQuery(ctx, device, iface, cfg, group);
}

function onIgmp(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame, now: number): void {
  const cfg = igmpCfg(device, ingress.name);
  const pl = l3Payload(frame);
  const m = pl && decodeIgmp(pl);
  if (!cfg || !m || !usable(ingress)) return;
  const st = pimd(device);
  const from = frame.ipv4!.srcIp;
  let changed = false;
  switch (m.kind) {
    case "query": {
      const q = st.igmpIf[ingress.name];
      if (q && from !== addrOf(ingress) && ipCmp(from, addrOf(ingress)) < 0) {
        q.querier = from;
        q.otherUntil = now + 2 * qiMs(cfg) + qmrtMs(cfg) / 2;
      }
      break;
    }
    case "report":
      changed = igmpJoin(st, ingress.name, m.group, cfg, m.version, from, now);
      break;
    case "leave":
      igmpLeave(ctx, device, st, ingress, m.group, cfg, now);
      break;
    case "v3report":
      for (const r of m.records) {
        if ((r.type === V3_CHANGE_TO_INCLUDE || r.type === V3_MODE_IS_INCLUDE) && !r.sources.length) igmpLeave(ctx, device, st, ingress, r.group, cfg, now);
        else changed = igmpJoin(st, ingress.name, r.group, cfg, 3, from, now) || changed;
      }
      break;
  }
  if (changed) reconcile(ctx, device, now);
}

function onPim(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame, now: number): void {
  const pl = l3Payload(frame);
  const m = pl && decodePim(pl);
  if (!m) return;
  const st = pimd(device);
  const from = frame.ipv4!.srcIp;
  if (m.kind === "register") {
    stat(st, ingress.name).regRx += 1;
    onRegister(ctx, device, from, m.nullRegister, m.inner, now);
    return;
  }
  if (m.kind === "registerstop") {
    stat(st, ingress.name).regStopRx += 1;
    const sg = findSg(st, m.source, m.group);
    if (sg?.fhr) {
      sg.regState = "Prune";
      sg.regStopUntil = now + REGISTER_SUPPRESSION_MS;
      sg.nullRegAt = now + REGISTER_SUPPRESSION_MS - REGISTER_PROBE_MS;
    }
    return;
  }
  if (!pimCfg(device, ingress.name) || !usable(ingress)) return; // PIM not enabled here
  if (m.kind === "hello") {
    stat(st, ingress.name).helloRx += 1;
    const n = st.nbrs.find((x) => x.iface === ingress.name && x.addr === from);
    const exp = now + m.holdtime * 1000;
    if (n && n.expiresMs > now && n.genId === m.genId) {
      n.expiresMs = exp;
      n.holdtime = m.holdtime;
      n.drPriority = m.drPriority;
      return;
    }
    st.nbrs = st.nbrs.filter((x) => x !== n);
    st.nbrs.push({ iface: ingress.name, addr: from, sinceMs: now, expiresMs: exp, holdtime: m.holdtime, drPriority: m.drPriority, genId: m.genId });
    st.helloNext[ingress.name] = now; // triggered Hello to the new neighbour
    reconcile(ctx, device, now);
    return;
  }
  if (m.kind === "joinprune") {
    stat(st, ingress.name).jpRx += 1;
    if (!ownsIp(ingress, m.upstream)) return; // addressed to another upstream router
    processJoinPrune(st, ingress, m.holdtime, m.groups, now);
    reconcile(ctx, device, now);
  }
}

// ---------------------------------------------------------------------------
// Register (FHR → RP) / Register-Stop (RP → FHR)

/** The packet as it is on the wire now (TTL re-applied, checksum fixed). */
function ipBytesOf(frame: Frame): number[] {
  const l3 = [...(frame.rawL3 ?? [])];
  if (l3.length >= 20 && frame.ipv4) {
    const ihl = (l3[0] & 0x0f) * 4;
    l3[8] = frame.ipv4.ttl & 0xff;
    l3[10] = l3[11] = 0;
    const ck = inetChecksum(l3.slice(0, ihl));
    l3[10] = ck >> 8;
    l3[11] = ck & 0xff;
  }
  return l3;
}

/** A Frame for a decapsulated IP packet (Register payload). */
function frameFromIp(ip: number[]): Frame | undefined {
  if (ip.length < 20 || ip[0] >> 4 !== 4) return undefined;
  const ihl = (ip[0] & 0x0f) * 4;
  const str = (o: number) => `${ip[o]}.${ip[o + 1]}.${ip[o + 2]}.${ip[o + 3]}`;
  const proto = ip[9];
  const udp = proto === 17 && ip.length >= ihl + 8 ? { srcPort: (ip[ihl] << 8) | ip[ihl + 1], dstPort: (ip[ihl + 2] << 8) | ip[ihl + 3], length: (ip[ihl + 4] << 8) | ip[ihl + 5] } : undefined;
  const frame = buildFrame(
    { srcMac: "00:00:00:00:00:00", dstMac: multicastMac(str(16)), etherType: "IPv4", payloadBytes: ip.length, summary: `UDP ${str(12)} → ${str(16)} (decapsulated)` },
    { ipv4: { srcIp: str(12), dstIp: str(16), ttl: ip[8], protocol: proto === 17 ? "UDP" : "OTHER", identification: (ip[4] << 8) | ip[5], ...(proto === 17 ? {} : { protocolNumber: proto }) }, udp },
  );
  frame.rawL3 = ip;
  return frame;
}

function sendRegister(ctx: SimContext, device: Device, sg: SgState, frame: Frame | undefined): void {
  const rp = rpAddress(device);
  const r = rp ? rpfOf(device, rp) : undefined;
  const out = r ? interfaceByName(device, r.iface) : undefined;
  if (!rp || !usable(out)) return;
  const nullRegister = !frame;
  const inner = frame ? ipBytesOf(frame) : nullHeader(sg);
  stat(pimd(device), out.name).regTx += 1;
  sendIpv4(ctx, device, { src: addrOf(out), dst: rp, ttl: 64, tos: 0xc0, proto: IPPROTO_PIM, payload: encodePim({ kind: "register", border: false, nullRegister, inner }), summary: `PIMv2 ${nullRegister ? "Null-" : ""}Register (${sg.src}, ${sg.group}) → RP ${rp}` });
}

/** Null-Register payload: a bare IP header S → G (pim_register.c pim_null_register_send). */
function nullHeader(sg: SgState): number[] {
  const b = (ip: string) => ip.split(".").map(Number);
  const hdr = [0x45, 0, 0, 20, 0, 0, 0, 0, 0, IPPROTO_PIM, 0, 0, ...b(sg.src), ...b(sg.group)];
  const ck = inetChecksum(hdr);
  hdr[10] = ck >> 8;
  hdr[11] = ck & 0xff;
  return hdr;
}

function sendRegisterStop(ctx: SimContext, device: Device, to: string, sg: SgState): void {
  const r = rpfOf(device, to);
  const via = r && interfaceByName(device, r.iface);
  const rp = rpAddress(device) ?? (via ? addrOf(via) : "0.0.0.0");
  if (via) stat(pimd(device), via.name).regStopTx += 1;
  sendIpv4(ctx, device, { src: rp, dst: to, ttl: 64, tos: 0xc0, proto: IPPROTO_PIM, payload: encodePim({ kind: "registerstop", group: sg.group, source: sg.src }), summary: `PIMv2 Register-Stop (${sg.src}, ${sg.group}) → ${to}` });
}

function onRegister(ctx: SimContext, device: Device, from: string, nullRegister: boolean, inner: number[], now: number): void {
  const inFrame = frameFromIp(inner);
  if (!inFrame || !iAmRp(device)) return;
  const st = pimd(device);
  const src = inFrame.ipv4!.srcIp;
  const group = inFrame.ipv4!.dstIp;
  let sg = findSg(st, src, group);
  // A Null-Register only probes: it never creates state or restarts the KAT (RFC 7761 §4.4.2).
  if (nullRegister && !sg) {
    sendRegisterStop(ctx, device, from, { src, group, sinceMs: now, lastDataMs: now, packets: 0 });
    return;
  }
  if (!sg) st.sg.push((sg = { src, group, sinceMs: now, lastDataMs: now, packets: 0 }));
  sg.fromRegister = true;
  sg.regFrom = from;
  if (!nullRegister) sg.lastDataMs = now;
  const olist = oilSg(device, st, sg, now);
  if (nullRegister || sg.sptBit || !olist.length) {
    sendRegisterStop(ctx, device, from, sg);
  } else {
    sg.packets += 1;
    replicate(ctx, device, undefined, inFrame, olist);
  }
  reconcile(ctx, device, now);
}

// ---------------------------------------------------------------------------
// Data plane

function drop(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame, why: string): void {
  ctx.emit({
    type: "FRAME_DROPPED",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: multicast ${frame.ipv4!.srcIp} → ${frame.ipv4!.dstIp} ${why} — dropped`,
    osiLayers: [3],
    frame,
  });
}

/** Replicate a packet out of each olist interface with TTL − 1 (new L2 header per oif). */
function replicate(ctx: SimContext, device: Device, ingress: NetInterface | undefined, frame: Frame, olist: string[]): void {
  const ip = frame.ipv4!;
  const oifs = olist.filter((o) => o !== ingress?.name).map((o) => interfaceByName(device, o)).filter(usable);
  if (!oifs.length) return;
  ctx.emit({
    type: "FRAME_FORWARDED",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress?.id,
    interfaceName: ingress?.name,
    message: `${device.name}: mroute (${ip.srcIp}, ${ip.dstIp}) ttl ${ip.ttl} → ${ip.ttl - 1}, replicate → ${oifs.map((o) => o.name).join(", ")}`,
    osiLayers: [3],
    frame,
  });
  for (const oif of oifs) {
    const out = cloneFrame(frame);
    out.id = nextFrameId();
    out.ethernet.srcMac = oif.mac;
    out.ethernet.dstMac = multicastMac(ip.dstIp);
    if (out.vlan) {
      delete out.vlan;
      out.meta.sizeBytes = Math.max(64, out.meta.sizeBytes - DOT1Q_BYTES);
    }
    out.ipv4!.ttl = ip.ttl - 1;
    out.meta.forwarded = true;
    ctx.transmit(device.id, oif.id, out);
  }
}

function forward(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const ip = frame.ipv4!;
  const now = ctx.wallNow();
  if (ip.ttl <= 1) {
    drop(ctx, device, ingress, frame, "TTL expired (multicast: no ICMP error)");
    return;
  }
  const st = pimd(device);
  const S = ip.srcIp;
  const G = ip.dstIp;
  let sg = findSg(st, S, G);

  // First-hop router: source on a directly connected PIM interface where we are DR.
  const local = ingress.ipv4.some((a) => cidrContains(a.address, a.prefix, S));
  if (local && (pimCfg(device, ingress.name) || igmpCfg(device, ingress.name)) && amDr(device, ingress.name, now) && !isSsmGroup(G)) {
    const rpHere = iAmRp(device);
    if (!sg) st.sg.push((sg = { src: S, group: G, sinceMs: now, lastDataMs: now, packets: 0 }));
    sg.fhr = true;
    sg.iif = ingress.name;
    sg.lastDataMs = now;
    sg.packets += 1;
    if (!rpHere && rpAddress(device)) sg.regState ??= "Join";
    replicate(ctx, device, ingress, frame, oilSg(device, st, sg, now));
    if (sg.regState === "Join" && !rpHere) sendRegister(ctx, device, sg, frame);
    reconcile(ctx, device, now);
    return;
  }

  const rp = rpAddress(device);
  const rpRpf = rp ? rpfOf(device, rp) : undefined;
  if (sg && iifOf(device, sg) === ingress.name) {
    sg.lastDataMs = now;
    sg.packets += 1;
    const newSpt = !sg.sptBit;
    sg.sptBit = true; // Update_SPTbit: native packet on RPF(S)
    replicate(ctx, device, ingress, frame, oilSg(device, st, sg, now));
    if (newSpt && iAmRp(device) && sg.regFrom) sendRegisterStop(ctx, device, sg.regFrom, sg);
    if (newSpt) reconcile(ctx, device, now);
    return;
  }
  const starOil = oilStar(device, st, G, now);
  if (rpRpf && !rpRpf.local && ingress.name === rpRpf.iface && starOil.length) {
    if (sg?.sptBit) {
      drop(ctx, device, ingress, frame, `RPF check failed: SPT bit set, (S,G) iif is ${iifOf(device, sg)}, packet arrived on RPT interface ${ingress.name}`);
      return;
    }
    const pruned = rptPrunedOf(st, S, G, now);
    replicate(ctx, device, ingress, frame, starOil.filter((i) => !pruned.includes(i)));
    if (sg) {
      sg.lastDataMs = now;
      sg.packets += 1;
    }
    // Last-hop router: switch to the SPT on the first packet down the RPT.
    if (!sg && localMembers(device, st, G, now).length && !pimGlobal(device)?.sptInfinity && rpfOf(device, S)) {
      st.sg.push({ src: S, group: G, sinceMs: now, lastDataMs: now, packets: 1, sptSwitch: true });
      reconcile(ctx, device, now);
    }
    return;
  }
  if (sg || starOil.length) {
    const want = sg ? iifOf(device, sg) : rpRpf?.iface;
    drop(ctx, device, ingress, frame, `RPF check failed: expected on ${want ?? "?"}, arrived on ${ingress.name}`);
    return;
  }
  drop(ctx, device, ingress, frame, "no (S,G) or (*,G) multicast route");
}

registerDataPlaneHook({
  id: "pim-mroute",
  l3Ingress(ctx, device, ingress, frame) {
    const ip = frame.ipv4;
    if (!ip || !isMulticastIp(ip.dstIp) || !hasMcastConfig(device)) return undefined;
    const proto = ipProtoOf(frame);
    if (proto === IPPROTO_IGMP || proto === IPPROTO_PIM || isLinkLocalGroup(ip.dstIp)) return null; // never routed
    forward(ctx, device, ingress, frame);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Daemon

function minDue(acc: number | undefined, t: number | undefined): number | undefined {
  return t === undefined ? acc : acc === undefined || t < acc ? t : acc;
}

registerDaemon({
  id: "pimd",
  nextDue(device, now) {
    if (!isL3Device(device)) return undefined;
    const st = peekPimd(device);
    const pimIfs = pimIfCfgs(device);
    const igmpIfs = igmpIfCfgs(device);
    if (!st) return pimIfs.length || igmpIfs.length ? 0 : undefined;
    let due: number | undefined;
    for (const c of pimIfs) if (usable(interfaceByName(device, c.iface))) due = minDue(due, st.helloNext[c.iface] ?? 0);
    for (const c of igmpIfs) if (usable(interfaceByName(device, c.iface))) due = minDue(due, st.igmpIf[c.iface]?.nextQueryMs ?? 0);
    for (const n of st.nbrs) due = minDue(due, n.expiresMs);
    for (const g of st.groups) due = minDue(minDue(due, g.expiresMs), g.lmqNextMs);
    for (const c of st.ifch) due = minDue(due, c.expiresMs);
    for (const c of st.rptPrunes) due = minDue(due, c.expiresMs);
    for (const s of st.sg) {
      const kat = s.lastDataMs + katMs(device);
      due = minDue(minDue(minDue(due, kat > now ? kat : undefined), s.regStopUntil), s.nullRegAt);
    }
    due = minDue(due, st.jpNextMs);
    // Interfaces whose PIM/IGMP was removed: clean up once.
    const pimNames = new Set(pimIfs.map((c) => c.iface));
    const igmpNames = new Set(igmpIfs.map((c) => c.iface));
    if (Object.keys(st.helloNext).some((i) => !pimNames.has(i)) || Object.keys(st.igmpIf).some((i) => !igmpNames.has(i))) due = 0;
    return due;
  },
  tick(ctx, device, now) {
    const st = pimd(device);
    const pimNames = new Set(pimIfCfgs(device).map((c) => c.iface));
    const igmpNames = new Set(igmpIfCfgs(device).map((c) => c.iface));
    // Deconfigured interfaces drop their state.
    for (const i of Object.keys(st.helloNext)) if (!pimNames.has(i)) delete st.helloNext[i];
    for (const i of Object.keys(st.igmpIf)) if (!igmpNames.has(i)) delete st.igmpIf[i];
    st.nbrs = st.nbrs.filter((n) => pimNames.has(n.iface) && n.expiresMs > now);
    st.ifch = st.ifch.filter((c) => pimNames.has(c.iface) && c.expiresMs > now);
    st.rptPrunes = st.rptPrunes.filter((c) => pimNames.has(c.iface) && c.expiresMs > now);
    st.groups = st.groups.filter((g) => igmpNames.has(g.iface) && g.expiresMs > now);

    for (const c of pimIfCfgs(device)) {
      const i = interfaceByName(device, c.iface);
      if (!usable(i) || (st.helloNext[c.iface] ?? 0) > now) continue;
      st.helloNext[c.iface] = now + helloMs(c);
      sendHello(ctx, device, i);
    }
    for (const c of igmpIfCfgs(device)) {
      const i = interfaceByName(device, c.iface);
      if (!usable(i)) continue;
      const q = (st.igmpIf[c.iface] ??= { querier: addrOf(i), nextQueryMs: now, startupLeft: 2, sinceMs: now });
      if (q.otherUntil !== undefined && q.otherUntil <= now) {
        q.otherUntil = undefined;
        q.querier = addrOf(i);
      }
      if (q.nextQueryMs > now) continue;
      if (q.startupLeft > 0) q.startupLeft -= 1;
      q.nextQueryMs = now + (q.startupLeft > 0 ? qiMs(c) / 4 : qiMs(c));
      if (q.querier === addrOf(i)) sendQuery(ctx, device, i, c);
    }
    for (const g of st.groups) {
      if (g.lmqNextMs === undefined || g.lmqNextMs > now) continue;
      const c = igmpCfg(device, g.iface);
      const i = interfaceByName(device, g.iface);
      g.lmqLeft = (g.lmqLeft ?? 1) - 1;
      g.lmqNextMs = g.lmqLeft > 0 && c ? now + lmqiMs(c) : undefined;
      if (c && usable(i)) sendQuery(ctx, device, i, c, g.group);
    }
    for (const s of st.sg) {
      // CouldRegister(S,G) needs the keep-alive timer running (RFC 7761 §4.4.1).
      const couldRegister = s.lastDataMs + katMs(device) > now;
      if (s.nullRegAt !== undefined && s.nullRegAt <= now) {
        s.nullRegAt = undefined;
        if (couldRegister) sendRegister(ctx, device, s, undefined);
      }
      if (s.regStopUntil !== undefined && s.regStopUntil <= now) {
        s.regStopUntil = undefined;
        s.regState = "Join";
      }
    }
    if (st.jpNextMs !== undefined && st.jpNextMs <= now) {
      st.jpNextMs = now + jpIntervalMs(device);
      for (const n of uniq(st.adv.map((e) => `${e.iface}|${e.nbr}`))) {
        const [iface, nbr] = n.split("|");
        sendJp(ctx, device, iface, nbr, jpGroups(st.adv.filter((e) => e.iface === iface && e.nbr === nbr)));
      }
    }
    reconcile(ctx, device, now);
    return true;
  },
  receiveL3(ctx, device, ingress, frame) {
    const proto = ipProtoOf(frame);
    if ((proto !== IPPROTO_IGMP && proto !== IPPROTO_PIM) || !hasMcastConfig(device)) return false;
    const now = ctx.wallNow();
    if (proto === IPPROTO_IGMP) onIgmp(ctx, device, ingress, frame, now);
    else onPim(ctx, device, ingress, frame, now);
    return true;
  },
  describe(frame) {
    if (ipProtoOf(frame) !== IPPROTO_PIM) return undefined;
    const pl = l3Payload(frame);
    return pl ? describePim(pl) : undefined;
  },
});
