/**
 * BFD control-plane daemon — a model of FRR 10.3 bfdd (src/sonic-frr/frr/bfdd)
 * registered with lib/control/daemon.ts and serving lib/control/bfd-api.ts.
 *
 * Sessions
 *   One session per peer address per device. It exists while the peer is
 *   configured (`bfd` → `peer ...`, stored by lib/commands/sonic/bfd.ts in
 *   features.bfd) and/or registered by a client (OSPF/BGP via bfd().register),
 *   like bfdd's refcounted sessions (BFD_SESS_FLAG_CONFIG vs dynamic). Runtime
 *   state lives in features["bfdd"].
 *
 * State machine (RFC 5880 §6.2 / §6.8.6) — bfd.c bs_down/init/up_handler
 * (bfd.c:1150-1295): Down+rx Down→Init, Down+rx Init→Up, Init+rx Init|Up→Up,
 * Init+rx AdminDown→Down(diag 3), Up+rx Down|AdminDown→Down(diag 3). Detection
 * timer expiry in Init/Up → Down(diag 1) (bfd_recvtimer_cb, bfd.c:807).
 *
 * Timers (bfd.c/bfd_packet.c)
 *   - Slow 1 s tx/rx (BFD_DEF_SLOWTX, bfd.h:440) while not Up and after going
 *     Down: bs_set_slow_timers (bfd.c:1460) — cur timers 1 s, detect 3 s.
 *   - Going Up starts a Poll (ptm_bfd_sess_up → bfd_set_polling, bfd.c:555):
 *     packets carry P and the configured timers; the peer answers F
 *     (bfd_recv_cb, bfd_packet.c:1091-1104) and both sides switch to them in
 *     bs_final_handler (bfd.c:1426): tx = max(local desired min tx, remote
 *     required min rx). Changing tx/rx while Up polls again (bfd_session_apply,
 *     bfd.c:213).
 *   - Detection time on every rx = remote detect mult × max(local current
 *     required min rx, remote desired min tx) (bfd_packet.c:1080-1086).
 *   - Jitter: bfdd jitters tx to 75-100 % (ptm_bfd_start_xmt_timer, bfd.c:445).
 *     The simulator ticks every 100 ms, so a jittered 225-300 ms would round up
 *     to the same 300 ms tick anyway: jitter is NOT modelled; packets go out on
 *     exact multiples of the interval. All timers fire on the first 100 ms tick
 *     at/after their deadline (nextDue reports the exact deadline), so a timer
 *     can be late by < 100 ms — e.g. a 900 ms detection time is observed as
 *     900-1000 ms after the last packet.
 *
 * Wire: 24-byte control packets (bfd-packet.ts), UDP dport 3784 single-hop with
 * TTL 255 out of the bound interface (RFC 5881 §5, BFD_TTL_VAL bfd.h:445), 4784
 * multihop routed (RFC 5883), IP TOS 0xC0 (BFD_TOS_VAL), source port from a
 * per-device counter starting at 49152 (bp_peer_socket, bfd_packet.c:1465-1518).
 * Receive validation in bfd_recv_cb order (bfd_packet.c:902-990).
 *
 * Deviations (documented):
 *   - Shutdown sets local diag 7 (RFC 5880 §6.8.16 "SHOULD set LocalDiag");
 *     FRR's bfd_set_shutdown (bfd.c:1514) leaves the previous diag.
 *   - Interface oper-down does not tear the session down directly — as in FRR,
 *     which only reacts to interface deletion (ptm_adapter.c:838-839); sends
 *     fail (Tx fail counter) and the detection timer brings it Down (diag 1).
 *   - No echo function, no authentication, no demand mode, default VRF only.
 */
import { Device } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { featureState, peekFeatureState } from "../models/feature-state";
import { sameSubnet } from "../models/ip";
import { registerDaemon } from "../control/daemon";
import { setBfdImpl, BfdClient, BfdSessionKey, BfdState } from "../control/bfd-api";
import { sendIpv4, transmitIpv4, l4Payload, ownsAddress } from "../control/packet";
import { resolveArp } from "./arp";
import {
  BFD_PKT_LEN, BFD_VERSION, BFD_PORT_SINGLEHOP, BFD_PORT_MULTIHOP,
  ST_ADMIN_DOWN, ST_DOWN, ST_INIT, ST_UP, encodeBfd, decodeBfd, tcpdumpBfd,
} from "./bfd-packet";

// --- defaults (bfd.h:434-445) ----------------------------------------------
export const BFD_DEFAULTS = { detectMult: 3, minTx: 300, minRx: 300, echoRx: 50, slowTx: 1000, mhTtl: 254 };
const BFD_TTL = 255;
const BFD_TOS = 0xc0;
const SRCPORT_INIT = 49152;
const SRCPORT_MAX = 65535;

/** Diagnostic codes (RFC 5880 §4.1, bfd.h:205-218). */
export const DIAG = { NONE: 0, CONTROL_EXPIRED: 1, NEIGHBOR_DOWN: 3, PATH_DOWN: 5, ADMIN_DOWN: 7 } as const;

/** Configured peer as stored by the CLI (features.bfd.peers). */
export interface BfdPeerConfig {
  peer: string;
  local?: string;
  interface?: string;
  multihop?: boolean;
  rxInterval?: number;
  txInterval?: number;
  multiplier?: number;
  shutdown?: boolean;
}

export interface BfdSession {
  peer: string;
  local?: string;
  ifname?: string;
  multihop: boolean;
  configured: boolean;
  clients: BfdClient[];
  myDisc: number;
  remoteDisc: number;
  state: number;
  localDiag: number;
  remoteDiag: number;
  /** Configured ("timers") values, ms. */
  detectMult: number;
  desiredMinTx: number;
  requiredMinRx: number;
  requiredMinEchoRx: number;
  /** In-use ("cur_timers") values, ms. */
  curTx: number;
  curRx: number;
  /** Last values received from the peer, ms. */
  remoteDesiredTx: number;
  remoteRequiredRx: number;
  remoteEchoRx: number;
  remoteDetectMult: number;
  /** Negotiated transmit interval and detection time, ms. */
  xmtTO: number;
  detectTO: number;
  polling: boolean;
  shutdown: boolean;
  /** Absolute wall-clock ms of the next transmission / detection expiry. */
  nextTx?: number;
  detectAt?: number;
  uptime: number;
  downtime: number;
  /** Local address the peer's packets arrived on (single hop; FRR bs->local_address). */
  pktLocal?: string;
  srcPort: number;
  mhTtl: number;
  stats: { rxCtrl: number; txCtrl: number; up: number; down: number; zebra: number; txFail: number };
}

interface BfdRuntime {
  sessions: BfdSession[];
  /** JSON of the config peers last applied (re-reconcile when it differs). */
  applied: string;
  nextSrcPort: number;
}

const RT = "bfdd";

const runtime = (d: Device) => featureState<BfdRuntime>(d, RT, () => ({ sessions: [], applied: "[]", nextSrcPort: SRCPORT_INIT }));
const configPeers = (d: Device) => peekFeatureState<{ peers: BfdPeerConfig[] }>(d, "bfd")?.peers ?? [];

/** All sessions of a device in creation order (read-only use by `show`). */
export function bfdSessions(device: Device): BfdSession[] {
  return peekFeatureState<BfdRuntime>(device, RT)?.sessions ?? [];
}

export function findSession(device: Device, peer: string): BfdSession | undefined {
  return bfdSessions(device).find((s) => s.peer === peer);
}

/** Random non-zero discriminator unique on the device (ptm_bfd_gen_ID, bfd.c:429). */
function genDisc(rt: BfdRuntime): number {
  let id: number;
  do id = (Math.floor(Math.random() * 0x10000) << 16 | Math.floor(Math.random() * 0x10000)) >>> 0;
  while (id === 0 || rt.sessions.some((s) => s.myDisc === id));
  return id;
}

/** bfd_session_new (bfd.c:873) + bfd_session_enable (bfd.c:292). */
function newSession(rt: BfdRuntime, key: BfdSessionKey, now: number): BfdSession {
  const D = BFD_DEFAULTS;
  const s: BfdSession = {
    peer: key.peer,
    local: key.local,
    ifname: key.iface,
    multihop: !!key.multihop,
    configured: false,
    clients: [],
    myDisc: genDisc(rt),
    remoteDisc: 0,
    state: ST_DOWN,
    localDiag: 0,
    remoteDiag: 0,
    detectMult: D.detectMult,
    desiredMinTx: D.minTx,
    requiredMinRx: D.minRx,
    requiredMinEchoRx: D.echoRx,
    curTx: D.slowTx,
    curRx: D.slowTx,
    remoteDesiredTx: D.slowTx,
    remoteRequiredRx: D.slowTx,
    remoteEchoRx: 0,
    remoteDetectMult: D.detectMult,
    xmtTO: D.slowTx,
    detectTO: D.detectMult * D.slowTx,
    polling: false,
    shutdown: false,
    uptime: now,
    downtime: now,
    srcPort: rt.nextSrcPort,
    mhTtl: D.mhTtl,
    stats: { rxCtrl: 0, txCtrl: 0, up: 0, down: 0, zebra: 0, txFail: 0 },
  };
  rt.nextSrcPort = rt.nextSrcPort >= SRCPORT_MAX ? SRCPORT_INIT : rt.nextSrcPort + 1;
  s.detectAt = now + s.detectTO;
  s.nextTx = now + s.xmtTO;
  rt.sessions.push(s);
  return s;
}

// --- state transitions (bfd.c) ----------------------------------------------

/** A packet to send once the current handler has finished mutating state. */
type Pending = { s: BfdSession; bytes: number[] };

function packet(s: BfdSession, fbit: boolean): number[] {
  // ptm_bfd_snd (bfd_packet.c:416): announce the configured timers only while
  // polling, otherwise the ones in use; P is never set together with F.
  return encodeBfd({
    diag: s.localDiag,
    state: s.state,
    poll: s.polling && !fbit,
    final: fbit,
    detectMult: s.detectMult,
    myDisc: s.myDisc,
    yourDisc: s.remoteDisc,
    desiredMinTx: (s.polling ? s.desiredMinTx : s.curTx) * 1000,
    requiredMinRx: (s.polling ? s.requiredMinRx : s.curRx) * 1000,
    requiredMinEchoRx: s.requiredMinEchoRx * 1000,
  });
}

function slowTimers(s: BfdSession): void {
  s.curTx = BFD_DEFAULTS.slowTx;
  s.curRx = BFD_DEFAULTS.slowTx;
  s.detectTO = BFD_DEFAULTS.detectMult * BFD_DEFAULTS.slowTx;
  s.xmtTO = BFD_DEFAULTS.slowTx;
}

/** ptm_bfd_sess_up (bfd.c:555). */
function sessUp(s: BfdSession, now: number, out: Pending[]): void {
  const old = s.state;
  s.localDiag = 0;
  s.state = ST_UP;
  s.uptime = now;
  s.polling = true;
  out.push({ s, bytes: packet(s, false) });
  s.stats.zebra++;
  if (old !== ST_UP) s.stats.up++;
}

/** ptm_bfd_sess_dn (bfd.c:580). */
function sessDown(s: BfdSession, diag: number, now: number, out: Pending[]): void {
  const old = s.state;
  s.localDiag = diag;
  s.remoteDisc = 0;
  s.state = ST_DOWN;
  s.polling = false;
  s.downtime = now;
  out.push({ s, bytes: packet(s, false) });
  slowTimers(s);
  if (old === ST_UP) s.stats.zebra++;
  if (old !== ST_DOWN) s.stats.down++;
  s.pktLocal = undefined;
}

/** bs_state_handler (bfd.c:1297) — `n` is the state the peer just sent. */
function stateHandler(s: BfdSession, n: number, now: number, out: Pending[]): void {
  switch (s.state) {
    case ST_DOWN:
      if (n === ST_DOWN) s.state = ST_INIT;
      else if (n === ST_INIT) sessUp(s, now, out);
      break;
    case ST_INIT:
      if (n === ST_ADMIN_DOWN) sessDown(s, DIAG.NEIGHBOR_DOWN, now, out);
      else if (n === ST_INIT || n === ST_UP) sessUp(s, now, out);
      break;
    case ST_UP:
      if (n === ST_ADMIN_DOWN || n === ST_DOWN) sessDown(s, DIAG.NEIGHBOR_DOWN, now, out);
      break;
  }
}

/** bs_final_handler (bfd.c:1426): adopt the configured timers after Poll/Final. */
function finalHandler(s: BfdSession, now: number): void {
  s.curTx = s.desiredMinTx;
  s.curRx = s.requiredMinRx;
  s.xmtTO = Math.max(s.desiredMinTx, s.remoteRequiredRx);
  s.nextTx = now + s.xmtTO;
}

/** bfd_set_shutdown (bfd.c:1514). */
function setShutdown(s: BfdSession, down: boolean, now: number): void {
  const isShutdown = s.state === ST_UP ? false : s.shutdown;
  if (down) {
    s.shutdown = true;
    if (isShutdown) return;
    s.state = ST_ADMIN_DOWN;
    s.localDiag = DIAG.ADMIN_DOWN; // RFC 5880 §6.8.16 (see header: FRR keeps the old diag)
    s.polling = false;
    s.stats.zebra++;
    s.detectAt = undefined;
    // bfdd sends one AdminDown packet then stops its timers; queue it for the next tick.
    s.nextTx = now;
  } else {
    s.shutdown = false;
    if (!isShutdown) return;
    s.state = ST_DOWN;
    s.stats.zebra++;
    s.detectAt = now + s.detectTO;
    s.nextTx = now + s.xmtTO;
  }
}

/** bfd_session_apply (bfd.c:145) for the configured parameters. */
function applyConfig(s: BfdSession, p: { multiplier?: number; txInterval?: number; rxInterval?: number; shutdown?: boolean }, now: number): void {
  const oldTx = s.desiredMinTx;
  const oldRx = s.requiredMinRx;
  s.detectMult = p.multiplier ?? BFD_DEFAULTS.detectMult;
  s.desiredMinTx = p.txInterval ?? BFD_DEFAULTS.minTx;
  s.requiredMinRx = p.rxInterval ?? BFD_DEFAULTS.minRx;
  setShutdown(s, !!p.shutdown, now);
  if (s.state === ST_UP && (s.desiredMinTx !== oldTx || s.requiredMinRx !== oldRx)) s.polling = true;
}

/**
 * Bring the device's sessions in line with its configured peers (create,
 * update, de-configure). Called by the `config bfd ...` commands right away and
 * by tick() whenever the stored config differs from what was last applied.
 */
export function reconcileBfd(device: Device, now: number): void {
  const peers = configPeers(device);
  const sig = JSON.stringify(peers);
  const existing = peekFeatureState<BfdRuntime>(device, RT);
  if (!existing && peers.length === 0) return;
  const rt = runtime(device);
  for (const p of peers) {
    let s = rt.sessions.find((x) => x.peer === p.peer);
    if (!s) s = newSession(rt, { peer: p.peer, local: p.local, iface: p.interface, multihop: p.multihop }, now);
    s.configured = true;
    s.ifname = p.interface;
    s.local = p.local;
    s.multihop = !!p.multihop;
    applyConfig(s, p, now);
  }
  for (const s of [...rt.sessions]) {
    if (!s.configured || peers.some((p) => p.peer === s.peer)) continue;
    s.configured = false;
    if (s.clients.length === 0) rt.sessions = rt.sessions.filter((x) => x !== s);
    else applyConfig(s, {}, now);
  }
  rt.applied = sig;
}

// --- transmit / receive -----------------------------------------------------

function boundInterface(device: Device, s: BfdSession): NetInterface | undefined {
  if (s.ifname) return device.interfaces.find((i) => i.name === s.ifname);
  return device.interfaces.find((i) => i.ipv4.some((a) => sameSubnet(a.address, s.peer, a.prefix)));
}

const STATE_NAME = ["AdminDown", "Down", "Init", "Up"];

function transmit(ctx: SimContext, device: Device, s: BfdSession, bytes: number[]): void {
  const summary = `BFD ${STATE_NAME[s.state]} ${s.myDisc}→${s.remoteDisc}`;
  if (s.multihop) {
    if (!s.local) {
      s.stats.txFail++;
      return;
    }
    const r = sendIpv4(ctx, device, { src: s.local, dst: s.peer, ttl: BFD_TTL, tos: BFD_TOS, udp: { sport: s.srcPort, dport: BFD_PORT_MULTIHOP }, payload: bytes, summary });
    if (r.ok) s.stats.txCtrl++;
    else s.stats.txFail++;
    return;
  }
  const iface = boundInterface(device, s);
  const src = s.local ?? (iface && primaryIpv4(iface)?.address);
  // Socket bound to a missing/down interface: sendto() fails (bfd_packet.c _ptm_bfd_send → tx_fail_pkt).
  if (!iface || !src || iface.adminState !== "up" || iface.operState !== "up") {
    s.stats.txFail++;
    return;
  }
  s.stats.txCtrl++;
  const mac = resolveArp(ctx, device, iface, s.peer);
  if (!mac) return; // kernel drops it after ARP fails; bfdd already counted it as sent
  transmitIpv4(ctx, device, iface, mac, { src, dst: s.peer, ttl: BFD_TTL, tos: BFD_TOS, udp: { sport: s.srcPort, dport: BFD_PORT_SINGLEHOP }, payload: bytes, summary });
}

function flush(ctx: SimContext, device: Device, out: Pending[]): void {
  for (const p of out.splice(0)) transmit(ctx, device, p.s, p.bytes);
}

/** Wall-clock now for packet handlers (the store's sims carry wallBase = Date.now()). */
function wallNow(ctx: SimContext): number {
  const w = ctx.wallNow();
  return w > 1e11 ? w : Date.now();
}

/** bfd_recv_cb (bfd_packet.c:842). Returns true when the packet was for bfdd. */
function receive(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const ip = frame.ipv4;
  const udp = frame.udp;
  if (!ip || !udp || (udp.dstPort !== BFD_PORT_SINGLEHOP && udp.dstPort !== BFD_PORT_MULTIHOP)) return false;
  if (!ownsAddress(device, ip.dstIp)) return false; // transit (e.g. multihop) — let it be forwarded
  const rt = peekFeatureState<BfdRuntime>(device, RT);
  const data = l4Payload(frame);
  if (!rt || !data) return true;
  const isMhop = udp.dstPort === BFD_PORT_MULTIHOP;
  const p = decodeBfd(data);
  if (!p) return true; // too small
  if (!isMhop && ip.ttl !== BFD_TTL) return true; // RFC 5881 §5 GTSM
  if (p.version !== BFD_VERSION || p.detectMult === 0 || p.length < BFD_PKT_LEN || p.length > data.length || p.multipoint || p.myDisc === 0) return true;

  const s = p.yourDisc !== 0
    ? rt.sessions.find((x) => x.myDisc === p.yourDisc && x.peer === ip.srcIp)
    : rt.sessions.find((x) => x.peer === ip.srcIp && x.multihop === isMhop && (isMhop || !x.ifname || x.ifname === ingress.name) && (!x.local || x.local === ip.dstIp));
  if (!s) return true; // no session found
  if (p.yourDisc === 0 && s.state !== ST_DOWN && s.state !== ST_ADMIN_DOWN) return true;
  if (isMhop && ip.ttl < s.mhTtl) return true;
  if (!isMhop && !s.pktLocal) s.pktLocal = ip.dstIp;

  const now = wallNow(ctx);
  const out: Pending[] = [];
  s.stats.rxCtrl++;
  s.remoteDisc = p.myDisc;
  s.remoteDiag = p.diag;
  s.remoteDesiredTx = p.desiredMinTx / 1000;
  s.remoteRequiredRx = p.requiredMinRx / 1000;
  s.remoteEchoRx = p.requiredMinEchoRx / 1000;
  s.remoteDetectMult = p.detectMult;

  stateHandler(s, p.state, now, out);
  if (s.polling && p.final) {
    s.polling = false;
    finalHandler(s, now);
  }
  s.detectTO = s.remoteDetectMult * Math.max(s.curRx, s.remoteDesiredTx);
  if (!s.shutdown) s.detectAt = now + s.detectTO;
  if (p.poll) {
    finalHandler(s, now);
    out.push({ s, bytes: packet(s, true) });
  }
  flush(ctx, device, out);
  return true;
}

// --- daemon -----------------------------------------------------------------

function nextDue(device: Device, now: number): number | undefined {
  const rt = peekFeatureState<BfdRuntime>(device, RT);
  const peers = configPeers(device);
  if (!rt) return peers.length ? now : undefined;
  if (JSON.stringify(peers) !== rt.applied) return now;
  let due: number | undefined;
  for (const s of rt.sessions) {
    for (const t of [s.nextTx, s.detectAt]) if (t !== undefined && (due === undefined || t < due)) due = t;
  }
  return due;
}

function tick(ctx: SimContext, device: Device, now: number): boolean {
  const rt0 = peekFeatureState<BfdRuntime>(device, RT);
  if (!rt0 || JSON.stringify(configPeers(device)) !== rt0.applied) reconcileBfd(device, now);
  const rt = peekFeatureState<BfdRuntime>(device, RT);
  if (!rt) return false;
  const out: Pending[] = [];
  for (const s of rt.sessions) {
    if (s.detectAt !== undefined && s.detectAt <= now) {
      s.detectAt = undefined;
      if (s.state === ST_INIT || s.state === ST_UP) sessDown(s, DIAG.CONTROL_EXPIRED, now, out);
    }
    flush(ctx, device, out);
    if (s.nextTx !== undefined && s.nextTx <= now) {
      transmit(ctx, device, s, packet(s, false));
      // AdminDown: bfdd sent its single AdminDown packet and stopped the timer.
      s.nextTx = s.state === ST_ADMIN_DOWN ? undefined : now + s.xmtTO;
    }
  }
  return true;
}

function describe(frame: Frame, verbose: boolean): string | undefined {
  const udp = frame.udp;
  if (!frame.ipv4 || !udp || (udp.dstPort !== BFD_PORT_SINGLEHOP && udp.dstPort !== BFD_PORT_MULTIHOP)) return undefined;
  const data = l4Payload(frame);
  const p = data && decodeBfd(data);
  if (!data || !p) return undefined;
  return tcpdumpBfd(p, udp.dstPort, data.length, verbose);
}

registerDaemon({ id: "bfd", nextDue, tick, receiveL3: receive, describe });

// --- client API (lib/control/bfd-api.ts) ------------------------------------

const API_STATE: BfdState[] = ["admin-down", "down", "init", "up"];

setBfdImpl({
  register(device, key, client) {
    const rt = runtime(device);
    let s = rt.sessions.find((x) => x.peer === key.peer);
    if (!s) s = newSession(rt, key, Date.now());
    if (!s.clients.includes(client)) s.clients.push(client);
  },
  unregister(device, peer, client) {
    const rt = peekFeatureState<BfdRuntime>(device, RT);
    const s = rt?.sessions.find((x) => x.peer === peer);
    if (!rt || !s) return;
    s.clients = s.clients.filter((c) => c !== client);
    if (s.clients.length === 0 && !s.configured) rt.sessions = rt.sessions.filter((x) => x !== s);
  },
  state(device, peer) {
    const s = findSession(device, peer);
    return s ? API_STATE[s.state] : undefined;
  },
});
