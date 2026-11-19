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
 *   Inter-area         RFC 16.2 / ospf_ia.c process_summary_lsa: type-3/4 from
 *                      the backbone only on an ABR with a Full backbone
 *                      neighbour (Cisco ABR, ospf_ia.c:596-630), all areas
 *                      otherwise; summaries inside an active range ignored.
 *   ABR                ospf_abr.c: ABR = >1 configured area + active backbone
 *                      (ospf_check_abr_status :454, abr-type cisco); type-3 for
 *                      intra routes into other areas, backbone inter-area routes
 *                      into non-backbone areas (ospf_abr_announce_network :840),
 *                      `area X range` aggregates with the max component cost
 *                      (ospf_abr_update_aggregate :530), type-4 for ASBRs into
 *                      regular areas, not from an NSSA (:1140), default type-3
 *                      (default-cost, 1) into stub and NSSA areas (:1530);
 *                      `no-summary` suppresses all but the default.
 *   NSSA               RFC 3101: N/P option bit; the ASBR floods its externals
 *                      as type-7 with P-bit and an NSSA forwarding address when
 *                      not an ABR (ospf_lsa.c ospf_install_flood_nssa,
 *                      ospf_get_nssa_ip :1674); the elected translator (highest
 *                      router-id ABR, ospf_abr_nssa_am_elected :322) re-originates
 *                      them as type-5 (ospf_lsa_translated_nssa_new :2002).
 *   ASBR / externals   `redistribute connected|static|bgp` and
 *                      `default-information originate [always]` → type-5
 *                      (metric 20 / E2 default, default route 10 or 1 with
 *                      always: ospf_lsa.c metric_value :1712); connected networks
 *                      OSPF already covers are skipped (ospf_zebra.c:999);
 *                      forwarding address = next hop when on an OSPF subnet
 *                      (:1627). Routes per RFC 16.4 / ospf_ase.c: E1 = path +
 *                      metric, E2 compared by type-2 metric first; zebra metric
 *                      is the type-2 cost for E2 (O>* … [110/20]).
 *   VRF                `router ospf vrf NAME`: one instance per VRF (config in
 *                      features["ospf:NAME"], state in features["ospfd:NAME"]),
 *                      only that VRF's interfaces, routes tagged Route.vrf.
 *   BFD                `ip ospf bfd`: session registered when a neighbour
 *                      reaches 2-Way (ospf_bfd.c); BFD up→down kills the
 *                      neighbour immediately (NSM InactivityTimer).
 *
 * Simplifications (documented): acks are sent directly (no 1 s delayed ack),
 * MinLSInterval/MinLSArrival and SPF hold timers are not enforced (FRR's
 * initial SPF delay is 0), a flushed MaxAge LSA is removed right after it is
 * flooded, no virtual links/transit areas, no NSSA ranges or type-7 defaults,
 * range discard routes are listed in `show ip ospf route` but not installed in
 * the RIB, no authentication, MTU is not checked in DBDs.
 */
import { registerDaemon } from "../control/daemon";
import { transmitIpv4, multicastMac, ipPayload } from "../control/packet";
import { bfd } from "../control/bfd-api";
import { logEvent } from "../control/syslog";
import { Device, findInterface } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { Route, carryInstallTime } from "../models/route";
import { cidrContains, ipToInt, networkAddress, prefixToMask, sameSubnet } from "../models/ip";
import { DEFAULT_VRF, vrfOf } from "../models/vrf";
import { SimContext } from "../engine/context";
import {
  OspfConfig,
  OspfIfSpec,
  ospfCapable,
  ospfConfig,
  ospfInterfaces,
  ospfRouterId,
  ospfConfiguredVrfs,
  areaType,
  areaCfg,
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
  LSA_SUMMARY,
  LSA_ASBR_SUMMARY,
  LSA_EXTERNAL,
  LSA_NSSA,
  LS_INFINITY,
  OPT_NP,
  RTR_B,
  RTR_E,
  RTR_NT,
  encodeSummaryBody,
  decodeSummaryBody,
  encodeExternalBody,
  decodeExternalBody,
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
import { featureEnabled } from "./cpu-features";

/** ospfd/zebra run in the bgp container: no config while it is disabled (adjacencies torn down, routes withdrawn). */
const liveOspfConfig = (d: Device, vrf?: string) => (featureEnabled(d, "bgp") ? ospfConfig(d, vrf) : undefined);

export const RT_KEY = "ospfd";
/** Runtime key of an instance: "ospfd" (VRF default) or "ospfd:NAME". */
export const rtKey = (vrf: string = DEFAULT_VRF) => (vrf === DEFAULT_VRF ? RT_KEY : `${RT_KEY}:${vrf}`);
/** Pseudo-area holding the AS-scope LSDB (type-5). */
export const AS_SCOPE = "AS";
const BACKBONE = "0.0.0.0";
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
  /** Type-5 translated from a type-7 (OSPF_LSA_LOCAL_XLT). */
  xlt?: boolean;
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
  /** OSPF_PATH_INTRA_AREA / OSPF_PATH_INTER_AREA / range discard entry. */
  kind: "intra" | "inter" | "discard";
}

/** Router routing table entry (ABRs/ASBRs only, like FRR's new_rtrs). */
export interface OspfRtrRoute {
  rid: string;
  cost: number;
  area: string;
  ia: boolean;
  flags: number;
  paths: OspfRoutePath[];
}

/** External routing table entry (type-5 / type-7). */
export interface OspfExtRoute {
  dest: string;
  prefix: number;
  e2: boolean;
  /** Cost to the ASBR / forwarding address (E2), or total cost (E1). */
  cost: number;
  type2: number;
  tag: number;
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
  rtrs?: OspfRtrRoute[];
  ext?: OspfExtRoute[];
  /** OSPF_FLAG_ABR / OSPF_FLAG_ASBR. */
  abr?: boolean;
  asbr?: boolean;
  /** NSSATranslatorState per NSSA area. */
  xlt?: Record<string, boolean>;
}

export function ospfRuntime(device: Device, vrf: string = DEFAULT_VRF): OspfRt | undefined {
  return device.config.features?.[rtKey(vrf)] as OspfRt | undefined;
}

/** VRFs with a running or configured instance. */
function instanceVrfs(device: Device): string[] {
  const out = new Set(ospfConfiguredVrfs(device));
  for (const k of Object.keys(device.config.features ?? {})) {
    if (k === RT_KEY) out.add(DEFAULT_VRF);
    else if (k.startsWith(`${RT_KEY}:`)) out.add(k.slice(RT_KEY.length + 1));
  }
  return [...out];
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
  vrf: string;
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

/** Options of an area (ospf_area_type_set): regular E, stub none, NSSA N/P; AS scope E. */
const areaOptions = (cfg: OspfConfig, area: string) => {
  if (area === AS_SCOPE) return OPT_E;
  const t = areaType(cfg, area);
  return t === "nssa" ? OPT_NP : t === "stub" ? 0 : OPT_E;
};
const isRegular = (cfg: OspfConfig, area: string) => !areaType(cfg, area);
const ipNum = (ip: string) => ipToInt(ip);
const lsaTypeOfKey = (key: string) => Number(key.slice(0, key.indexOf("/")));
/** LSDB (area or AS) an LSA type lives in. */
const scopeOf = (type: number, area: string) => (type === LSA_EXTERNAL ? AS_SCOPE : area);
/** May an LSA of this type be exchanged on an interface of `area` (RFC 3101: no type-5 in stub/NSSA, type-7 only in NSSA)? */
function typeAllowed(cfg: OspfConfig, area: string, t: number): boolean {
  if (t === LSA_ROUTER || t === LSA_NETWORK || t === LSA_SUMMARY || t === LSA_ASBR_SUMMARY) return true;
  if (t === LSA_EXTERNAL) return isRegular(cfg, area);
  if (t === LSA_NSSA) return areaType(cfg, area) === "nssa";
  return false;
}
const maskLen = (mask: string) => (ipNum(mask).toString(2).match(/1/g) ?? []).length;

function emit(d: D, oif: OspfIf | undefined, type: "OSPF_HELLO" | "OSPF_NEIGHBOR" | "OSPF_ROUTE", message: string): void {
  d.ctx.emit({ type, deviceId: d.device.id, deviceName: d.device.name, interfaceId: oif?.ifId, interfaceName: oif?.name, message: `${d.device.name}: ${message}`, osiLayers: [3] });
}

// ---------------------------------------------------------------------------
// Signature of everything that affects the running instance: config + the
// interfaces' addresses/state. A change makes the daemon due immediately
// (local interface down → neighbours on it go Down at once).
function computeSig(device: Device, vrf: string): string {
  const cfg = liveOspfConfig(device, vrf);
  if (!cfg) return "";
  const vrfState = device.config.features?.vrf ?? null;
  // Redistributed RIB routes: a change re-runs origination (zebra redistribute add/delete).
  const rib = cfg.redistribute?.length || cfg.defaultInfo
    ? device.routingTable.filter((r) => r.type !== "ospf" && (r.vrf ?? DEFAULT_VRF) === vrf).map((r) => [r.type, r.destination, r.prefix, r.nextHop])
    : null;
  return JSON.stringify([cfg, vrfState, rib, device.interfaces.map((i) => [i.id, i.name, i.ipv4, i.adminState, i.operState, i.speed])]);
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
  const want = ospfInterfaces(device, cfg, d.vrf).filter((s) => s.up);
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
  rt.sig = computeSig(device, d.vrf);
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
  // ospf_nsm.c:626-636 AdjChg: with log-adjacency-changes only Full or a downward change, "detail" every change.
  // (Down is logged by nbrDown, which knows the event.) Off unless configured (SONiC's effective default, see
  // OspfConfig.logAdjacencyChanges); "(%s)" is ospf_get_name() = the VRF name.
  const lac = d.cfg.logAdjacencyChanges;
  if (state !== "Down" && lac && (lac === "detail" || state === "Full" || NSM[state] < NSM[old]))
    logEvent(d.device, d.now, "NOTICE", "bgp#ospfd", `AdjChg: Nbr ${n.rid}, NbrIP ${n.ip} (${d.vrf}) on ${oif.name}:${oif.ip}: ${old} -> ${state} (${
      state === "Full" ? (old === "Loading" ? "LoadingDone" : "ExchangeDone")
      : state === "Init" ? (NSM[old] > NSM.Init ? "1-WayReceived" : "HelloReceived")
      : state === "2-Way" ? (old === "Init" ? "2-WayReceived" : "AdjOK?")
      : state === "ExStart" ? (old === "Init" ? "2-WayReceived" : old === "2-Way" ? "AdjOK?" : "SeqNumberMismatch")
      : state === "Exchange" ? "NegotiationDone" : "ExchangeDone"})`);
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
  const was = n.state;
  setNbrState(d, oif, n, "Down");
  // ospf_nsm.c:631 — interface down = KillNbr (ospf_interface.c:355); dead timer and BFD down = InactivityTimer (ospf_bfd.c:60).
  if (was !== "Down" && d.cfg.logAdjacencyChanges)
    logEvent(d.device, d.now, "NOTICE", "bgp#ospfd", `AdjChg: Nbr ${n.rid}, NbrIP ${n.ip} (${d.vrf}) on ${oif.name}:${oif.ip}: ${was} -> Down (${why === "interface down" ? "KillNbr" : "InactivityTimer"})`);
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
/** The LSDB entry for a key as seen from an interface's area (type-5 from the AS scope). */
function entryFor(d: D, area: string, key: string): LsaEntry | undefined {
  return areaDb(d.rt, scopeOf(lsaTypeOfKey(key), area))[key];
}

function nextChunk(d: D, oif: OspfIf, n: OspfNbr): { headers: number[][]; more: boolean } {
  if (!n.summary) {
    const db = areaDb(d.rt, oif.area);
    const as = isRegular(d.cfg, oif.area) ? areaDb(d.rt, AS_SCOPE) : {};
    n.summary = [...Object.keys(db).filter((k) => lsaAge(db[k], d.now) < MAX_AGE), ...Object.keys(as).filter((k) => lsaAge(as[k], d.now) < MAX_AGE)].sort();
  }
  const keys = n.summary.splice(0, DBD_CHUNK).filter((k) => entryFor(d, oif.area, k));
  return {
    headers: keys.map((k) => {
      const e = entryFor(d, oif.area, k)!;
      return withAge(e.lsa, lsaAge(e, d.now)).slice(0, 20);
    }),
    more: n.summary.length > 0,
  };
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
  if ((h.options & (OPT_E | OPT_NP)) !== areaOptions(d.cfg, oif.area)) return; // E-bit / N-bit mismatch (ospf_packet.c ospf_hello)
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
  for (const h of headers) {
    if (!typeAllowed(d.cfg, oif.area, h.type)) continue;
    const cur = entryFor(d, oif.area, lsaKey(h));
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
  const lsas: number[][] = [];
  for (const e of decodeLsr(body)) {
    const ent = typeAllowed(d.cfg, oif.area, e.type) ? entryFor(d, oif.area, lsaKey(e)) : undefined;
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
  const acks: number[][] = [];
  for (const lsa of decodeLsu(body)) {
    if (!lsaChecksumOk(lsa)) continue;
    const h = parseLsaHeader(lsa);
    if (!typeAllowed(d.cfg, oif.area, h.type)) continue;
    const scope = scopeOf(h.type, oif.area);
    const db = areaDb(d.rt, scope);
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
        if (mine) originate(d, scope, h.type, h.id, cur!.lsa.slice(20), h.seq + 1);
        else {
          db[key] = { lsa, rxMs: d.now, age0: h.age };
          flushSelf(d, scope, key);
        }
        continue;
      }
      for (const o of d.rt.oifs) for (const x of o.nbrs) delete x.rxmt[key];
      db[key] = { lsa: withAge(lsa, h.age), rxMs: d.now, age0: h.age };
      d.rt.spfDirty = true;
      flood(d, scope, key, oif, n);
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
  for (const h of decodeAck(body)) {
    const key = lsaKey(h);
    if (n.rxmt[key] === undefined) continue;
    const cur = entryFor(d, oif.area, key);
    if (!cur || compareLsa(h, lsaHeaderNow(cur, d.now)) === 0) delete n.rxmt[key];
  }
}

/** RFC 13.3 flooding procedure; AS-scope LSAs go to every regular (non-stub, non-NSSA) area. */
function flood(d: D, area: string, key: string, from?: OspfIf, fromNbr?: OspfNbr): void {
  const e = areaDb(d.rt, area)[key];
  if (!e) return;
  const h = lsaHeaderNow(e, d.now);
  for (const oif of d.rt.oifs) {
    if ((area === AS_SCOPE ? !isRegular(d.cfg, oif.area) : oif.area !== area) || oif.passive || oif.state === "Loopback" || oif.state === "Down") continue;
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

function install(d: D, area: string, key: string, lsa: number[], self: boolean, xlt?: boolean): void {
  areaDb(d.rt, area)[key] = { lsa, rxMs: d.now, age0: parseLsaHeader(lsa).age, ...(self ? { self: true } : {}), ...(xlt ? { xlt: true } : {}) };
  // Our own summary/external LSAs never feed our own SPF (process_summary_lsa / ospf_ase skip self).
  const t = parseLsaHeader(lsa).type;
  if (!self || t === LSA_ROUTER || t === LSA_NETWORK) d.rt.spfDirty = true;
}

function originate(d: D, area: string, type: number, id: string, body: number[], minSeq?: number, force = false, opts: { options?: number; xlt?: boolean } = {}): void {
  const key = lsaKey({ type, id, adv: d.rt.routerId });
  const cur = areaDb(d.rt, area)[key];
  const curH = cur && lsaHeaderNow(cur, d.now);
  // A type-7 keeps its P-bit choice on refresh; everything else carries the area's options.
  const options = opts.options ?? (type === LSA_NSSA && cur ? curH!.options : areaOptions(d.cfg, area));
  const xlt = opts.xlt ?? cur?.xlt;
  if (!force && minSeq === undefined && cur && curH!.age < MAX_AGE && curH!.options === options && !!cur.xlt === !!xlt && sameBytes(cur.lsa.slice(20), body)) return;
  let seq = curH ? curH.seq + 1 : INITIAL_SEQ;
  if (minSeq !== undefined && minSeq > seq) seq = minSeq;
  const lsa = buildLsa({ age: 0, options, type, id, adv: d.rt.routerId, seq }, body);
  install(d, area, key, lsa, true, xlt);
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

/** Router-LSA flags (ospf_lsa.c router_lsa_flags :381): B on an ABR, E on an ASBR except in stub areas. */
function routerFlags(d: D, area: string): number {
  let f = 0;
  if (d.rt.abr) f |= RTR_B;
  if (d.rt.asbr && areaType(d.cfg, area) !== "stub") f |= RTR_E;
  return f;
}

function originateAll(d: D): void {
  const { rt } = d;
  const areas = new Set([...rt.oifs.map((o) => o.area), ...Object.keys(rt.lsdb).filter((a) => a !== AS_SCOPE)]);
  for (const area of areas) {
    const active = rt.oifs.some((o) => o.area === area && o.state !== "Down");
    const rkey = lsaKey({ type: LSA_ROUTER, id: rt.routerId, adv: rt.routerId });
    if (active) originate(d, area, LSA_ROUTER, rt.routerId, encodeRouterBody(routerFlags(d, area), routerLinks(d, area)));
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

interface RtrInfo {
  cost: number;
  paths: OspfRoutePath[];
  flags: number;
}

interface AreaSpf {
  nets: OspfRouteView[];
  /** Routers reachable in the area (vertex cost + paths + Router-LSA flags). */
  rtrs: Map<string, RtrInfo>;
}

function spfArea(d: D, area: string): AreaSpf {
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
  if (!rootLsa) return { nets: [], rtrs: new Map() };
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
    if (!r || cost < r.cost) routes.set(k, { dest, prefix, cost, area, paths: [...paths], kind: "intra" });
    else if (cost === r.cost) addPaths(r.paths, paths);
  };
  const rtrs = new Map<string, RtrInfo>();
  for (const V of tree.values()) {
    if (V.kind === "R" && V.id !== me) rtrs.set(V.id, { cost: V.dist, paths: V.paths, flags: decodeRouterBody(V.lsa).flags });
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
  return { nets: [...routes.values()], rtrs };
}

const addPathsTo = (into: OspfRoutePath[], add: OspfRoutePath[]) => {
  for (const p of add) if (!into.some((q) => q.nh === p.nh && q.ifId === p.ifId)) into.push(p);
};
const sortPaths = (paths: OspfRoutePath[]) => paths.sort((a, b) => (a.nh === null ? -1 : b.nh === null ? 1 : ipNum(a.nh) - ipNum(b.nh)));
const routeKey = (dest: string, prefix: number) => `${dest}/${prefix}`;

/** Live LSAs of one type in a scope, skipping MaxAge and (optionally) our own. */
function lsasOf(d: D, scope: string, type: number, includeSelf = false): { h: LsaHeader; e: LsaEntry }[] {
  const out: { h: LsaHeader; e: LsaEntry }[] = [];
  for (const e of Object.values(d.rt.lsdb[scope] ?? {})) {
    if (lsaAge(e, d.now) >= MAX_AGE) continue;
    const h = parseLsaHeader(e.lsa);
    if (h.type !== type || (!includeSelf && h.adv === d.rt.routerId)) continue;
    out.push({ h, e });
  }
  return out;
}

/** Areas with a running interface, backbone first. */
const activeAreas = (d: D) => [...new Set(d.rt.oifs.map((o) => o.area))].sort((a, b) => ipNum(a) - ipNum(b));
/** ospf_act_bb_connection: a Full neighbour in the backbone. */
const bbConnected = (d: D) => d.rt.oifs.some((o) => o.area === BACKBONE && o.nbrs.some((n) => n.state === "Full"));

interface ActiveRange {
  area: string;
  dest: string;
  prefix: number;
  cost: number;
  advertise: boolean;
}

/** Configured `area X range` entries that cover at least one intra-area route of X (ospf_area_range_active), ABR only. */
function activeRanges(d: D, intra: OspfRouteView[]): ActiveRange[] {
  if (!d.rt.abr) return [];
  const out: ActiveRange[] = [];
  for (const a of d.cfg.areas) {
    for (const r of a.ranges ?? []) {
      const [net, len] = r.prefix.split("/");
      const prefix = Number(len);
      const comps = intra.filter((x) => x.area === a.id && x.prefix >= prefix && cidrContains(net, prefix, x.dest) && x.cost < LS_INFINITY);
      if (!comps.length) continue;
      out.push({ area: a.id, dest: networkAddress(net, prefix), prefix, cost: r.cost ?? Math.max(...comps.map((c) => c.cost)), advertise: !r.notAdvertise });
    }
  }
  return out;
}

const inRange = (rg: { dest: string; prefix: number }, dest: string, prefix: number) => prefix >= rg.prefix && cidrContains(rg.dest, rg.prefix, dest);

function runSpf(d: D): void {
  const t0 = typeof performance !== "undefined" ? performance.now() : 0;
  const all = new Map<string, OspfRouteView>();
  const areas = activeAreas(d);
  const perArea = new Map<string, Map<string, RtrInfo>>();
  for (const area of areas) {
    const res = spfArea(d, area);
    perArea.set(area, res.rtrs);
    for (const r of res.nets) {
      const k = routeKey(r.dest, r.prefix);
      const cur = all.get(k);
      if (!cur || r.cost < cur.cost) all.set(k, r);
    }
    d.rt.spf.perArea[area] = (d.rt.spf.perArea[area] ?? 0) + 1;
  }
  const intra = [...all.values()];
  const ranges = activeRanges(d, intra);

  // Inter-area routes (RFC 16.2, ospf_ia.c ospf_ia_routing / process_summary_lsa).
  const examine = d.rt.abr && bbConnected(d) ? areas.filter((a) => a === BACKBONE) : areas;
  const asbrIa = new Map<string, OspfRtrRoute>();
  for (const area of examine) {
    const rtrs = perArea.get(area)!;
    for (const type of [LSA_SUMMARY, LSA_ASBR_SUMMARY]) {
      for (const { h, e } of lsasOf(d, area, type)) {
        const sb = decodeSummaryBody(e.lsa);
        if (sb.metric >= LS_INFINITY) continue;
        const len = type === LSA_SUMMARY ? maskLen(sb.mask) : 32;
        const dest = networkAddress(h.id, len);
        if (type === LSA_SUMMARY && ranges.some((rg) => inRange(rg, dest, len))) continue;
        // Ignore a default summary from a stub/NSSA area on an ABR (ospf_ia.c process_summary_lsa).
        if (d.rt.abr && !isRegular(d.cfg, area) && dest === ZERO && len === 0) continue;
        const abr = rtrs.get(h.adv);
        if (!abr || !(abr.flags & RTR_B)) continue; // ospf_find_abr_route
        const cost = abr.cost + sb.metric;
        if (type === LSA_SUMMARY) {
          const k = routeKey(dest, len);
          const cur = all.get(k);
          if (cur?.kind === "intra") continue;
          if (!cur || cost < cur.cost) all.set(k, { dest, prefix: len, cost, area, paths: [...abr.paths], kind: "inter" });
          else if (cost === cur.cost) addPathsTo(cur.paths, abr.paths);
        } else {
          if ([...perArea.values()].some((m) => (m.get(h.id)?.flags ?? 0) & RTR_E)) continue; // intra-area route wins
          const cur = asbrIa.get(h.id);
          if (!cur || cost < cur.cost) asbrIa.set(h.id, { rid: h.id, cost, area, ia: true, flags: RTR_E, paths: [...abr.paths] });
          else if (cost === cur.cost) addPathsTo(cur.paths, abr.paths);
        }
      }
    }
  }

  // Router routing table: ABRs/ASBRs per area (ospf_intra_add_router) + inter-area ASBRs.
  const rtrTable: OspfRtrRoute[] = [];
  for (const [area, rtrs] of perArea) {
    for (const [rid, r] of rtrs) if (r.flags & (RTR_B | RTR_E)) rtrTable.push({ rid, cost: r.cost, area, ia: false, flags: r.flags, paths: [...r.paths] });
  }
  rtrTable.push(...asbrIa.values());
  rtrTable.sort((a, b) => ipNum(a.rid) - ipNum(b.rid) || ipNum(a.area) - ipNum(b.area));

  // AS-external routes (RFC 16.4, ospf_ase.c ospf_ase_calculate_route).
  const netRoutes = [...all.values()];
  const asbrRoute = (rid: string, viaArea?: string): { cost: number; paths: OspfRoutePath[] } | undefined => {
    let best: { cost: number; paths: OspfRoutePath[] } | undefined;
    for (const r of rtrTable) {
      if (r.rid !== rid || !(r.flags & RTR_E) || (viaArea !== undefined && (r.ia || r.area !== viaArea))) continue;
      if (!best || r.cost < best.cost) best = { cost: r.cost, paths: r.paths };
    }
    return best;
  };
  const fwdRoute = (fwd: string): { cost: number; paths: OspfRoutePath[] } | undefined => {
    if (d.rt.oifs.some((o) => o.ip === fwd)) return undefined; // our own address: ignore the LSA
    let best: OspfRouteView | undefined;
    for (const r of netRoutes) if (cidrContains(r.dest, r.prefix, fwd) && (!best || r.prefix > best.prefix)) best = r;
    if (!best) return undefined;
    return { cost: best.cost, paths: best.paths.map((p) => (p.nh === null ? { ...p, nh: fwd } : p)) };
  };
  const ext = new Map<string, OspfExtRoute>();
  const sources: { h: LsaHeader; e: LsaEntry; area?: string }[] = [
    ...lsasOf(d, AS_SCOPE, LSA_EXTERNAL),
    ...areas.filter((a) => areaType(d.cfg, a) === "nssa").flatMap((a) => lsasOf(d, a, LSA_NSSA).map((x) => ({ ...x, area: a }))),
  ];
  for (const { h, e, area } of sources) {
    const x = decodeExternalBody(e.lsa);
    if (x.metric >= LS_INFINITY) continue;
    const len = maskLen(x.mask);
    const dest = networkAddress(h.id, len);
    const k = routeKey(dest, len);
    if (all.has(k)) continue; // intra/inter-area routes are preferred over externals
    const asbr = asbrRoute(h.adv, area);
    if (!asbr) continue;
    const base = x.fwd !== ZERO ? fwdRoute(x.fwd) : asbr;
    if (!base) continue;
    const cand: OspfExtRoute = { dest, prefix: len, e2: x.e2, cost: x.e2 ? base.cost : base.cost + x.metric, type2: x.metric, tag: x.tag, paths: [...base.paths] };
    const cur = ext.get(k);
    const cmp = !cur
      ? -1
      : cand.e2 !== cur.e2
        ? (cand.e2 ? 1 : -1)
        : cand.e2 && cand.type2 !== cur.type2
          ? cand.type2 - cur.type2
          : cand.cost - cur.cost;
    if (cmp < 0) ext.set(k, cand);
    else if (cmp === 0) addPathsTo(cur!.paths, cand.paths);
  }

  // Discard entries for active advertised ranges (ospf_abr_manage_discard_routes).
  for (const rg of ranges) {
    const k = routeKey(rg.dest, rg.prefix);
    if (rg.advertise && !all.has(k)) all.set(k, { dest: rg.dest, prefix: rg.prefix, cost: rg.cost, area: rg.area, paths: [], kind: "discard" });
  }

  for (const r of all.values()) sortPaths(r.paths);
  for (const r of ext.values()) sortPaths(r.paths);
  const bySortKey = (a: { dest: string; prefix: number }, b: { dest: string; prefix: number }) => ipNum(a.dest) - ipNum(b.dest) || a.prefix - b.prefix;
  d.rt.routes = [...all.values()].sort(bySortKey);
  d.rt.rtrs = rtrTable;
  d.rt.ext = [...ext.values()].sort(bySortKey);
  d.rt.spf.runs++;
  d.rt.spf.lastMs = d.now;
  d.rt.spf.durUs = Math.max(1, Math.round(((typeof performance !== "undefined" ? performance.now() : 0) - t0) * 1000));
  d.rt.spfDirty = false;
  installRoutes(d, d.rt.routes, d.rt.ext);
}

/** Replace this instance's routes in the RIB (connected/static/BGP and other VRFs untouched). */
function installRoutes(d: D, routes: OspfRouteView[], ext: OspfExtRoute[] = []): void {
  const table = d.device.routingTable;
  const mine = (r: Route) => r.type === "ospf" && (r.vrf ?? DEFAULT_VRF) === d.vrf;
  const prev = table.filter(mine);
  const vrf = d.vrf === DEFAULT_VRF ? {} : { vrf: d.vrf };
  // zebra metric: path cost, or the type-2 metric for E2 (ospf_zebra.c ospf_zebra_add).
  const entries = [
    ...routes.filter((r) => r.kind !== "discard").map((r) => ({ dest: r.dest, prefix: r.prefix, metric: r.cost, paths: r.paths })),
    ...ext.map((r) => ({ dest: r.dest, prefix: r.prefix, metric: r.e2 ? r.type2 : r.cost, paths: r.paths })),
  ];
  const next: Route[] = entries.flatMap((r) =>
    r.paths.map((p) => ({ destination: r.dest, prefix: r.prefix, nextHop: p.nh, interfaceId: p.ifId, type: "ospf" as const, metric: r.metric, distance: 110, ...vrf })),
  );
  const strip = (l: Route[]) => JSON.stringify(l.map(({ installedAtMs: _t, ...rest }) => rest));
  if (strip(prev) === strip(next)) return;
  carryInstallTime(prev, next, d.now);
  const added = next.filter((r) => r.nextHop && !prev.some((p) => p.destination === r.destination && p.prefix === r.prefix && p.nextHop === r.nextHop));
  for (const r of added) emit(d, undefined, "OSPF_ROUTE", `OSPF route ${r.destination}/${r.prefix} via ${r.nextHop} (cost ${r.metric})`);
  d.device.routingTable = [...table.filter((r) => !mine(r)), ...next];
}

// ---------------------------------------------------------------------------
// ABR / ASBR status and summary / external origination (ospf_abr.c ospf_abr_task, ospf_asbr.c).

/** ospf_check_abr_status (abr-type cisco), ospf_abr_nssa_check_status, ospf_asbr_status_update. */
function updateStatus(d: D): void {
  const { rt, cfg } = d;
  const configured = new Set(ospfInterfaces(d.device, cfg, d.vrf).map((s) => s.area));
  rt.abr = configured.size > 1 && rt.oifs.some((o) => o.area === BACKBONE);
  const xlt: Record<string, boolean> = {};
  for (const area of activeAreas(d)) if (areaType(cfg, area) === "nssa") xlt[area] = !!rt.abr && nssaElected(d, area);
  rt.xlt = xlt;
  rt.asbr = !!(cfg.redistribute?.length || cfg.defaultInfo) || Object.values(xlt).some(Boolean);
}

/** ospf_abr_nssa_am_elected: highest router-id among the area's ABRs, unless one has the Nt bit. */
function nssaElected(d: D, area: string): boolean {
  let best: string | undefined;
  for (const { h, e } of lsasOf(d, area, LSA_ROUTER)) {
    const flags = decodeRouterBody(e.lsa).flags;
    if (!(flags & RTR_B)) continue;
    if (flags & RTR_NT) return false;
    if (!best || ipNum(h.id) > ipNum(best)) best = h.id;
  }
  return !best || ipNum(best) < ipNum(d.rt.routerId);
}

/** Originate what we want in a scope for the given types and flush our stale ones. */
function syncSelf(d: D, scope: string, types: number[], want: Map<string, { type: number; id: string; body: number[]; options?: number; xlt?: boolean }>): void {
  for (const w of want.values()) originate(d, scope, w.type, w.id, w.body, undefined, false, { options: w.options, xlt: !!w.xlt });
  for (const [key, e] of Object.entries(areaDb(d.rt, scope))) {
    if (!e.self) continue;
    const h = parseLsaHeader(e.lsa);
    if (types.includes(h.type) && !want.has(`${h.type}/${h.id}`)) flushSelf(d, scope, key);
  }
}

function abrTask(d: D): void {
  const { rt, cfg } = d;
  const areas = activeAreas(d);
  const want = new Map<string, Map<string, { type: number; id: string; body: number[] }>>(areas.map((a) => [a, new Map()]));
  const put = (area: string, type: number, dest: string, prefix: number, metric: number) =>
    want.get(area)?.set(`${type}/${dest}`, { type, id: dest, body: encodeSummaryBody(type === LSA_SUMMARY ? prefixToMask(prefix) : ZERO, metric) });
  if (rt.abr && rt.routes) {
    const ifArea = (ifId: string) => rt.oifs.find((o) => o.ifId === ifId)?.area;
    const nhIn = (paths: OspfRoutePath[], area: string) => paths.some((p) => ifArea(p.ifId) === area); // ospf_abr_nexthops_belong_to_area
    const bb = bbConnected(d);
    const intra = rt.routes.filter((r) => r.kind === "intra");
    const ranges = activeRanges(d, intra);
    // ospf_abr_process_network_rt / ospf_abr_announce_network.
    for (const r of rt.routes) {
      if (r.kind === "discard" || r.cost >= LS_INFINITY) continue;
      if (r.kind === "inter" && (r.area !== BACKBONE || !bb)) continue;
      for (const a of areas) {
        if (a === r.area || nhIn(r.paths, a)) continue;
        const ac = areaCfg(cfg, a);
        if (ac?.type && ac.noSummary) continue;
        if (r.kind === "inter") {
          if (a !== BACKBONE) put(a, LSA_SUMMARY, r.dest, r.prefix, r.cost);
        } else if (!ranges.some((rg) => rg.area === r.area && inRange(rg, r.dest, r.prefix))) put(a, LSA_SUMMARY, r.dest, r.prefix, r.cost);
      }
    }
    // ospf_abr_announce_aggregates: an active range is announced into every other area.
    for (const rg of ranges) if (rg.advertise) for (const a of areas) if (a !== rg.area) put(a, LSA_SUMMARY, rg.dest, rg.prefix, rg.cost);
    // ospf_abr_process_router_rt / ospf_abr_announce_rtr: type-4 for the best route to each ASBR.
    const best = new Map<string, OspfRtrRoute>();
    for (const r of rt.rtrs ?? []) if (r.flags & RTR_E && (!best.has(r.rid) || r.cost < best.get(r.rid)!.cost)) best.set(r.rid, r);
    for (const r of best.values()) {
      if (r.ia && (r.area !== BACKBONE || !bb)) continue;
      if (areaType(cfg, r.area) === "nssa") continue; // RFC 3101: no type-4 for an ASBR inside an NSSA
      for (const a of areas) {
        if (a === r.area || nhIn(r.paths, a) || !isRegular(cfg, a) || (r.ia && a === BACKBONE)) continue;
        put(a, LSA_ASBR_SUMMARY, r.rid, 32, r.cost);
      }
    }
    // ospf_abr_announce_stub_defaults.
    for (const a of areas) if (a !== BACKBONE && !isRegular(cfg, a)) put(a, LSA_SUMMARY, ZERO, 0, areaCfg(cfg, a)?.defaultCost ?? 1);
  }
  for (const area of new Set([...areas, ...Object.keys(rt.lsdb).filter((a) => a !== AS_SCOPE)])) syncSelf(d, area, [LSA_SUMMARY, LSA_ASBR_SUMMARY], want.get(area) ?? new Map());
}

/** Self-originated externals: redistribution / default-information (type-5 + type-7 copies) and NSSA translation. */
function externalTask(d: D): void {
  const { rt, cfg, device } = d;
  const areas = activeAreas(d);
  const as = new Map<string, { type: number; id: string; body: number[]; xlt?: boolean }>();
  // Translation: type-7 with the P-bit → type-5 (ospf_abr_process_nssa_translates).
  for (const area of areas) {
    if (!rt.xlt?.[area]) continue;
    for (const { h, e } of lsasOf(d, area, LSA_NSSA)) {
      const x = decodeExternalBody(e.lsa);
      if (!(h.options & OPT_NP) || x.fwd === ZERO || x.metric >= LS_INFINITY) continue;
      as.set(`${LSA_EXTERNAL}/${h.id}`, { type: LSA_EXTERNAL, id: h.id, body: encodeExternalBody(x), xlt: true });
    }
  }
  // Redistribution (ospf_redistribute_check, ospf_external_lsa_body_set).
  const onOspfNet = (ip: string) => rt.oifs.some((o) => cidrContains(networkAddress(o.ip, o.prefix), o.prefix, ip));
  const own: { dest: string; prefix: number; body: number[] }[] = [];
  const PROTO: Record<string, string> = { connected: "connected", static: "static", default: "static", bgp: "bgp" };
  for (const red of cfg.redistribute ?? []) {
    for (const r of device.routingTable) {
      if (PROTO[r.type] !== red.protocol || (r.vrf ?? DEFAULT_VRF) !== d.vrf || r.prefix === 0) continue;
      const dest = networkAddress(r.destination, r.prefix);
      if (own.some((o) => o.dest === dest && o.prefix === r.prefix)) continue;
      // Connected networks OSPF already runs on are not redistributed (ospf_distribute_check_connected).
      if (r.type === "connected" && rt.oifs.some((o) => r.prefix >= o.prefix && cidrContains(networkAddress(o.ip, o.prefix), o.prefix, dest))) continue;
      const fwd = r.nextHop && onOspfNet(r.nextHop) ? r.nextHop : ZERO; // ospf_external_lsa_nexthop_get
      own.push({ dest, prefix: r.prefix, body: encodeExternalBody({ mask: prefixToMask(r.prefix), e2: red.metricType !== 1, metric: red.metric ?? 20, fwd, tag: 0 }) });
    }
  }
  const di = cfg.defaultInfo;
  if (di && (di.always || device.routingTable.some((r) => r.prefix === 0 && r.type !== "ospf" && (r.vrf ?? DEFAULT_VRF) === d.vrf))) {
    own.push({ dest: ZERO, prefix: 0, body: encodeExternalBody({ mask: ZERO, e2: di.metricType !== 1, metric: di.metric ?? (di.always ? 1 : 10), fwd: ZERO, tag: 0 }) });
  }
  for (const o of own) as.set(`${LSA_EXTERNAL}/${o.dest}`, { type: LSA_EXTERNAL, id: o.dest, body: o.body });
  syncSelf(d, AS_SCOPE, [LSA_EXTERNAL], as);
  // Type-7 copies into each attached NSSA (ospf_install_flood_nssa): P-bit + NSSA forwarding address unless ABR.
  for (const area of new Set([...areas, ...Object.keys(rt.lsdb).filter((a) => a !== AS_SCOPE)])) {
    const want = new Map<string, { type: number; id: string; body: number[]; options: number }>();
    if (areaType(cfg, area) === "nssa" && areas.includes(area)) {
      const nssaIfs = rt.oifs.filter((o) => areaType(cfg, o.area) === "nssa");
      const nssaIp = (nssaIfs.find((o) => o.area === area) ?? nssaIfs[0])?.ip ?? ZERO; // ospf_get_nssa_ip
      for (const o of own) {
        const x = decodeExternalBody([...Array(20).fill(0), ...o.body]);
        if (!rt.abr && x.fwd === ZERO) x.fwd = nssaIp;
        if (!rt.abr && x.fwd === ZERO) continue;
        want.set(`${LSA_NSSA}/${o.dest}`, { type: LSA_NSSA, id: o.dest, body: encodeExternalBody(x), options: OPT_E | (rt.abr ? 0 : OPT_NP) });
      }
    }
    syncSelf(d, area, [LSA_NSSA], want);
  }
}

// ---------------------------------------------------------------------------
// Driving: per-device processing with deferred ISM events + origination + SPF.
function withInstance(ctx: SimContext, device: Device, vrf: string, now: number, fn: (d: D) => void): boolean {
  const cfg = liveOspfConfig(device, vrf);
  let rt = ospfRuntime(device, vrf);
  if (!cfg && !rt) return false;
  const features = (device.config.features ??= {});
  if (!rt) {
    rt = newRt(ospfRouterId(device, cfg!), now);
    features[rtKey(vrf)] = rt;
  }
  const d: D = { ctx, device, cfg: cfg ?? { networks: [], areas: [] }, rt, now, vrf };
  if (!cfg) {
    teardown(d);
    delete features[rtKey(vrf)];
    flush();
    return true;
  }
  if (rt.sig !== computeSig(device, vrf)) reconcile(d);
  fn(d);
  postProcess(d);
  flush();
  return true;
}

/** Run `fn` on every OSPF instance of the device (one per VRF). */
function withDevice(ctx: SimContext, device: Device, now: number, fn: (d: D) => void): void {
  for (const vrf of instanceVrfs(device)) withInstance(ctx, device, vrf, now, fn);
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
  updateStatus(d);
  originateAll(d);
  if (d.rt.spfDirty) runSpf(d);
  abrTask(d);
  externalTask(d);
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

const rtSnapshot = (device: Device) => JSON.stringify([instanceVrfs(device).map((v) => device.config.features?.[rtKey(v)] ?? null), device.routingTable]);

function tick(ctx: SimContext, device: Device, now: number): boolean {
  const before = rtSnapshot(device);
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
          const lsas = dueKeys.filter((k) => entryFor(d, oif.area, k)).map((k) => wire(entryFor(d, oif.area, k)!, now));
          for (const k of dueKeys) {
            if (entryFor(d, oif.area, k)) n.rxmt[k] = now + oif.rxmt * 1000;
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
  return rtSnapshot(device) !== before;
}

function nextDue(device: Device, now: number): number | undefined {
  if (device.state === "down" || !ospfCapable(device)) return undefined;
  let due: number | undefined;
  for (const vrf of instanceVrfs(device)) {
    const rt = ospfRuntime(device, vrf);
    if ((rt?.sig ?? "") !== computeSig(device, vrf)) return now;
    if (!rt) continue;
    for (const oif of rt.oifs) for (const n of oif.nbrs) if (n.bfdReg && bfd().state(device, n.ip) !== n.bfdLast) return now;
    const t = dueTimes(rt);
    if (t.length) due = Math.min(due ?? Infinity, ...t);
  }
  return due;
}

function receiveL3(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const ip = frame.ipv4;
  if (!ip || ip.protocol !== "OSPF" || !ospfCapable(device)) return false;
  const vrf = vrfOf(device, ingress);
  const rt = ospfRuntime(device, vrf);
  if (!rt || !liveOspfConfig(device, vrf)) return false;
  const payload = ipPayload(frame);
  const pkt = payload && decodePacket(payload);
  if (!pkt) return true; // bad checksum/version: dropped by ospfd
  const now = ctx.wallNow();
  withInstance(ctx, device, vrf, now, (d) => {
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
  const devs = Object.values(ctx.state.devices).filter((dv) => dv.state !== "down" && ospfCapable(dv) && instanceVrfs(dv).length > 0);
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
  const live = devs.filter((dv) => instanceVrfs(dv).some((v) => ospfRuntime(dv, v)));
  for (const dv of live) {
    for (const v of instanceVrfs(dv)) for (const oif of ospfRuntime(dv, v)?.oifs ?? []) adjacencies += oif.nbrs.filter((n) => n.state === "Full").length;
    routesInstalled += dv.routingTable.filter((r) => r.type === "ospf" && r.nextHop).length;
  }
  return { routers: live.length, adjacencies, routesInstalled };
}
