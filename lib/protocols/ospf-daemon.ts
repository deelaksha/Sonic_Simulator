/**
 * OSPFv2 daemon (ospfd) — a ControlDaemon registered with lib/control/daemon.ts.
 *
 * Runs on routers and SONiC switches (routed ports, SVIs, loopbacks). All
 * protocol packets are real IPv4/OSPF bytes (proto 89, TTL 1, TOS 0xc0 like
 * FRR) built by ospf-wire.ts; state is serializable and lives in
 * device.config.features["ospfd"] (configuration stays in features.ospf).
 *
 * Mapping to FRR 10.3 / RFC 2328:
 *   Interface FSM      ospf_ism.c — Down → Waiting/Point-To-Point/Loopback;
 *                      Waiting ends on WaitTimer (= dead interval) or
 *                      BackupSeen; DR/BDR election ospf_dr_election() incl. the
 *                      second pass (ospf_ism.c:195-240), AdjOK? on DR/BDR change.
 *   Hello              ospf_packet.c ospf_hello()/ospf_make_hello(): interval,
 *                      dead and (broadcast) mask must match; first Hello is sent
 *                      immediately on interface up (ospf_ism.c ism_timer_set).
 *   Neighbour FSM      ospf_nsm.c — Down→Init→2-Way→ExStart→Exchange→Loading→Full;
 *                      adjacency only with DR/BDR on broadcast (RFC 10.4);
 *                      InactivityTimer (dead interval) → Down.
 *   Exchange           RFC 10.6/10.8 master/slave DBD with sequence numbers,
 *                      LSR → LSU → LSAck, ExchangeDone/LoadingDone.
 *   LSDB / flooding    RFC 13 (newer-instance test 13.1, self-originated 13.4,
 *                      flooding 13.3 incl. AllDRouters from DROther), Router-LSA
 *                      (RFC 12.4.1 / ospf_lsa.c link builders) and Network-LSA
 *                      by the DR, LS age, 30-min refresh, MaxAge removal.
 *   SPF                RFC 16.1 Dijkstra with bidirectional link check, ECMP
 *                      next hops, stub networks → device.routingTable as type
 *                      "ospf", distance 110, metric = cost.
 *   BFD                `ip ospf bfd`: session registered when a neighbour
 *                      reaches 2-Way (ospf_bfd.c); BFD up→down kills the
 *                      neighbour immediately (NSM InactivityTimer).
 *
 * Simplifications (documented): acks are sent directly (no 1 s delayed ack),
 * MinLSInterval/MinLSArrival and SPF hold timers are not enforced (FRR's
 * initial SPF delay is 0), a flushed MaxAge LSA is removed right after it is
 * flooded, only intra-area routes are computed (no summary/external LSAs), no
 * authentication, MTU is not checked in DBDs.
 */
import { registerDaemon } from "../control/daemon";
import { transmitIpv4, multicastMac, ipPayload } from "../control/packet";
import { bfd } from "../control/bfd-api";
import { Device, findInterface } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { Route, carryInstallTime } from "../models/route";
import { ipToInt, networkAddress, prefixToMask, sameSubnet } from "../models/ip";
import { SimContext } from "../engine/context";
import {
  OspfConfig,
  OspfIfSpec,
  ospfCapable,
  ospfConfig,
  ospfInterfaces,
  ospfRouterId,
  areaType,
  OSPF_RXMT_DEFAULT,
} from "./ospf-config";
import {
  OSPF_ALL_DR,
  OSPF_ALL_SPF,
  OSPF_PROTO,
  T_HELLO,
  T_DBD,
  T_LSR,
  T_LSU,
  T_ACK,
  PACKET_NAMES,
  LSA_ROUTER,
  LSA_NETWORK,
  DD_I,
  DD_M,
  DD_MS,
  OPT_E,
  MAX_AGE,
  INITIAL_SEQ,
  RouterLink,
  LsaHeader,
  encodePacket,
  decodePacket,
  encodeHello,
  decodeHello,
  encodeDbd,
  decodeDbd,
  encodeLsr,
  decodeLsr,
  encodeLsu,
  decodeLsu,
  decodeAck,
  buildLsa,
  parseLsaHeader,
  lsaKey,
  lsaChecksumOk,
  withAge,
  compareLsa,
  encodeRouterBody,
  decodeRouterBody,
  encodeNetworkBody,
  decodeNetworkBody,
  describeOspf,
} from "./ospf-wire";

export const RT_KEY = "ospfd";
const LS_REFRESH_TIME = 1800; // OSPF_LS_REFRESH_TIME (lib/libospf.h:28)
const DBD_CHUNK = 60; // LSA headers per DBD (fits a 1500-byte MTU)
const ZERO = "0.0.0.0";

export type NsmState = "Down" | "Init" | "2-Way" | "ExStart" | "Exchange" | "Loading" | "Full";
export type IsmState = "Down" | "Loopback" | "Waiting" | "Point-To-Point" | "DROther" | "Backup" | "DR";
const NSM: Record<NsmState, number> = { Down: 0, Init: 1, "2-Way": 2, ExStart: 3, Exchange: 4, Loading: 5, Full: 6 };
const ISM: Record<IsmState, number> = { Down: 0, Loopback: 1, Waiting: 2, "Point-To-Point": 3, DROther: 4, Backup: 5, DR: 6 };

export interface OspfNbr {
  rid: string;
  ip: string;
  mac: string;
  priority: number;
  dr: string;
  bdr: string;
  options: number;
  state: NsmState;
  deadDue: number;
  /** ts_last_progress: last state change (the "Up Time" column). */
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
  bfdReg?: boolean;
  bfdLast?: string;
}

export interface OspfIf {
  name: string;
  ifId: string;
  ip: string;
  prefix: number;
  area: string;
  type: "broadcast" | "point-to-point" | "loopback";
  cost: number;
  hello: number;
  dead: number;
  rxmt: number;
  priority: number;
  passive: boolean;
  bfd: boolean;
  psig: string;
  state: IsmState;
  dr: string;
  bdr: string;
  helloDue?: number;
  waitDue?: number;
  upMs: number;
  nbrs: OspfNbr[];
  lsRxmt: number;
  pendNbrChange?: boolean;
  pendBackupSeen?: boolean;
}

export interface LsaEntry {
  lsa: number[];
  rxMs: number;
  age0: number;
  self?: boolean;
}

export interface OspfRoutePath {
  nh: string | null;
  ifId: string;
  ifName: string;
}

export interface OspfRouteView {
  dest: string;
  prefix: number;
  cost: number;
  area: string;
  paths: OspfRoutePath[];
}

export interface OspfRt {
  sig: string;
  routerId: string;
  startedMs: number;
  oifs: OspfIf[];
  lsdb: Record<string, Record<string, LsaEntry>>;
  spfDirty?: boolean;
  spf: { runs: number; lastMs?: number; durUs: number; perArea: Record<string, number> };
  /** Last SPF result (undefined until SPF has run: "No OSPF routing information exist"). */
  routes?: OspfRouteView[];
}

export function ospfRuntime(device: Device): OspfRt | undefined {
  return device.config.features?.[RT_KEY] as OspfRt | undefined;
}

/** Current LS age of an LSDB entry. */
export function lsaAge(e: LsaEntry, now: number): number {
  return Math.min(MAX_AGE, e.age0 + Math.max(0, Math.floor((now - e.rxMs) / 1000)));
}

export function lsaHeaderNow(e: LsaEntry, now: number): LsaHeader {
  return { ...parseLsaHeader(e.lsa), age: lsaAge(e, now) };
}

// ---------------------------------------------------------------------------
// Transmit queue: packets are queued while a device is being processed and
// sent once its state is consistent, so recursive delivery (peer replies inside
// ctx.transmit) never observes half-updated state.
interface Out {
  ctx: SimContext;
  device: Device;
  ifId: string;
  dstMac: string;
  src: string;
  dst: string;
  payload: number[];
  summary: string;
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
      transmitIpv4(o.ctx, o.device, iface, o.dstMac, { src: o.src, dst: o.dst, proto: OSPF_PROTO, ttl: 1, tos: 0xc0, payload: o.payload, summary: o.summary });
    }
  } catch (e) {
    outbox.length = 0;
    throw e;
  } finally {
    flushing = false;
  }
}

/** Per-call processing context for one device. */
interface D {
  ctx: SimContext;
  device: Device;
  cfg: OspfConfig;
  rt: OspfRt;
  now: number;
}

function send(d: D, oif: OspfIf, to: "spf" | "dr" | OspfNbr, type: number, body: number[]): void {
  let dst = OSPF_ALL_SPF;
  let mac = multicastMac(OSPF_ALL_SPF);
  if (to === "dr") {
    dst = OSPF_ALL_DR;
    mac = multicastMac(OSPF_ALL_DR);
  } else if (to !== "spf" && oif.type !== "point-to-point") {
    // FRR sends every packet to AllSPFRouters on point-to-point networks.
    dst = to.ip;
    mac = to.mac;
  }
  outbox.push({
    ctx: d.ctx,
    device: d.device,
    ifId: oif.ifId,
    dstMac: mac,
    src: oif.ip,
    dst,
    payload: encodePacket(type, d.rt.routerId, oif.area, body),
    summary: `OSPFv2 ${PACKET_NAMES[type]}`,
  });
}

const areaOptions = (cfg: OspfConfig, area: string) => (areaType(cfg, area) ? 0 : OPT_E);
const ipNum = (ip: string) => ipToInt(ip);

function emit(d: D, oif: OspfIf | undefined, type: "OSPF_HELLO" | "OSPF_NEIGHBOR" | "OSPF_ROUTE", message: string): void {
  d.ctx.emit({ type, deviceId: d.device.id, deviceName: d.device.name, interfaceId: oif?.ifId, interfaceName: oif?.name, message: `${d.device.name}: ${message}`, osiLayers: [3] });
}

// ---------------------------------------------------------------------------
// Signature of everything that affects the running instance: config + the
// interfaces' addresses/state. A change makes the daemon due immediately
// (local interface down → neighbours on it go Down at once).
function computeSig(device: Device): string {
  const cfg = ospfConfig(device);
  if (!cfg) return "";
  return JSON.stringify([cfg, device.interfaces.map((i) => [i.id, i.name, i.ipv4, i.adminState, i.operState, i.speed])]);
}

function newRt(routerId: string, now: number): OspfRt {
  return { sig: "", routerId, startedMs: now, oifs: [], lsdb: {}, spf: { runs: 0, durUs: 0, perArea: {} } };
}

const psigOf = (s: OspfIfSpec) => `${s.ip}/${s.prefix}|${s.area}|${s.type}|${s.hello}|${s.dead}|${s.priority}|${s.passive}`;

/** Bring the running instance in line with config + interface state. */
function reconcile(d: D): void {
  const { device, cfg, rt, now } = d;
  const rid = ospfRouterId(device, cfg);
  if (rt.routerId !== rid) {
    // Router-ID change: restart the instance (FRR asks for `clear ip ospf process`).
    teardown(d);
    Object.assign(rt, newRt(rid, now));
  }
  const want = ospfInterfaces(device, cfg).filter((s) => s.up);
  for (const oif of [...rt.oifs]) {
    const w = want.find((s) => s.iface.name === oif.name && s.iface.id === oif.ifId);
    if (!w || psigOf(w) !== oif.psig) ifDown(d, oif);
  }
  for (const w of want) {
    const oif = rt.oifs.find((o) => o.name === w.iface.name);
    if (!oif) {
      ifUp(d, w);
      continue;
    }
    oif.cost = w.cost; // cost change: Router-LSA re-originated in postProcess
    if (oif.bfd !== w.bfd) {
      oif.bfd = w.bfd;
      for (const n of oif.nbrs) if (NSM[n.state] >= NSM["2-Way"]) (w.bfd ? bfdRegister : bfdUnregister)(d, oif, n);
    }
  }
  rt.oifs.sort((a, b) => device.interfaces.findIndex((i) => i.id === a.ifId) - device.interfaces.findIndex((i) => i.id === b.ifId));
  rt.sig = computeSig(device);
}

function ifUp(d: D, s: OspfIfSpec): void {
  const { now } = d;
  const oif: OspfIf = {
    name: s.iface.name,
    ifId: s.iface.id,
    ip: s.ip,
    prefix: s.prefix,
    area: s.area,
    type: s.type,
    cost: s.cost,
    hello: s.hello,
    dead: s.dead,
    rxmt: OSPF_RXMT_DEFAULT,
    priority: s.priority,
    passive: s.passive,
    bfd: s.bfd,
    psig: psigOf(s),
    state: "Down",
    dr: ZERO,
    bdr: ZERO,
    upMs: now,
    nbrs: [],
    lsRxmt: 0,
  };
  // ISM InterfaceUp (ospf_ism.c ism_interface_up + ism_timer_set).
  if (s.type === "loopback") oif.state = "Loopback";
  else if (s.type === "point-to-point") oif.state = "Point-To-Point";
  else if (s.priority === 0) oif.state = "DROther";
  else {
    oif.state = "Waiting";
    oif.waitDue = now + s.dead * 1000;
  }
  if (s.type !== "loopback" && !s.passive) oif.helloDue = now; // first Hello immediately
  d.rt.oifs.push(oif);
}

function ifDown(d: D, oif: OspfIf): void {
  for (const n of [...oif.nbrs]) nbrDown(d, oif, n, "interface down");
  d.rt.oifs = d.rt.oifs.filter((o) => o !== oif);
}

/** Stop the instance: flush self-originated LSAs, drop neighbours and routes. */
function teardown(d: D): void {
  for (const area of Object.keys(d.rt.lsdb)) {
    for (const [key, e] of Object.entries(d.rt.lsdb[area])) if (e.self) flushSelf(d, area, key);
  }
  for (const oif of [...d.rt.oifs]) ifDown(d, oif);
  d.rt.lsdb = {};
  installRoutes(d, []);
  d.rt.routes = undefined;
}

// ---------------------------------------------------------------------------
// Neighbour FSM helpers.
function setNbrState(d: D, oif: OspfIf, n: OspfNbr, state: NsmState): void {
  const old = n.state;
  if (old === state) return;
  n.state = state;
  n.progressMs = d.now;
  if (oif.bfd) {
    if (NSM[state] >= NSM["2-Way"] && NSM[old] < NSM["2-Way"]) bfdRegister(d, oif, n);
    if (NSM[state] < NSM["2-Way"] && NSM[old] >= NSM["2-Way"]) bfdUnregister(d, oif, n);
  }
  if (oif.type === "broadcast" && NSM[old] >= NSM["2-Way"] !== NSM[state] >= NSM["2-Way"]) oif.pendNbrChange = true;
  if (NSM[state] < NSM.ExStart) {
    n.summary = undefined;
    n.reqs = [];
    n.rxmt = {};
    n.lastDbd = undefined;
    n.ddRxmtDue = undefined;
    n.reqDue = undefined;
  }
  if (state === "Full" || old === "Full") {
    emit(d, oif, "OSPF_NEIGHBOR", `OSPF neighbor ${n.rid} (${n.ip}) on ${oif.name}: ${old} → ${state}`);
  }
}

function bfdRegister(d: D, oif: OspfIf, n: OspfNbr): void {
  bfd().register(d.device, { peer: n.ip, local: oif.ip, iface: oif.name }, "ospf");
  n.bfdReg = true;
  n.bfdLast = bfd().state(d.device, n.ip);
}

function bfdUnregister(d: D, _oif: OspfIf, n: OspfNbr): void {
  if (!n.bfdReg) return;
  bfd().unregister(d.device, n.ip, "ospf");
  n.bfdReg = false;
  n.bfdLast = undefined;
}

function nbrDown(d: D, oif: OspfIf, n: OspfNbr, why: string): void {
  setNbrState(d, oif, n, "Down");
  oif.nbrs = oif.nbrs.filter((x) => x !== n);
  emit(d, oif, "OSPF_NEIGHBOR", `OSPF neighbor ${n.rid} (${n.ip}) on ${oif.name} Down: ${why}`);
}

const shouldAdj = (oif: OspfIf, n: OspfNbr) =>
  oif.type === "point-to-point" || oif.dr === oif.ip || oif.bdr === oif.ip || oif.dr === n.ip || oif.bdr === n.ip;

function enterExStart(d: D, oif: OspfIf, n: OspfNbr): void {
  setNbrState(d, oif, n, "ExStart");
  n.summary = undefined;
  n.reqs = [];
  n.rxmt = {};
  n.master = true;
  n.ddSeq = ((n.ddSeq ?? Math.floor(d.now / 1000)) + 1) & 0x7fffffff;
  sendDbd(d, oif, n, DD_I | DD_M | DD_MS, []);
}

function sendDbd(d: D, oif: OspfIf, n: OspfNbr, flags: number, headers: number[][]): void {
  const body = encodeDbd({ mtu: mtuOf(d.device), options: areaOptions(d.cfg, oif.area), flags, seq: n.ddSeq ?? 0, headers });
  n.lastDbd = body;
  n.moreSent = !!(flags & DD_M);
  n.ddRxmtDue = n.master ? d.now + oif.rxmt * 1000 : undefined;
  send(d, oif, n, T_DBD, body);
}

export const mtuOf = (device: Device) => (device.type === "switch" ? 9100 : 1500);

function areaDb(rt: OspfRt, area: string): Record<string, LsaEntry> {
  return (rt.lsdb[area] ??= {});
}

/** Next chunk of this neighbour's DD summary list as wire headers. */
function nextChunk(d: D, oif: OspfIf, n: OspfNbr): { headers: number[][]; more: boolean } {
  if (!n.summary) {
    const db = areaDb(d.rt, oif.area);
    n.summary = Object.keys(db).filter((k) => lsaAge(db[k], d.now) < MAX_AGE).sort();
  }
  const db = areaDb(d.rt, oif.area);
  const keys = n.summary.splice(0, DBD_CHUNK).filter((k) => db[k]);
  return { headers: keys.map((k) => withAge(db[k].lsa, lsaAge(db[k], d.now)).slice(0, 20)), more: n.summary.length > 0 };
}

function exchangeDone(d: D, oif: OspfIf, n: OspfNbr): void {
  n.ddRxmtDue = undefined;
  if (n.reqs.length === 0) setNbrState(d, oif, n, "Full");
  else {
    setNbrState(d, oif, n, "Loading");
    sendLsr(d, oif, n);
  }
}

function sendLsr(d: D, oif: OspfIf, n: OspfNbr): void {
  if (!n.reqs.length) return;
  send(d, oif, n, T_LSR, encodeLsr(n.reqs.slice(0, 100)));
  n.reqDue = d.now + oif.rxmt * 1000;
}

function seqMismatch(d: D, oif: OspfIf, n: OspfNbr): void {
  enterExStart(d, oif, n);
}

// ---------------------------------------------------------------------------
// Interface FSM: DR/BDR election (ospf_ism.c:47-240).
interface Cand {
  self: boolean;
  rid: string;
  ip: string;
  priority: number;
  n?: OspfNbr;
}

function election(d: D, oif: OspfIf): void {
  const oldDr = oif.dr;
  const oldBdr = oif.bdr;
  const oldState = oif.state;
  const el: Cand[] = [];
  if (oif.priority > 0) el.push({ self: true, rid: d.rt.routerId, ip: oif.ip, priority: oif.priority });
  for (const n of oif.nbrs) if (n.rid !== ZERO && n.priority > 0 && NSM[n.state] >= NSM["2-Way"]) el.push({ self: false, rid: n.rid, ip: n.ip, priority: n.priority, n });
  const declDr = (c: Cand) => (c.self ? oif.dr : c.n!.dr);
  const declBdr = (c: Cand) => (c.self ? oif.bdr : c.n!.bdr);
  const best = (l: Cand[]) =>
    l.reduce<Cand | undefined>((m, c) => (!m || c.priority > m.priority || (c.priority === m.priority && ipNum(c.rid) > ipNum(m.rid)) ? c : m), undefined);
  const electBdr = () => {
    const noDr = el.filter((c) => declDr(c) !== c.ip);
    const bdrs = noDr.filter((c) => declBdr(c) === c.ip);
    oif.bdr = best(bdrs.length ? bdrs : noDr)?.ip ?? ZERO;
  };
  const electDr = () => {
    const drs = el.filter((c) => declDr(c) === c.ip);
    oif.dr = (drs.length ? best(drs) : el.find((c) => c.ip === oif.bdr))?.ip ?? ZERO;
  };
  const stateOf = (): IsmState => (oif.dr === oif.ip ? "DR" : oif.bdr === oif.ip ? "Backup" : "DROther");
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
    // ospf_dr_change: AdjOK? for every neighbour at 2-Way or above.
    for (const n of oif.nbrs) {
      if (NSM[n.state] < NSM["2-Way"]) continue;
      if (n.state === "2-Way" && shouldAdj(oif, n)) enterExStart(d, oif, n);
      else if (NSM[n.state] >= NSM.ExStart && !shouldAdj(oif, n)) setNbrState(d, oif, n, "2-Way");
    }
  }
}

// ---------------------------------------------------------------------------
// Hello.
function sendHello(d: D, oif: OspfIf): void {
  const nbrs = oif.nbrs.filter((n) => NSM[n.state] >= NSM.Init).map((n) => n.rid);
  const body = encodeHello({
    mask: prefixToMask(oif.prefix),
    helloInterval: oif.hello,
    options: areaOptions(d.cfg, oif.area),
    priority: oif.priority,
    deadInterval: oif.dead,
    dr: oif.dr,
    bdr: oif.bdr,
    neighbors: nbrs,
  });
  send(d, oif, "spf", T_HELLO, body);
  emit(d, oif, "OSPF_HELLO", `OSPF Hello out ${oif.name} (area ${oif.area}, rid ${d.rt.routerId})`);
}

function recvHello(d: D, oif: OspfIf, srcIp: string, srcMac: string, rid: string, body: number[]): void {
  const h = decodeHello(body);
  if (!h) return;
  if (h.helloInterval !== oif.hello || h.deadInterval !== oif.dead) return; // interval mismatch (ospf_packet.c:750-778)
  if (oif.type === "broadcast" && h.mask !== prefixToMask(oif.prefix)) return; // NetworkMask mismatch
  if ((h.options & OPT_E) !== areaOptions(d.cfg, oif.area)) return; // E-bit mismatch
  let n = oif.type === "point-to-point" ? oif.nbrs.find((x) => x.rid === rid) : oif.nbrs.find((x) => x.ip === srcIp);
  if (!n) {
    // New neighbour: priority -1 / DR+BDR 0.0.0.0 until its Hello is accepted (ospf_nbr_new).
    n = { rid, ip: srcIp, mac: srcMac, priority: -1, dr: ZERO, bdr: ZERO, options: h.options, state: "Down", deadDue: 0, progressMs: d.now, reqs: [], rxmt: {} };
    oif.nbrs.push(n);
    oif.nbrs.sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
  }
  n.rid = rid;
  n.ip = srcIp;
  n.mac = srcMac;
  // HelloReceived: (re)start the inactivity timer; Down → Init.
  n.deadDue = d.now + oif.dead * 1000;
  if (n.state === "Down") setNbrState(d, oif, n, "Init");
  if (h.neighbors.includes(d.rt.routerId)) {
    // 2-WayReceived (ospf_nsm.c nsm_twoway_received).
    if (n.state === "Init") {
      if (shouldAdj(oif, n)) enterExStart(d, oif, n);
      else setNbrState(d, oif, n, "2-Way");
    }
    n.options |= h.options;
  } else {
    // 1-WayReceived.
    if (NSM[n.state] >= NSM["2-Way"]) setNbrState(d, oif, n, "Init");
    n.priority = h.priority;
    n.dr = h.dr;
    n.bdr = h.bdr;
    return;
  }
  if (oif.type === "broadcast") {
    if (srcIp === h.dr && h.bdr === ZERO && oif.state === "Waiting") oif.pendBackupSeen = true;
    if (oif.state === "Waiting" && srcIp === h.bdr) oif.pendBackupSeen = true;
    if ((srcIp === h.dr) !== (srcIp === n.dr)) oif.pendNbrChange = true;
    if ((srcIp === h.bdr) !== (srcIp === n.bdr)) oif.pendNbrChange = true;
    if (n.priority >= 0 && n.priority !== h.priority) oif.pendNbrChange = true;
  }
  n.priority = h.priority;
  n.dr = h.dr;
  n.bdr = h.bdr;
}

// ---------------------------------------------------------------------------
// Database Description (RFC 10.6).
function processHeaders(d: D, oif: OspfIf, n: OspfNbr, headers: LsaHeader[]): void {
  const db = areaDb(d.rt, oif.area);
  for (const h of headers) {
    if (h.type !== LSA_ROUTER && h.type !== LSA_NETWORK) continue;
    const cur = db[lsaKey(h)];
    if (cur && compareLsa(h, lsaHeaderNow(cur, d.now)) <= 0) continue;
    if (n.reqs.some((r) => lsaKey(r) === lsaKey(h))) continue;
    n.reqs.push({ type: h.type, id: h.id, adv: h.adv, seq: h.seq, checksum: h.checksum, age: h.age });
  }
}

function recvDbd(d: D, oif: OspfIf, n: OspfNbr, body: number[]): void {
  const dd = decodeDbd(body);
  if (!dd) return;
  if (n.state === "Init") {
    // RFC 10.6: in Init, a DD packet implies 2-WayReceived.
    if (shouldAdj(oif, n)) enterExStart(d, oif, n);
    else setNbrState(d, oif, n, "2-Way");
  }
  const myRid = ipNum(d.rt.routerId);
  const nRid = ipNum(n.rid);
  switch (n.state) {
    case "ExStart": {
      if ((dd.flags & (DD_I | DD_M | DD_MS)) === (DD_I | DD_M | DD_MS) && dd.headers.length === 0 && nRid > myRid) {
        // Neighbour is master; we are slave (NegotiationDone).
        n.master = false;
        n.ddSeq = dd.seq;
        n.options = dd.options;
        setNbrState(d, oif, n, "Exchange");
        const c = nextChunk(d, oif, n);
        sendDbd(d, oif, n, c.more ? DD_M : 0, c.headers);
      } else if (!(dd.flags & DD_I) && !(dd.flags & DD_MS) && dd.seq === n.ddSeq && nRid < myRid) {
        // We are master (NegotiationDone); the reply may already carry headers.
        n.master = true;
        n.options = dd.options;
        setNbrState(d, oif, n, "Exchange");
        processHeaders(d, oif, n, dd.headers);
        masterNext(d, oif, n, dd.flags);
      }
      return;
    }
    case "Exchange": {
      if (n.master) {
        if (dd.seq !== n.ddSeq) return; // duplicate / stale from the slave: discard
        if (dd.flags & DD_I || dd.flags & DD_MS) return seqMismatch(d, oif, n);
        processHeaders(d, oif, n, dd.headers);
        masterNext(d, oif, n, dd.flags);
      } else {
        if (dd.seq === n.ddSeq && n.lastDbd) {
          send(d, oif, n, T_DBD, n.lastDbd); // duplicate from master: resend our last
          return;
        }
        if (dd.flags & DD_I || !(dd.flags & DD_MS) || dd.seq !== ((n.ddSeq ?? 0) + 1) >>> 0) return seqMismatch(d, oif, n);
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
      else if (n.master && dd.seq === ((n.ddSeq ?? 0) - 1) >>> 0) return; // duplicate: discard
      else if (!n.master || dd.seq !== n.ddSeq) seqMismatch(d, oif, n);
      return;
    }
    default:
      return; // Down / 2-Way: ignore
  }
}

/** Master side after the slave acknowledged our last DBD. */
function masterNext(d: D, oif: OspfIf, n: OspfNbr, slaveFlags: number): void {
  const slaveMore = !!(slaveFlags & DD_M);
  if (n.summary && !n.moreSent && !slaveMore) {
    exchangeDone(d, oif, n);
    return;
  }
  n.ddSeq = ((n.ddSeq ?? 0) + 1) >>> 0;
  const c = nextChunk(d, oif, n);
  sendDbd(d, oif, n, DD_MS | (c.more ? DD_M : 0), c.headers);
}

// ---------------------------------------------------------------------------
// LS Request / Update / Ack.
function recvLsr(d: D, oif: OspfIf, n: OspfNbr, body: number[]): void {
  if (NSM[n.state] < NSM.Exchange) return;
  const db = areaDb(d.rt, oif.area);
  const lsas: number[][] = [];
  for (const e of decodeLsr(body)) {
    const ent = db[lsaKey(e)];
    if (!ent) return seqMismatch(d, oif, n); // BadLSReq
    lsas.push(wire(ent, d.now));
  }
  if (lsas.length) send(d, oif, n, T_LSU, encodeLsu(lsas));
}

/** LSA bytes as transmitted: age + InfTransDelay (1 s), capped at MaxAge. */
function wire(e: LsaEntry, now: number): number[] {
  return withAge(e.lsa, Math.min(MAX_AGE, lsaAge(e, now) + 1));
}

function isSelfLsa(d: D, h: LsaHeader): boolean {
  return h.adv === d.rt.routerId || (h.type === LSA_NETWORK && d.rt.oifs.some((o) => o.ip === h.id));
}

function recvLsu(d: D, oif: OspfIf, n: OspfNbr, body: number[]): void {
  if (NSM[n.state] < NSM.Exchange) return;
  const db = areaDb(d.rt, oif.area);
  const acks: number[][] = [];
  for (const lsa of decodeLsu(body)) {
    if (!lsaChecksumOk(lsa)) continue;
    const h = parseLsaHeader(lsa);
    if (h.type !== LSA_ROUTER && h.type !== LSA_NETWORK) continue;
    const key = lsaKey(h);
    const cur = db[key];
    const reqIdx = n.reqs.findIndex((r) => lsaKey(r) === key);
    if (h.age >= MAX_AGE && !cur && !oif.nbrs.some((x) => x.state === "Exchange" || x.state === "Loading")) {
      acks.push(lsa.slice(0, 20));
      continue;
    }
    const cmp = cur ? compareLsa(h, lsaHeaderNow(cur, d.now)) : 1;
    if (cmp > 0) {
      if (reqIdx >= 0) n.reqs.splice(reqIdx, 1);
      if (isSelfLsa(d, h)) {
        // RFC 13.4: a newer instance of our own LSA (e.g. from before a restart).
        acks.push(lsa.slice(0, 20));
        const mine = cur?.self && h.age < MAX_AGE;
        if (mine) originate(d, oif.area, h.type, h.id, cur!.lsa.slice(20), h.seq + 1);
        else {
          db[key] = { lsa, rxMs: d.now, age0: h.age };
          flushSelf(d, oif.area, key);
        }
        continue;
      }
      for (const o of d.rt.oifs) for (const x of o.nbrs) delete x.rxmt[key];
      db[key] = { lsa: withAge(lsa, h.age), rxMs: d.now, age0: h.age };
      d.rt.spfDirty = true;
      flood(d, oif.area, key, oif, n);
      acks.push(lsa.slice(0, 20));
      if (h.age >= MAX_AGE) delete db[key];
    } else if (cmp === 0) {
      if (n.rxmt[key] !== undefined) delete n.rxmt[key]; // implied acknowledgment
      else acks.push(lsa.slice(0, 20));
    } else if (cur) {
      // Our copy is newer: send it back to the neighbour.
      send(d, oif, n, T_LSU, encodeLsu([wire(cur, d.now)]));
    }
  }
  if (acks.length) send(d, oif, oif.type === "point-to-point" ? "spf" : n, T_ACK, acks.flat());
  if (n.state === "Loading" && n.reqs.length === 0) setNbrState(d, oif, n, "Full");
  else if (n.state === "Loading") sendLsr(d, oif, n);
}

function recvAck(d: D, oif: OspfIf, n: OspfNbr, body: number[]): void {
  if (NSM[n.state] < NSM.Exchange) return;
  const db = areaDb(d.rt, oif.area);
  for (const h of decodeAck(body)) {
    const key = lsaKey(h);
    if (n.rxmt[key] === undefined) continue;
    const cur = db[key];
    if (!cur || compareLsa(h, lsaHeaderNow(cur, d.now)) === 0) delete n.rxmt[key];
  }
}

/** RFC 13.3 flooding procedure. */
function flood(d: D, area: string, key: string, from?: OspfIf, fromNbr?: OspfNbr): void {
  const e = areaDb(d.rt, area)[key];
  if (!e) return;
  const h = lsaHeaderNow(e, d.now);
  for (const oif of d.rt.oifs) {
    if (oif.area !== area || oif.passive || oif.state === "Loopback" || oif.state === "Down") continue;
    let added = false;
    for (const n of oif.nbrs) {
      if (NSM[n.state] < NSM.Exchange) continue;
      if (n.state !== "Full") {
        const ri = n.reqs.findIndex((r) => lsaKey(r) === key);
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
    if (oif === from && fromNbr && (fromNbr.ip === oif.dr || fromNbr.ip === oif.bdr)) continue;
    if (oif === from && oif.state === "Backup") continue;
    const to = oif.type === "point-to-point" || oif.state === "DR" || oif.state === "Backup" ? "spf" : "dr";
    send(d, oif, to, T_LSU, encodeLsu([wire(e, d.now)]));
  }
}

// ---------------------------------------------------------------------------
// LSA origination (RFC 12.4).
function routerLinks(d: D, area: string): RouterLink[] {
  const links: RouterLink[] = [];
  for (const oif of d.rt.oifs) {
    if (oif.area !== area || oif.state === "Down") continue;
    const net = networkAddress(oif.ip, oif.prefix);
    const mask = prefixToMask(oif.prefix);
    if (oif.type === "loopback") {
      links.push({ type: 3, linkId: oif.ip, linkData: "255.255.255.255", metric: 0 });
    } else if (oif.type === "point-to-point") {
      for (const n of oif.nbrs) if (n.state === "Full") links.push({ type: 1, linkId: n.rid, linkData: oif.ip, metric: oif.cost });
      links.push({ type: 3, linkId: net, linkData: mask, metric: oif.cost });
    } else {
      const drNbr = oif.nbrs.find((n) => n.ip === oif.dr);
      const transit =
        oif.state !== "Waiting" &&
        oif.dr !== ZERO &&
        ((oif.dr === oif.ip && oif.nbrs.some((n) => n.state === "Full")) || drNbr?.state === "Full");
      links.push(transit ? { type: 2, linkId: oif.dr, linkData: oif.ip, metric: oif.cost } : { type: 3, linkId: net, linkData: mask, metric: oif.cost });
    }
  }
  return links;
}

function install(d: D, area: string, key: string, lsa: number[], self: boolean): void {
  areaDb(d.rt, area)[key] = { lsa, rxMs: d.now, age0: parseLsaHeader(lsa).age, ...(self ? { self: true } : {}) };
  d.rt.spfDirty = true;
}

function originate(d: D, area: string, type: number, id: string, body: number[], minSeq?: number, force = false): void {
  const key = lsaKey({ type, id, adv: d.rt.routerId });
  const cur = areaDb(d.rt, area)[key];
  const curH = cur && lsaHeaderNow(cur, d.now);
  if (!force && minSeq === undefined && cur && curH!.age < MAX_AGE && sameBytes(cur.lsa.slice(20), body)) return;
  let seq = curH ? curH.seq + 1 : INITIAL_SEQ;
  if (minSeq !== undefined && minSeq > seq) seq = minSeq;
  const lsa = buildLsa({ age: 0, options: areaOptions(d.cfg, area), type, id, adv: d.rt.routerId, seq }, body);
  install(d, area, key, lsa, true);
  flood(d, area, key);
}

function flushSelf(d: D, area: string, key: string): void {
  const db = areaDb(d.rt, area);
  const e = db[key];
  if (!e) return;
  e.age0 = MAX_AGE;
  e.rxMs = d.now;
  e.lsa = withAge(e.lsa, MAX_AGE);
  flood(d, area, key);
  delete db[key];
  d.rt.spfDirty = true;
}

const sameBytes = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function originateAll(d: D): void {
  const { rt } = d;
  const areas = new Set([...rt.oifs.map((o) => o.area), ...Object.keys(rt.lsdb)]);
  for (const area of areas) {
    const active = rt.oifs.some((o) => o.area === area && o.state !== "Down");
    const rkey = lsaKey({ type: LSA_ROUTER, id: rt.routerId, adv: rt.routerId });
    if (active) originate(d, area, LSA_ROUTER, rt.routerId, encodeRouterBody(0, routerLinks(d, area)));
    else if (areaDb(rt, area)[rkey]) flushSelf(d, area, rkey);
    // Network-LSA: originated by the DR while it has at least one Full neighbour.
    const want = new Set<string>();
    for (const oif of rt.oifs) {
      if (oif.area !== area || oif.type !== "broadcast" || oif.state !== "DR") continue;
      const full = oif.nbrs.filter((n) => n.state === "Full").map((n) => n.rid);
      if (!full.length) continue;
      want.add(oif.ip);
      originate(d, area, LSA_NETWORK, oif.ip, encodeNetworkBody(prefixToMask(oif.prefix), [rt.routerId, ...full]));
    }
    for (const [key, e] of Object.entries(areaDb(rt, area))) {
      const h = parseLsaHeader(e.lsa);
      if (e.self && h.type === LSA_NETWORK && !want.has(h.id)) flushSelf(d, area, key);
    }
  }
}

// ---------------------------------------------------------------------------
// SPF (RFC 16.1) → routes.
interface Vertex {
  vid: string;
  kind: "R" | "N";
  id: string;
  dist: number;
  paths: OspfRoutePath[];
  lsa: number[];
}

function spfArea(d: D, area: string): OspfRouteView[] {
  const db = areaDb(d.rt, area);
  const live = Object.values(db).filter((e) => lsaAge(e, d.now) < MAX_AGE);
  const routerLsa = new Map<string, number[]>();
  const networkLsa = new Map<string, number[]>();
  for (const e of live) {
    const h = parseLsaHeader(e.lsa);
    if (h.type === LSA_ROUTER && h.id === h.adv) routerLsa.set(h.id, e.lsa);
    if (h.type === LSA_NETWORK) networkLsa.set(h.id, e.lsa);
  }
  const me = d.rt.routerId;
  const rootLsa = routerLsa.get(me);
  if (!rootLsa) return [];
  const rlinks = new Map<string, RouterLink[]>();
  const linksOf = (rid: string) => {
    if (!rlinks.has(rid)) rlinks.set(rid, decodeRouterBody(routerLsa.get(rid)!).links);
    return rlinks.get(rid)!;
  };
  const tree = new Map<string, Vertex>();
  const cand = new Map<string, Vertex>([[`R:${me}`, { vid: `R:${me}`, kind: "R", id: me, dist: 0, paths: [], lsa: rootLsa }]]);
  const ifByIp = (ip: string) => d.rt.oifs.find((o) => o.ip === ip);
  const addPaths = (into: OspfRoutePath[], add: OspfRoutePath[]) => {
    for (const p of add) if (!into.some((q) => q.nh === p.nh && q.ifId === p.ifId)) into.push(p);
  };

  while (cand.size) {
    // Lowest cost; on a tie prefer network vertices (RFC 16.1 step 3).
    let v: Vertex | undefined;
    for (const c of cand.values()) if (!v || c.dist < v.dist || (c.dist === v.dist && c.kind === "N" && v.kind === "R")) v = c;
    cand.delete(v!.vid);
    tree.set(v!.vid, v!);
    const V = v!;
    const relax = (kind: "R" | "N", id: string, lsa: number[], cost: number, paths: OspfRoutePath[]) => {
      const vid = `${kind}:${id}`;
      if (tree.has(vid) || !paths.length) return;
      const c = cand.get(vid);
      if (!c || cost < c.dist) cand.set(vid, { vid, kind, id, dist: cost, paths: [...paths], lsa });
      else if (cost === c.dist) addPaths(c.paths, paths);
    };
    if (V.kind === "R") {
      for (const l of linksOf(V.id)) {
        if (l.type === 1) {
          const w = routerLsa.get(l.linkId);
          if (!w || !linksOf(l.linkId).some((x) => x.type === 1 && x.linkId === V.id)) continue;
          let paths = V.paths;
          if (V.id === me) {
            const oif = ifByIp(l.linkData);
            const n = oif?.nbrs.find((x) => x.rid === l.linkId && x.state === "Full");
            paths = oif && n ? [{ nh: n.ip, ifId: oif.ifId, ifName: oif.name }] : [];
          }
          relax("R", l.linkId, w, V.dist + l.metric, paths);
        } else if (l.type === 2) {
          const nl = networkLsa.get(l.linkId);
          if (!nl || !decodeNetworkBody(nl).routers.includes(V.id)) continue;
          let paths = V.paths;
          if (V.id === me) {
            const oif = ifByIp(l.linkData);
            paths = oif ? [{ nh: null, ifId: oif.ifId, ifName: oif.name }] : [];
          }
          relax("N", l.linkId, nl, V.dist + l.metric, paths);
        }
      }
    } else {
      for (const r of decodeNetworkBody(V.lsa).routers) {
        const w = routerLsa.get(r);
        if (!w) continue;
        const back = linksOf(r).find((x) => x.type === 2 && x.linkId === V.id);
        if (!back) continue;
        // Directly attached network → next hop is the router's address on it.
        const direct = V.paths.length > 0 && V.paths.every((p) => p.nh === null);
        const paths = direct ? V.paths.map((p) => ({ ...p, nh: back.linkData })) : V.paths;
        relax("R", r, w, V.dist, paths);
      }
    }
  }

  // Stage 2: transit networks + stub links.
  const routes = new Map<string, OspfRouteView>();
  const offer = (dest: string, prefix: number, cost: number, paths: OspfRoutePath[]) => {
    if (!paths.length) return;
    const k = `${dest}/${prefix}`;
    const r = routes.get(k);
    if (!r || cost < r.cost) routes.set(k, { dest, prefix, cost, area, paths: [...paths] });
    else if (cost === r.cost) addPaths(r.paths, paths);
  };
  const maskLen = (mask: string) => (ipNum(mask).toString(2).match(/1/g) ?? []).length;
  for (const V of tree.values()) {
    if (V.kind === "N") {
      const nb = decodeNetworkBody(V.lsa);
      const len = maskLen(nb.mask);
      offer(networkAddress(V.id, len), len, V.dist, V.paths);
      continue;
    }
    for (const l of linksOf(V.id)) {
      if (l.type !== 3) continue;
      const len = maskLen(l.linkData);
      let paths = V.paths;
      if (V.id === me) {
        const oif = d.rt.oifs.find((o) => (len === 32 ? o.ip === l.linkId : networkAddress(o.ip, o.prefix) === l.linkId && o.prefix === len));
        paths = oif ? [{ nh: null, ifId: oif.ifId, ifName: oif.name }] : [];
      }
      offer(l.linkId, len, V.dist + l.metric, paths);
    }
  }
  return [...routes.values()];
}

function runSpf(d: D): void {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const all = new Map<string, OspfRouteView>();
  const areas = [...new Set(d.rt.oifs.map((o) => o.area))].sort((a, b) => ipNum(a) - ipNum(b));
  for (const area of areas) {
    for (const r of spfArea(d, area)) {
      const k = `${r.dest}/${r.prefix}`;
      const cur = all.get(k);
      if (!cur || r.cost < cur.cost) all.set(k, r);
    }
    d.rt.spf.perArea[area] = (d.rt.spf.perArea[area] ?? 0) + 1;
  }
  for (const r of all.values()) r.paths.sort((a, b) => (a.nh === null ? -1 : b.nh === null ? 1 : ipNum(a.nh) - ipNum(b.nh)));
  const routes = [...all.values()].sort((a, b) => ipNum(a.dest) - ipNum(b.dest) || a.prefix - b.prefix);
  d.rt.spf.runs++;
  d.rt.spf.lastMs = d.now;
  d.rt.spf.durUs = Math.max(1, Math.round(((typeof performance !== "undefined" ? performance.now() : 0) - t0) * 1000));
  d.rt.routes = routes;
  d.rt.spfDirty = false;
  installRoutes(d, routes);
}

/** Replace this daemon's routes in the RIB (connected/static/BGP untouched). */
function installRoutes(d: D, routes: OspfRouteView[]): void {
  const table = d.device.routingTable;
  const prev = table.filter((r) => r.type === "ospf");
  const next: Route[] = routes.flatMap((r) =>
    r.paths.map((p) => ({ destination: r.dest, prefix: r.prefix, nextHop: p.nh, interfaceId: p.ifId, type: "ospf" as const, metric: r.cost, distance: 110 })),
  );
  const strip = (l: Route[]) => JSON.stringify(l.map(({ installedAtMs: _t, ...rest }) => rest));
  if (strip(prev) === strip(next)) return;
  carryInstallTime(prev, next, d.now);
  const added = next.filter((r) => r.nextHop && !prev.some((p) => p.destination === r.destination && p.prefix === r.prefix && p.nextHop === r.nextHop));
  for (const r of added) emit(d, undefined, "OSPF_ROUTE", `OSPF route ${r.destination}/${r.prefix} via ${r.nextHop} (cost ${r.metric})`);
  d.device.routingTable = [...table.filter((r) => r.type !== "ospf"), ...next];
}

// ---------------------------------------------------------------------------
// Driving: per-device processing with deferred ISM events + origination + SPF.
function withDevice(ctx: SimContext, device: Device, now: number, fn: (d: D) => void): boolean {
  const cfg = ospfConfig(device);
  let rt = ospfRuntime(device);
  if (!cfg && !rt) return false;
  const features = (device.config.features ??= {});
  if (!rt) {
    rt = newRt(ospfRouterId(device, cfg!), now);
    features[RT_KEY] = rt;
  }
  const d: D = { ctx, device, cfg: cfg ?? { networks: [], areas: [] }, rt, now };
  if (!cfg) {
    teardown(d);
    delete features[RT_KEY];
    flush();
    return true;
  }
  if (rt.sig !== computeSig(device)) reconcile(d);
  fn(d);
  postProcess(d);
  flush();
  return true;
}

/** Run deferred ISM events (OSPF_ISM_EVENT_SCHEDULE): BackupSeen / NeighborChange → election. */
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
  if (d.rt.spfDirty) runSpf(d);
}

function dueTimes(rt: OspfRt): number[] {
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
  for (const db of Object.values(rt.lsdb)) {
    for (const e of Object.values(db)) t.push(e.rxMs + ((e.self ? LS_REFRESH_TIME : MAX_AGE) - e.age0) * 1000);
  }
  return t;
}

function tick(ctx: SimContext, device: Device, now: number): boolean {
  const before = JSON.stringify([device.config.features?.[RT_KEY] ?? null, device.routingTable]);
  withDevice(ctx, device, now, (d) => {
    for (const oif of [...d.rt.oifs]) {
      if (oif.waitDue !== undefined && oif.waitDue <= now && oif.state === "Waiting") election(d, oif); // WaitTimer
      for (const n of [...oif.nbrs]) {
        if (n.deadDue <= now) {
          nbrDown(d, oif, n, "inactivity timer expired");
          continue;
        }
        if (n.bfdReg) {
          const s = bfd().state(device, n.ip);
          const last = n.bfdLast;
          n.bfdLast = s;
          if (last === "up" && s === "down") {
            nbrDown(d, oif, n, "BFD session down");
            continue;
          }
        }
        if (n.ddRxmtDue !== undefined && n.ddRxmtDue <= now && n.master && n.lastDbd && (n.state === "ExStart" || n.state === "Exchange")) {
          send(d, oif, n, T_DBD, n.lastDbd);
          n.ddRxmtDue = now + oif.rxmt * 1000;
        }
        if (n.reqDue !== undefined && n.reqDue <= now && n.reqs.length && (n.state === "Exchange" || n.state === "Loading")) sendLsr(d, oif, n);
        const dueKeys = Object.entries(n.rxmt).filter(([, t]) => t <= now).map(([k]) => k);
        if (dueKeys.length) {
          const db = areaDb(d.rt, oif.area);
          const lsas = dueKeys.filter((k) => db[k]).map((k) => wire(db[k], now));
          for (const k of dueKeys) {
            if (db[k]) n.rxmt[k] = now + oif.rxmt * 1000;
            else delete n.rxmt[k];
          }
          if (lsas.length) {
            oif.lsRxmt += lsas.length;
            send(d, oif, n, T_LSU, encodeLsu(lsas));
          }
        }
      }
      if (oif.helloDue !== undefined && oif.helloDue <= now) {
        runIsmEvents(d); // a Hello carries the DR/BDR of any election just triggered
        sendHello(d, oif);
        oif.helloDue = now + oif.hello * 1000;
      }
    }
    // LSA aging: refresh our own at 30 min, drop others at MaxAge.
    for (const [area, db] of Object.entries(d.rt.lsdb)) {
      for (const [key, e] of Object.entries(db)) {
        const age = lsaAge(e, now);
        if (e.self && age >= LS_REFRESH_TIME) {
          const h = parseLsaHeader(e.lsa);
          originate(d, area, h.type, h.id, e.lsa.slice(20), undefined, true);
        } else if (!e.self && age >= MAX_AGE) {
          delete db[key];
          d.rt.spfDirty = true;
        }
      }
    }
  });
  return JSON.stringify([device.config.features?.[RT_KEY] ?? null, device.routingTable]) !== before;
}

function nextDue(device: Device, now: number): number | undefined {
  if (device.state === "down" || !ospfCapable(device)) return undefined;
  const rt = ospfRuntime(device);
  if (!rt && !ospfConfig(device)) return undefined;
  if ((rt?.sig ?? "") !== computeSig(device)) return now;
  if (!rt) return undefined;
  for (const oif of rt.oifs) for (const n of oif.nbrs) if (n.bfdReg && bfd().state(device, n.ip) !== n.bfdLast) return now;
  const t = dueTimes(rt);
  return t.length ? Math.min(...t) : undefined;
}

function receiveL3(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const ip = frame.ipv4;
  if (!ip || ip.protocol !== "OSPF" || !ospfCapable(device)) return false;
  const rt = ospfRuntime(device);
  if (!rt || !ospfConfig(device)) return false;
  const payload = ipPayload(frame);
  const pkt = payload && decodePacket(payload);
  if (!pkt) return true; // bad checksum/version: dropped by ospfd
  const now = ctx.wallNow();
  withDevice(ctx, device, now, (d) => {
    const oif = d.rt.oifs.find((o) => o.ifId === ingress.id);
    if (!oif || oif.passive || oif.state === "Down" || oif.state === "Loopback") return;
    if (ip.dstIp === OSPF_ALL_DR ? oif.state !== "DR" && oif.state !== "Backup" : ip.dstIp !== OSPF_ALL_SPF && ip.dstIp !== oif.ip) return;
    if (pkt.hdr.routerId === d.rt.routerId || pkt.hdr.areaId !== oif.area) return;
    if (oif.type !== "point-to-point" && !sameSubnet(ip.srcIp, oif.ip, oif.prefix)) return;
    if (pkt.hdr.type === T_HELLO) return recvHello(d, oif, ip.srcIp, frame.ethernet.srcMac, pkt.hdr.routerId, pkt.body);
    const n = oif.type === "point-to-point" ? oif.nbrs.find((x) => x.rid === pkt.hdr.routerId) : oif.nbrs.find((x) => x.ip === ip.srcIp);
    if (!n) return;
    if (pkt.hdr.type === T_DBD) recvDbd(d, oif, n, pkt.body);
    else if (pkt.hdr.type === T_LSR) recvLsr(d, oif, n, pkt.body);
    else if (pkt.hdr.type === T_LSU) recvLsu(d, oif, n, pkt.body);
    else if (pkt.hdr.type === T_ACK) recvAck(d, oif, n, pkt.body);
  });
  return true;
}

function describe(frame: Frame, verbose: boolean): string | undefined {
  if (frame.ipv4?.protocol !== "OSPF") return undefined;
  const p = ipPayload(frame);
  return p ? describeOspf(p, verbose) : undefined;
}

registerDaemon({ id: "ospf", nextDue, tick, receiveL3, describe });

// ---------------------------------------------------------------------------
// `ospf converge` support: drive every OSPF speaker to convergence now.
export interface OspfConvergeSummary {
  routers: number;
  adjacencies: number;
  routesInstalled: number;
}

/**
 * Converge the whole domain at the current instant: bring interfaces up, send
 * immediate Hello rounds and expire Wait timers instead of waiting 10 s/40 s.
 * Everything else (election, DBD/LSR/LSU exchange, flooding, SPF) is the normal
 * protocol above; timers then continue from now.
 */
export function convergeOspf(ctx: SimContext): OspfConvergeSummary {
  const now = ctx.wallNow();
  const devs = Object.values(ctx.state.devices).filter((dv) => dv.state !== "down" && ospfCapable(dv) && (ospfConfig(dv) || ospfRuntime(dv)));
  for (const dv of devs) withDevice(ctx, dv, now, () => {});
  for (let round = 0; round < 6; round++) {
    for (const dv of devs) {
      withDevice(ctx, dv, now, (d) => {
        for (const oif of d.rt.oifs) {
          if (round === 2 && oif.state === "Waiting") election(d, oif);
          if (oif.helloDue === undefined) continue;
          sendHello(d, oif);
          oif.helloDue = now + oif.hello * 1000;
        }
      });
    }
  }
  let adjacencies = 0;
  let routesInstalled = 0;
  const live = devs.filter((dv) => ospfRuntime(dv));
  for (const dv of live) {
    for (const oif of ospfRuntime(dv)!.oifs) adjacencies += oif.nbrs.filter((n) => n.state === "Full").length;
    routesInstalled += dv.routingTable.filter((r) => r.type === "ospf" && r.nextHop).length;
  }
  return { routers: live.length, adjacencies, routesInstalled };
}
