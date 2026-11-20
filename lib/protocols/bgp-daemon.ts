/**
 * BGP-4 control-plane daemon (FRR 10.3 bgpd behaviour), registered with
 * lib/control/daemon.ts. Runs on routers and SONiC switches with `router bgp`.
 *
 * Transport — a minimal but real TCP per session on port 179 (lib/control/packet
 * sendIpv4 builds checksummed segments routed like any packet):
 *   active open  SYN from an ephemeral port (32768-60999), SYN-ACK, ACK; the
 *                passive side listens on 179. BGP messages are PSH/ACK segments
 *                with seq/ack accounting; FIN/ACK handshake on close, RST for
 *                segments that match no connection (unconfigured peer, shutdown).
 *   Simplified   no retransmission, no delayed/pure ACKs for data (every data
 *                segment piggybacks the ACK), no window management, no options.
 *                Connection collision (RFC 4271 §6.8) simplified: an incoming SYN
 *                replaces our own unanswered SYN; a SYN while a connection is
 *                already in OpenSent/OpenConfirm/Established is answered with RST.
 *                Packets are processed through a FIFO (receive queue) so each
 *                TCP stream is handled strictly in order even though the engine
 *                delivers frames synchronously.
 *
 * FSM (RFC 4271 §8; FRR bgp_fsm.c table :2440+): Idle → Connect (SYN sent) →
 * OpenSent (TCP up, OPEN sent; hold 240 s per RFC 4271 §8.2.2) → OpenConfirm (OPEN
 * accepted, KEEPALIVE sent) → Established (KEEPALIVE received). Connect failure /
 * RST → Active; ConnectRetry timer 30 s, doubling to 120 s when not configured
 * (bgpd.h:2132-2133, bgp_fsm.c:500-501). After any reset the peer restarts from
 * Idle after a 1 s idle-hold (BGP_INIT_START_TIMER, bgpd.h:2125).
 *
 * Timers: keepalive 60 / hold 180 (FRR "traditional" profile — bgp_vty.h:13-23;
 * SONiC's debian/rules builds FRR without --with-defaults=datacenter). Negotiated
 * hold = min(local, remote), keepalive = min(configured, hold/3) (bgp_packet.c:
 * 2048-2069). Hold expiry → NOTIFICATION 4 (Hold Timer Expired) → Idle.
 *
 * RIB: Adj-RIB-In per peer, Loc-RIB best path in FRR bgp_path_info_cmp order
 * (bgp_route.c:722, steps 1-15: weight, local-pref, local route, AS-path length,
 * origin, MED (same neighbour AS), eBGP over iBGP, IGP metric (always 0 here),
 * oldest eBGP path, lowest router-id, lowest peer address). Inbound loop check
 * drops paths containing our AS (bgp_route.c:5023). Outbound: never back to the
 * sender (:2291), iBGP split horizon, eBGP prepends our AS + next-hop-self, MED
 * only for locally originated routes, LOCAL_PREF only to iBGP (bgp_attr.c:4660).
 * Best paths from peers are installed into device.routingTable as type "bgp"
 * (distance 20 eBGP / 200 iBGP) and withdrawn when the session drops.
 * `network` honours FRR's import-check (bgp_vty.c:72-79): it is originated only
 * while an exact route exists in the RIB.
 *
 * fast-external-failover (default on, bgp_zebra.c:273-286): when the interface of
 * a directly connected eBGP session goes down the session is stopped at once
 * (last reset "Interface down"). BFD (`neighbor X bfd`): up→down stops the
 * session with Cease/BFD Down (bgp_bfd.c:66-72).
 *
 * Policy (./bgp-policy.ts): per neighbour and address family, inbound prefix-list,
 * filter-list, weight and route-map (bgp_input_filter / bgp_input_modifier) are
 * applied to the raw Adj-RIB-In when the table is built, so a policy change takes
 * effect at once like FRR's automatic soft reconfiguration on route-map /
 * prefix-list updates; outbound filters and route-maps run per peer
 * (subgroup_announce_check). Well-known communities no-advertise / no-export /
 * local-AS are honoured outbound. Multipath (bgp_mpath.c): `maximum-paths`
 * (default multipath_num = 256 — bgpd.c:3489-3493, SONiC debian/rules:70
 * --enable-multipath=256) equal-cost paths are installed as ECMP routes.
 *
 * IPv6 unicast (RFC 4760 / RFC 2545): `address-family ipv6 unicast` →
 * `neighbor X activate` adds MP capability AFI 2 / SAFI 1; routes travel in
 * MP_REACH/MP_UNREACH over the IPv4 session and are installed into
 * device.routingTable6 (type "bgp", distance 20/200).
 *
 * VRF instances (`router bgp <as> vrf <name>`): each has its own peers, runtime
 * (feature "bgpd:<vrf>"), TCP sessions sourced/routed in the VRF and routes
 * tagged Route.vrf. Redistribution: `redistribute connected|static|ospf
 * [route-map R] [metric N]` per address family; `table-map R` filters/sets on
 * RIB install.
 *
 * L2VPN EVPN (RFC 7432 / RFC 8365) — `address-family l2vpn evpn`:
 *   `neighbor X activate` adds the MP capability AFI 25 / SAFI 70 to the OPEN
 *   (bgp_open.c bgp_open_capability: every activated AF, IPv4 unicast first); the
 *   AF is up when both sides sent it. Activating/deactivating on a live session
 *   resets it (Cease/Other Configuration Change, last reset "Address family
 *   activated" — bgpd.c:2433). EVPN routes travel in their own UPDATEs
 *   (MP_REACH/MP_UNREACH, ./bgp-wire.ts encodeEvpnUpdate) and live in a separate
 *   per-peer Adj-RIB-In/Out keyed by RD + prefix. Best path uses the same
 *   bgp_path_info_cmp order. EVPN next hops are never rewritten — not even towards
 *   eBGP peers (bgp_updgrp_packet.c:577-590 "No route-map changes allowed for EVPN
 *   nexthops") — and must resolve through any route, BGP included (no
 *   directly-connected check for SAFI_EVPN, bgp_route.c bgp_update). Local routes
 *   (type-2 MAC/IP, type-3 IMET with `advertise-all-vni`) and the import of the
 *   Loc-RIB into VNIs belong to the VXLAN module, which registers an
 *   EvpnProvider (lib/protocols/vxlan-daemon.ts) — bgpd only carries the routes.
 */
import { Device, findInterface, isRouter, isSwitch, interfaceByName } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame, TcpHeader } from "../models/packet";
import { Route, isSelectedRoute, longestPrefixMatch, longestPrefixMatch6 } from "../models/route";
import { cidrContains, networkAddress } from "../models/ip";
import { isLinkLocal6, networkAddress6, sameSubnet6 } from "../models/ipv6";
import { vrfOf } from "../models/vrf";
import { ipOutput } from "./ipv4";
import { featureState, peekFeatureState } from "../models/feature-state";
import { SimContext } from "../engine/context";
import { registerDaemon } from "../control/daemon";
import { sendIpv4, l4Payload, ownsAddress, ipv4Packet, tcpSegment } from "../control/packet";
import { bfd } from "../control/bfd-api";
import { logEvent } from "../control/syslog";
import { BgpConfig, BgpNeighbor, BgpSummary, RedistProto, afConfig, bgpVrfNames, getBgpConfig } from "./bgp";
import { Af, COMMUNITY, applyRouteMap, asPathListPermits, policySig, prefixListPermits, sortCommunities } from "./bgp-policy";
import {
  BGP_PORT,
  BgpDecodeError,
  BgpMsg,
  OpenMsg,
  PathAttrs,
  UpdateMsg,
  capAs4,
  capEnhancedRr,
  capExtMessage,
  capFqdn,
  capMp,
  capRefresh,
  decodeMessages,
  describeBgpPayload,
  encodeKeepalive,
  encodeNotification,
  encodeOpen,
  encodeUpdate,
  encodeEvpnUpdate,
  encodeV6Update,
  EvpnAttrs,
  notifyText,
  openAs,
  openHostname,
} from "./bgp-wire";
import { AFI_L2VPN, SAFI_EVPN, EvpnRoute, Pmsi, evpnKey, sortEcs } from "./evpn-wire";
import { featureEnabled } from "./cpu-features";

/** bgpd runs in the bgp container: while `config feature state bgp disabled` it has no config (sessions torn down, routes withdrawn). */
const liveBgpConfig = (d: Device, vrf?: string) => (featureEnabled(d, "bgp") ? getBgpConfig(d, vrf) : undefined);

// ---------------------------------------------------------------------------
// Defaults (sources in the module comment)
export const BGP_DEFAULTS = { keepalive: 60, holdtime: 180, connectRetry: 30, maxConnectRetry: 120, openHold: 240, idleHold: 1, localPref: 100, maxPaths: 256 };
const SYN_WINDOW = 64240;
const DATA_WINDOW = 502;

export type FsmState = "Idle" | "Connect" | "Active" | "OpenSent" | "OpenConfirm" | "Established";

interface Tcb {
  state: "SYN_SENT" | "SYN_RCVD" | "ESTABLISHED" | "FIN_WAIT" | "CLOSE_WAIT";
  localIp: string;
  localPort: number;
  remotePort: number;
  sndNxt: number;
  rcvNxt: number;
  ifaceId?: string;
}

export interface BgpPath {
  origin: number;
  asPath: number[];
  nextHop: string;
  med?: number;
  localPref?: number;
  weight: number;
  /** Peer address, or "0.0.0.0" for locally originated routes. */
  peer: string;
  peerRid: string;
  ebgp: boolean;
  local?: "network" | "redistribute";
  sinceMs: number;
  /** COMMUNITY attribute (sorted). */
  communities?: number[];
  /** IPv6: link-local next hop from a 32-byte MP_REACH next hop. */
  nextHopLL?: string;
  /** IGP cost to the next hop (best-path step 8), filled when the table is built. */
  igpMetric?: number;
  /** Neighbour AS (eBGP multipath needs the same one). */
  peerAs?: number;
  /** Redistributed route's source protocol. */
  proto?: string;
}

/** An L2VPN EVPN path (route + attributes). */
export interface EvpnPath extends BgpPath {
  route: EvpnRoute;
  extComms: number[][];
  pmsi?: Pmsi;
}

export interface MsgCounters {
  open: number;
  update: number;
  notify: number;
  keepalive: number;
  refresh: number;
}

export interface PeerRt {
  peer: string;
  state: FsmState;
  tcb?: Tcb;
  connectAt?: number;
  holdAt?: number;
  kaAt?: number;
  /** Current ConnectRetry interval (s). */
  vConnect: number;
  /** Negotiated hold / keepalive (s). */
  holdTime: number;
  keepalive: number;
  remoteAs?: number;
  remoteId?: string;
  remoteHost?: string;
  as4: boolean;
  capsRcvd: number[];
  sent: MsgCounters;
  rcvd: MsgCounters;
  uptimeMs?: number;
  lastReadMs?: number;
  lastWriteMs?: number;
  established: number;
  dropped: number;
  lastReset?: { atMs: number; reason: string; notify?: { code: number; subcode: number; dir: "sent" | "received" } };
  adjIn: Record<string, BgpPath>;
  /** Adj-RIB-Out: prefix → attribute signature last advertised. */
  adjOut: Record<string, string>;
  aspathLoop: number;
  /** Config fields whose change resets the session. */
  cfgSig: string;
  bfdReg?: boolean;
  bfdLast?: string;
  /** Multiprotocol capabilities the peer sent ("afi/safi"). */
  mpRcvd?: string[];
  /** L2VPN EVPN Adj-RIB-In: RD|prefix → path. */
  evpnIn?: Record<string, EvpnPath>;
  /** L2VPN EVPN Adj-RIB-Out: RD|prefix → attribute signature + route (for withdraws). */
  evpnOut?: Record<string, { sig: string; route: EvpnRoute }>;
  /** IPv6 unicast Adj-RIB-In / Adj-RIB-Out (signatures). */
  adjIn6?: Record<string, BgpPath>;
  adjOut6?: Record<string, string>;
  /** Advertised paths as `show ... advertised-routes` displays them (post-policy). */
  advOut?: Record<string, BgpPath>;
  advOut6?: Record<string, BgpPath>;
}

export interface BgpRt {
  localAs: number;
  routerId: string;
  peers: Record<string, PeerRt>;
  tableVersion: number;
  /** prefix → "peer|attr-signature" of the selected path. */
  best: Record<string, string>;
  /** Signature of every input (config, RIB, links); a change makes the daemon due. */
  sig: string;
  dirty?: boolean;
  /** EVPN Loc-RIB: RD|prefix → "peer|signature" of the selected path. */
  evpnBest?: Record<string, string>;
  /** IPv6 unicast Loc-RIB. */
  best6?: Record<string, string>;
  /** Signature of the BGP routes this instance installed (re-install when something else wiped them). */
  installed?: string;
}

// ---------------------------------------------------------------------------
// L2VPN EVPN hand-off to the VXLAN module

export interface EvpnLocalRoute {
  route: EvpnRoute;
  nextHop: string;
  extComms: number[][];
  pmsi?: Pmsi;
}

export interface EvpnProvider {
  /** Routes this VTEP originates (called only with `advertise-all-vni`). */
  localRoutes(device: Device, cfg: BgpConfig, routerId: string): EvpnLocalRoute[];
  /** The EVPN Loc-RIB changed (best paths, local ones included): import into VNIs. */
  ribChanged(ctx: SimContext, device: Device, best: EvpnPath[]): void;
  /** VRF routes imported from EVPN (symmetric IRB): owned by the provider, not by a VRF instance's install. */
  ownsRoute?(device: Device, r: Route): boolean;
}

let evpnProvider: EvpnProvider | undefined;
export function setEvpnProvider(p: EvpnProvider): void {
  evpnProvider = p;
}
const evpnOwned = (device: Device, r: Route) => !!evpnProvider?.ownsRoute?.(device, r);

/** EVPN negotiated with this peer: activated locally and the peer sent MP 25/70. */
export function evpnUp(nb: BgpNeighbor | undefined, p: PeerRt | undefined): boolean {
  return !!nb?.evpn && !!p && (p.mpRcvd ?? []).includes(`${AFI_L2VPN}/${SAFI_EVPN}`);
}

/** IPv6 unicast negotiated: activated locally and the peer sent MP 2/1. */
export function v6Up(nb: BgpNeighbor | undefined, p: PeerRt | undefined): boolean {
  return !!nb?.ipv6 && !!p && (p.mpRcvd ?? []).includes("2/1");
}

const zero = (): MsgCounters => ({ open: 0, update: 0, notify: 0, keepalive: 0, refresh: 0 });
export const totalMsgs = (c: MsgCounters) => c.open + c.update + c.notify + c.keepalive + c.refresh;

const rtKey = (vrf: string | undefined) => (!vrf || vrf === "default" ? "bgpd" : `bgpd:${vrf}`);

export function peekBgpRuntime(device: Device, vrf = "default"): BgpRt | undefined {
  return peekFeatureState<BgpRt>(device, rtKey(vrf));
}

/** VRFs with a BGP instance configured or still running (default first). */
function instanceVrfs(device: Device): string[] {
  const live = Object.keys(device.config.features ?? {})
    .filter((k) => k.startsWith("bgpd:"))
    .map((k) => k.slice(5));
  return [...new Set(["default", ...bgpVrfNames(device), ...live])];
}

const vrfOfCfg = (cfg: BgpConfig | undefined) => cfg?.vrf ?? "default";

/** Signature of the BGP routes installed for one VRF (both tables). */
function installedSig(device: Device, vrf: string): string {
  const mine = (r: Route) => r.type === "bgp" && (r.vrf ?? "default") === vrf && !evpnOwned(device, r);
  return [...device.routingTable.filter(mine), ...(device.routingTable6 ?? []).filter(mine)].map((r) => `${r.destination}/${r.prefix}>${r.nextHop}`).join(",");
}

const runsBgp = (d: Device) => (isRouter(d.type) || isSwitch(d.type)) && d.state !== "down";

// ---------------------------------------------------------------------------
// helpers

const ipInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0) >>> 0;

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Router-id: configured, else the highest interface address (zebra router-id). */
export function bgpRouterId(device: Device, cfg: BgpConfig): string {
  if (cfg.routerId) return cfg.routerId;
  const ips = device.interfaces.filter((i) => vrfOf(device, i) === vrfOfCfg(cfg)).flatMap((i) => i.ipv4.map((a) => a.address));
  if (!ips.length) return "0.0.0.0";
  return ips.reduce((a, b) => (ipInt(b) > ipInt(a) ? b : a));
}

const isEbgp = (cfg: BgpConfig, nb: BgpNeighbor) => nb.remoteAs !== cfg.localAs;

function nbCfg(cfg: BgpConfig, peer: string): BgpNeighbor | undefined {
  return cfg.neighbors.find((n) => n.peer === peer);
}

/** Non-BGP route used to reach an address (connected/static/OSPF), with its egress interface. */
function igpLookup(device: Device, ip: string, vrf = "default"): { route: Route; iface: NetInterface } | undefined {
  const m = longestPrefixMatch(
    device.routingTable.filter((r) => r.type !== "bgp"),
    ip,
    vrf,
  );
  const iface = m ? findInterface(device, m.route.interfaceId) : undefined;
  return m && iface ? { route: m.route, iface } : undefined;
}

function nextHopUsable(device: Device, nh: string, vrf = "default"): NetInterface | undefined {
  const r = igpLookup(device, nh, vrf);
  return r && r.iface.operState === "up" && r.iface.adminState === "up" ? r.iface : undefined;
}

function inputSig(device: Device, cfg: BgpConfig | undefined): string {
  const routes = [...device.routingTable, ...(device.routingTable6 ?? [])]
    .filter((r) => r.type !== "bgp")
    .map((r) => `${r.vrf ?? ""}:${r.destination}/${r.prefix}:${r.metric}:${r.interfaceId}:${r.type}:${r.nextHop}`)
    .join(",");
  const links = device.interfaces.map((i) => `${i.id}:${i.operState}:${i.adminState}:${i.ipv4.map((a) => a.address).join("+")}:${i.ipv6.map((a) => a.address).join("+")}:${vrfOf(device, i)}`).join(",");
  return JSON.stringify([cfg ?? null, routes, links, cfg ? policySig(device) : ""]);
}

function peerCfgSig(_cfg: BgpConfig, nb: BgpNeighbor): string {
  return JSON.stringify([nb.remoteAs, nb.updateSource, nb.ebgpMultihop, !!nb.evpn, !!nb.ipv6]);
}

function newPeer(cfg: BgpConfig, nb: BgpNeighbor, now: number): PeerRt {
  return {
    peer: nb.peer,
    state: "Idle",
    connectAt: nb.shutdown || nb.remoteAs === undefined ? undefined : now,
    vConnect: nb.connectRetry ?? BGP_DEFAULTS.connectRetry,
    holdTime: 0,
    keepalive: 0,
    as4: true,
    capsRcvd: [],
    sent: zero(),
    rcvd: zero(),
    established: 0,
    dropped: 0,
    adjIn: {},
    adjOut: {},
    aspathLoop: 0,
    cfgSig: peerCfgSig(cfg, nb),
  };
}

function emit(ctx: SimContext, device: Device, type: "BGP_OPEN" | "BGP_ESTABLISHED" | "BGP_UPDATE" | "BGP_ROUTE", message: string): void {
  ctx.emit({ type, deviceId: device.id, deviceName: device.name, message: `${device.name}: ${message}`, osiLayers: [7] });
}

// ---------------------------------------------------------------------------
// receive queue: frames are handled strictly FIFO so each TCP stream stays in order

interface Pending {
  ctx: SimContext;
  device: Device;
  ingressId: string;
  frame: Frame;
}
let queue: Pending[] = [];
let draining = false;

function withDrain<T>(fn: () => T): T {
  if (draining) return fn();
  draining = true;
  try {
    const r = fn();
    while (queue.length) {
      const it = queue.shift()!;
      processSegment(it.ctx, it.device, it.ingressId, it.frame);
    }
    return r;
  } finally {
    draining = false;
    queue = [];
  }
}

// ---------------------------------------------------------------------------
// TCP

function ttlFor(cfg: BgpConfig, nb: BgpNeighbor): number {
  if (!isEbgp(cfg, nb)) return 255;
  return nb.ebgpMultihop ?? 1; // BGP_DEFAULT_TTL (bgpd.h:983)
}

const tcpFlagText = (flags: string[]) => {
  const order = ["FIN", "SYN", "RST", "PSH", "URG"];
  const ch: Record<string, string> = { FIN: "F", SYN: "S", RST: "R", PSH: "P", URG: "U" };
  return order.filter((f) => flags.includes(f)).map((f) => ch[f]).join("") + (flags.includes("ACK") ? "." : "");
};

function sendSegment(ctx: SimContext, device: Device, cfg: BgpConfig, nb: BgpNeighbor, tcb: Tcb, flags: TcpHeader["flags"], payload: number[], summary: string): boolean {
  const syn = flags.includes("SYN");
  const seq = syn ? (tcb.sndNxt - 1) >>> 0 : tcb.sndNxt;
  const tcp: TcpHeader = {
    srcPort: tcb.localPort,
    dstPort: tcb.remotePort,
    seq,
    ack: flags.includes("ACK") ? tcb.rcvNxt : 0,
    flags,
    window: syn ? SYN_WINDOW : DATA_WINDOW,
  };
  if (!syn) tcb.sndNxt = (tcb.sndNxt + payload.length + (flags.includes("FIN") ? 1 : 0)) >>> 0;
  const r = sendTcp(ctx, device, vrfOfCfg(cfg), { src: tcb.localIp, dst: nb.peer, ttl: ttlFor(cfg, nb), tos: 0xc0, tcp, payload, summary: `BGP ${summary} [${tcpFlagText(flags)}] ${tcb.localIp}:${tcb.localPort} → ${nb.peer}:${tcb.remotePort}` });
  return r.ok;
}

/** sendIpv4, routed in the instance's VRF (lib/control/packet sendIpv4 has no VRF option). */
function sendTcp(ctx: SimContext, device: Device, vrf: string, o: { src: string; dst: string; ttl: number; tos: number; tcp: TcpHeader; payload: number[]; summary: string }) {
  if (vrf === "default") return sendIpv4(ctx, device, o);
  const rawL3 = ipv4Packet({ src: o.src, dst: o.dst, proto: 6, ttl: o.ttl, tos: o.tos, payload: tcpSegment(o.src, o.dst, o.tcp, o.payload) });
  return ipOutput(ctx, device, { srcIp: o.src, dstIp: o.dst, ttl: o.ttl, protocol: "TCP", identification: 0, tcp: o.tcp, rawL3, upperBytes: 0, summary: o.summary, vrf });
}

/** Bare RST for a segment that matches no connection (RFC 793 reset generation). */
function sendRstVrf(ctx: SimContext, device: Device, frame: Frame, payloadLen: number, vrf = "default"): void {
  const ip = frame.ipv4!;
  const t = frame.tcp!;
  const hasAck = t.flags.includes("ACK");
  const tcp: TcpHeader = hasAck
    ? { srcPort: t.dstPort, dstPort: t.srcPort, seq: t.ack, ack: 0, flags: ["RST"], window: 0 }
    : { srcPort: t.dstPort, dstPort: t.srcPort, seq: 0, ack: (t.seq + payloadLen + (t.flags.includes("SYN") ? 1 : 0)) >>> 0, flags: ["RST", "ACK"], window: 0 };
  sendTcp(ctx, device, vrf, { src: ip.dstIp, dst: ip.srcIp, ttl: 64, tos: 0, tcp, payload: [], summary: `TCP RST ${ip.dstIp}:${t.dstPort} → ${ip.srcIp}:${t.srcPort}` });
}

function sendMsg(ctx: SimContext, device: Device, cfg: BgpConfig, nb: BgpNeighbor, p: PeerRt, bytes: number[], kind: keyof MsgCounters, now: number): boolean {
  if (!p.tcb || p.tcb.state !== "ESTABLISHED") return false;
  p.sent[kind]++;
  p.lastWriteMs = now;
  const name = { open: "OPEN", update: "UPDATE", notify: "NOTIFICATION", keepalive: "KEEPALIVE", refresh: "ROUTE-REFRESH" }[kind];
  return sendSegment(ctx, device, cfg, nb, p.tcb, ["PSH", "ACK"], bytes, name);
}

// ---------------------------------------------------------------------------
// FSM actions

function localAddressFor(device: Device, nb: BgpNeighbor, vrf = "default"): { ip: string; iface: NetInterface } | undefined {
  const route = igpLookup(device, nb.peer, vrf);
  if (nb.updateSource) {
    const byName = interfaceByName(device, nb.updateSource);
    const iface = byName ?? device.interfaces.find((i) => i.ipv4.some((a) => a.address === nb.updateSource));
    const ip = byName ? primaryIpv4(byName)?.address : nb.updateSource;
    if (!iface || !ip || !route) return undefined;
    return { ip, iface: route.iface };
  }
  if (!route) return undefined;
  const ip = primaryIpv4(route.iface)?.address;
  return ip ? { ip, iface: route.iface } : undefined;
}

function startConnect(ctx: SimContext, device: Device, cfg: BgpConfig, nb: BgpNeighbor, p: PeerRt, now: number): void {
  const fail = () => {
    p.tcb = undefined;
    p.state = "Active";
    p.connectAt = now + p.vConnect * 1000;
  };
  const local = localAddressFor(device, nb, vrfOfCfg(cfg));
  // eBGP single-hop needs a directly connected peer (FRR: "not directly connected").
  const route = igpLookup(device, nb.peer, vrfOfCfg(cfg));
  if (!local || local.iface.operState !== "up" || (isEbgp(cfg, nb) && !nb.ebgpMultihop && route?.route.nextHop)) return fail();
  const iss = hash32(`${device.id}|${nb.peer}|${now}|iss`);
  const tcb: Tcb = { state: "SYN_SENT", localIp: local.ip, localPort: 32768 + (hash32(`${device.id}|${nb.peer}|${now}`) % 28232), remotePort: BGP_PORT, sndNxt: (iss + 1) >>> 0, rcvNxt: 0, ifaceId: local.iface.id };
  p.tcb = tcb;
  p.state = "Connect";
  p.connectAt = now + p.vConnect * 1000;
  if (!sendSegment(ctx, device, cfg, nb, tcb, ["SYN"], [], "SYN")) fail();
}

/** TCP connection up (either side): send OPEN, enter OpenSent. */
function tcpEstablished(ctx: SimContext, device: Device, cfg: BgpConfig, nb: BgpNeighbor, p: PeerRt, now: number): void {
  p.state = "OpenSent";
  p.connectAt = undefined;
  p.holdAt = now + BGP_DEFAULTS.openHold * 1000;
  const hold = nb.holdtime ?? cfg.holdtime ?? BGP_DEFAULTS.holdtime;
  const open = encodeOpen({
    version: 4,
    myAs: cfg.localAs!,
    holdTime: hold,
    bgpId: bgpRouterId(device, cfg),
    caps: [capMp(1, 1), ...(nb.ipv6 ? [capMp(2, 1)] : []), ...(nb.evpn ? [capMp(AFI_L2VPN, SAFI_EVPN)] : []), capRefresh(), capEnhancedRr(), capAs4(cfg.localAs!), capExtMessage(), capFqdn(device.config.hostname || device.name)],
  });
  emit(ctx, device, "BGP_OPEN", `BGP OPEN AS${cfg.localAs} id ${bgpRouterId(device, cfg)} hold ${hold}s → ${nb.peer} (TCP/179)`);
  sendMsg(ctx, device, cfg, nb, p, open, "open", now);
}

interface StopOpts {
  reason: string;
  notify?: { code: number; subcode: number };
  /** Notification received from the peer (recorded, not sent). */
  received?: { code: number; subcode: number };
}

/** BGP_Stop: optional NOTIFICATION, close TCP, flush routes, back to Idle. */
function stopPeer(ctx: SimContext, device: Device, cfg: BgpConfig | undefined, p: PeerRt, now: number, o: StopOpts): void {
  const nb = cfg ? nbCfg(cfg, p.peer) : undefined;
  const wasUp = p.state === "Established";
  if (o.notify && p.tcb?.state === "ESTABLISHED" && cfg && nb && (p.state === "OpenSent" || p.state === "OpenConfirm" || p.state === "Established")) {
    sendMsg(ctx, device, cfg, nb, p, encodeNotification(o.notify.code, o.notify.subcode), "notify", now);
  }
  if (p.tcb) {
    if (p.tcb.state === "ESTABLISHED" && cfg && nb) {
      const tcb = p.tcb;
      tcb.state = "FIN_WAIT";
      sendSegment(ctx, device, cfg, nb, tcb, ["FIN", "ACK"], [], "FIN");
    } else if (p.tcb.state !== "FIN_WAIT" && p.tcb.state !== "CLOSE_WAIT") p.tcb = undefined;
  }
  if (wasUp) {
    p.dropped++;
    p.uptimeMs = now;
  }
  const notify = o.notify ? { ...o.notify, dir: "sent" as const } : o.received ? { ...o.received, dir: "received" as const } : undefined;
  p.lastReset = { atMs: now, reason: o.reason, notify };
  p.state = "Idle";
  p.holdAt = undefined;
  p.kaAt = undefined;
  p.adjIn = {};
  p.adjOut = {};
  p.evpnIn = {};
  p.evpnOut = {};
  p.adjIn6 = {};
  p.adjOut6 = {};
  p.advOut = {};
  p.advOut6 = {};
  p.connectAt = !nb || nb.shutdown || nb.remoteAs === undefined ? undefined : now + BGP_DEFAULTS.idleHold * 1000;
  const rt = peekBgpRuntime(device, vrfOfCfg(cfg));
  if (rt) rt.dirty = true;
  if (wasUp) emit(ctx, device, "BGP_ESTABLISHED", `BGP neighbor ${p.peer} Down ${o.reason}${notify ? ` (${notifyText(notify.code, notify.subcode)})` : ""}`);
  // bgp_fsm.c:1383-1395 (bgp log-neighbor-changes, set by SONiC's bgpd.main.conf.j2:72): "%pBP" = host(hostname|Unknown).
  if (wasUp) logEvent(device, now, "INFO", "bgp#bgpd", `%ADJCHANGE: neighbor ${p.peer}(${p.remoteHost ?? "Unknown"}) in vrf ${vrfOfCfg(cfg)} Down ${o.reason}`);
}

// ---------------------------------------------------------------------------
// message handling

function negotiate(cfg: BgpConfig, nb: BgpNeighbor, p: PeerRt, remoteHold: number): void {
  const configured = nb.holdtime !== undefined;
  const sendHold = configured ? nb.holdtime! : cfg.holdtime ?? BGP_DEFAULTS.holdtime;
  p.holdTime = Math.min(remoteHold, sendHold);
  p.keepalive = Math.floor(p.holdTime / 3);
  const ka = configured ? nb.keepalive : cfg.keepalive ?? BGP_DEFAULTS.keepalive;
  if (ka && ka < p.keepalive) p.keepalive = ka;
}

function handleOpen(ctx: SimContext, device: Device, cfg: BgpConfig, nb: BgpNeighbor, p: PeerRt, m: OpenMsg, now: number): void {
  if (p.state !== "OpenSent") {
    const sub = p.state === "OpenConfirm" ? 2 : p.state === "Established" ? 3 : 0;
    return stopPeer(ctx, device, cfg, p, now, { reason: "BGP Notification send", notify: { code: 5, subcode: sub } });
  }
  const { as, as4 } = openAs(m);
  const bad = (subcode: number) => stopPeer(ctx, device, cfg, p, now, { reason: "BGP Notification send", notify: { code: 2, subcode } });
  if (m.version !== 4) return bad(1);
  if (as !== nb.remoteAs) return bad(2); // bgp_packet.c:1850 BGP_NOTIFY_OPEN_BAD_PEER_AS
  if (!isEbgp(cfg, nb) && m.bgpId === bgpRouterId(device, cfg)) return bad(3);
  if (m.holdTime !== 0 && m.holdTime < 3) return bad(6); // bgp_packet.c:2025
  p.remoteAs = as;
  p.remoteId = m.bgpId;
  p.as4 = as4;
  p.remoteHost = openHostname(m);
  p.capsRcvd = m.caps.map((c) => c.code);
  p.mpRcvd = m.caps.filter((c) => c.code === 1 && c.value.length === 4).map((c) => `${(c.value[0] << 8) | c.value[1]}/${c.value[3]}`);
  negotiate(cfg, nb, p, m.holdTime);
  p.state = "OpenConfirm";
  p.holdAt = p.holdTime ? now + p.holdTime * 1000 : undefined;
  p.kaAt = p.keepalive ? now + p.keepalive * 1000 : undefined;
  sendMsg(ctx, device, cfg, nb, p, encodeKeepalive(), "keepalive", now);
}

function handleKeepalive(ctx: SimContext, device: Device, cfg: BgpConfig, nb: BgpNeighbor, p: PeerRt, now: number): void {
  if (p.state === "OpenSent") return stopPeer(ctx, device, cfg, p, now, { reason: "BGP Notification send", notify: { code: 5, subcode: 1 } });
  p.holdAt = p.holdTime ? now + p.holdTime * 1000 : undefined;
  if (p.state !== "OpenConfirm") return;
  p.state = "Established";
  p.established++;
  p.uptimeMs = now;
  p.vConnect = nb.connectRetry ?? BGP_DEFAULTS.connectRetry;
  emit(ctx, device, "BGP_ESTABLISHED", `BGP neighbor ${p.peer} (AS${p.remoteAs}) Up — Established`);
  logEvent(device, now, "INFO", "bgp#bgpd", `%ADJCHANGE: neighbor ${p.peer}(${p.remoteHost ?? "Unknown"}) in vrf ${vrfOfCfg(cfg)} Up`); // bgp_fsm.c:2172-2178
  peekBgpRuntime(device, vrfOfCfg(cfg))!.dirty = true;
  converge(ctx, device, now, vrfOfCfg(cfg));
}

function handleUpdate(ctx: SimContext, device: Device, cfg: BgpConfig, nb: BgpNeighbor, p: PeerRt, m: UpdateMsg, now: number): void {
  if (p.state !== "Established") {
    const sub = p.state === "OpenSent" ? 1 : 2;
    return stopPeer(ctx, device, cfg, p, now, { reason: "BGP Notification send", notify: { code: 5, subcode: sub } });
  }
  p.holdAt = p.holdTime ? now + p.holdTime * 1000 : undefined;
  for (const w of m.withdrawn) delete p.adjIn[w];
  if (m.attrs) {
    const a = m.attrs;
    for (const pfx of m.nlri) {
      if (a.asPath.includes(cfg.localAs!)) {
        // "as-path contains our own AS;" — filtered, implicit withdraw of any older path.
        p.aspathLoop++;
        delete p.adjIn[pfx];
        continue;
      }
      const old = p.adjIn[pfx];
      const comms = a.communities?.length ? sortCommunities(a.communities) : undefined;
      const sameAttrs = old && attrSig(old) === attrSig({ ...a, communities: comms, weight: 0 });
      p.adjIn[pfx] = { origin: a.origin, asPath: a.asPath, nextHop: a.nextHop, med: a.med, localPref: a.localPref, communities: comms, weight: 0, peer: p.peer, peerRid: p.remoteId ?? p.peer, peerAs: p.remoteAs, ebgp: isEbgp(cfg, nb), sinceMs: sameAttrs ? old.sinceMs : now };
    }
  }
  if ((m.v6Reach || m.v6Unreach) && v6Up(nb, p)) {
    const in6 = (p.adjIn6 ??= {});
    for (const w of m.v6Unreach ?? []) delete in6[w];
    if (m.v6Reach && m.attrs) {
      const a = m.attrs;
      for (const pfx of m.v6Reach.nlri) {
        if (a.asPath.includes(cfg.localAs!)) {
          p.aspathLoop++;
          delete in6[pfx];
          continue;
        }
        const comms = a.communities?.length ? sortCommunities(a.communities) : undefined;
        const path: BgpPath = { origin: a.origin, asPath: a.asPath, nextHop: m.v6Reach.nextHop, nextHopLL: m.v6Reach.nextHopLL, med: a.med, localPref: a.localPref, communities: comms, weight: 0, peer: p.peer, peerRid: p.remoteId ?? p.peer, peerAs: p.remoteAs, ebgp: isEbgp(cfg, nb), sinceMs: now };
        const old = in6[pfx];
        if (old && attrSig(old) === attrSig(path)) path.sinceMs = old.sinceMs;
        in6[pfx] = path;
      }
    }
  }
  if ((m.evpnReach || m.evpnUnreach) && evpnUp(nb, p)) {
    // Not negotiated → ignored (bgp_mp_reach_parse: AFI/SAFI not activated).
    const ein = (p.evpnIn ??= {});
    for (const r of m.evpnUnreach ?? []) delete ein[evpnKey(r)];
    if (m.evpnReach && m.attrs) {
      const a = m.attrs;
      for (const r of m.evpnReach.nlri) {
        const k = evpnKey(r);
        if (a.asPath.includes(cfg.localAs!)) {
          p.aspathLoop++;
          delete ein[k];
          continue;
        }
        const path: EvpnPath = { origin: a.origin, asPath: a.asPath, nextHop: m.evpnReach.nextHop, med: a.med, localPref: a.localPref, weight: 0, peer: p.peer, peerRid: p.remoteId ?? p.peer, ebgp: isEbgp(cfg, nb), sinceMs: now, route: r, extComms: sortEcs(a.extComms ?? []), pmsi: a.pmsi };
        const old = ein[k];
        if (old && evpnSig(old) === evpnSig(path)) path.sinceMs = old.sinceMs;
        ein[k] = path;
      }
    }
  }
  const nEvpn = (m.evpnReach?.nlri.length ?? 0) + (m.evpnUnreach?.length ?? 0);
  const n6 = (m.v6Reach?.nlri.length ?? 0) + (m.v6Unreach?.length ?? 0);
  emit(ctx, device, "BGP_UPDATE", `BGP UPDATE from ${p.peer}: ${n6 ? `${m.v6Reach?.nlri.length ?? 0} IPv6 prefix(es)${m.v6Unreach?.length ? `, ${m.v6Unreach.length} withdrawn` : ""}` : nEvpn ? `${m.evpnReach?.nlri.length ?? 0} EVPN route(s)${m.evpnUnreach?.length ? `, ${m.evpnUnreach.length} withdrawn` : ""}` : `${m.nlri.length} prefix(es)${m.withdrawn.length ? `, ${m.withdrawn.length} withdrawn` : ""}`}`);
  peekBgpRuntime(device, vrfOfCfg(cfg))!.dirty = true;
  converge(ctx, device, now, vrfOfCfg(cfg));
}

function handleMessage(ctx: SimContext, device: Device, cfg: BgpConfig, nb: BgpNeighbor, p: PeerRt, m: BgpMsg, now: number): void {
  p.lastReadMs = now;
  const kind: keyof MsgCounters = ({ 1: "open", 2: "update", 3: "notify", 4: "keepalive", 5: "refresh" } as const)[m.type];
  p.rcvd[kind]++;
  if (m.type === 1) handleOpen(ctx, device, cfg, nb, p, m, now);
  else if (m.type === 4) handleKeepalive(ctx, device, cfg, nb, p, now);
  else if (m.type === 2) handleUpdate(ctx, device, cfg, nb, p, m, now);
  else if (m.type === 3) {
    // The sender closes the connection after a NOTIFICATION; wait for its FIN.
    if (p.tcb) p.tcb.state = "CLOSE_WAIT";
    stopPeer(ctx, device, cfg, p, now, { reason: "BGP Notification received", received: { code: m.code, subcode: m.subcode } });
  } else if (m.type === 5 && p.state === "Established") {
    for (const k of Object.keys(p.adjOut)) delete p.adjOut[k];
    p.adjOut6 = {};
    converge(ctx, device, now, vrfOfCfg(cfg));
  }
}

function processSegment(ctx: SimContext, device: Device, ingressId: string, frame: Frame): void {
  const ip = frame.ipv4!;
  const vrf = vrfOf(device, device.interfaces.find((i) => i.ipv4.some((a) => a.address === ip.dstIp)));
  const cfg = liveBgpConfig(device, vrf);
  const t = frame.tcp!;
  const payload = l4Payload(frame) ?? new Uint8Array();
  const now = Math.floor(ctx.wallNow());
  const has = (f: string) => t.flags.includes(f);
  const sendRst = (c: SimContext, d: Device, f: Frame, len: number) => sendRstVrf(c, d, f, len, vrf);
  if (!cfg) {
    if (!has("RST")) sendRst(ctx, device, frame, payload.length);
    return;
  }
  const rt = ensureRuntime(device, cfg, now);
  const nb = nbCfg(cfg, ip.srcIp);
  const p = rt.peers[ip.srcIp];
  const tcb = p?.tcb;
  const matches = !!tcb && tcb.remotePort === t.srcPort && tcb.localPort === t.dstPort && tcb.localIp === ip.dstIp;

  if (has("RST")) {
    if (p && matches) {
      if (p.state === "Connect") {
        p.tcb = undefined;
        p.state = "Active"; // TCP_connection_open_failed
      } else if (p.state !== "Idle") stopPeer(ctx, device, cfg, p, now, { reason: "Peer closed the session" });
      else p.tcb = undefined;
    }
    return;
  }

  if (!p || !nb || nb.shutdown || nb.remoteAs === undefined) {
    // Unknown / unconfigured / shut-down peer: refuse the connection.
    sendRst(ctx, device, frame, payload.length);
    return;
  }

  if (has("SYN") && !has("ACK")) {
    if (t.dstPort !== BGP_PORT) return sendRst(ctx, device, frame, 0);
    if (tcb && tcb.state === "ESTABLISHED" && (p.state === "OpenSent" || p.state === "OpenConfirm" || p.state === "Established")) {
      return sendRst(ctx, device, frame, 0); // collision, simplified: keep the existing connection
    }
    const iss = hash32(`${device.id}|${ip.srcIp}|${t.srcPort}|${now}|iss`);
    const ntcb: Tcb = { state: "SYN_RCVD", localIp: ip.dstIp, localPort: BGP_PORT, remotePort: t.srcPort, sndNxt: (iss + 1) >>> 0, rcvNxt: (t.seq + 1) >>> 0, ifaceId: ingressId };
    p.tcb = ntcb;
    sendSegment(ctx, device, cfg, nb, ntcb, ["SYN", "ACK"], [], "SYN-ACK");
    return;
  }

  if (!matches || !tcb) {
    sendRst(ctx, device, frame, payload.length);
    return;
  }

  if (has("SYN") && has("ACK")) {
    if (tcb.state !== "SYN_SENT" || t.ack !== tcb.sndNxt) return sendRst(ctx, device, frame, 0);
    tcb.rcvNxt = (t.seq + 1) >>> 0;
    tcb.state = "ESTABLISHED";
    sendSegment(ctx, device, cfg, nb, tcb, ["ACK"], [], "ACK");
    tcpEstablished(ctx, device, cfg, nb, p, now);
    return;
  }

  if (tcb.state === "SYN_RCVD" && has("ACK") && t.ack === tcb.sndNxt) {
    tcb.state = "ESTABLISHED";
    tcpEstablished(ctx, device, cfg, nb, p, now);
  }

  if (payload.length && (tcb.state === "ESTABLISHED" || tcb.state === "CLOSE_WAIT")) {
    tcb.rcvNxt = (t.seq + payload.length) >>> 0; // no retransmission: accept in-order data as-is
    let msgs: BgpMsg[] = [];
    try {
      msgs = decodeMessages(payload, p.as4);
    } catch (e) {
      if (e instanceof BgpDecodeError) return stopPeer(ctx, device, cfg, p, now, { reason: "BGP Notification send", notify: { code: e.code, subcode: e.subcode } });
      throw e;
    }
    for (const m of msgs) {
      if (p.tcb !== tcb) break; // session reset while handling an earlier message
      handleMessage(ctx, device, cfg, nb, p, m, now);
    }
  }

  if (has("FIN") && p.tcb === tcb) {
    tcb.rcvNxt = (t.seq + payload.length + 1) >>> 0;
    if (tcb.state === "FIN_WAIT") {
      sendSegment(ctx, device, cfg, nb, tcb, ["ACK"], [], "ACK");
      p.tcb = undefined;
      return;
    }
    // Peer closed the connection: answer with our FIN and drop it.
    sendSegment(ctx, device, cfg, nb, tcb, ["FIN", "ACK"], [], "FIN");
    p.tcb = undefined;
    if (p.state !== "Idle") stopPeer(ctx, device, cfg, p, now, { reason: "Peer closed the session" });
    else if (p.state === "Idle" && p.connectAt === undefined && !nb.shutdown) p.connectAt = now + BGP_DEFAULTS.idleHold * 1000;
  }
}

// ---------------------------------------------------------------------------
// RIB

function attrSig(a: PathAttrs & { weight?: number; nextHopLL?: string }): string {
  return `${a.origin}|${a.asPath.join(" ")}|${a.nextHop}|${a.med ?? ""}|${a.localPref ?? ""}|${(a.communities ?? []).join(",")}|${a.nextHopLL ?? ""}`;
}

/**
 * FRR bgp_path_info_cmp (bgp_route.c:722): negative when `a` is better. `reason`
 * receives the deciding step (bgp_path_selection_reason2str, bgp_route.c:9497).
 */
export function comparePaths(a: BgpPath, b: BgpPath, reason?: { r: string }): number {
  const why = (r: string, v: number) => {
    if (reason) reason.r = r;
    return v;
  };
  if (a.weight !== b.weight) return why("Weight", b.weight - a.weight); // 1
  const lpA = a.localPref ?? BGP_DEFAULTS.localPref;
  const lpB = b.localPref ?? BGP_DEFAULTS.localPref;
  if (lpA !== lpB) return why("Local Pref", lpB - lpA); // 2
  const la = a.peer === "0.0.0.0" ? 1 : 0;
  const lb = b.peer === "0.0.0.0" ? 1 : 0;
  if (la !== lb) return why("Local Route", lb - la); // 3
  if (a.asPath.length !== b.asPath.length) return why("AS Path", a.asPath.length - b.asPath.length); // 4
  if (a.origin !== b.origin) return why("Origin", a.origin - b.origin); // 5
  if ((a.asPath[0] ?? 0) === (b.asPath[0] ?? 0) && (a.med ?? 0) !== (b.med ?? 0)) return why("MED", (a.med ?? 0) - (b.med ?? 0)); // 6
  if (a.ebgp !== b.ebgp) return why("Peer Type", a.ebgp ? -1 : 1); // 7
  if ((a.igpMetric ?? 0) !== (b.igpMetric ?? 0)) return why("IGP Metric", (a.igpMetric ?? 0) - (b.igpMetric ?? 0)); // 8
  if (a.ebgp && b.ebgp && a.sinceMs !== b.sinceMs) return why("Older Path", a.sinceMs - b.sinceMs); // 12 oldest external
  if (a.peerRid !== b.peerRid) return why("Router ID", ipInt(a.peerRid) - ipInt(b.peerRid)); // 13
  return why("Neighbor IP", a.peer.includes(":") || b.peer.includes(":") ? a.peer.localeCompare(b.peer) : ipInt(a.peer) - ipInt(b.peer)); // 15
}

/**
 * Multipath candidate (bgp_route.c:1405-1445): equal with the best through the
 * IGP-metric step, and — without `bgp bestpath as-path multipath-relax` — an
 * identical AS_PATH (iBGP) or the same neighbour AS (eBGP).
 */
function multipathEqual(a: BgpPath, b: BgpPath, relax: boolean): boolean {
  const r = { r: "" };
  comparePaths(a, b, r);
  if (!["Older Path", "Router ID", "Neighbor IP"].includes(r.r) || a.peer === "0.0.0.0" || b.peer === "0.0.0.0") return false;
  if (relax) return true;
  if (!a.ebgp) return a.asPath.join(" ") === b.asPath.join(" ");
  return a.peerAs === b.peerAs;
}

/** Non-BGP IPv6 route or connected subnet reaching `ip` (switches keep no connected v6 routes). */
function igpLookup6(device: Device, ip: string, vrf: string): { metric: number; iface: NetInterface } | undefined {
  const m = longestPrefixMatch6(
    (device.routingTable6 ?? []).filter((r) => r.type !== "bgp" && (r.vrf ?? "default") === vrf),
    ip,
  );
  const iface = m ? findInterface(device, m.route.interfaceId) : device.interfaces.find((i) => vrfOf(device, i) === vrf && i.ipv6.some((a) => !isLinkLocal6(a.address) && sameSubnet6(a.address, ip, a.prefix)));
  return iface ? { metric: m?.route.metric ?? 0, iface } : undefined;
}

const ifUp = (i: NetInterface | undefined) => !!i && i.operState === "up" && i.adminState === "up";

/** Egress interface for a path's next hop, or undefined when it does not resolve. */
function pathEgress(device: Device, vrf: string, af: Af, path: BgpPath, sessionIface?: string): NetInterface | undefined {
  if (af === "ipv4") return nextHopUsable(device, path.nextHop, vrf);
  if (path.nextHopLL && sessionIface) {
    const i = findInterface(device, sessionIface);
    if (ifUp(i)) return i;
  }
  const r = igpLookup6(device, path.nextHop, vrf);
  return r && ifUp(r.iface) ? r.iface : undefined;
}

function igpMetricOf(device: Device, vrf: string, af: Af, nh: string): number {
  if (af === "ipv4") return igpLookup(device, nh, vrf)?.route.metric ?? 0;
  return igpLookup6(device, nh, vrf)?.metric ?? 0;
}

/** Connected IPv6 subnets of up interfaces in `vrf` (from addressing; switches keep no v6 connected routes). */
function connected6(device: Device, vrf: string): { key: string; iface: NetInterface }[] {
  const out: { key: string; iface: NetInterface }[] = [];
  for (const i of device.interfaces) {
    if (i.management || i.operState !== "up" || vrfOf(device, i) !== vrf) continue;
    for (const a of i.ipv6) if (!isLinkLocal6(a.address)) out.push({ key: `${networkAddress6(a.address, a.prefix)}/${a.prefix}`, iface: i });
  }
  return out;
}

/**
 * Locally originated paths: `network` (valid only while an exact route exists —
 * import-check, bgp_route.c:6922 bgp_nexthop_reachability_check) and
 * `redistribute connected|static|ospf [route-map R] [metric N]` (bgp_route.c
 * bgp_redistribute_add: origin incomplete, MED = route metric, next hop = the
 * route's gateway, route-map applied — deny keeps the route out).
 */
function localPaths(device: Device, cfg: BgpConfig, af: Af, rid: string): Map<string, { path: BgpPath; valid: boolean }> {
  const out = new Map<string, { path: BgpPath; valid: boolean }>();
  const vrf = cfg.vrf ?? "default";
  const ac = afConfig(cfg, af);
  const self = af === "ipv4" ? "0.0.0.0" : "::";
  const rib = (af === "ipv4" ? device.routingTable : (device.routingTable6 ?? [])).filter((r) => r.type !== "bgp" && (r.vrf ?? "default") === vrf);
  const mk = (local: "network" | "redistribute", origin: number, med: number, proto?: string, nextHop = self): BgpPath => ({ origin, asPath: [], nextHop, med, weight: 32768, peer: "0.0.0.0", peerRid: rid, ebgp: false, local, proto, sinceMs: 0 });
  const conn6 = af === "ipv6" ? connected6(device, vrf) : [];
  for (const n of ac.networks) {
    const [addr, len] = n.split("/");
    const r = af === "ipv4" ? rib.find((x) => x.destination === networkAddress(addr, Number(len)) && x.prefix === Number(len)) : rib.find((x) => `${networkAddress6(x.destination, x.prefix)}/${x.prefix}` === n);
    const valid = !!r || conn6.some((c) => c.key === n);
    out.set(n, { path: mk("network", 0, r?.metric ?? 0), valid });
  }
  for (const proto of ["connected", "static", "ospf"] as RedistProto[]) {
    const rd = ac.redist?.[proto];
    if (!rd) continue;
    const cands: { key: string; metric: number; nextHop?: string }[] = [];
    for (const r of rib) {
      if (r.type !== proto) continue;
      if (!isSelectedRoute(af === "ipv4" ? device.routingTable : (device.routingTable6 ?? []), r)) continue; // zebra redistributes the selected route only
      if (proto === "connected") {
        const iface = findInterface(device, r.interfaceId);
        if (!iface || iface.management || iface.operState !== "up") continue;
      }
      const key = af === "ipv4" ? `${r.destination}/${r.prefix}` : `${networkAddress6(r.destination, r.prefix)}/${r.prefix}`;
      cands.push({ key, metric: proto === "connected" ? 0 : r.metric, nextHop: r.nextHop ?? undefined });
    }
    if (proto === "connected") for (const c of conn6) if (!cands.some((x) => x.key === c.key)) cands.push({ key: c.key, metric: 0 });
    for (const c of cands) {
      if (out.get(c.key)?.valid) continue;
      const path = mk("redistribute", 2, rd.metric ?? c.metric, proto, c.nextHop ?? self);
      if (rd.routeMap && applyRouteMap(device, rd.routeMap, { prefix: c.key, af, protocol: proto }, path) === "deny") continue;
      out.set(c.key, { path, valid: true });
    }
  }
  return out;
}

/**
 * Inbound policy (bgp_route.c bgp_update → bgp_input_filter :1671: prefix-list,
 * filter-list; then bgp_input_modifier :1873: neighbor weight, route-map in).
 * undefined = filtered. The raw path stays in the Adj-RIB-In, so policy changes
 * re-evaluate at once (FRR re-applies policy on route-map/prefix-list change —
 * bgp_routemap.c bgp_route_map_process_update / bgp_prefix_list_update).
 */
export function inboundPath(device: Device, nb: BgpNeighbor | undefined, af: Af, prefix: string, raw: BgpPath): BgpPath | undefined {
  const pol = nb?.af?.[af];
  if (pol?.prefixListIn && !prefixListPermits(device, pol.prefixListIn, prefix, af)) return undefined;
  if (pol?.filterListIn && !asPathListPermits(device, pol.filterListIn, raw.asPath)) return undefined;
  const a: BgpPath = { ...raw, asPath: [...raw.asPath], communities: raw.communities ? [...raw.communities] : undefined, weight: pol?.weight ?? 0 };
  if (pol?.routeMapIn && applyRouteMap(device, pol.routeMapIn, { prefix, af, peer: raw.peer }, a) === "deny") return undefined;
  return a;
}

export interface TableEntry {
  path: BgpPath;
  valid: boolean;
  /** Selected as an additional ECMP path ('=' in show ip bgp). */
  multipath?: boolean;
  /** Why the best path won (route_vty_out_detail "best (<reason>)"). */
  reason?: string;
}

const adjInOf = (p: PeerRt, af: Af) => (af === "ipv4" ? p.adjIn : (p.adjIn6 ?? {}));

/** All candidate paths per prefix after inbound policy, best first (valid = next hop resolvable). */
export function bgpTable(device: Device, af: Af = "ipv4", vrf = "default"): Map<string, TableEntry[]> {
  const cfg = liveBgpConfig(device, vrf);
  const rt = peekBgpRuntime(device, vrf);
  const table = new Map<string, TableEntry[]>();
  if (!cfg) return table;
  for (const [k, e] of localPaths(device, cfg, af, bgpRouterId(device, cfg))) table.set(k, [e]);
  for (const p of Object.values(rt?.peers ?? {})) {
    if (p.state !== "Established") continue;
    const nb = nbCfg(cfg, p.peer);
    for (const [k, raw] of Object.entries(adjInOf(p, af))) {
      const path = inboundPath(device, nb, af, k, raw);
      if (!path) continue;
      const valid = !!pathEgress(device, vrf, af, path, p.tcb?.ifaceId);
      path.igpMetric = valid ? igpMetricOf(device, vrf, af, path.nextHop) : 0;
      const list = table.get(k) ?? [];
      list.push({ path, valid });
      table.set(k, list);
    }
  }
  const ac = afConfig(cfg, af);
  for (const list of table.values()) {
    list.sort((x, y) => (x.valid !== y.valid ? (x.valid ? -1 : 1) : comparePaths(x.path, y.path)));
    const best = list[0];
    if (!best?.valid) continue;
    if (list.length === 1) best.reason = "First path received";
    else {
      const r = { r: "" };
      comparePaths(best.path, list[1].path, r);
      best.reason = r.r;
    }
    // bgp_mpath.c bgp_path_info_mpath_update: up to maximum-paths (eBGP / ibgp by the best path's type)
    const max = (best.path.ebgp ? ac.maxPaths : ac.maxPathsIbgp) ?? BGP_DEFAULTS.maxPaths;
    let n = 1;
    for (const e of list.slice(1)) {
      if (n >= max) break;
      if (e.valid && multipathEqual(e.path, best.path, !!cfg.multipathRelax)) {
        e.multipath = true;
        n++;
      }
    }
  }
  return table;
}

/**
 * Outbound processing for one peer (bgp_route.c subgroup_announce_check):
 * never back to the sender, iBGP split horizon, well-known communities
 * (no-advertise: nobody; no-export / local-AS: no eBGP peer), output prefix-list
 * and filter-list, attribute rewrite (eBGP: next-hop-self, MED only for local
 * routes, no LOCAL_PREF; iBGP: LOCAL_PREF default 100), then route-map out. Our own
 * AS is prepended for eBGP after the route-map (bgp_attr.c bgp_packet_attribute).
 * Returns the attributes to send (wire) and as shown by advertised-routes (shown).
 */
function outboundAttrs(device: Device, cfg: BgpConfig, nb: BgpNeighbor, p: PeerRt, af: Af, k: string, b: BgpPath): { wire: PathAttrs & { nextHopLL?: string }; shown: BgpPath } | undefined {
  const ebgp = isEbgp(cfg, nb);
  const local = b.peer === "0.0.0.0";
  if (b.peer === p.peer) return undefined; // never back to the sender
  if (!ebgp && !b.ebgp && !local) return undefined; // iBGP split horizon
  const comms = b.communities ?? [];
  if (comms.includes(COMMUNITY.NO_ADVERTISE)) return undefined;
  if (ebgp && (comms.includes(COMMUNITY.NO_EXPORT) || comms.includes(COMMUNITY.LOCAL_AS))) return undefined;
  const pol = nb.af?.[af];
  if (pol?.prefixListOut && !prefixListPermits(device, pol.prefixListOut, k, af)) return undefined;
  if (pol?.filterListOut && !asPathListPermits(device, pol.filterListOut, b.asPath)) return undefined;
  const nh = af === "ipv4" ? { nextHop: p.tcb!.localIp } : selfNextHop6(device, cfg, p);
  const shown: BgpPath = { ...b, asPath: [...b.asPath], communities: b.communities ? [...b.communities] : undefined };
  const a: PathAttrs & { nextHopLL?: string } = ebgp
    ? { origin: b.origin, asPath: [...b.asPath], ...nh, med: local ? b.med : undefined, communities: b.communities }
    : { origin: b.origin, asPath: [...b.asPath], ...(local ? nh : { nextHop: b.nextHop }), med: b.med, localPref: b.localPref ?? BGP_DEFAULTS.localPref, communities: b.communities };
  if (pol?.routeMapOut) {
    const pa = { ...a, weight: b.weight };
    if (applyRouteMap(device, pol.routeMapOut, { prefix: k, af, peer: p.peer }, pa) === "deny") return undefined;
    const nhChanged = pa.nextHop !== a.nextHop;
    Object.assign(a, { origin: pa.origin, asPath: pa.asPath, nextHop: pa.nextHop, med: pa.med, communities: pa.communities }, ebgp ? {} : { localPref: pa.localPref });
    if (nhChanged) a.nextHopLL = undefined;
    Object.assign(shown, { origin: pa.origin, asPath: pa.asPath, med: pa.med, localPref: pa.localPref, communities: pa.communities, ...(nhChanged ? { nextHop: pa.nextHop } : {}) });
  }
  if (ebgp) a.asPath = [cfg.localAs!, ...a.asPath];
  if (a.communities && !a.communities.length) a.communities = undefined;
  return { wire: a, shown };
}

/**
 * IPv6 next hop we advertise (bgp_zebra.c bgp_nexthop_set): the global address of
 * the session's interface (IPv4-mapped ::ffff:a.b.c.d when it has none) plus its
 * link-local when the peer shares the network (length 32 next hop).
 */
function selfNextHop6(device: Device, cfg: BgpConfig, p: PeerRt): { nextHop: string; nextHopLL?: string } {
  const iface = p.tcb?.ifaceId ? findInterface(device, p.tcb.ifaceId) : undefined;
  const g = iface?.ipv6.find((a) => !isLinkLocal6(a.address));
  const ll = iface?.ipv6.find((a) => isLinkLocal6(a.address));
  const shared = !!iface?.ipv4.some((a) => cidrContains(networkAddress(a.address, a.prefix), a.prefix, p.peer));
  return { nextHop: g ? g.address : `::ffff:${p.tcb?.localIp ?? "0.0.0.0"}`, ...(ll && shared ? { nextHopLL: ll.address } : {}) };
}

/** table-map (bgp_zebra.c bgp_table_map_apply): deny keeps a route out of the RIB, sets apply. */
function tableMapRoute(device: Device, cfg: BgpConfig, af: Af, k: string, p: BgpPath): BgpPath | undefined {
  const tm = afConfig(cfg, af).tableMap;
  if (!tm) return p;
  const a = { ...p, asPath: [...p.asPath] };
  return applyRouteMap(device, tm, { prefix: k, af, peer: p.peer }, a) === "permit" ? a : undefined;
}

/** zebra: install best + multipath routes learned from peers (one Route per ECMP next hop). */
function installRoutes(ctx: SimContext, device: Device, cfg: BgpConfig, rt: BgpRt, af: Af, table: Map<string, TableEntry[]>, now: number): void {
  const vrf = cfg.vrf ?? "default";
  const mine = (r: Route) => r.type === "bgp" && (r.vrf ?? "default") === vrf && !evpnOwned(device, r);
  const cur = af === "ipv4" ? device.routingTable : (device.routingTable6 ?? []);
  const prev = cur.filter(mine);
  const keep = cur.filter((r) => !mine(r));
  for (const [k, list] of table) {
    if (!list[0]?.valid || list[0].path.peer === "0.0.0.0") continue;
    for (const e of list.filter((x, i) => i === 0 || x.multipath)) {
      const p = tableMapRoute(device, cfg, af, k, e.path);
      if (!p) continue;
      const iface = pathEgress(device, vrf, af, p, rt.peers[p.peer]?.tcb?.ifaceId);
      if (!iface) continue;
      const [dest, len] = k.split("/");
      const nh = af === "ipv6" && p.nextHopLL ? p.nextHopLL : p.nextHop;
      const old = prev.find((r) => r.destination === dest && r.prefix === Number(len) && r.nextHop === nh && r.interfaceId === iface.id);
      if (!old) emit(ctx, device, "BGP_ROUTE", `BGP route ${k} via ${nh} (AS path ${p.asPath.join(" ") || "local"}) installed${vrf !== "default" ? ` in vrf ${vrf}` : ""}`);
      keep.push({ destination: dest, prefix: Number(len), nextHop: nh, interfaceId: iface.id, type: "bgp", metric: p.med ?? 0, distance: p.ebgp ? 20 : 200, installedAtMs: old?.installedAtMs ?? now, ...(vrf !== "default" ? { vrf } : {}) });
    }
  }
  if (af === "ipv4") device.routingTable = keep;
  else device.routingTable6 = keep;
}

/** Decision process + RIB install + Adj-RIB-Out diff → UPDATEs, per address family. */
function converge(ctx: SimContext, device: Device, now: number, vrf = "default"): void {
  const cfg = liveBgpConfig(device, vrf);
  const rt = peekBgpRuntime(device, vrf);
  if (!cfg || !rt) return;
  rt.dirty = false;
  for (const af of ["ipv4", "ipv6"] as Af[]) {
    const table = bgpTable(device, af, vrf);
    const best = new Map<string, BgpPath>();
    for (const [k, list] of table) if (list[0]?.valid) best.set(k, list[0].path);

    // Loc-RIB change → table version
    const newBest: Record<string, string> = {};
    for (const [k, list] of table) if (list[0]?.valid) newBest[k] = list.filter((e, i) => i === 0 || e.multipath).map((e) => `${e.path.peer}|${attrSig(e.path)}`).join("+");
    const oldBest = (af === "ipv4" ? rt.best : rt.best6) ?? {};
    for (const k of new Set([...Object.keys(newBest), ...Object.keys(oldBest)])) if (newBest[k] !== oldBest[k]) rt.tableVersion++;
    if (af === "ipv4") rt.best = newBest;
    else rt.best6 = newBest;
    installRoutes(ctx, device, cfg, rt, af, table, now);

    // Adj-RIB-Out per Established peer with the address family negotiated
    for (const p of Object.values(rt.peers)) {
      const nb = nbCfg(cfg, p.peer);
      if (!nb || p.state !== "Established" || !p.tcb) continue;
      if (af === "ipv6" && !v6Up(nb, p)) continue;
      const want = new Map<string, PathAttrs & { nextHopLL?: string }>();
      const shown: Record<string, BgpPath> = {};
      for (const [k, b] of best) {
        const o = outboundAttrs(device, cfg, nb, p, af, k, b);
        if (!o) continue;
        want.set(k, o.wire);
        shown[k] = o.shown;
      }
      const adjOut = af === "ipv4" ? p.adjOut : (p.adjOut6 ??= {});
      if (af === "ipv4") p.advOut = shown;
      else p.advOut6 = shown;
      const withdrawn = Object.keys(adjOut).filter((k) => !want.has(k));
      const groups = new Map<string, { attrs: PathAttrs & { nextHopLL?: string }; nlri: string[] }>();
      for (const [k, a] of want) {
        const s = attrSig(a);
        if (adjOut[k] === s) continue;
        const g = groups.get(s) ?? { attrs: a, nlri: [] };
        g.nlri.push(k);
        groups.set(s, g);
      }
      if (withdrawn.length) {
        for (const k of withdrawn) delete adjOut[k];
        const bytes = af === "ipv4" ? encodeUpdate({ withdrawn, nlri: [] }, p.as4) : encodeV6Update({ unreach: withdrawn }, p.as4);
        sendMsg(ctx, device, cfg, nb, p, bytes, "update", now);
      }
      for (const [s, g] of groups) {
        for (const k of g.nlri) adjOut[k] = s;
        const a = g.attrs;
        const bytes =
          af === "ipv4"
            ? encodeUpdate({ withdrawn: [], attrs: a, nlri: g.nlri }, p.as4)
            : encodeV6Update({ reach: { nextHop: a.nextHop, nextHopLL: a.nextHopLL, nlri: g.nlri, attrs: { origin: a.origin, asPath: a.asPath, med: a.med, localPref: a.localPref, communities: a.communities } } }, p.as4);
        sendMsg(ctx, device, cfg, nb, p, bytes, "update", now);
      }
    }
  }
  rt.installed = installedSig(device, vrf);
  if (vrf === "default") convergeEvpn(ctx, device, cfg, rt, now);
}

// ---------------------------------------------------------------------------
// L2VPN EVPN RIB

const hex = (ecs: number[][]) => ecs.map((e) => e.map((x) => x.toString(16).padStart(2, "0")).join("")).join(",");

function evpnSig(a: { origin: number; asPath: number[]; nextHop: string; med?: number; localPref?: number; extComms: number[][]; pmsi?: Pmsi; route: EvpnRoute }): string {
  const pm = a.pmsi ? `${a.pmsi.tunnelType}/${a.pmsi.vni}/${a.pmsi.endpoint}` : "";
  return `${a.origin}|${a.asPath.join(" ")}|${a.nextHop}|${a.med ?? ""}|${a.localPref ?? ""}|${hex(a.extComms)}|${pm}|${a.route.vni ?? ""}/${a.route.vni2 ?? ""}/${a.route.esi ?? ""}`;
}

/** EVPN next hops resolve through any route, BGP-learned included (see module comment). */
function evpnNexthopUsable(device: Device, nh: string): boolean {
  if (ownsAddress(device, nh)) return true;
  const m = longestPrefixMatch(device.routingTable, nh);
  const iface = m ? findInterface(device, m.route.interfaceId) : undefined;
  return !!iface && iface.operState === "up" && iface.adminState === "up";
}

/** All EVPN candidate paths per RD|prefix, best first. */
export function evpnTable(device: Device): Map<string, { path: EvpnPath; valid: boolean }[]> {
  const cfg = liveBgpConfig(device);
  const rt = peekBgpRuntime(device);
  const table = new Map<string, { path: EvpnPath; valid: boolean }[]>();
  if (!cfg) return table;
  const rid = bgpRouterId(device, cfg);
  if (cfg.advertiseAllVni && evpnProvider) {
    for (const l of evpnProvider.localRoutes(device, cfg, rid)) {
      const path: EvpnPath = { origin: 0, asPath: [], nextHop: l.nextHop, weight: 32768, peer: "0.0.0.0", peerRid: rid, ebgp: false, sinceMs: 0, route: l.route, extComms: l.extComms, pmsi: l.pmsi };
      table.set(evpnKey(l.route), [{ path, valid: true }]);
    }
  }
  for (const p of Object.values(rt?.peers ?? {})) {
    if (p.state !== "Established" || !evpnUp(nbCfg(cfg, p.peer), p)) continue;
    for (const [k, path] of Object.entries(p.evpnIn ?? {})) {
      const list = table.get(k) ?? [];
      list.push({ path, valid: evpnNexthopUsable(device, path.nextHop) });
      table.set(k, list);
    }
  }
  for (const list of table.values()) list.sort((x, y) => (x.valid !== y.valid ? (x.valid ? -1 : 1) : comparePaths(x.path, y.path)));
  return table;
}

function convergeEvpn(ctx: SimContext, device: Device, cfg: BgpConfig, rt: BgpRt, now: number): void {
  const best = new Map<string, EvpnPath>();
  for (const [k, list] of evpnTable(device)) if (list[0]?.valid) best.set(k, list[0].path);
  const newBest: Record<string, string> = {};
  for (const [k, p] of best) newBest[k] = `${p.peer}|${evpnSig(p)}`;
  const old = rt.evpnBest ?? {};
  for (const k of new Set([...Object.keys(newBest), ...Object.keys(old)])) if (newBest[k] !== old[k]) rt.tableVersion++;
  rt.evpnBest = newBest;
  evpnProvider?.ribChanged(ctx, device, [...best.values()]);

  for (const p of Object.values(rt.peers)) {
    const nb = nbCfg(cfg, p.peer);
    if (!nb || p.state !== "Established" || !p.tcb || !evpnUp(nb, p)) continue;
    const ebgp = isEbgp(cfg, nb);
    const want = new Map<string, { route: EvpnRoute; nextHop: string; attrs: EvpnAttrs; sig: string }>();
    for (const [k, b] of best) {
      if (b.peer === p.peer) continue; // never back to the sender
      if (!ebgp && !b.ebgp && b.peer !== "0.0.0.0") continue; // iBGP split horizon
      const attrs: EvpnAttrs = ebgp
        ? { origin: b.origin, asPath: [cfg.localAs!, ...b.asPath], extComms: b.extComms, pmsi: b.pmsi }
        : { origin: b.origin, asPath: b.asPath, med: b.med, localPref: b.localPref ?? BGP_DEFAULTS.localPref, extComms: b.extComms, pmsi: b.pmsi };
      // next hop unchanged, also towards eBGP peers (bgp_updgrp_packet.c:577-590)
      want.set(k, { route: b.route, nextHop: b.nextHop, attrs, sig: evpnSig({ ...attrs, nextHop: b.nextHop, route: b.route }) });
    }
    const out = (p.evpnOut ??= {});
    const withdrawn = Object.keys(out).filter((k) => !want.has(k));
    if (withdrawn.length) {
      const routes = withdrawn.map((k) => out[k].route);
      for (const k of withdrawn) delete out[k];
      sendMsg(ctx, device, cfg, nb, p, encodeEvpnUpdate({ unreach: routes }, p.as4), "update", now);
    }
    const groups = new Map<string, { nextHop: string; attrs: EvpnAttrs; keys: string[]; routes: EvpnRoute[] }>();
    for (const [k, w] of want) {
      if (out[k]?.sig === w.sig) continue;
      const gs = w.sig.replace(/\|[^|]*$/, ""); // group by attributes (not the per-route label)
      const g = groups.get(gs) ?? { nextHop: w.nextHop, attrs: w.attrs, keys: [], routes: [] };
      g.keys.push(k);
      g.routes.push(w.route);
      groups.set(gs, g);
    }
    for (const g of groups.values()) {
      g.keys.forEach((k, i) => (out[k] = { sig: want.get(k)!.sig, route: g.routes[i] }));
      sendMsg(ctx, device, cfg, nb, p, encodeEvpnUpdate({ reach: { nextHop: g.nextHop, nlri: g.routes, attrs: g.attrs } }, p.as4), "update", now);
    }
  }
}

/** The VXLAN module's local routes changed: run the decision process now. */
export function evpnRefresh(ctx: SimContext, device: Device, now: number): void {
  withDrain(() => {
    if (liveBgpConfig(device) && peekBgpRuntime(device)) converge(ctx, device, now);
  });
}

// ---------------------------------------------------------------------------
// config reconciliation + timers

function ensureRuntime(device: Device, cfg: BgpConfig, now: number): BgpRt {
  const rt = featureState<BgpRt>(device, rtKey(cfg.vrf), () => ({ localAs: cfg.localAs!, routerId: bgpRouterId(device, cfg), peers: {}, tableVersion: 0, best: {}, sig: "" }));
  for (const nb of cfg.neighbors) if (!rt.peers[nb.peer]) rt.peers[nb.peer] = newPeer(cfg, nb, now);
  return rt;
}

function reconcile(ctx: SimContext, device: Device, cfg: BgpConfig | undefined, now: number, vrf = vrfOfCfg(cfg)): void {
  const rt = peekBgpRuntime(device, vrf);
  if (!cfg) {
    if (!rt) return;
    for (const p of Object.values(rt.peers)) {
      const nbOld = { peer: p.peer, remoteAs: p.remoteAs } as BgpNeighbor;
      if (p.state !== "Idle" && p.tcb?.state === "ESTABLISHED") {
        const fakeCfg: BgpConfig = { localAs: rt.localAs, neighbors: [nbOld], networks: [], ...(vrf !== "default" ? { vrf } : {}) };
        sendMsg(ctx, device, fakeCfg, nbOld, p, encodeNotification(6, 3), "notify", now);
        sendSegment(ctx, device, fakeCfg, nbOld, p.tcb, ["FIN", "ACK"], [], "FIN");
      }
      if (p.bfdReg) bfd().unregister(device, p.peer, "bgp");
    }
    const mine = (r: Route) => r.type === "bgp" && (r.vrf ?? "default") === vrf && !evpnOwned(device, r);
    device.routingTable = device.routingTable.filter((r) => !mine(r));
    device.routingTable6 = (device.routingTable6 ?? []).filter((r) => !mine(r));
    delete device.config.features![rtKey(vrf)];
    if (vrf === "default") evpnProvider?.ribChanged(ctx, device, []);
    return;
  }
  const live = ensureRuntime(device, cfg, now);
  const rid = bgpRouterId(device, cfg);
  if (live.localAs !== cfg.localAs || live.routerId !== rid) {
    const reason = live.localAs !== cfg.localAs ? "Local AS change" : "Router ID changed";
    for (const p of Object.values(live.peers)) if (p.state !== "Idle") stopPeer(ctx, device, cfg, p, now, { reason, notify: { code: 6, subcode: 6 } });
    live.localAs = cfg.localAs!;
    live.routerId = rid;
  }
  for (const p of Object.values(live.peers)) {
    const nb = nbCfg(cfg, p.peer);
    if (!nb) {
      // `no neighbor X`: Cease / Peer De-configured
      if (p.state !== "Idle") stopPeer(ctx, device, { ...cfg, neighbors: [...cfg.neighbors, { peer: p.peer, remoteAs: p.remoteAs }] }, p, now, { reason: "Neighbor deleted", notify: { code: 6, subcode: 3 } });
      if (p.bfdReg) bfd().unregister(device, p.peer, "bgp");
      delete live.peers[p.peer];
      live.dirty = true;
      continue;
    }
    const sig = peerCfgSig(cfg, nb);
    if (sig !== p.cfgSig) {
      const [n, o] = [JSON.parse(sig), JSON.parse(p.cfgSig)];
      const reason = n[0] !== o[0] ? "Remote AS changed" : n[3] !== o[3] || n[4] !== o[4] ? "Address family activated" : "Update source change";
      p.cfgSig = sig;
      if (p.state !== "Idle") stopPeer(ctx, device, cfg, p, now, { reason, notify: { code: 6, subcode: 6 } });
      else if (nb.remoteAs !== undefined && !nb.shutdown && p.connectAt === undefined) p.connectAt = now;
    }
    if (nb.shutdown && (p.state !== "Idle" || p.connectAt !== undefined)) {
      if (p.state !== "Idle") stopPeer(ctx, device, cfg, p, now, { reason: "Admin. shutdown", notify: { code: 6, subcode: 2 } });
      p.connectAt = undefined;
    } else if (!nb.shutdown && p.state === "Idle" && p.connectAt === undefined && nb.remoteAs !== undefined) {
      p.connectAt = now;
    }
    if (nb.connectRetry !== undefined) p.vConnect = nb.connectRetry;
    if (nb.bfd && !p.bfdReg) {
      const local = localAddressFor(device, nb, vrf);
      bfd().register(device, { peer: nb.peer, local: local?.ip, iface: local?.iface.name, multihop: !!nb.ebgpMultihop }, "bgp");
      p.bfdReg = true;
    } else if (!nb.bfd && p.bfdReg) {
      bfd().unregister(device, nb.peer, "bgp");
      p.bfdReg = false;
      p.bfdLast = undefined;
    }
  }
  live.sig = inputSig(device, cfg);
  live.dirty = true;
}

/** The interface carrying a directly connected eBGP session went down (fast-external-failover). */
function sessionIfaceDown(device: Device, cfg: BgpConfig, p: PeerRt): boolean {
  const nb = nbCfg(cfg, p.peer);
  if (!nb || !isEbgp(cfg, nb) || nb.ebgpMultihop || p.state === "Idle" || !p.tcb?.ifaceId) return false;
  const iface = findInterface(device, p.tcb.ifaceId);
  return !iface || iface.operState !== "up" || iface.adminState !== "up";
}

function bfdDown(device: Device, p: PeerRt): boolean {
  if (!p.bfdReg) return false;
  const s = bfd().state(device, p.peer);
  return s !== p.bfdLast;
}

function nextDue(device: Device, now: number): number | undefined {
  if (!runsBgp(device)) return undefined;
  let due: number | undefined;
  for (const vrf of instanceVrfs(device)) {
    const d = nextDueVrf(device, now, vrf);
    if (d !== undefined && (due === undefined || d < due)) due = d;
  }
  return due;
}

function nextDueVrf(device: Device, now: number, vrf: string): number | undefined {
  const cfg = liveBgpConfig(device, vrf);
  const rt = peekBgpRuntime(device, vrf);
  if (!cfg) return rt ? now : undefined;
  if (!rt || rt.dirty || rt.sig !== inputSig(device, cfg) || rt.installed !== installedSig(device, vrf)) return now;
  let due: number | undefined;
  const at = (t: number | undefined) => {
    if (t !== undefined && (due === undefined || t < due)) due = t;
  };
  for (const p of Object.values(rt.peers)) {
    if (sessionIfaceDown(device, cfg, p) || bfdDown(device, p)) return now;
    at(p.connectAt);
    at(p.holdAt);
    at(p.kaAt);
  }
  return due;
}

function tick(ctx: SimContext, device: Device, now: number): boolean {
  return withDrain(() => {
    for (const vrf of instanceVrfs(device)) tickVrf(ctx, device, now, vrf);
    return true;
  });
}

function tickVrf(ctx: SimContext, device: Device, now: number, vrf: string): void {
  {
    const cfg = liveBgpConfig(device, vrf);
    const rt = peekBgpRuntime(device, vrf);
    if (!cfg || !rt || rt.sig !== inputSig(device, cfg)) reconcile(ctx, device, cfg, now, vrf);
    if (!cfg) return;
    const live = peekBgpRuntime(device, vrf)!;
    if (live.installed !== installedSig(device, vrf)) live.dirty = true;
    for (const p of Object.values(live.peers)) {
      const nb = nbCfg(cfg, p.peer);
      if (!nb) continue;
      if (sessionIfaceDown(device, cfg, p)) {
        // bgp_zebra.c:273-286: BGP_Stop, last_reset = PEER_DOWN_IF_DOWN (no NOTIFICATION).
        if (p.tcb) p.tcb = undefined;
        stopPeer(ctx, device, cfg, p, now, { reason: "Interface down" });
        continue;
      }
      if (p.bfdReg) {
        const s = bfd().state(device, p.peer);
        if (p.bfdLast === "up" && s === "down" && p.state !== "Idle") stopPeer(ctx, device, cfg, p, now, { reason: "BFD down received", notify: { code: 6, subcode: 10 } });
        p.bfdLast = s;
      }
      if (p.holdAt !== undefined && p.holdAt <= now) {
        stopPeer(ctx, device, cfg, p, now, { reason: "BGP Notification send", notify: { code: 4, subcode: 0 } });
        continue;
      }
      if (p.kaAt !== undefined && p.kaAt <= now && (p.state === "OpenConfirm" || p.state === "Established")) {
        sendMsg(ctx, device, cfg, nb, p, encodeKeepalive(), "keepalive", now);
        p.kaAt = now + p.keepalive * 1000;
      }
      if (p.connectAt !== undefined && p.connectAt <= now && !nb.shutdown && nb.remoteAs !== undefined) {
        if (p.state === "Connect" || p.state === "Active") {
          if (nb.connectRetry === undefined) p.vConnect = Math.min(BGP_DEFAULTS.maxConnectRetry, p.vConnect * 2);
          startConnect(ctx, device, cfg, nb, p, now);
        } else if (p.state === "Idle") startConnect(ctx, device, cfg, nb, p, now);
        else p.connectAt = undefined;
      }
    }
    if (live.dirty) converge(ctx, device, now, vrf);
  }
}

function isBgpSegment(frame: Frame): boolean {
  return !!frame.ipv4 && !!frame.tcp && !!frame.rawL3 && (frame.tcp.dstPort === BGP_PORT || frame.tcp.srcPort === BGP_PORT);
}

registerDaemon({
  id: "bgp",
  nextDue,
  tick,
  receiveL3(ctx, device, ingress, frame) {
    if (!isBgpSegment(frame) || !runsBgp(device) || !instanceVrfs(device).some((v) => liveBgpConfig(device, v))) return false;
    if (!ownsAddress(device, frame.ipv4!.dstIp)) return false; // transit: let the router forward it
    queue.push({ ctx, device, ingressId: ingress.id, frame });
    withDrain(() => undefined);
    return true;
  },
  describe(frame, verbose) {
    if (!frame.ipv4 || !frame.tcp || (frame.tcp.dstPort !== BGP_PORT && frame.tcp.srcPort !== BGP_PORT)) return undefined;
    const payload = l4Payload(frame) ?? new Uint8Array();
    const t = frame.tcp;
    const ack = t.flags.includes("ACK") ? `, ack ${t.ack}` : "";
    // tcpdump prints the TCP payload length from the IP header (not the padded frame).
    if (payload.length === 0) return `Flags [${tcpFlagText(t.flags)}], seq ${t.seq}${ack}, win ${t.window}, length 0`;
    const end = (t.seq + payload.length) >>> 0;
    return `Flags [${tcpFlagText(t.flags)}], seq ${t.seq}:${end}${ack}, win ${t.window}, length ${payload.length}: ${describeBgpPayload(payload, verbose)}`;
  },
});

// ---------------------------------------------------------------------------
// `bgp converge` / Simulation.runBgp(): drive every speaker until quiescent

export function runBgpToConvergence(ctx: SimContext): BgpSummary {
  const now = Math.floor(ctx.wallNow());
  const speakers = Object.values(ctx.state.devices).filter((d) => runsBgp(d) && instanceVrfs(d).some((v) => liveBgpConfig(d, v)));
  withDrain(() => {
    for (const d of speakers) {
      for (const vrf of instanceVrfs(d)) {
        const cfg = liveBgpConfig(d, vrf);
        if (!cfg) continue;
        reconcile(ctx, d, cfg, now, vrf);
        for (const p of Object.values(peekBgpRuntime(d, vrf)!.peers)) {
          const nb = nbCfg(cfg, p.peer);
          if (p.state !== "Established" && nb && !nb.shutdown && nb.remoteAs !== undefined) p.connectAt = now;
        }
      }
    }
  });
  for (let i = 0; i < 20; i++) {
    let ran = false;
    for (const d of speakers) {
      const due = nextDue(d, now);
      if (due !== undefined && due <= now) {
        tick(ctx, d, now);
        ran = true;
      }
    }
    if (!ran) break;
  }
  let sessions = 0;
  let routesInstalled = 0;
  for (const d of speakers) {
    for (const vrf of instanceVrfs(d)) sessions += Object.values(peekBgpRuntime(d, vrf)?.peers ?? {}).filter((p) => p.state === "Established").length;
    routesInstalled += d.routingTable.filter((r) => r.type === "bgp").length;
  }
  return { routers: speakers.length, sessions, routesInstalled };
}
