/**
 * OSPFv3 daemon (FRR ospf6d, RFC 5340) — a ControlDaemon plus an IPv6
 * control-plane receiver (ipv6.ts registerV6Receiver).
 *
 * Runs on routers and SONiC switches on interfaces with `ipv6 ospf6 area`.
 * Packets are real IPv6/OSPFv3 bytes (Next Header 89, hop limit 1, traffic
 * class 0xc0 like ospf6_network.c) from the interface link-local address to
 * ff02::5 AllSPFRouters / ff02::6 AllDRouters, or to a neighbour's link-local.
 * Runtime state lives in device.config.features["ospf6d"].
 *
 * RFC 5340 mapping (same machinery as the OSPFv2 daemon, ospf-daemon.ts):
 *   Interface FSM / DR election   RFC 2328 9.4 with Router IDs as DR/BDR (5340 4.2.1)
 *   Hello                         A.3.2: Interface ID, 24-bit options V6|E|R;
 *                                 hello/dead interval and instance must match;
 *                                 neighbours are identified by Router ID on
 *                                 every link type
 *   Neighbour FSM / exchange      Down→Init→2-Way→ExStart→Exchange→Loading→Full,
 *                                 master/slave DBD, LSR/LSU/LSAck
 *   LSAs                          Router (0x2001), Network (0x2002, by the DR,
 *                                 LS ID = DR Interface ID), Link (0x0008,
 *                                 link-local flooding scope, one per interface),
 *                                 Intra-Area-Prefix (0x2009) for the router's
 *                                 stub/point-to-point/loopback prefixes and, by
 *                                 the DR, for each transit network
 *   SPF                           RFC 5340 4.8.1 (Dijkstra over Router/Network
 *                                 LSAs, next hop = the neighbour's link-local)
 *                                 + 4.8.3 (prefixes from Intra-Area-Prefix-LSAs)
 *                                 → device.routingTable6, type "ospf",
 *                                 distance 110, metric = cost.
 *
 * Simplifications (documented): single instance in the default VRF, intra-area
 * routes only (no ABR inter-area / external LSAs), direct acks, no MinLSInterval
 * / SPF hold timers, no authentication trailer, MTU not checked in DBDs.
 */
import { registerDaemon } from "../control/daemon";
import { logEvent } from "../control/syslog";
import { Device, findInterface } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { Route, carryInstallTime } from "../models/route";
import { ipToInt } from "../models/ip";
import { isLinkLocal6, networkAddress6, parseIpv6 } from "../models/ipv6";
import { SimContext } from "../engine/context";
import { IPV6_NH, registerV6Receiver, transmitIpv6, multicastMac6, ip6Payload, ip6NextHeader, linkLocalOf, ensureLinkLocal } from "./ipv6";
import { vrfOf } from "../models/vrf";
import { Ospf6Config, Ospf6IfSpec, ospf6Capable, ospf6Config, ospf6Interfaces, ospf6RouterId, OSPF6_RXMT_DEFAULT } from "./ospf6-config";
import {
  ALL_SPF6,
  ALL_DR6,
  LSA6_ROUTER,
  LSA6_NETWORK,
  LSA6_LINK,
  LSA6_INTRA_PREFIX,
  OPTIONS6,
  PFX_LA,
  T_HELLO,
  T_DBD,
  T_LSR,
  T_LSU,
  T_ACK,
  PACKET_NAMES,
  DD_I,
  DD_M,
  DD_MS,
  MAX_AGE,
  INITIAL_SEQ,
  Lsa6Header,
  Prefix6,
  RouterIf6,
  encodePacket6,
  decodePacket6,
  encodeHello6,
  decodeHello6,
  encodeDbd6,
  decodeDbd6,
  encodeLsr,
  decodeLsr,
  encodeLsu,
  decodeLsu,
  decodeAck6,
  buildLsa6,
  parseLsa6Header,
  lsa6Key,
  lsaChecksumOk,
  withAge,
  compareLsa,
  encodeRouter6,
  decodeRouter6,
  encodeNetwork6,
  decodeNetwork6,
  encodeLink6,
  decodeLink6,
  encodeIntraPrefix6,
  decodeIntraPrefix6,
  intToDotted,
  describeOspf6,
} from "./ospf6-wire";
import { featureEnabled } from "./cpu-features";

/** ospf6d runs in the bgp container: no config while it is disabled. */
const liveOspf6Config = (d: Device) => (featureEnabled(d, "bgp") ? ospf6Config(d) : undefined);

export const RT6_KEY = "ospf6d";
const LS_REFRESH_TIME = 1800;
const DBD_CHUNK = 60;
const ZERO = "0.0.0.0";

export type Nsm6 = "Down" | "Init" | "2-Way" | "ExStart" | "Exchange" | "Loading" | "Full";
export type Ism6 = "Down" | "Loopback" | "Waiting" | "PointToPoint" | "DROther" | "BDR" | "DR";
const NSM: Record<Nsm6, number> = { Down: 0, Init: 1, "2-Way": 2, ExStart: 3, Exchange: 4, Loading: 5, Full: 6 };
const ISM: Record<Ism6, number> = { Down: 0, Loopback: 1, Waiting: 2, PointToPoint: 3, DROther: 4, BDR: 5, DR: 6 };

export interface Ospf6Nbr {
  rid: string;
  /** Neighbour's link-local address (Hello source). */
  ll: string;
  mac: string;
  ifIndex: number;
  priority: number;
  dr: string;
  bdr: string;
  state: Nsm6;
  deadDue: number;
  progressMs: number;
  master?: boolean;
  ddSeq?: number;
  summary?: string[];
  lastDbd?: number[];
  moreSent?: boolean;
  ddRxmtDue?: number;
  reqs: { type: number; id: string; adv: string; seq: number; checksum: number; age: number }[];
  reqDue?: number;
  rxmt: Record<string, number>;
}

export interface Ospf6If {
  name: string;
  ifId: string;
  ifIndex: number;
  ll: string;
  prefixes: { address: string; prefix: number }[];
  area: string;
  type: "broadcast" | "point-to-point" | "loopback";
  cost: number;
  hello: number;
  dead: number;
  rxmt: number;
  priority: number;
  passive: boolean;
  psig: string;
  state: Ism6;
  dr: string;
  bdr: string;
  helloDue?: number;
  waitDue?: number;
  upMs: number;
  nbrs: Ospf6Nbr[];
  pendNbrChange?: boolean;
  pendBackupSeen?: boolean;
}

export interface Lsa6Entry {
  lsa: number[];
  rxMs: number;
  age0: number;
  self?: boolean;
}

export interface Ospf6Path {
  nh: string | null;
  ifId: string;
  ifName: string;
}

export interface Ospf6RouteView {
  dest: string;
  prefix: number;
  cost: number;
  area: string;
  paths: Ospf6Path[];
}

export interface Ospf6Rt {
  sig: string;
  routerId: string;
  startedMs: number;
  oifs: Ospf6If[];
  /** Area-scope LSAs per area. */
  lsdb: Record<string, Record<string, Lsa6Entry>>;
  /** Link-scope (Link-LSA) databases per interface name. */
  linkDb: Record<string, Record<string, Lsa6Entry>>;
  spfDirty?: boolean;
  spf: { runs: number; lastMs?: number };
  routes?: Ospf6RouteView[];
}

export function ospf6Runtime(device: Device): Ospf6Rt | undefined {
  return device.config.features?.[RT6_KEY] as Ospf6Rt | undefined;
}

export function lsa6Age(e: Lsa6Entry, now: number): number {
  return Math.min(MAX_AGE, e.age0 + Math.max(0, Math.floor((now - e.rxMs) / 1000)));
}

export function lsa6HeaderNow(e: Lsa6Entry, now: number): Lsa6Header {
  return { ...parseLsa6Header(e.lsa), age: lsa6Age(e, now) };
}

// ---------------------------------------------------------------------------
// Deferred transmit (see ospf-daemon.ts): recursion-safe delivery.
interface Out {
  ctx: SimContext;
  device: Device;
  ifId: string;
  dstMac: string;
  src: string;
  dst: string;
  type: number;
  rid: string;
  area: string;
  body: number[];
}
const outbox: Out[] = [];
let flushing = false;

function flush(): void {
  if (flushing) return;
  flushing = true;
  try {
    while (outbox.length) {
      const o = outbox.shift()!;
      const iface = findInterface(o.device, o.ifId);
      if (!iface) continue;
      const payload = encodePacket6(o.type, o.rid, o.area, o.body, o.src, o.dst);
      transmitIpv6(o.ctx, o.device, iface, o.dstMac, { src: o.src, dst: o.dst, nextHeader: IPV6_NH.OSPF, hopLimit: 1, trafficClass: 0xc0, payload, summary: `OSPFv3 ${PACKET_NAMES[o.type]}` });
    }
  } catch (e) {
    outbox.length = 0;
    throw e;
  } finally {
    flushing = false;
  }
}

interface D {
  ctx: SimContext;
  device: Device;
  cfg: Ospf6Config;
  rt: Ospf6Rt;
  now: number;
}

function send(d: D, oif: Ospf6If, to: "spf" | "dr" | Ospf6Nbr, type: number, body: number[]): void {
  let dst = ALL_SPF6;
  let mac = multicastMac6(ALL_SPF6);
  if (to === "dr") {
    dst = ALL_DR6;
    mac = multicastMac6(ALL_DR6);
  } else if (to !== "spf" && oif.type !== "point-to-point") {
    dst = to.ll;
    mac = to.mac;
  }
  outbox.push({ ctx: d.ctx, device: d.device, ifId: oif.ifId, dstMac: mac, src: oif.ll, dst, type, rid: d.rt.routerId, area: oif.area, body });
}

const ipNum = (ip: string) => ipToInt(ip);

function emit(d: D, oif: Ospf6If | undefined, type: "OSPF_HELLO" | "OSPF_NEIGHBOR" | "OSPF_ROUTE", message: string): void {
  d.ctx.emit({ type, deviceId: d.device.id, deviceName: d.device.name, interfaceId: oif?.ifId, interfaceName: oif?.name, message: `${d.device.name}: ${message}`, osiLayers: [3] });
}

// ---------------------------------------------------------------------------
function computeSig(device: Device): string {
  const cfg = liveOspf6Config(device);
  if (!cfg) return "";
  // VRF membership too: ospf6d (default VRF) leaves an interface that moves to a VRF.
  return JSON.stringify([cfg, device.interfaces.map((i) => [i.id, i.name, i.ipv6, i.ipv4.length ? i.ipv4[0].address : "", i.adminState, i.operState, i.speed, vrfOf(device, i)])]);
}

function newRt(routerId: string, now: number): Ospf6Rt {
  return { sig: "", routerId, startedMs: now, oifs: [], lsdb: {}, linkDb: {}, spf: { runs: 0 } };
}

const psigOf = (s: Ospf6IfSpec, ll: string) => `${ll}|${s.area}|${s.type}|${s.hello}|${s.dead}|${s.priority}|${s.passive}|${s.ifIndex}`;

function reconcile(d: D): void {
  const { device, cfg, rt, now } = d;
  const rid = ospf6RouterId(device, cfg);
  if (rt.routerId !== rid) {
    teardown(d);
    Object.assign(rt, newRt(rid, now));
  }
  const want = ospf6Interfaces(device, cfg).filter((s) => s.up);
  for (const s of want) if (s.type !== "loopback") ensureLinkLocal(s.iface);
  for (const oif of [...rt.oifs]) {
    const w = want.find((s) => s.iface.name === oif.name && s.iface.id === oif.ifId);
    if (!w || psigOf(w, linkLocalOf(w.iface) ?? "") !== oif.psig) ifDown(d, oif);
  }
  for (const w of want) {
    const oif = rt.oifs.find((o) => o.name === w.iface.name);
    if (!oif) {
      ifUp(d, w);
      continue;
    }
    oif.cost = w.cost;
    oif.prefixes = w.prefixes;
  }
  rt.oifs.sort((a, b) => a.ifIndex - b.ifIndex);
  rt.spfDirty = true;
  rt.sig = computeSig(device);
}

function ifUp(d: D, s: Ospf6IfSpec): void {
  const ll = linkLocalOf(s.iface) ?? "";
  if (s.type !== "loopback" && !ll) return;
  const oif: Ospf6If = {
    name: s.iface.name,
    ifId: s.iface.id,
    ifIndex: s.ifIndex,
    ll,
    prefixes: s.prefixes,
    area: s.area,
    type: s.type,
    cost: s.cost,
    hello: s.hello,
    dead: s.dead,
    rxmt: OSPF6_RXMT_DEFAULT,
    priority: s.priority,
    passive: s.passive,
    psig: psigOf(s, ll),
    state: "Down",
    dr: ZERO,
    bdr: ZERO,
    upMs: d.now,
    nbrs: [],
  };
  if (s.type === "loopback") oif.state = "Loopback";
  else if (s.type === "point-to-point") oif.state = "PointToPoint";
  else if (s.priority === 0) oif.state = "DROther";
  else {
    oif.state = "Waiting";
    oif.waitDue = d.now + s.dead * 1000;
  }
  if (s.type !== "loopback" && !s.passive) oif.helloDue = d.now;
  d.rt.oifs.push(oif);
}

function ifDown(d: D, oif: Ospf6If): void {
  for (const n of [...oif.nbrs]) nbrDown(d, oif, n, "interface down");
  const ldb = d.rt.linkDb[oif.name];
  if (ldb) delete d.rt.linkDb[oif.name];
  d.rt.oifs = d.rt.oifs.filter((o) => o !== oif);
  d.rt.spfDirty = true;
}

function teardown(d: D): void {
  for (const area of Object.keys(d.rt.lsdb)) for (const [key, e] of Object.entries(d.rt.lsdb[area])) if (e.self) flushSelf(d, area, key);
  for (const oif of [...d.rt.oifs]) ifDown(d, oif);
  d.rt.lsdb = {};
  d.rt.linkDb = {};
  installRoutes(d, []);
  d.rt.routes = undefined;
}

// ---------------------------------------------------------------------------
// Neighbour FSM.
const NSM_NAME: Record<Nsm6, string> = { Down: "Down", Init: "Init", "2-Way": "Twoway", ExStart: "ExStart", Exchange: "ExChange", Loading: "Loading", Full: "Full" };
export const nsm6Name = (s: Nsm6) => NSM_NAME[s];
const lac = (d: D) => d.cfg.logAdjacencyChanges ?? true;

function setNbrState(d: D, oif: Ospf6If, n: Ospf6Nbr, state: Nsm6, event: string): void {
  const old = n.state;
  if (old === state) return;
  n.state = state;
  n.progressMs = d.now;
  if (oif.type === "broadcast" && NSM[old] >= NSM["2-Way"] !== NSM[state] >= NSM["2-Way"]) oif.pendNbrChange = true;
  if (NSM[state] < NSM.ExStart) {
    n.summary = undefined;
    n.reqs = [];
    n.rxmt = {};
    n.lastDbd = undefined;
    n.ddRxmtDue = undefined;
    n.reqDue = undefined;
  }
  if (state === "Full" || old === "Full") emit(d, oif, "OSPF_NEIGHBOR", `OSPFv3 neighbor ${n.rid} on ${oif.name}: ${old} → ${state}`);
  // ospf6_neighbor.c:238-249 — Full or a downward change (every change with `detail`).
  const l = lac(d);
  if (l && (l === "detail" || state === "Full" || NSM[state] < NSM[old]))
    logEvent(d.device, d.now, "NOTICE", "bgp#ospf6d", `AdjChg: Nbr ${n.rid}(default) on ${n.rid}%${oif.name}: ${NSM_NAME[old]} -> ${NSM_NAME[state]} (${event})`);
}

function nbrDown(d: D, oif: Ospf6If, n: Ospf6Nbr, why: string): void {
  setNbrState(d, oif, n, "Down", why === "interface down" ? "InterfaceDown" : "InactivityTimer");
  oif.nbrs = oif.nbrs.filter((x) => x !== n);
  d.rt.spfDirty = true;
  emit(d, oif, "OSPF_NEIGHBOR", `OSPFv3 neighbor ${n.rid} on ${oif.name} Down: ${why}`);
}

const shouldAdj = (d: D, oif: Ospf6If, n: Ospf6Nbr) => {
  const me = d.rt.routerId;
  return oif.type === "point-to-point" || oif.dr === me || oif.bdr === me || oif.dr === n.rid || oif.bdr === n.rid;
};

function enterExStart(d: D, oif: Ospf6If, n: Ospf6Nbr, event: string): void {
  setNbrState(d, oif, n, "ExStart", event);
  n.summary = undefined;
  n.reqs = [];
  n.rxmt = {};
  n.master = true;
  n.ddSeq = ((n.ddSeq ?? Math.floor(d.now / 1000)) + 1) & 0x7fffffff;
  sendDbd(d, oif, n, DD_I | DD_M | DD_MS, []);
}

export const mtu6Of = (device: Device) => (device.type === "switch" ? 9100 : 1500);

function sendDbd(d: D, oif: Ospf6If, n: Ospf6Nbr, flags: number, headers: number[][]): void {
  const body = encodeDbd6({ options: OPTIONS6, mtu: mtu6Of(d.device), flags, seq: n.ddSeq ?? 0, headers });
  n.lastDbd = body;
  n.moreSent = !!(flags & DD_M);
  n.ddRxmtDue = n.master ? d.now + oif.rxmt * 1000 : undefined;
  send(d, oif, n, T_DBD, body);
}

const areaDb = (rt: Ospf6Rt, area: string) => (rt.lsdb[area] ??= {});
const linkDb = (rt: Ospf6Rt, ifName: string) => (rt.linkDb[ifName] ??= {});
/** The database an LSA of this type belongs to as seen from `oif`. */
const dbFor = (rt: Ospf6Rt, oif: Ospf6If, type: number) => (type === LSA6_LINK ? linkDb(rt, oif.name) : areaDb(rt, oif.area));
const known = (t: number) => t === LSA6_ROUTER || t === LSA6_NETWORK || t === LSA6_LINK || t === LSA6_INTRA_PREFIX;

/** DD summary list: area-scope LSAs + this link's Link-LSAs. */
function nextChunk(d: D, oif: Ospf6If, n: Ospf6Nbr): { headers: number[][]; more: boolean } {
  const live = (db: Record<string, Lsa6Entry>) => Object.keys(db).filter((k) => lsa6Age(db[k], d.now) < MAX_AGE);
  n.summary ??= [...live(areaDb(d.rt, oif.area)), ...live(linkDb(d.rt, oif.name))].sort();
  const keys = n.summary.splice(0, DBD_CHUNK);
  const headers: number[][] = [];
  for (const k of keys) {
    const e = areaDb(d.rt, oif.area)[k] ?? linkDb(d.rt, oif.name)[k];
    if (e) headers.push(withAge(e.lsa, lsa6Age(e, d.now)).slice(0, 20));
  }
  return { headers, more: n.summary.length > 0 };
}

function exchangeDone(d: D, oif: Ospf6If, n: Ospf6Nbr): void {
  n.ddRxmtDue = undefined;
  if (n.reqs.length === 0) setNbrState(d, oif, n, "Full", "ExchangeDone");
  else {
    setNbrState(d, oif, n, "Loading", "ExchangeDone");
    sendLsr(d, oif, n);
  }
}

function sendLsr(d: D, oif: Ospf6If, n: Ospf6Nbr): void {
  if (!n.reqs.length) return;
  send(d, oif, n, T_LSR, encodeLsr(n.reqs.slice(0, 100)));
  n.reqDue = d.now + oif.rxmt * 1000;
}

// ---------------------------------------------------------------------------
// DR election (RFC 2328 9.4 with Router IDs, RFC 5340 4.2.1).
interface Cand {
  self: boolean;
  rid: string;
  priority: number;
  n?: Ospf6Nbr;
}

function election(d: D, oif: Ospf6If): void {
  const me = d.rt.routerId;
  const oldDr = oif.dr;
  const oldBdr = oif.bdr;
  const oldState = oif.state;
  const el: Cand[] = [];
  if (oif.priority > 0) el.push({ self: true, rid: me, priority: oif.priority });
  for (const n of oif.nbrs) if (n.priority > 0 && NSM[n.state] >= NSM["2-Way"]) el.push({ self: false, rid: n.rid, priority: n.priority, n });
  const declDr = (c: Cand) => (c.self ? oif.dr : c.n!.dr);
  const declBdr = (c: Cand) => (c.self ? oif.bdr : c.n!.bdr);
  const best = (l: Cand[]) => l.reduce<Cand | undefined>((m, c) => (!m || c.priority > m.priority || (c.priority === m.priority && ipNum(c.rid) > ipNum(m.rid)) ? c : m), undefined);
  const electBdr = () => {
    const noDr = el.filter((c) => declDr(c) !== c.rid);
    const bdrs = noDr.filter((c) => declBdr(c) === c.rid);
    oif.bdr = best(bdrs.length ? bdrs : noDr)?.rid ?? ZERO;
  };
  const electDr = () => {
    const drs = el.filter((c) => declDr(c) === c.rid);
    oif.dr = (drs.length ? best(drs) : el.find((c) => c.rid === oif.bdr))?.rid ?? ZERO;
  };
  const stateOf = (): Ism6 => (oif.dr === me ? "DR" : oif.bdr === me ? "BDR" : "DROther");
  electBdr();
  electDr();
  let ns = stateOf();
  if (ns !== oldState && !(ns === "DROther" && ISM[oldState] < ISM.DROther)) {
    electBdr();
    electDr();
    ns = stateOf();
  }
  oif.state = ns;
  oif.waitDue = undefined;
  if (oif.dr !== oldDr || oif.bdr !== oldBdr) {
    for (const n of oif.nbrs) {
      if (NSM[n.state] < NSM["2-Way"]) continue;
      if (n.state === "2-Way" && shouldAdj(d, oif, n)) enterExStart(d, oif, n, "AdjOK?");
      else if (NSM[n.state] >= NSM.ExStart && !shouldAdj(d, oif, n)) setNbrState(d, oif, n, "2-Way", "AdjOK?");
    }
  }
}

// ---------------------------------------------------------------------------
// Hello.
function sendHello(d: D, oif: Ospf6If): void {
  const body = encodeHello6({
    ifId: oif.ifIndex,
    priority: oif.priority,
    options: OPTIONS6,
    helloInterval: oif.hello,
    deadInterval: oif.dead,
    dr: oif.dr,
    bdr: oif.bdr,
    neighbors: oif.nbrs.filter((n) => NSM[n.state] >= NSM.Init).map((n) => n.rid),
  });
  send(d, oif, "spf", T_HELLO, body);
  emit(d, oif, "OSPF_HELLO", `OSPFv3 Hello out ${oif.name} (area ${oif.area}, rid ${d.rt.routerId})`);
}

function recvHello(d: D, oif: Ospf6If, srcIp: string, srcMac: string, rid: string, body: number[]): void {
  const h = decodeHello6(body);
  if (!h) return;
  if (h.helloInterval !== oif.hello || h.deadInterval !== oif.dead) return; // ospf6_message.c ospf6_hello_recv
  if ((h.options & 0x02) !== (OPTIONS6 & 0x02)) return; // E-bit mismatch
  let n = oif.nbrs.find((x) => x.rid === rid);
  if (!n) {
    n = { rid, ll: srcIp, mac: srcMac, ifIndex: h.ifId, priority: -1, dr: ZERO, bdr: ZERO, state: "Down", deadDue: 0, progressMs: d.now, reqs: [], rxmt: {} };
    oif.nbrs.push(n);
    oif.nbrs.sort((a, b) => ipNum(a.rid) - ipNum(b.rid));
  }
  if (n.ll !== srcIp || n.ifIndex !== h.ifId) d.rt.spfDirty = true;
  n.ll = srcIp;
  n.mac = srcMac;
  n.ifIndex = h.ifId;
  n.deadDue = d.now + oif.dead * 1000;
  if (n.state === "Down") setNbrState(d, oif, n, "Init", "HelloReceived");
  if (!h.neighbors.includes(d.rt.routerId)) {
    if (NSM[n.state] >= NSM["2-Way"]) setNbrState(d, oif, n, "Init", "1-WayReceived");
    n.priority = h.priority;
    n.dr = h.dr;
    n.bdr = h.bdr;
    return;
  }
  if (n.state === "Init") {
    if (shouldAdj(d, oif, n)) enterExStart(d, oif, n, "2-WayReceived");
    else setNbrState(d, oif, n, "2-Way", "2-WayReceived");
  }
  if (oif.type === "broadcast") {
    if (rid === h.dr && h.bdr === ZERO && oif.state === "Waiting") oif.pendBackupSeen = true;
    if (oif.state === "Waiting" && rid === h.bdr) oif.pendBackupSeen = true;
    if ((rid === h.dr) !== (rid === n.dr)) oif.pendNbrChange = true;
    if ((rid === h.bdr) !== (rid === n.bdr)) oif.pendNbrChange = true;
    if (n.priority >= 0 && n.priority !== h.priority) oif.pendNbrChange = true;
  }
  n.priority = h.priority;
  n.dr = h.dr;
  n.bdr = h.bdr;
}

// ---------------------------------------------------------------------------
// Database Description.
function processHeaders(d: D, oif: Ospf6If, n: Ospf6Nbr, headers: Lsa6Header[]): void {
  for (const h of headers) {
    if (!known(h.type)) continue;
    const cur = dbFor(d.rt, oif, h.type)[lsa6Key(h)];
    if (cur && compareLsa(h, lsa6HeaderNow(cur, d.now)) <= 0) continue;
    if (n.reqs.some((r) => lsa6Key(r) === lsa6Key(h))) continue;
    n.reqs.push({ type: h.type, id: h.id, adv: h.adv, seq: h.seq, checksum: h.checksum, age: h.age });
  }
}

function recvDbd(d: D, oif: Ospf6If, n: Ospf6Nbr, body: number[]): void {
  const dd = decodeDbd6(body);
  if (!dd) return;
  if (n.state === "Init") {
    if (shouldAdj(d, oif, n)) enterExStart(d, oif, n, "2-WayReceived");
    else setNbrState(d, oif, n, "2-Way", "2-WayReceived");
  }
  const myRid = ipNum(d.rt.routerId);
  const nRid = ipNum(n.rid);
  switch (n.state) {
    case "ExStart": {
      if ((dd.flags & (DD_I | DD_M | DD_MS)) === (DD_I | DD_M | DD_MS) && dd.headers.length === 0 && nRid > myRid) {
        n.master = false;
        n.ddSeq = dd.seq;
        setNbrState(d, oif, n, "Exchange", "NegotiationDone");
        const c = nextChunk(d, oif, n);
        sendDbd(d, oif, n, c.more ? DD_M : 0, c.headers);
      } else if (!(dd.flags & DD_I) && !(dd.flags & DD_MS) && dd.seq === n.ddSeq && nRid < myRid) {
        n.master = true;
        setNbrState(d, oif, n, "Exchange", "NegotiationDone");
        processHeaders(d, oif, n, dd.headers);
        masterNext(d, oif, n, dd.flags);
      }
      return;
    }
    case "Exchange": {
      if (n.master) {
        if (dd.seq !== n.ddSeq) return;
        if (dd.flags & DD_I || dd.flags & DD_MS) return enterExStart(d, oif, n, "SeqNumberMismatch");
        processHeaders(d, oif, n, dd.headers);
        masterNext(d, oif, n, dd.flags);
      } else {
        if (dd.seq === n.ddSeq && n.lastDbd) {
          send(d, oif, n, T_DBD, n.lastDbd);
          return;
        }
        if (dd.flags & DD_I || !(dd.flags & DD_MS) || dd.seq !== ((n.ddSeq ?? 0) + 1) >>> 0) return enterExStart(d, oif, n, "SeqNumberMismatch");
        n.ddSeq = dd.seq;
        processHeaders(d, oif, n, dd.headers);
        const c = nextChunk(d, oif, n);
        sendDbd(d, oif, n, c.more ? DD_M : 0, c.headers);
        if (!(dd.flags & DD_M) && !c.more) exchangeDone(d, oif, n);
      }
      return;
    }
    case "Loading":
    case "Full": {
      if (!n.master && dd.seq === n.ddSeq && n.lastDbd) send(d, oif, n, T_DBD, n.lastDbd);
      else if (n.master && dd.seq === ((n.ddSeq ?? 0) - 1) >>> 0) return;
      else if (!n.master || dd.seq !== n.ddSeq) enterExStart(d, oif, n, "SeqNumberMismatch");
      return;
    }
    default:
      return;
  }
}

function masterNext(d: D, oif: Ospf6If, n: Ospf6Nbr, slaveFlags: number): void {
  if (n.summary && !n.moreSent && !(slaveFlags & DD_M)) {
    exchangeDone(d, oif, n);
    return;
  }
  n.ddSeq = ((n.ddSeq ?? 0) + 1) >>> 0;
  const c = nextChunk(d, oif, n);
  sendDbd(d, oif, n, DD_MS | (c.more ? DD_M : 0), c.headers);
}

// ---------------------------------------------------------------------------
// LS Request / Update / Ack.
function wire(e: Lsa6Entry, now: number): number[] {
  return withAge(e.lsa, Math.min(MAX_AGE, lsa6Age(e, now) + 1));
}

function recvLsr(d: D, oif: Ospf6If, n: Ospf6Nbr, body: number[]): void {
  if (NSM[n.state] < NSM.Exchange) return;
  const lsas: number[][] = [];
  for (const e of decodeLsr(body)) {
    const ent = dbFor(d.rt, oif, e.type)[lsa6Key(e)];
    if (!ent) return enterExStart(d, oif, n, "BadLSReq");
    lsas.push(wire(ent, d.now));
  }
  if (lsas.length) send(d, oif, n, T_LSU, encodeLsu(lsas));
}

const isSelf = (d: D, h: Lsa6Header) => h.adv === d.rt.routerId;

function recvLsu(d: D, oif: Ospf6If, n: Ospf6Nbr, body: number[]): void {
  if (NSM[n.state] < NSM.Exchange) return;
  const acks: number[][] = [];
  for (const lsa of decodeLsu(body)) {
    if (!lsaChecksumOk(lsa)) continue;
    const h = parseLsa6Header(lsa);
    if (!known(h.type)) continue;
    const db = dbFor(d.rt, oif, h.type);
    const area = h.type === LSA6_LINK ? undefined : oif.area;
    const key = lsa6Key(h);
    const cur = db[key];
    const reqIdx = n.reqs.findIndex((r) => lsa6Key(r) === key);
    if (h.age >= MAX_AGE && !cur && !oif.nbrs.some((x) => x.state === "Exchange" || x.state === "Loading")) {
      acks.push(lsa.slice(0, 20));
      continue;
    }
    const cmp = cur ? compareLsa(h, lsa6HeaderNow(cur, d.now)) : 1;
    if (cmp > 0) {
      if (reqIdx >= 0) n.reqs.splice(reqIdx, 1);
      if (isSelf(d, h)) {
        // RFC 2328 13.4: a newer instance of our own LSA — re-originate above it, or flush.
        acks.push(lsa.slice(0, 20));
        if (cur?.self && h.age < MAX_AGE) originate(d, area ?? oif.area, h.type, h.id, cur.lsa.slice(20), h.seq + 1, false, h.type === LSA6_LINK ? oif : undefined);
        else {
          db[key] = { lsa, rxMs: d.now, age0: h.age };
          flushKey(d, db, key, area, h.type === LSA6_LINK ? oif : undefined);
        }
        continue;
      }
      for (const o of d.rt.oifs) for (const x of o.nbrs) delete x.rxmt[key];
      db[key] = { lsa: withAge(lsa, h.age), rxMs: d.now, age0: h.age };
      d.rt.spfDirty = true;
      flood(d, db, key, area, h.type === LSA6_LINK ? oif : undefined, oif, n);
      acks.push(lsa.slice(0, 20));
      if (h.age >= MAX_AGE) delete db[key];
    } else if (cmp === 0) {
      if (n.rxmt[key] !== undefined) delete n.rxmt[key];
      else acks.push(lsa.slice(0, 20));
    } else if (cur) {
      send(d, oif, n, T_LSU, encodeLsu([wire(cur, d.now)]));
    }
  }
  if (acks.length) send(d, oif, oif.type === "point-to-point" ? "spf" : n, T_ACK, acks.flat());
  if (n.state === "Loading" && n.reqs.length === 0) setNbrState(d, oif, n, "Full", "LoadingDone");
  else if (n.state === "Loading") sendLsr(d, oif, n);
}

function recvAck(d: D, oif: Ospf6If, n: Ospf6Nbr, body: number[]): void {
  if (NSM[n.state] < NSM.Exchange) return;
  for (const h of decodeAck6(body)) {
    const key = lsa6Key(h);
    if (n.rxmt[key] === undefined) continue;
    const cur = dbFor(d.rt, oif, h.type)[key];
    if (!cur || compareLsa(h, lsa6HeaderNow(cur, d.now)) === 0) delete n.rxmt[key];
  }
}

/** RFC 2328 13.3 flooding, scoped: area LSAs on the area's interfaces, Link-LSAs on their own link only. */
function flood(d: D, db: Record<string, Lsa6Entry>, key: string, area: string | undefined, link: Ospf6If | undefined, from?: Ospf6If, fromNbr?: Ospf6Nbr): void {
  const e = db[key];
  if (!e) return;
  const h = lsa6HeaderNow(e, d.now);
  for (const oif of d.rt.oifs) {
    if (link ? oif !== link : oif.area !== area) continue;
    if (oif.passive || oif.state === "Loopback" || oif.state === "Down") continue;
    let added = false;
    for (const n of oif.nbrs) {
      if (NSM[n.state] < NSM.Exchange) continue;
      if (n.state !== "Full") {
        const ri = n.reqs.findIndex((r) => lsa6Key(r) === key);
        if (ri >= 0) {
          const c = compareLsa(n.reqs[ri], h);
          if (c > 0) continue;
          n.reqs.splice(ri, 1);
          if (c === 0) continue;
        }
      }
      if (n === fromNbr) continue;
      n.rxmt[key] = d.now + oif.rxmt * 1000;
      added = true;
    }
    if (!added) continue;
    if (oif === from && fromNbr && (fromNbr.rid === oif.dr || fromNbr.rid === oif.bdr)) continue;
    if (oif === from && oif.state === "BDR") continue;
    const to = oif.type === "point-to-point" || oif.state === "DR" || oif.state === "BDR" ? "spf" : "dr";
    send(d, oif, to, T_LSU, encodeLsu([wire(e, d.now)]));
  }
}

// ---------------------------------------------------------------------------
// Origination.
const sameBytes = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function originate(d: D, area: string, type: number, id: string, body: number[], minSeq?: number, force = false, link?: Ospf6If): void {
  const db = link ? linkDb(d.rt, link.name) : areaDb(d.rt, area);
  const key = lsa6Key({ type, id, adv: d.rt.routerId });
  const cur = db[key];
  const curH = cur && lsa6HeaderNow(cur, d.now);
  if (!force && minSeq === undefined && cur && curH!.age < MAX_AGE && sameBytes(cur.lsa.slice(20), body)) return;
  let seq = curH ? curH.seq + 1 : INITIAL_SEQ;
  if (minSeq !== undefined && minSeq > seq) seq = minSeq;
  const lsa = buildLsa6({ age: 0, type, id, adv: d.rt.routerId, seq }, body);
  db[key] = { lsa, rxMs: d.now, age0: 0, self: true };
  d.rt.spfDirty = true;
  flood(d, db, key, link ? undefined : area, link);
}

function flushKey(d: D, db: Record<string, Lsa6Entry>, key: string, area: string | undefined, link: Ospf6If | undefined): void {
  const e = db[key];
  if (!e) return;
  e.age0 = MAX_AGE;
  e.rxMs = d.now;
  e.lsa = withAge(e.lsa, MAX_AGE);
  flood(d, db, key, area, link);
  delete db[key];
  d.rt.spfDirty = true;
}

function flushSelf(d: D, area: string, key: string): void {
  flushKey(d, areaDb(d.rt, area), key, area, undefined);
}

const fullNbrs = (oif: Ospf6If) => oif.nbrs.filter((n) => n.state === "Full");

/** Broadcast link is transit: DR known and (we are DR with a Full neighbour, or Full with the DR). */
function isTransit(d: D, oif: Ospf6If): boolean {
  if (oif.type !== "broadcast" || oif.state === "Waiting" || oif.dr === ZERO) return false;
  if (oif.dr === d.rt.routerId) return fullNbrs(oif).length > 0;
  return oif.nbrs.find((n) => n.rid === oif.dr)?.state === "Full";
}

function routerIfs(d: D, area: string): RouterIf6[] {
  const out: RouterIf6[] = [];
  for (const oif of d.rt.oifs) {
    if (oif.area !== area || oif.state === "Down" || oif.type === "loopback") continue;
    if (oif.type === "point-to-point") {
      for (const n of fullNbrs(oif)) out.push({ type: 1, metric: oif.cost, ifId: oif.ifIndex, nbrIfId: n.ifIndex, nbrRid: n.rid });
    } else if (isTransit(d, oif)) {
      const drIf = oif.dr === d.rt.routerId ? oif.ifIndex : (oif.nbrs.find((n) => n.rid === oif.dr)?.ifIndex ?? 0);
      out.push({ type: 2, metric: oif.cost, ifId: oif.ifIndex, nbrIfId: drIf, nbrRid: oif.dr });
    }
  }
  return out;
}

const pfx = (address: string, prefix: number, metric: number, options = 0): Prefix6 => ({ len: prefix, options, metric, prefix: networkAddress6(address, prefix) });

function originateAll(d: D): void {
  const { rt } = d;
  const me = rt.routerId;
  const areas = new Set([...rt.oifs.map((o) => o.area), ...Object.keys(rt.lsdb)]);
  for (const area of areas) {
    const db = areaDb(rt, area);
    const active = rt.oifs.some((o) => o.area === area && o.state !== "Down");
    const rkey = lsa6Key({ type: LSA6_ROUTER, id: ZERO, adv: me });
    const ikey = lsa6Key({ type: LSA6_INTRA_PREFIX, id: ZERO, adv: me });
    if (!active) {
      for (const [k, e] of Object.entries(db)) if (e.self) flushSelf(d, area, k);
      continue;
    }
    originate(d, area, LSA6_ROUTER, ZERO, encodeRouter6(0, routerIfs(d, area)));
    // Router's Intra-Area-Prefix-LSA: loopback /128, point-to-point and stub broadcast prefixes (RFC 5340 4.4.3.9).
    const prefixes: Prefix6[] = [];
    for (const oif of rt.oifs) {
      if (oif.area !== area || oif.state === "Down") continue;
      if (oif.type === "loopback") for (const a of oif.prefixes) prefixes.push(pfx(a.address, 128, 0, PFX_LA));
      else if (oif.type === "point-to-point" || !isTransit(d, oif)) for (const a of oif.prefixes) prefixes.push(pfx(a.address, a.prefix, oif.cost));
    }
    if (prefixes.length) originate(d, area, LSA6_INTRA_PREFIX, ZERO, encodeIntraPrefix6({ refType: LSA6_ROUTER, refId: ZERO, refAdv: me, prefixes }));
    else if (db[ikey]?.self) flushSelf(d, area, ikey);
    if (db[rkey] === undefined) continue;
    // DR: Network-LSA + transit Intra-Area-Prefix-LSA (LS ID = the DR's Interface ID).
    const wantNet = new Set<string>();
    const wantIap = new Set<string>();
    for (const oif of rt.oifs) {
      if (oif.area !== area || oif.type !== "broadcast" || oif.state !== "DR") continue;
      const full = fullNbrs(oif);
      if (!full.length) continue;
      const id = intToDotted(oif.ifIndex);
      wantNet.add(id);
      originate(d, area, LSA6_NETWORK, id, encodeNetwork6([me, ...full.map((n) => n.rid)].sort((a, b) => ipNum(a) - ipNum(b))));
      const seen = new Set<string>();
      const tp: Prefix6[] = [];
      const addP = (p: Prefix6) => {
        const k = `${p.prefix}/${p.len}`;
        if (!seen.has(k)) {
          seen.add(k);
          tp.push({ ...p, metric: 0 });
        }
      };
      for (const a of oif.prefixes) addP(pfx(a.address, a.prefix, 0));
      const ldb = linkDb(rt, oif.name);
      for (const n of full) {
        const l = ldb[lsa6Key({ type: LSA6_LINK, id: intToDotted(n.ifIndex), adv: n.rid })];
        if (l) for (const p of decodeLink6(l.lsa).prefixes) addP(p);
      }
      if (tp.length) {
        wantIap.add(id);
        originate(d, area, LSA6_INTRA_PREFIX, id, encodeIntraPrefix6({ refType: LSA6_NETWORK, refId: id, refAdv: me, prefixes: tp }));
      }
    }
    for (const [k, e] of Object.entries(db)) {
      if (!e.self) continue;
      const h = parseLsa6Header(e.lsa);
      if (h.type === LSA6_NETWORK && !wantNet.has(h.id)) flushSelf(d, area, k);
      if (h.type === LSA6_INTRA_PREFIX && h.id !== ZERO && !wantIap.has(h.id)) flushSelf(d, area, k);
    }
  }
  // Link-LSA per interface (not on loopbacks): our link-local + the link's prefixes.
  for (const oif of rt.oifs) {
    if (oif.type === "loopback" || oif.state === "Down") continue;
    originate(d, oif.area, LSA6_LINK, intToDotted(oif.ifIndex), encodeLink6(oif.priority, oif.ll, oif.prefixes.map((a) => pfx(a.address, a.prefix, 0))), undefined, false, oif);
  }
}

// ---------------------------------------------------------------------------
// SPF (RFC 5340 4.8).
interface Vertex {
  vid: string;
  kind: "R" | "N";
  rid: string;
  netId?: string;
  dist: number;
  paths: Ospf6Path[];
}

function spfArea(d: D, area: string): Ospf6RouteView[] {
  const me = d.rt.routerId;
  const db = areaDb(d.rt, area);
  const live = Object.values(db).filter((e) => lsa6Age(e, d.now) < MAX_AGE);
  const rlinks = new Map<string, RouterIf6[]>();
  const nets = new Map<string, string[]>();
  const iaps: { h: Lsa6Header; lsa: number[] }[] = [];
  for (const e of live) {
    const h = parseLsa6Header(e.lsa);
    if (h.type === LSA6_ROUTER) rlinks.set(h.adv, [...(rlinks.get(h.adv) ?? []), ...decodeRouter6(e.lsa)]);
    else if (h.type === LSA6_NETWORK) nets.set(`${h.adv}/${h.id}`, decodeNetwork6(e.lsa));
    else if (h.type === LSA6_INTRA_PREFIX) iaps.push({ h, lsa: e.lsa });
  }
  if (!rlinks.has(me)) return [];
  const oifByIndex = (i: number) => d.rt.oifs.find((o) => o.ifIndex === i && o.area === area);
  const addPaths = (into: Ospf6Path[], add: Ospf6Path[]) => {
    for (const p of add) if (!into.some((q) => q.nh === p.nh && q.ifId === p.ifId)) into.push(p);
  };
  const tree = new Map<string, Vertex>();
  const cand = new Map<string, Vertex>([[`R:${me}`, { vid: `R:${me}`, kind: "R", rid: me, dist: 0, paths: [] }]]);
  while (cand.size) {
    let v: Vertex | undefined;
    for (const c of cand.values()) if (!v || c.dist < v.dist || (c.dist === v.dist && c.kind === "N" && v.kind === "R")) v = c;
    const V = v!;
    cand.delete(V.vid);
    tree.set(V.vid, V);
    const relax = (w: Omit<Vertex, "paths" | "dist">, cost: number, paths: Ospf6Path[]) => {
      if (tree.has(w.vid) || !paths.length) return;
      const c = cand.get(w.vid);
      if (!c || cost < c.dist) cand.set(w.vid, { ...w, dist: cost, paths: [...paths] });
      else if (cost === c.dist) addPaths(c.paths, paths);
    };
    if (V.kind === "R") {
      for (const l of rlinks.get(V.rid) ?? []) {
        if (l.type === 1) {
          if (!(rlinks.get(l.nbrRid) ?? []).some((x) => x.type === 1 && x.nbrRid === V.rid)) continue;
          let paths = V.paths;
          if (V.rid === me) {
            const oif = oifByIndex(l.ifId);
            const n = oif?.nbrs.find((x) => x.rid === l.nbrRid && x.state === "Full");
            paths = oif && n ? [{ nh: n.ll, ifId: oif.ifId, ifName: oif.name }] : [];
          }
          relax({ vid: `R:${l.nbrRid}`, kind: "R", rid: l.nbrRid }, V.dist + l.metric, paths);
        } else if (l.type === 2) {
          const netId = intToDotted(l.nbrIfId);
          const att = nets.get(`${l.nbrRid}/${netId}`);
          if (!att || !att.includes(V.rid)) continue;
          let paths = V.paths;
          if (V.rid === me) {
            const oif = oifByIndex(l.ifId);
            paths = oif ? [{ nh: null, ifId: oif.ifId, ifName: oif.name }] : [];
          }
          relax({ vid: `N:${l.nbrRid}/${netId}`, kind: "N", rid: l.nbrRid, netId }, V.dist + l.metric, paths);
        }
      }
    } else {
      for (const r of nets.get(`${V.rid}/${V.netId}`) ?? []) {
        const back = (rlinks.get(r) ?? []).some((x) => x.type === 2 && x.nbrRid === V.rid && intToDotted(x.nbrIfId) === V.netId);
        if (!back) continue;
        // Directly attached network: next hop = that router's link-local on the link.
        const paths = V.paths.flatMap((p) => {
          if (p.nh !== null) return [p];
          const oif = d.rt.oifs.find((o) => o.ifId === p.ifId);
          const n = oif?.nbrs.find((x) => x.rid === r);
          return n ? [{ ...p, nh: n.ll }] : [];
        });
        relax({ vid: `R:${r}`, kind: "R", rid: r }, V.dist, paths);
      }
    }
  }

  // Prefixes from Intra-Area-Prefix-LSAs attached to vertices in the tree.
  const routes = new Map<string, Ospf6RouteView>();
  for (const { h, lsa } of iaps) {
    const ip = decodeIntraPrefix6(lsa);
    const vid = ip.refType === LSA6_ROUTER ? `R:${ip.refAdv}` : `N:${ip.refAdv}/${ip.refId}`;
    const V = tree.get(vid);
    if (!V || ip.refAdv !== h.adv) continue;
    for (const p of ip.prefixes) {
      let paths = V.paths;
      if (V.rid === me && V.kind === "R") {
        const oif = d.rt.oifs.find((o) => o.area === area && o.prefixes.some((a) => (p.len === 128 ? a.address === p.prefix : networkAddress6(a.address, a.prefix) === p.prefix && a.prefix === p.len)));
        paths = oif ? [{ nh: null, ifId: oif.ifId, ifName: oif.name }] : [];
      } else if (V.kind === "N" && V.paths.every((x) => x.nh === null)) paths = V.paths;
      if (!paths.length) continue;
      const cost = V.dist + p.metric;
      const k = `${p.prefix}/${p.len}`;
      const r = routes.get(k);
      if (!r || cost < r.cost) routes.set(k, { dest: p.prefix, prefix: p.len, cost, area, paths: [...paths] });
      else if (cost === r.cost) addPaths(r.paths, paths);
    }
  }
  return [...routes.values()];
}

const v6Key = (a: string) => parseIpv6(a) ?? 0n;

function runSpf(d: D): void {
  const all = new Map<string, Ospf6RouteView>();
  for (const area of [...new Set(d.rt.oifs.map((o) => o.area))].sort((a, b) => ipNum(a) - ipNum(b))) {
    for (const r of spfArea(d, area)) {
      const k = `${r.dest}/${r.prefix}`;
      const cur = all.get(k);
      if (!cur || r.cost < cur.cost) all.set(k, r);
    }
  }
  for (const r of all.values()) r.paths.sort((a, b) => (a.nh === null ? -1 : b.nh === null ? 1 : a.ifName.localeCompare(b.ifName, undefined, { numeric: true })));
  const routes = [...all.values()].sort((a, b) => (v6Key(a.dest) < v6Key(b.dest) ? -1 : v6Key(a.dest) > v6Key(b.dest) ? 1 : a.prefix - b.prefix));
  d.rt.spf.runs++;
  d.rt.spf.lastMs = d.now;
  d.rt.routes = routes;
  d.rt.spfDirty = false;
  installRoutes(d, routes);
}

/** Replace this daemon's routes in the IPv6 RIB (connected/static/BGP untouched). */
function installRoutes(d: D, routes: Ospf6RouteView[]): void {
  const table = d.device.routingTable6 ?? (d.device.routingTable6 = []);
  const prev = table.filter((r) => r.type === "ospf");
  const next: Route[] = routes.flatMap((r) =>
    r.paths.map((p) => ({ destination: r.dest, prefix: r.prefix, nextHop: p.nh, interfaceId: p.ifId, type: "ospf" as const, metric: r.cost, distance: 110 })),
  );
  const strip = (l: Route[]) => JSON.stringify(l.map(({ installedAtMs: _t, ...rest }) => rest));
  if (strip(prev) === strip(next)) return;
  carryInstallTime(prev, next, d.now);
  for (const r of next.filter((r) => r.nextHop && !prev.some((p) => p.destination === r.destination && p.prefix === r.prefix && p.nextHop === r.nextHop)))
    emit(d, undefined, "OSPF_ROUTE", `OSPFv3 route ${r.destination}/${r.prefix} via ${r.nextHop} (cost ${r.metric})`);
  d.device.routingTable6 = [...table.filter((r) => r.type !== "ospf"), ...next];
}

/** Our routes went missing from the RIB (e.g. a connected-route rebuild): reinstall. */
function routesMissing(device: Device, rt: Ospf6Rt): boolean {
  const want = (rt.routes ?? []).reduce((n, r) => n + r.paths.length, 0);
  return (device.routingTable6 ?? []).filter((r) => r.type === "ospf").length !== want;
}

// ---------------------------------------------------------------------------
function withDevice(ctx: SimContext, device: Device, now: number, fn: (d: D) => void): boolean {
  const cfg = liveOspf6Config(device);
  let rt = ospf6Runtime(device);
  if (!cfg && !rt) return false;
  const features = (device.config.features ??= {});
  if (!rt) {
    rt = newRt(ospf6RouterId(device, cfg!), now);
    features[RT6_KEY] = rt;
  }
  const d: D = { ctx, device, cfg: cfg ?? { ifParams: {} }, rt, now };
  if (!cfg) {
    teardown(d);
    delete features[RT6_KEY];
    flush();
    return true;
  }
  if (rt.sig !== computeSig(device)) reconcile(d);
  fn(d);
  postProcess(d);
  flush();
  return true;
}

function runIsmEvents(d: D): void {
  for (let i = 0; i < 4; i++) {
    let again = false;
    for (const oif of d.rt.oifs) {
      const backupSeen = oif.pendBackupSeen;
      const nbrChange = oif.pendNbrChange;
      oif.pendBackupSeen = oif.pendNbrChange = undefined;
      if (oif.type !== "broadcast") continue;
      if ((oif.state === "Waiting" && backupSeen) || (nbrChange && ISM[oif.state] >= ISM.DROther)) {
        election(d, oif);
        again = true;
      }
    }
    if (!again) break;
  }
}

function postProcess(d: D): void {
  runIsmEvents(d);
  originateAll(d);
  if (d.rt.spfDirty || routesMissing(d.device, d.rt)) runSpf(d);
}

function dueTimes(rt: Ospf6Rt): number[] {
  const t: number[] = [];
  for (const oif of rt.oifs) {
    if (oif.helloDue !== undefined) t.push(oif.helloDue);
    if (oif.waitDue !== undefined) t.push(oif.waitDue);
    for (const n of oif.nbrs) {
      t.push(n.deadDue);
      if (n.ddRxmtDue !== undefined && (n.state === "ExStart" || n.state === "Exchange")) t.push(n.ddRxmtDue);
      if (n.reqDue !== undefined && n.reqs.length && (n.state === "Exchange" || n.state === "Loading")) t.push(n.reqDue);
      for (const due of Object.values(n.rxmt)) t.push(due);
    }
  }
  for (const db of [...Object.values(rt.lsdb), ...Object.values(rt.linkDb)])
    for (const e of Object.values(db)) t.push(e.rxMs + ((e.self ? LS_REFRESH_TIME : MAX_AGE) - e.age0) * 1000);
  return t;
}

function tick(ctx: SimContext, device: Device, now: number): boolean {
  const snap = () => JSON.stringify([device.config.features?.[RT6_KEY] ?? null, device.routingTable6]);
  const before = snap();
  withDevice(ctx, device, now, (d) => {
    for (const oif of [...d.rt.oifs]) {
      if (oif.waitDue !== undefined && oif.waitDue <= now && oif.state === "Waiting") election(d, oif);
      for (const n of [...oif.nbrs]) {
        if (n.deadDue <= now) {
          nbrDown(d, oif, n, "inactivity timer expired");
          continue;
        }
        if (n.ddRxmtDue !== undefined && n.ddRxmtDue <= now && n.master && n.lastDbd && (n.state === "ExStart" || n.state === "Exchange")) {
          send(d, oif, n, T_DBD, n.lastDbd);
          n.ddRxmtDue = now + oif.rxmt * 1000;
        }
        if (n.reqDue !== undefined && n.reqDue <= now && n.reqs.length && (n.state === "Exchange" || n.state === "Loading")) sendLsr(d, oif, n);
        const dueKeys = Object.entries(n.rxmt).filter(([, t]) => t <= now).map(([k]) => k);
        if (dueKeys.length) {
          const lsas: number[][] = [];
          for (const k of dueKeys) {
            const e = areaDb(d.rt, oif.area)[k] ?? linkDb(d.rt, oif.name)[k];
            if (e) {
              lsas.push(wire(e, now));
              n.rxmt[k] = now + oif.rxmt * 1000;
            } else delete n.rxmt[k];
          }
          if (lsas.length) send(d, oif, n, T_LSU, encodeLsu(lsas));
        }
      }
      if (oif.helloDue !== undefined && oif.helloDue <= now) {
        runIsmEvents(d);
        sendHello(d, oif);
        oif.helloDue = now + oif.hello * 1000;
      }
    }
    for (const [scope, db] of [...Object.entries(d.rt.lsdb).map(([a, x]) => [a, x] as const), ...Object.entries(d.rt.linkDb).map(([n, x]) => [`if:${n}`, x] as const)]) {
      for (const [key, e] of Object.entries(db)) {
        const age = lsa6Age(e, now);
        if (e.self && age >= LS_REFRESH_TIME) {
          const h = parseLsa6Header(e.lsa);
          const link = scope.startsWith("if:") ? d.rt.oifs.find((o) => `if:${o.name}` === scope) : undefined;
          if (scope.startsWith("if:") && !link) continue;
          originate(d, link?.area ?? scope, h.type, h.id, e.lsa.slice(20), undefined, true, link);
        } else if (!e.self && age >= MAX_AGE) {
          delete db[key];
          d.rt.spfDirty = true;
        }
      }
    }
  });
  return snap() !== before;
}

function nextDue(device: Device, now: number): number | undefined {
  if (device.state === "down" || !ospf6Capable(device)) return undefined;
  const rt = ospf6Runtime(device);
  if (!rt && !liveOspf6Config(device)) return undefined;
  if ((rt?.sig ?? "") !== computeSig(device)) return now;
  if (!rt) return undefined;
  if (routesMissing(device, rt)) return now;
  const t = dueTimes(rt);
  return t.length ? Math.min(...t) : undefined;
}

function receive(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  if (ip6NextHeader(frame) !== IPV6_NH.OSPF) return false;
  if (!ospf6Capable(device)) return true; // hosts: not listening on proto 89
  const rt = ospf6Runtime(device);
  if (!rt || !liveOspf6Config(device)) return true;
  const ip6 = frame.ipv6!;
  const payload = ip6Payload(frame);
  const pkt = payload && decodePacket6(payload, ip6.srcIp, ip6.dstIp);
  if (!pkt) return true; // bad checksum / version: dropped by ospf6d
  withDevice(ctx, device, ctx.wallNow(), (d) => {
    const oif = d.rt.oifs.find((o) => o.ifId === ingress.id);
    if (!oif || oif.passive || oif.state === "Down" || oif.state === "Loopback") return;
    if (!isLinkLocal6(ip6.srcIp)) return; // RFC 5340 2.5: sent from link-local addresses
    if (ip6.dstIp === ALL_DR6 ? oif.state !== "DR" && oif.state !== "BDR" : ip6.dstIp !== ALL_SPF6 && ip6.dstIp !== oif.ll) return;
    if (pkt.hdr.routerId === d.rt.routerId || pkt.hdr.areaId !== oif.area || pkt.hdr.instance !== 0) return;
    if (pkt.hdr.type === T_HELLO) return recvHello(d, oif, ip6.srcIp, frame.ethernet.srcMac, pkt.hdr.routerId, pkt.body);
    const n = oif.nbrs.find((x) => x.rid === pkt.hdr.routerId);
    if (!n) return;
    if (pkt.hdr.type === T_DBD) recvDbd(d, oif, n, pkt.body);
    else if (pkt.hdr.type === T_LSR) recvLsr(d, oif, n, pkt.body);
    else if (pkt.hdr.type === T_LSU) recvLsu(d, oif, n, pkt.body);
    else if (pkt.hdr.type === T_ACK) recvAck(d, oif, n, pkt.body);
  });
  return true;
}

function describe(frame: Frame, verbose: boolean): string | undefined {
  if (!frame.ipv6 || ip6NextHeader(frame) !== IPV6_NH.OSPF) return undefined;
  const p = ip6Payload(frame);
  const text = p && describeOspf6(p, verbose);
  return text ? `IP6 ${frame.ipv6.srcIp} > ${frame.ipv6.dstIp}: ${text}` : undefined;
}

registerDaemon({ id: "ospf6", nextDue, tick, describe });
registerV6Receiver("ospf6", receive);
