/**
 * MCLAG daemon — SONiC iccpd (ICCP, RFC 7275 mLACP) + the mclagsyncd/MlagOrch
 * data-plane effects (peer-link isolation, remote MAC programming).
 *
 * Config (simulated CONFIG_DB, written by lib/commands/sonic-cli/features/mclag.ts):
 *   cp_mclag.domains    MCLAG_DOMAIN  {domain_id, source_ip, peer_ip, peer_link,
 *                                      keepalive_interval, session_timeout, mclag_system_mac}
 *   cp_mclag.interfaces MCLAG_INTERFACE {domain_id, if_name}
 *
 * Sources (sonic-buildimage/src):
 *   iccpd/include/iccp_csm.h:53          ICCP over TCP port 8888.
 *   iccpd/include/scheduler.h:40         connect retry every CONNECT_INTERVAL_SEC (1 s).
 *   sonic-yang-models/yang-models/sonic-mclag.yang:90,100  keepalive_interval 1 s,
 *                                        session_timeout 30 s defaults.
 *   iccpd/src/scheduler.c:82             session down when no heartbeat for session_timeout.
 *   iccpd/src/iccp_csm.c:847-869         role: lower IP (inet_addr compare) = Active and
 *                                        socket client; the other is Standby.
 *   iccpd/src/iccp_netlink.c:640-700     Standby rewrites each MCLAG PortChannel hwaddr to the
 *                                        Active's system ID (only when the peer has the same
 *                                        MLAG interface) → both peers send identical LACP
 *                                        system IDs, the partner bonds to both as ONE LAG.
 *   iccpd/src/mlacp_link_handler.c:2394-2470 session down: remote MACs flushed, port
 *                                        isolation cleaned up, Standby restores its MACs.
 *   iccpd/src/mlacp_link_handler.c:1350+ peer-link isolation: traffic from the peer-link is
 *                                        blocked towards local MLAG interfaces whose remote
 *                                        counterpart is up (MlagOrch isolation group).
 *   iccpd/src/mlacp_sync_update.c:229-420 remote MAC: learned on an MLAG interface → local
 *                                        same-named PortChannel if up, else the peer-link;
 *                                        learned on an orphan port → the peer-link.
 *   iccpd/include/msg_format.h:57-110    message/TLV types (RG Connect 0x0700, RG App Data
 *                                        0x0703, System Config 0x0032, Aggregator State 0x0037,
 *                                        Heartbeat 0x003A, MAC Info 0x1038); mlacp_tlv.h layouts.
 *   iccpd/include/port.h:49-50           PORT_STATE_UP 0 / DOWN 1;  mlacp_tlv.h:500 MAC add 1/del 2.
 *   sonic-swss/mclagsyncd/mclaglink.cpp:1354,1405  MCLAG_TABLE oper_status up/down, role
 *                                        active/standby, system_mac.
 *
 * Simplifications (documented):
 *   - TCP is a 3-way handshake + PSH/ACK data segments; no standalone ACKs or
 *     retransmissions (the keepalive link is lossless in the simulator).
 *   - The ICC header carries LDP msg header + ICC RG ID TLV, but the RG Connect /
 *     sync-request exchange is reduced to one Connect + one App Data burst.
 *   - MACs are synced by a periodic diff of the local FDB (every tick) instead of
 *     netlink FDB events; synced MACs are re-pinned on the next tick if the bridge
 *     relearns them on the peer-link (real SONiC disables peer-link learning).
 *   - A configured mclag-system-mac is used as the LACP system ID on both peers.
 *   - ND sync, unique-ip, delay-restore, backup keepalive, traffic_disable are not modelled.
 *
 * ARP sync (iccpd mlacp_sync_update.c:626-917, mlacp_tlv.h:376-405):
 *   ARP entries learned on a VLAN interface or an MLAG interface are sent in an ARP
 *   Information TLV (0x1036; per entry op 1 add / 2 del, flag, learn_flag, ifname[20],
 *   IPv4, MAC). The peer installs each on its same-named interface
 *   (mlacp_fsm_update_arp_entry → kernel neighbour), skipping its own address
 *   (my_ip_arp_flag) — so a host's ARP learned on one peer appears on the other.
 *   Simplification: the local table is diffed every tick instead of netlink
 *   neighbour events; a locally learned entry wins over a synced one. Entries
 *   learned from the peer are not flushed when the session goes down (the disconnect
 *   handler, mlacp_link_handler.c:2394-2470, does not touch neighbours).
 *   `mclagdctl dump state|arp|mac -i <domain>` (iccpd src/mclagdctl/mclagdctl.c)
 *   lives in lib/commands/mclagdctl.ts.
 *
 * Feature: `config feature state iccpd disabled` stops docker-iccpd: the session
 * goes down (peer-learned MACs flushed, isolation lifted) and nothing is sent.
 */
import { registerDaemon } from "../control/daemon";
import { logEvent } from "../control/syslog";
import { registerDataPlaneHook } from "../control/hooks";
import { sendIpv4, l4Payload } from "../control/packet";
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame, TcpHeader } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { SimContext } from "../engine/context";
import { normalizeMac } from "../models/mac";
import { systemMac } from "./lacp-daemon";
import { learnArp, deleteArp } from "./arp";
import { featureEnabled } from "./cpu-features";

export const ICCP_TCP_PORT = 8888; // iccp_csm.h:53
const CONNECT_INTERVAL_MS = 1000; // scheduler.h:40
const DFLT_KEEPALIVE = 1; // sonic-mclag.yang:90
const DFLT_SESSION_TIMEOUT = 30; // sonic-mclag.yang:100
const MSG = { RG_CONNECT: 0x0700, RG_APP_DATA: 0x0703 } as const;
const TLV = { SENDER_NAME: 0x0001, RG_ID: 0x0005, SYSTEM_CONFIG: 0x0032, AGG_STATE: 0x0037, HEARTBEAT: 0x003a, ARP_INFO: 0x1036, MAC_INFO: 0x1038 } as const;
const NEIGH_SYNC_ADD = 1; // mlacp_tlv.h:475
const NEIGH_SYNC_DEL = 2;
const NEIGH_LOCAL = 1; // mlacp_tlv.h:373
const PORT_UP = 0x00; // port.h:49
const PORT_DOWN = 0x01;
const MAC_ADD = 1; // mlacp_tlv.h:500
const MAC_DEL = 2;
const MAX_L_PORT_NAME = 20; // port.h:46

type Rec = Record<string, unknown>;

export interface MclagDomainCfg {
  id: string;
  sourceIp: string;
  peerIp: string;
  peerLink?: string;
  keepalive: number;
  sessionTimeout: number;
  systemMac?: string;
  interfaces: string[];
}

interface Tcb {
  state: "SYN_SENT" | "SYN_RCVD" | "ESTABLISHED";
  localPort: number;
  remotePort: number;
  sndNxt: number;
  rcvNxt: number;
}

export interface MclagRt {
  domain: string;
  sig: string;
  tcb?: Tcb;
  /** ICCP session up (TCP established + peer System Config received). */
  session: boolean;
  everUp: boolean;
  role: "" | "active" | "standby";
  lastRx: number;
  nextHello?: number;
  nextConnect?: number;
  remoteSystemId?: string;
  /** MCLAG_REMOTE_INTF_TABLE: peer's MLAG interface oper state. */
  remoteIfs: Record<string, "up" | "down">;
  sentIfs: Record<string, "up" | "down">;
  /** "MAC|vid" → ifname we advertised. */
  sentMacs: Record<string, string>;
  /** "MAC|vid" → ifname the peer learned it on. */
  remoteMacs: Record<string, string>;
  /** "MAC|vid" entries this daemon programmed into the FDB. */
  installed: Record<string, true>;
  /** "MAC|vid" → MLAG PortChannel it was learned on, while redirected to the peer-link. */
  redirected: Record<string, string>;
  /** Standby: original PortChannel hwaddr before the system-ID rewrite. */
  origMac: Record<string, string>;
  /** ARP sync: ip → "ifname|MAC" we advertised; ip → entry the peer advertised; ips we installed. */
  sentArps?: Record<string, string>;
  remoteArps?: Record<string, { ifname: string; mac: string }>;
  installedArps?: Record<string, true>;
  msgId: number;
  tx: number;
  rx: number;
}

const RT = "iccpd";

export function mclagConfig(d: Device): MclagDomainCfg | undefined {
  const cp = peekFeatureState<Rec>(d, "cp_mclag");
  const dom = ((cp?.domains as Rec[] | undefined) ?? [])[0];
  if (!dom) return undefined;
  const id = String(dom.domain_id);
  const ifs = ((cp?.interfaces as Rec[] | undefined) ?? []).filter((i) => String(i.domain_id) === id).map((i) => String(i.if_name));
  return {
    id,
    sourceIp: String(dom.source_ip ?? ""),
    peerIp: String(dom.peer_ip ?? ""),
    peerLink: dom.peer_link ? String(dom.peer_link) : undefined,
    keepalive: Number(dom.keepalive_interval ?? DFLT_KEEPALIVE),
    sessionTimeout: Number(dom.session_timeout ?? DFLT_SESSION_TIMEOUT),
    systemMac: dom.mclag_system_mac ? normalizeMac(String(dom.mclag_system_mac)) : undefined,
    interfaces: ifs,
  };
}

export function mclagRuntime(d: Device): MclagRt | undefined {
  return peekFeatureState<MclagRt>(d, RT);
}

function freshRt(domain: string): MclagRt {
  return { domain, sig: "", session: false, everUp: false, role: "", lastRx: 0, remoteIfs: {}, sentIfs: {}, sentMacs: {}, remoteMacs: {}, installed: {}, redirected: {}, origMac: {}, msgId: 0, tx: 0, rx: 0 };
}

const ifByName = (d: Device, n: string | undefined) => (n ? d.interfaces.find((i) => i.name === n) : undefined);
const isUp = (i: NetInterface | undefined) => !!i && i.adminState === "up" && i.operState === "up";
const ownsIp = (d: Device, ip: string) => d.interfaces.some((i) => i.ipv4.some((a) => a.address === ip));

/** iccp_csm.c:851 `inet_addr(sender) < inet_addr(peer)` (network-order bytes read as a host uint32). */
function inetAddrHost(ip: string): number {
  const o = ip.split(".").map(Number);
  return ((o[0] | (o[1] << 8) | (o[2] << 16) | (o[3] << 24)) >>> 0);
}
export const isActiveRole = (c: MclagDomainCfg) => inetAddrHost(c.sourceIp) < inetAddrHost(c.peerIp);

/** MLACP system ID: mclag-system-mac if configured, else the switch MAC. */
export const localSystemId = (d: Device, c: MclagDomainCfg) => (c.systemMac ?? systemMac(d)).toUpperCase();

// ---------- ICCP encoding ----------

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const macBytes = (m: string) => m.split(":").map((x) => parseInt(x, 16));
const hexMac = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(":");
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const fixedName = (s: string) => [...ascii(s).slice(0, MAX_L_PORT_NAME), ...new Array(Math.max(0, MAX_L_PORT_NAME - s.length)).fill(0)];
const tlv = (type: number, value: number[]) => [...u16(type & 0x3fff), ...u16(value.length), ...value];

/** ICC message: LDP header (msg type, length, id) + ICC RG ID TLV + parameters (msg_format.h:251-286). */
function iccMsg(rt: MclagRt, type: number, rgId: number, params: number[]): number[] {
  const body = [...u32(++rt.msgId), ...tlv(TLV.RG_ID, u32(rgId)), ...params];
  return [...u16(type & 0x7fff), ...u16(body.length), ...body];
}

interface Tlv {
  type: number;
  v: number[];
}

function parseMsgs(b: number[]): { type: number; tlvs: Tlv[] }[] {
  const out: { type: number; tlvs: Tlv[] }[] = [];
  let off = 0;
  while (off + 4 <= b.length) {
    const type = ((b[off] << 8) | b[off + 1]) & 0x7fff;
    const len = (b[off + 2] << 8) | b[off + 3];
    const body = b.slice(off + 4, off + 4 + len);
    off += 4 + len;
    const tlvs: Tlv[] = [];
    let p = 4; // msg id
    while (p + 4 <= body.length) {
      const t = ((body[p] << 8) | body[p + 1]) & 0x3fff;
      const l = (body[p + 2] << 8) | body[p + 3];
      tlvs.push({ type: t, v: body.slice(p + 4, p + 4 + l) });
      p += 4 + l;
    }
    out.push({ type, tlvs });
  }
  return out;
}

function aggStateTlv(name: string, up: boolean): number[] {
  // mLACPAggPortStateTLV (mlacp_tlv.h:223-242): partner sys id/prio/key, agg id, actor key, state.
  const id = Number(name.replace(/\D/g, "")) & 0xffff;
  return tlv(TLV.AGG_STATE, [...new Array(6).fill(0), ...u16(0), ...u16(0), ...u16(id), ...u16(0), up ? PORT_UP : PORT_DOWN]);
}

function arpInfoTlv(entries: { op: number; ip: string; mac: string; ifname: string }[]): number[] {
  // mLACPARPInfoTLV / struct ARPMsg (mlacp_tlv.h:376-405): op, flag, learn_flag, ifname[20], ipv4, mac.
  const v = [...u16(entries.length)];
  for (const e of entries) v.push(e.op, 0, NEIGH_LOCAL, ...fixedName(e.ifname), ...e.ip.split(".").map(Number), ...macBytes(e.mac));
  return tlv(TLV.ARP_INFO, v);
}

function macInfoTlv(entries: { op: number; mac: string; vid: number; ifname: string }[]): number[] {
  // mLACPMACInfoTLV / mLACPMACData (mlacp_tlv.h:353-371).
  const v = [...u16(entries.length)];
  for (const e of entries) v.push(e.op, 0, ...macBytes(e.mac), ...u16(e.vid), ...fixedName(e.ifname));
  return tlv(TLV.MAC_INFO, v);
}

// ---------- TCP ----------

function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function segment(ctx: SimContext, d: Device, c: MclagDomainCfg, rt: MclagRt, flags: TcpHeader["flags"], payload: number[], what: string): void {
  const tcb = rt.tcb!;
  const syn = flags.includes("SYN");
  const tcp: TcpHeader = { srcPort: tcb.localPort, dstPort: tcb.remotePort, seq: syn ? (tcb.sndNxt - 1) >>> 0 : tcb.sndNxt, ack: flags.includes("ACK") ? tcb.rcvNxt : 0, flags, window: 64240 };
  if (!syn) tcb.sndNxt = (tcb.sndNxt + payload.length) >>> 0;
  rt.tx++;
  sendIpv4(ctx, d, { src: c.sourceIp, dst: c.peerIp, ttl: 64, tos: 0xc0, tcp, payload, summary: `ICCP ${what} ${c.sourceIp}:${tcb.localPort} → ${c.peerIp}:${tcb.remotePort}` });
}

function sendData(ctx: SimContext, d: Device, c: MclagDomainCfg, rt: MclagRt, payload: number[], what: string): void {
  if (rt.tcb?.state !== "ESTABLISHED" || !payload.length) return;
  segment(ctx, d, c, rt, ["PSH", "ACK"], payload, what);
}

// ---------- session ----------

function localIfStates(d: Device, c: MclagDomainCfg): Record<string, "up" | "down"> {
  const out: Record<string, "up" | "down"> = {};
  for (const n of c.interfaces) out[n] = isUp(ifByName(d, n)) ? "up" : "down";
  return out;
}

/** Initial burst after TCP comes up: RG Connect + App Data (system config, all MLAG ifs, all MACs). */
function sendInitial(ctx: SimContext, d: Device, c: MclagDomainCfg, rt: MclagRt): void {
  const rg = Number(c.id);
  const ifs = localIfStates(d, c);
  rt.sentIfs = ifs;
  rt.sentMacs = {};
  rt.sentArps = {};
  const params = [
    ...tlv(TLV.SYSTEM_CONFIG, [...macBytes(localSystemId(d, c)), ...u16(0xffff), isActiveRole(c) ? 0 : 1]),
    ...Object.entries(ifs).flatMap(([n, s]) => aggStateTlv(n, s === "up")),
  ];
  const payload = [...iccMsg(rt, MSG.RG_CONNECT, rg, tlv(TLV.SENDER_NAME, ascii(d.config.hostname ?? d.name))), ...iccMsg(rt, MSG.RG_APP_DATA, rg, params)];
  sendData(ctx, d, c, rt, payload, "RG Connect + System Config");
}

function sessionDown(d: Device, rt: MclagRt): boolean {
  const was = rt.session || !!rt.tcb;
  // mlacp_peer_disconn_handler: flush remote MACs, isolation cleanup, Standby restores MACs.
  for (const key of Object.keys(rt.installed)) removeFdb(d, key);
  for (const key of Object.keys(rt.redirected)) removeFdb(d, key);
  restoreMacs(d, rt);
  rt.installed = {};
  rt.redirected = {};
  rt.remoteMacs = {};
  rt.remoteIfs = {};
  rt.sentIfs = {};
  rt.sentMacs = {};
  rt.sentArps = {};
  rt.remoteArps = {};
  rt.installedArps = {};
  rt.session = false;
  rt.tcb = undefined;
  rt.remoteSystemId = undefined;
  rt.nextHello = undefined;
  return was;
}

function restoreMacs(d: Device, rt: MclagRt): void {
  for (const [n, mac] of Object.entries(rt.origMac)) {
    const pc = ifByName(d, n);
    if (pc) pc.mac = mac;
  }
  rt.origMac = {};
}

/** iccp_netlink.c:640-700 (+ configured mclag-system-mac on both peers). */
function applySystemMacs(d: Device, c: MclagDomainCfg, rt: MclagRt): boolean {
  let changed = false;
  for (const n of c.interfaces) {
    const pc = ifByName(d, n);
    if (!pc) continue;
    let want: string | undefined;
    if (c.systemMac) want = c.systemMac;
    else if (rt.session && rt.role === "standby" && rt.remoteSystemId && rt.remoteIfs[n]) want = rt.remoteSystemId;
    if (want) {
      if (normalizeMac(pc.mac) !== normalizeMac(want)) {
        rt.origMac[n] ??= pc.mac;
        pc.mac = want;
        changed = true;
      }
    } else if (rt.origMac[n]) {
      pc.mac = rt.origMac[n];
      delete rt.origMac[n];
      changed = true;
    }
  }
  return changed;
}

// ---------- FDB programming ----------

const fdbKey = (mac: string, vid: number) => `${normalizeMac(mac)}|${vid}`;
const splitKey = (k: string) => {
  const [mac, vid] = k.split("|");
  return { mac, vid: Number(vid) };
};

function removeFdb(d: Device, key: string): void {
  const { mac, vid } = splitKey(key);
  d.macTable = d.macTable.filter((e) => !(normalizeMac(e.mac) === mac && e.vlan === vid));
}

function setFdb(d: Device, key: string, iface: NetInterface): boolean {
  const { mac, vid } = splitKey(key);
  const e = d.macTable.find((x) => normalizeMac(x.mac) === mac && x.vlan === vid);
  if (e) {
    if (e.interfaceId === iface.id) return false;
    e.interfaceId = iface.id;
  } else d.macTable.push({ mac, interfaceId: iface.id, vlan: vid });
  return true;
}

/** Where a peer-learned MAC is programmed (mlacp_sync_update.c:306-353). */
function remoteTarget(d: Device, c: MclagDomainCfg, ifname: string): NetInterface | undefined {
  if (c.interfaces.includes(ifname)) {
    const local = ifByName(d, ifname);
    if (isUp(local)) return local;
  }
  const pl = ifByName(d, c.peerLink);
  return isUp(pl) ? pl : undefined;
}

/** Re-evaluate FDB entries: remote MACs, local MLAG-down redirection. Returns MAC Info entries to send. */
function syncFdb(d: Device, c: MclagDomainCfg, rt: MclagRt): { changed: boolean; send: { op: number; mac: string; vid: number; ifname: string }[] } {
  let changed = false;
  const peerLink = ifByName(d, c.peerLink);
  const byId = (id: string) => d.interfaces.find((i) => i.id === id);
  // 1. Locally learned MACs on a down MLAG interface → peer-link; back when it is up again.
  for (const e of d.macTable) {
    const key = fdbKey(e.mac, e.vlan);
    if (rt.installed[key]) continue;
    const port = byId(e.interfaceId);
    if (port && c.interfaces.includes(port.name) && !isUp(port) && peerLink && isUp(peerLink) && rt.remoteIfs[port.name] === "up") {
      rt.redirected[key] = port.name;
      e.interfaceId = peerLink.id;
      changed = true;
    }
  }
  for (const [key, po] of Object.entries(rt.redirected)) {
    const pc = ifByName(d, po);
    const { mac, vid } = splitKey(key);
    const e = d.macTable.find((x) => normalizeMac(x.mac) === mac && x.vlan === vid);
    if (!e) {
      delete rt.redirected[key];
      continue;
    }
    if (isUp(pc)) {
      e.interfaceId = pc!.id;
      delete rt.redirected[key];
      changed = true;
    }
  }
  // 2. Peer-learned MACs: (re)program; re-pin if the bridge relearned them elsewhere.
  for (const [key, ifname] of Object.entries(rt.remoteMacs)) {
    const { mac, vid } = splitKey(key);
    const e = d.macTable.find((x) => normalizeMac(x.mac) === mac && x.vlan === vid);
    const local = e && !rt.installed[key] && e.interfaceId !== peerLink?.id && !rt.redirected[key];
    if (local) continue; // locally learned on a front-panel port wins
    const target = remoteTarget(d, c, ifname);
    if (!target) {
      if (rt.installed[key]) {
        removeFdb(d, key);
        delete rt.installed[key];
        changed = true;
      }
      continue;
    }
    if (setFdb(d, key, target)) changed = true;
    rt.installed[key] = true;
  }
  // 3. Advertise local MACs (not peer-link, not programmed by us).
  const now: Record<string, string> = {};
  for (const e of d.macTable) {
    const key = fdbKey(e.mac, e.vlan);
    if (rt.installed[key]) continue;
    const port = byId(e.interfaceId);
    if (!port || (peerLink && port.id === peerLink.id && !rt.redirected[key])) continue;
    now[key] = rt.redirected[key] ?? port.name;
  }
  const send: { op: number; mac: string; vid: number; ifname: string }[] = [];
  for (const [key, ifname] of Object.entries(now)) {
    if (rt.sentMacs[key] !== ifname) send.push({ op: MAC_ADD, ...splitKey(key), ifname });
  }
  for (const [key, ifname] of Object.entries(rt.sentMacs)) if (!(key in now)) send.push({ op: MAC_DEL, ...splitKey(key), ifname });
  rt.sentMacs = now;
  return { changed, send };
}

// ---------- ARP sync ----------

/** Interfaces whose neighbours iccpd syncs: VLAN interfaces and MLAG interfaces. */
const arpSynced = (c: MclagDomainCfg, name: string) => /^Vlan\d+$/.test(name) || c.interfaces.includes(name);

/** Local ARP entries to advertise → add/del ARPMsg entries (diff against what was sent). */
function syncArp(d: Device, c: MclagDomainCfg, rt: MclagRt): { op: number; ip: string; mac: string; ifname: string }[] {
  const installed = (rt.installedArps ??= {});
  const now: Record<string, string> = {};
  for (const e of d.arpTable) {
    if (e.state === "incomplete" || installed[e.ip]) continue;
    const iface = d.interfaces.find((i) => i.id === e.interfaceId);
    if (!iface || !arpSynced(c, iface.name)) continue;
    now[e.ip] = `${iface.name}|${normalizeMac(e.mac)}`;
  }
  const sent = (rt.sentArps ??= {});
  const out: { op: number; ip: string; mac: string; ifname: string }[] = [];
  for (const [ip, v] of Object.entries(now)) {
    if (sent[ip] === v) continue;
    const [ifname, mac] = v.split("|");
    out.push({ op: NEIGH_SYNC_ADD, ip, mac, ifname });
  }
  for (const [ip, v] of Object.entries(sent)) {
    if (ip in now) continue;
    const [ifname, mac] = v.split("|");
    out.push({ op: NEIGH_SYNC_DEL, ip, mac, ifname });
  }
  rt.sentArps = now;
  return out;
}

/** mlacp_fsm_update_arp_entry (mlacp_sync_update.c:626-760): install a peer's ARP entry. */
function applyRemoteArp(d: Device, rt: MclagRt, op: number, ip: string, mac: string, ifname: string, nowMs: number): void {
  const installed = (rt.installedArps ??= {});
  const remote = (rt.remoteArps ??= {});
  if (op === NEIGH_SYNC_DEL) {
    delete remote[ip];
    if (installed[ip]) {
      deleteArp(d, ip);
      delete installed[ip];
    }
    return;
  }
  remote[ip] = { ifname, mac };
  const iface = ifByName(d, ifname);
  if (!iface || !iface.ipv4.length) return; // no such L3 interface here
  if (iface.ipv4.some((a) => a.address === ip)) return; // "ignoring ARP sync for self ip"
  const local = d.arpTable.find((e) => e.ip === ip);
  if (local && !installed[ip] && local.state !== "incomplete") return; // learned locally
  learnArp(d, ip, mac, iface.id, { now: nowMs });
  installed[ip] = true;
}

// ---------- daemon ----------

function signature(d: Device, c: MclagDomainCfg): string {
  const ifs = [...c.interfaces, c.peerLink ?? ""].map((n) => `${n}:${isUp(ifByName(d, n)) ? 1 : 0}:${ifByName(d, n)?.mac ?? ""}`).join(",");
  const fdb = d.macTable.map((e) => `${e.mac}/${e.vlan}/${e.interfaceId}`).join(",");
  const arp = d.arpTable.map((e) => `${e.ip}/${e.mac}/${e.state}`).join(",");
  return `${JSON.stringify(c)}|${ifs}|${fdb}|${arp}`;
}

function tickDevice(ctx: SimContext, d: Device, now: number): boolean {
  const c = mclagConfig(d);
  let rt = mclagRuntime(d);
  if (!c || !c.sourceIp || !c.peerIp || !featureEnabled(d, "iccpd")) {
    if (!rt) return false;
    sessionDown(d, rt);
    delete d.config.features![RT];
    return true;
  }
  if (rt && rt.domain !== c.id) {
    sessionDown(d, rt);
    delete d.config.features![RT];
  }
  rt = featureState<MclagRt>(d, RT, () => freshRt(c.id));
  let changed = false;
  const usable = ownsIp(d, c.sourceIp);

  // Session timeout (scheduler.c:82).
  if (rt.session && now - rt.lastRx > c.sessionTimeout * 1000) {
    logEvent(d, now, "WARNING", "iccpd#iccpd", "[ICCP_FSM.WARN] iccpd connection timeout (heartbeat)"); // iccpd/src/scheduler.c:85, logger.c:120
    if (sessionDown(d, rt)) changed = true;
  }
  // Active is the TCP client: SYN every CONNECT_INTERVAL until connected.
  if (usable && isActiveRole(c) && rt.tcb?.state !== "ESTABLISHED" && (rt.nextConnect ?? 0) <= now) {
    const iss = hash32(`${d.id}|${now}`);
    rt.tcb = { state: "SYN_SENT", localPort: 32768 + (hash32(`${d.id}|${c.peerIp}|${now}`) % 28232), remotePort: ICCP_TCP_PORT, sndNxt: (iss + 1) >>> 0, rcvNxt: 0 };
    rt.nextConnect = now + CONNECT_INTERVAL_MS;
    segment(ctx, d, c, rt, ["SYN"], [], "SYN");
    changed = true;
  }
  if (rt.tcb?.state === "ESTABLISHED") {
    const params: number[] = [];
    // Aggregator state changes.
    const ifs = localIfStates(d, c);
    for (const [n, s] of Object.entries(ifs)) if (rt.sentIfs[n] !== s) params.push(...aggStateTlv(n, s === "up"));
    rt.sentIfs = ifs;
    if (rt.session) {
      const fdb = syncFdb(d, c, rt);
      if (fdb.changed) changed = true;
      if (fdb.send.length) params.push(...macInfoTlv(fdb.send));
      const arps = syncArp(d, c, rt);
      if (arps.length) params.push(...arpInfoTlv(arps));
    }
    // Heartbeat every keepalive_interval.
    if ((rt.nextHello ?? 0) <= now) {
      params.push(...tlv(TLV.HEARTBEAT, [0xff]));
      rt.nextHello = now + c.keepalive * 1000;
      changed = true;
    }
    if (params.length) sendData(ctx, d, c, rt, iccMsg(rt, MSG.RG_APP_DATA, Number(c.id), params), "App Data");
  }
  if (applySystemMacs(d, c, rt)) changed = true;
  rt.sig = signature(d, c);
  return changed;
}

function onEstablished(ctx: SimContext, d: Device, c: MclagDomainCfg, rt: MclagRt, now: number): void {
  rt.tcb!.state = "ESTABLISHED";
  rt.lastRx = now;
  rt.nextHello = now + c.keepalive * 1000;
  sendInitial(ctx, d, c, rt);
}

function handleMsgs(d: Device, c: MclagDomainCfg, rt: MclagRt, payload: number[]): void {
  for (const m of parseMsgs(payload)) {
    for (const t of m.tlvs) {
      if (t.type === TLV.SYSTEM_CONFIG && t.v.length >= 6) {
        rt.remoteSystemId = hexMac(t.v.slice(0, 6));
        if (!rt.session) {
          // MLACP_STATE_EXCHANGE: session up, role decided (iccp_csm.c:847-869).
          rt.session = true;
          rt.everUp = true;
          rt.role = isActiveRole(c) ? "active" : "standby";
          logEvent(d, rt.lastRx, "NOTICE", "iccpd#iccpd", `[iccp_csm_transit.NOTICE] csm ${c.id} change state from CAPREC to OPERATIONAL.`); // iccpd/src/iccp_csm.c:377
        }
      } else if (t.type === TLV.AGG_STATE && t.v.length >= 15) {
        const id = (t.v[10] << 8) | t.v[11];
        rt.remoteIfs[`PortChannel${id}`] = t.v[14] === PORT_UP ? "up" : "down";
      } else if (t.type === TLV.ARP_INFO && t.v.length >= 2) {
        const n = (t.v[0] << 8) | t.v[1];
        for (let i = 0, off = 2; i < n && off + 33 <= t.v.length; i++, off += 33) {
          const ifname = String.fromCharCode(...t.v.slice(off + 3, off + 23).filter((x) => x !== 0));
          const ip = t.v.slice(off + 23, off + 27).join(".");
          applyRemoteArp(d, rt, t.v[off], ip, hexMac(t.v.slice(off + 27, off + 33)), ifname, rt.lastRx);
        }
      } else if (t.type === TLV.MAC_INFO && t.v.length >= 2) {
        const n = (t.v[0] << 8) | t.v[1];
        for (let i = 0, off = 2; i < n && off + 30 <= t.v.length; i++, off += 30) {
          const op = t.v[off];
          const mac = hexMac(t.v.slice(off + 2, off + 8));
          const vid = (t.v[off + 8] << 8) | t.v[off + 9];
          const ifname = String.fromCharCode(...t.v.slice(off + 10, off + 30).filter((x) => x !== 0));
          const key = fdbKey(mac, vid);
          if (op === MAC_ADD) rt.remoteMacs[key] = ifname;
          else {
            delete rt.remoteMacs[key];
            if (rt.installed[key]) {
              removeFdb(d, key);
              delete rt.installed[key];
            }
          }
        }
      }
    }
  }
  if (rt.session) syncFdbQuiet(d, c, rt);
}

/** Program peer MACs right away (advertisements wait for the next tick). */
function syncFdbQuiet(d: Device, c: MclagDomainCfg, rt: MclagRt): void {
  const sent = rt.sentMacs;
  syncFdb(d, c, rt);
  rt.sentMacs = sent;
}

function receive(ctx: SimContext, d: Device, _ingress: NetInterface, frame: Frame): boolean {
  const t = frame.tcp;
  const ip = frame.ipv4;
  if (!t || !ip || (t.dstPort !== ICCP_TCP_PORT && t.srcPort !== ICCP_TCP_PORT)) return false;
  const c = mclagConfig(d);
  if (!c || ip.dstIp !== c.sourceIp || ip.srcIp !== c.peerIp) return false;
  if (!featureEnabled(d, "iccpd")) return false; // iccpd not running: the kernel answers RST
  const rt = mclagRuntime(d) ?? (featureState<MclagRt>(d, RT, () => freshRt(c.id)));
  const now = ctx.wallNow();
  const has = (f: string) => t.flags.includes(f);
  rt.rx++;
  if (has("RST")) {
    sessionDown(d, rt);
    return true;
  }
  if (has("SYN") && !has("ACK")) {
    if (t.dstPort !== ICCP_TCP_PORT || isActiveRole(c)) return true; // only the Standby listens
    if (rt.tcb) sessionDown(d, rt); // peer restarted
    const iss = hash32(`${d.id}|${now}|${t.srcPort}`);
    rt.tcb = { state: "SYN_RCVD", localPort: ICCP_TCP_PORT, remotePort: t.srcPort, sndNxt: (iss + 1) >>> 0, rcvNxt: (t.seq + 1) >>> 0 };
    segment(ctx, d, c, rt, ["SYN", "ACK"], [], "SYN-ACK");
    return true;
  }
  const tcb = rt.tcb;
  if (!tcb || t.dstPort !== tcb.localPort || t.srcPort !== tcb.remotePort) return true;
  if (has("SYN") && has("ACK")) {
    if (tcb.state !== "SYN_SENT" || t.ack !== tcb.sndNxt) return true;
    tcb.rcvNxt = (t.seq + 1) >>> 0;
    tcb.state = "ESTABLISHED";
    segment(ctx, d, c, rt, ["ACK"], [], "ACK");
    onEstablished(ctx, d, c, rt, now);
    return true;
  }
  if (tcb.state === "SYN_RCVD" && has("ACK")) onEstablished(ctx, d, c, rt, now);
  const payload = l4Payload(frame);
  if (tcb.state === "ESTABLISHED" && payload && payload.length) {
    tcb.rcvNxt = (tcb.rcvNxt + payload.length) >>> 0;
    rt.lastRx = now;
    handleMsgs(d, c, rt, Array.from(payload));
    applySystemMacs(d, c, rt);
  }
  return true;
}

registerDaemon({
  id: "mclag",
  nextDue(d, now) {
    if (!isSwitch(d.type)) return undefined;
    const c = mclagConfig(d);
    const rt = mclagRuntime(d);
    if (!c || !featureEnabled(d, "iccpd")) return rt ? now : undefined;
    if (!rt || rt.sig !== signature(d, c)) return now;
    const ts: (number | undefined)[] = [rt.nextHello];
    if (rt.tcb?.state !== "ESTABLISHED" && isActiveRole(c)) ts.push(rt.nextConnect ?? now);
    if (rt.session) ts.push(rt.lastRx + c.sessionTimeout * 1000 + 1);
    const due = ts.filter((x): x is number => x !== undefined);
    return due.length ? Math.min(...due) : undefined;
  },
  tick: (ctx, d, now) => tickDevice(ctx, d, now),
  receiveL3: receive,
});

// ---------- data plane: peer-link isolation + no learning on the peer-link ----------

/** Is `iface` the peer-link, or a member of a PortChannel peer-link? */
function onPeerLink(d: Device, c: MclagDomainCfg, iface: NetInterface): boolean {
  if (!c.peerLink) return false;
  if (iface.name === c.peerLink) return true;
  const lags = peekFeatureState<{ portchannels: { name: string; members: string[] }[] }>(d, "lacp")?.portchannels ?? [];
  return !!lags.find((l) => l.name === c.peerLink)?.members.includes(iface.name);
}

/**
 * FDB entry of a frame's source MAC as it was before the bridge saw the frame on
 * the peer-link: the bridge (switch.ts) always learns, but iccpd disables learning
 * on the peer-link while the session is up (mlacp_link_handler.c:2278
 * set_peerlink_mlag_port_learn(peer_link, 0)), so the entry is put back as soon as
 * the bridge consults allowEgress for that frame (after learning, before forwarding).
 */
const beforeLearn = new WeakMap<Frame, { device: string; mac: string; ifaceId?: string }>();

function undoPeerLinkLearning(sw: Device, frame: Frame): void {
  const b = beforeLearn.get(frame);
  if (!b || b.device !== sw.id) return;
  beforeLearn.delete(frame);
  const mac = normalizeMac(b.mac);
  for (const e of [...sw.macTable]) {
    if (normalizeMac(e.mac) !== mac) continue;
    if (b.ifaceId) e.interfaceId = b.ifaceId;
    else sw.macTable = sw.macTable.filter((x) => x !== e);
  }
}

registerDataPlaneHook({
  id: "mclag",
  portIngress(_ctx, sw, iface, frame) {
    const rt = mclagRuntime(sw);
    if (!rt?.session) return true;
    const c = mclagConfig(sw);
    if (c && onPeerLink(sw, c, iface)) {
      const mac = normalizeMac(frame.ethernet.srcMac);
      const e = sw.macTable.find((x) => normalizeMac(x.mac) === mac);
      beforeLearn.set(frame, { device: sw.id, mac, ifaceId: e?.interfaceId });
    }
    return true;
  },
  allowEgress(_ctx, sw, ingressId, egress, _vid, frame) {
    if (!ingressId) return true;
    const rt = mclagRuntime(sw);
    if (!rt?.session) return true; // session down: isolation cleaned up (mlacp_link_handler.c:2445)
    const c = mclagConfig(sw);
    const pl = ifByName(sw, c?.peerLink);
    if (!c || !pl || pl.id !== ingressId) return true;
    undoPeerLinkLearning(sw, frame);
    return !(c.interfaces.includes(egress.name) && rt.remoteIfs[egress.name] === "up");
  },
});
