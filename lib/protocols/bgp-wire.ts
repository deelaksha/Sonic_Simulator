/**
 * BGP-4 message codec (RFC 4271 §4, RFC 6793 4-octet AS, RFC 5492 capabilities).
 * Byte layout follows FRR 10.3 bgpd:
 *   OPEN          bgp_packet.c bgp_open_send + bgp_open.c:1714 bgp_open_capability —
 *                 every capability in its OWN optional parameter (type 2).
 *   UPDATE attrs  bgp_attr.c:4498 bgp_packet_attribute — ORIGIN (flags 0x40),
 *                 AS_PATH (0x50: transitive + extended length, :4607), NEXT_HOP
 *                 (0x40), MED (0x80 optional), LOCAL_PREF (0x40, iBGP only).
 *   NOTIFICATION  code/subcode strings from bgp_debug.c:112-166.
 *   L2VPN EVPN    MP_REACH_NLRI (14) / MP_UNREACH_NLRI (15), AFI 25 / SAFI 70, both
 *                 flags 0x90 (optional + extended length, bgp_attr.c:4140 / :5002),
 *                 MP_REACH first in the attribute list (bgp_attr.c:4518), next-hop
 *                 length 4 + reserved octet; then ORIGIN, AS_PATH, (MED, LOCAL_PREF),
 *                 EXT_COMMUNITIES (16, flags 0xC0, :4489) and PMSI_TUNNEL (22, 0xC0,
 *                 :4951). No NEXT_HOP attribute (bgp_attr.c:4518 — MP only).
 *                 NLRI/ext-community/PMSI bodies: ./evpn-wire.ts.
 *   COMMUNITY     type 8, flags 0xC0 (optional transitive, bgp_attr.c bgp_packet_attribute
 *                 after LOCAL_PREF), 4-octet values sorted ascending (community_uniq_sort).
 *   IPv6 unicast  MP_REACH_NLRI AFI 2 / SAFI 1 (RFC 4760, RFC 2545): next-hop length
 *                 16 (global) or 32 (global + link-local, peer on a shared network —
 *                 bgp_updgrp_packet.c bpacket_reformat_for_peer), reserved octet,
 *                 NLRI as <len><prefix bytes>; first in the attribute list like EVPN,
 *                 no NEXT_HOP. Withdraws: MP_UNREACH_NLRI AFI 2 / SAFI 1 alone.
 */
import { AFI_L2VPN, SAFI_EVPN, EvpnRoute, Pmsi, decodeEvpnNlri, decodePmsi, encodeEvpnNlri, encodePmsi, evpnPrefixStr, ecListStr } from "./evpn-wire";
import { formatIpv6, parseIpv6 } from "../models/ipv6";

export const AFI_IP6 = 2;
export const SAFI_UNICAST = 1;

export const BGP_PORT = 179;
export const AS_TRANS = 23456; // RFC 6793
export const MSG = { OPEN: 1, UPDATE: 2, NOTIFICATION: 3, KEEPALIVE: 4, ROUTE_REFRESH: 5 } as const;
export const CAP = { MP: 1, REFRESH: 2, EXT_MESSAGE: 6, AS4: 65, ENHANCED_RR: 70, FQDN: 73 } as const;
export const ORIGIN_STR = ["i", "e", "?"]; // bgp_route.c bgp_origin_str

export interface Capability {
  code: number;
  value: number[];
}
export interface OpenMsg {
  type: 1;
  version: number;
  myAs: number;
  holdTime: number;
  bgpId: string;
  caps: Capability[];
}
export interface PathAttrs {
  origin: number;
  asPath: number[];
  nextHop: string;
  med?: number;
  localPref?: number;
  /** EXTENDED_COMMUNITIES (8-byte values, wire order). */
  extComms?: number[][];
  pmsi?: Pmsi;
  /** COMMUNITY (RFC 1997), sorted. */
  communities?: number[];
}
export interface UpdateMsg {
  type: 2;
  withdrawn: string[];
  attrs?: PathAttrs;
  nlri: string[];
  /** MP_REACH_NLRI for L2VPN EVPN (next hop = VTEP IP). */
  evpnReach?: { nextHop: string; nlri: EvpnRoute[] };
  /** MP_UNREACH_NLRI for L2VPN EVPN. */
  evpnUnreach?: EvpnRoute[];
  /** MP_REACH_NLRI for IPv6 unicast (global next hop, optional link-local). */
  v6Reach?: { nextHop: string; nextHopLL?: string; nlri: string[] };
  /** MP_UNREACH_NLRI for IPv6 unicast. */
  v6Unreach?: string[];
}
export interface NotificationMsg {
  type: 3;
  code: number;
  subcode: number;
  data: number[];
}
export interface KeepaliveMsg {
  type: 4;
}
export interface RefreshMsg {
  type: 5;
}
export type BgpMsg = OpenMsg | UpdateMsg | NotificationMsg | KeepaliveMsg | RefreshMsg;

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ipBytes = (ip: string) => ip.split(".").map((o) => Number(o) & 0xff);
const ipStr = (b: ArrayLike<number>, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const rd16 = (b: ArrayLike<number>, o: number) => (b[o] << 8) | b[o + 1];
const rd32 = (b: ArrayLike<number>, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function header(type: number, body: number[]): number[] {
  return [...new Array(16).fill(0xff), ...u16(19 + body.length), type, ...body];
}

// --- capabilities (bgp_open.c bgp_open_capability order) ---
export const capMp = (afi = 1, safi = 1): Capability => ({ code: CAP.MP, value: [...u16(afi), 0, safi] });
export const capRefresh = (): Capability => ({ code: CAP.REFRESH, value: [] });
export const capEnhancedRr = (): Capability => ({ code: CAP.ENHANCED_RR, value: [] });
export const capAs4 = (as: number): Capability => ({ code: CAP.AS4, value: u32(as) });
export const capExtMessage = (): Capability => ({ code: CAP.EXT_MESSAGE, value: [] });
export function capFqdn(host: string): Capability {
  const h = Array.from(host.slice(0, 64), (c) => c.charCodeAt(0) & 0x7f);
  return { code: CAP.FQDN, value: [h.length, ...h, 0] }; // hostname, empty domain name
}

export function encodeOpen(o: Omit<OpenMsg, "type">): number[] {
  const params: number[] = [];
  for (const c of o.caps) params.push(2, c.value.length + 2, c.code, c.value.length, ...c.value);
  const myAs = o.myAs > 0xffff ? AS_TRANS : o.myAs;
  return header(MSG.OPEN, [o.version, ...u16(myAs), ...u16(o.holdTime), ...ipBytes(o.bgpId), params.length, ...params]);
}

export const encodeKeepalive = (): number[] => header(MSG.KEEPALIVE, []);

export function encodeNotification(code: number, subcode: number, data: number[] = []): number[] {
  return header(MSG.NOTIFICATION, [code, subcode, ...data]);
}

function encodePrefix(cidr: string): number[] {
  const [addr, len] = cidr.split("/");
  const l = Number(len);
  return [l, ...ipBytes(addr).slice(0, Math.ceil(l / 8))];
}

function encodeAsPath(path: number[], as4: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < path.length; i += 255) {
    const seg = path.slice(i, i + 255);
    out.push(2, seg.length); // AS_SEQUENCE
    for (const a of seg) out.push(...(as4 ? u32(a) : u16(a > 0xffff ? AS_TRANS : a)));
  }
  return out;
}

export function encodeUpdate(u: Omit<UpdateMsg, "type">, as4: boolean): number[] {
  const wd = u.withdrawn.flatMap(encodePrefix);
  const attrs: number[] = [];
  if (u.attrs) {
    const a = u.attrs;
    attrs.push(0x40, 1, 1, a.origin);
    const ap = encodeAsPath(a.asPath, as4);
    attrs.push(0x50, 2, ...u16(ap.length), ...ap);
    attrs.push(0x40, 3, 4, ...ipBytes(a.nextHop));
    if (a.med !== undefined) attrs.push(0x80, 4, 4, ...u32(a.med));
    if (a.localPref !== undefined) attrs.push(0x40, 5, 4, ...u32(a.localPref));
    attrs.push(...encodeCommunities(a.communities));
  }
  const nlri = u.nlri.flatMap(encodePrefix);
  return header(MSG.UPDATE, [...u16(wd.length), ...wd, ...u16(attrs.length), ...attrs, ...nlri]);
}

function encodeCommunities(c: number[] | undefined): number[] {
  if (!c?.length) return [];
  const body = c.flatMap(u32);
  return body.length > 255 ? [0xd0, 8, ...u16(body.length), ...body] : [0xc0, 8, body.length, ...body];
}

const ip6Bytes = (ip: string): number[] => {
  let n = parseIpv6(ip) ?? 0n;
  const out = new Array(16).fill(0);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
};
const ip6Str = (b: ArrayLike<number>, o: number): string => {
  let n = 0n;
  for (let i = 0; i < 16; i++) n = (n << 8n) | BigInt(b[o + i] ?? 0);
  return formatIpv6(n);
};

function encodePrefix6(cidr: string): number[] {
  const [addr, len] = cidr.split("/");
  const l = Number(len);
  return [l, ...ip6Bytes(addr).slice(0, Math.ceil(l / 8))];
}

function decodePrefixes6(b: Uint8Array, o: number, end: number): string[] {
  const out: string[] = [];
  while (o < end) {
    const l = b[o++];
    const n = Math.ceil(l / 8);
    const a = new Array(16).fill(0);
    for (let i = 0; i < n; i++) a[i] = b[o + i];
    o += n;
    out.push(`${ip6Str(a, 0)}/${l}`);
  }
  return out;
}

/** Attributes of an IPv6 unicast UPDATE (next hop travels inside MP_REACH). */
export interface V6Attrs {
  origin: number;
  asPath: number[];
  med?: number;
  localPref?: number;
  communities?: number[];
}

/** UPDATE carrying IPv6 unicast routes: MP_REACH (with attrs) or MP_UNREACH (withdraw only). */
export function encodeV6Update(u: { reach?: { nextHop: string; nextHopLL?: string; nlri: string[]; attrs: V6Attrs }; unreach?: string[] }, as4: boolean): number[] {
  const attrs: number[] = [];
  if (u.unreach) {
    const body = [...u16(AFI_IP6), SAFI_UNICAST, ...u.unreach.flatMap(encodePrefix6)];
    attrs.push(0x90, 15, ...u16(body.length), ...body);
  }
  if (u.reach) {
    const a = u.reach.attrs;
    const nh = [...ip6Bytes(u.reach.nextHop), ...(u.reach.nextHopLL ? ip6Bytes(u.reach.nextHopLL) : [])];
    const body = [...u16(AFI_IP6), SAFI_UNICAST, nh.length, ...nh, 0, ...u.reach.nlri.flatMap(encodePrefix6)];
    attrs.push(0x90, 14, ...u16(body.length), ...body);
    attrs.push(0x40, 1, 1, a.origin);
    const ap = encodeAsPath(a.asPath, as4);
    attrs.push(0x50, 2, ...u16(ap.length), ...ap);
    if (a.med !== undefined) attrs.push(0x80, 4, 4, ...u32(a.med));
    if (a.localPref !== undefined) attrs.push(0x40, 5, 4, ...u32(a.localPref));
    attrs.push(...encodeCommunities(a.communities));
  }
  return header(MSG.UPDATE, [0, 0, ...u16(attrs.length), ...attrs]);
}

/** Attributes of an EVPN UPDATE (no NEXT_HOP: it travels inside MP_REACH). */
export interface EvpnAttrs {
  origin: number;
  asPath: number[];
  med?: number;
  localPref?: number;
  extComms: number[][];
  pmsi?: Pmsi;
}

/** UPDATE carrying L2VPN EVPN routes: MP_REACH (with attrs) or MP_UNREACH (withdraw only). */
export function encodeEvpnUpdate(u: { reach?: { nextHop: string; nlri: EvpnRoute[]; attrs: EvpnAttrs }; unreach?: EvpnRoute[] }, as4: boolean): number[] {
  const attrs: number[] = [];
  if (u.unreach) {
    const body = [...u16(AFI_L2VPN), SAFI_EVPN, ...u.unreach.flatMap(encodeEvpnNlri)];
    attrs.push(0x90, 15, ...u16(body.length), ...body);
  }
  if (u.reach) {
    const a = u.reach.attrs;
    const body = [...u16(AFI_L2VPN), SAFI_EVPN, 4, ...ipBytes(u.reach.nextHop), 0, ...u.reach.nlri.flatMap(encodeEvpnNlri)];
    attrs.push(0x90, 14, ...u16(body.length), ...body);
    attrs.push(0x40, 1, 1, a.origin);
    const ap = encodeAsPath(a.asPath, as4);
    attrs.push(0x50, 2, ...u16(ap.length), ...ap);
    if (a.med !== undefined) attrs.push(0x80, 4, 4, ...u32(a.med));
    if (a.localPref !== undefined) attrs.push(0x40, 5, 4, ...u32(a.localPref));
    if (a.extComms.length) attrs.push(0xc0, 16, a.extComms.length * 8, ...a.extComms.flat());
    if (a.pmsi) attrs.push(0xc0, 22, 9, ...encodePmsi(a.pmsi));
  }
  return header(MSG.UPDATE, [0, 0, ...u16(attrs.length), ...attrs]);
}

// --- decoding ---
function decodePrefixes(b: Uint8Array, o: number, end: number): string[] {
  const out: string[] = [];
  while (o < end) {
    const l = b[o++];
    const n = Math.ceil(l / 8);
    const a = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) a[i] = b[o + i];
    o += n;
    out.push(`${a.join(".")}/${l}`);
  }
  return out;
}

export class BgpDecodeError extends Error {
  constructor(public code: number, public subcode: number, msg: string) {
    super(msg);
  }
}

function decodeUpdate(b: Uint8Array, as4: boolean): UpdateMsg {
  let o = 19;
  const wdLen = rd16(b, o);
  o += 2;
  const withdrawn = decodePrefixes(b, o, o + wdLen);
  o += wdLen;
  const attrLen = rd16(b, o);
  o += 2;
  const attrEnd = o + attrLen;
  const a: Partial<PathAttrs> = {};
  let evpnReach: UpdateMsg["evpnReach"];
  let evpnUnreach: UpdateMsg["evpnUnreach"];
  let v6Reach: UpdateMsg["v6Reach"];
  let v6Unreach: UpdateMsg["v6Unreach"];
  let seen = 0;
  while (o < attrEnd) {
    const flags = b[o];
    const code = b[o + 1];
    const ext = flags & 0x10;
    const len = ext ? rd16(b, o + 2) : b[o + 2];
    o += ext ? 4 : 3;
    if (code === 1) a.origin = b[o];
    else if (code === 2) {
      const path: number[] = [];
      let p = o;
      while (p < o + len) {
        const cnt = b[p + 1];
        p += 2;
        for (let i = 0; i < cnt; i++) {
          path.push(as4 ? rd32(b, p) : rd16(b, p));
          p += as4 ? 4 : 2;
        }
      }
      a.asPath = path;
    } else if (code === 3) a.nextHop = ipStr(b, o);
    else if (code === 4) a.med = rd32(b, o);
    else if (code === 5) a.localPref = rd32(b, o);
    else if (code === 14 && rd16(b, o) === AFI_L2VPN && b[o + 2] === SAFI_EVPN) {
      const nhLen = b[o + 3];
      evpnReach = { nextHop: ipStr(b, o + 4), nlri: decodeEvpnNlri(b, o + 4 + nhLen + 1, o + len) };
    } else if (code === 15 && rd16(b, o) === AFI_L2VPN && b[o + 2] === SAFI_EVPN) evpnUnreach = decodeEvpnNlri(b, o + 3, o + len);
    else if (code === 14 && rd16(b, o) === AFI_IP6 && b[o + 2] === SAFI_UNICAST) {
      const nhLen = b[o + 3];
      v6Reach = { nextHop: ip6Str(b, o + 4), ...(nhLen >= 32 ? { nextHopLL: ip6Str(b, o + 20) } : {}), nlri: decodePrefixes6(b, o + 4 + nhLen + 1, o + len) };
    } else if (code === 15 && rd16(b, o) === AFI_IP6 && b[o + 2] === SAFI_UNICAST) v6Unreach = decodePrefixes6(b, o + 3, o + len);
    else if (code === 8) a.communities = Array.from({ length: Math.floor(len / 4) }, (_, i) => rd32(b, o + i * 4));
    else if (code === 16) a.extComms = Array.from({ length: Math.floor(len / 8) }, (_, i) => Array.from(b.slice(o + i * 8, o + i * 8 + 8)));
    else if (code === 22 && len >= 9) a.pmsi = decodePmsi(b, o);
    seen |= 1 << code;
    o += len;
  }
  const nlri = decodePrefixes(b, attrEnd, b.length);
  if (nlri.length && (seen & 0b1110) !== 0b1110) {
    // RFC 4271 §6.3: missing well-known mandatory attribute (ORIGIN/AS_PATH/NEXT_HOP).
    const missing = !(seen & 2) ? 1 : !(seen & 4) ? 2 : 3;
    throw new BgpDecodeError(3, 3, `missing well-known attribute ${missing}`);
  }
  return { type: 2, withdrawn, attrs: attrLen ? (a as PathAttrs) : undefined, nlri, ...(evpnReach ? { evpnReach } : {}), ...(evpnUnreach ? { evpnUnreach } : {}), ...(v6Reach ? { v6Reach } : {}), ...(v6Unreach ? { v6Unreach } : {}) };
}

function decodeOpen(b: Uint8Array): OpenMsg {
  const caps: Capability[] = [];
  const optLen = b[28];
  let o = 29;
  while (o < 29 + optLen) {
    const ptype = b[o];
    const plen = b[o + 1];
    if (ptype === 2) {
      let c = o + 2;
      while (c < o + 2 + plen) {
        const code = b[c];
        const clen = b[c + 1];
        caps.push({ code, value: Array.from(b.slice(c + 2, c + 2 + clen)) });
        c += 2 + clen;
      }
    }
    o += 2 + plen;
  }
  return { type: 1, version: b[19], myAs: rd16(b, 20), holdTime: rd16(b, 22), bgpId: ipStr(b, 24), caps };
}

/** Split a TCP payload into BGP messages (one segment may carry several). */
export function decodeMessages(bytes: Uint8Array, as4: boolean): BgpMsg[] {
  const out: BgpMsg[] = [];
  let o = 0;
  while (o + 19 <= bytes.length) {
    for (let i = 0; i < 16; i++) if (bytes[o + i] !== 0xff) throw new BgpDecodeError(1, 1, "marker");
    const len = rd16(bytes, o + 16);
    if (len < 19 || len > 4096 || o + len > bytes.length) throw new BgpDecodeError(1, 2, "bad length");
    const m = bytes.slice(o, o + len);
    const type = m[18];
    if (type === MSG.OPEN) out.push(decodeOpen(m));
    else if (type === MSG.UPDATE) out.push(decodeUpdate(m, as4));
    else if (type === MSG.NOTIFICATION) out.push({ type: 3, code: m[19], subcode: m[20], data: Array.from(m.slice(21)) });
    else if (type === MSG.KEEPALIVE) out.push({ type: 4 });
    else if (type === MSG.ROUTE_REFRESH) out.push({ type: 5 });
    else throw new BgpDecodeError(1, 3, "bad type");
    o += len;
  }
  return out;
}

/** AS number the OPEN really carries: the 4-octet AS capability when present (RFC 6793 §4.1). */
export function openAs(o: OpenMsg): { as: number; as4: boolean } {
  const c = o.caps.find((x) => x.code === CAP.AS4 && x.value.length === 4);
  return c ? { as: rd32(c.value, 0), as4: true } : { as: o.myAs, as4: false };
}

export function openHostname(o: OpenMsg): string | undefined {
  const c = o.caps.find((x) => x.code === CAP.FQDN);
  if (!c || !c.value.length) return undefined;
  return String.fromCharCode(...c.value.slice(1, 1 + c.value[0]));
}

// --- strings (bgp_debug.c) ---
const NOTIFY_CODE: Record<number, string> = {
  1: "Message Header Error",
  2: "OPEN Message Error",
  3: "UPDATE Message Error",
  4: "Hold Timer Expired",
  5: "Neighbor Events Error",
  6: "Cease",
  7: "ROUTE-REFRESH Message Error",
  8: "Send Hold Timer Expired",
};
const NOTIFY_SUB: Record<number, Record<number, string>> = {
  1: { 1: "/Connection Not Synchronized", 2: "/Bad Message Length", 3: "/Bad Message Type" },
  2: { 0: "/Unspecific", 1: "/Unsupported Version Number", 2: "/Bad Peer AS", 3: "/Bad BGP Identifier", 4: "/Unsupported Optional Parameter", 6: "/Unacceptable Hold Time", 7: "/Unsupported Capability" },
  3: { 0: "/Unspecific", 1: "/Malformed Attribute List", 2: "/Unrecognized Well-known Attribute", 3: "/Missing Well-known Attribute", 4: "/Attribute Flags Error", 5: "/Attribute Length Error", 6: "/Invalid ORIGIN Attribute", 8: "/Invalid NEXT_HOP Attribute", 9: "/Optional Attribute Error", 10: "/Invalid Network Field", 11: "/Malformed AS_PATH" },
  5: { 0: "/Unspecific", 1: "/Receiving Unexpected Message in OpenSent State", 2: "/Receiving Unexpected Message in OpenConfirm State", 3: "/Receiving Unexpected Message in Established State" },
  6: { 0: "/Unspecific", 1: "/Maximum Number of Prefixes Reached", 2: "/Administrative Shutdown", 3: "/Peer De-configured", 4: "/Administrative Reset", 5: "/Connection Rejected", 6: "/Other Configuration Change", 7: "/Connection Collision Resolution", 8: "/Out of Resources", 9: "/Hard Reset", 10: "/BFD Down" },
};
/** "Hold Timer Expired" / "OPEN Message Error/Bad Peer AS" (bgp_notify_code_str + subcode_str). */
export function notifyText(code: number, subcode: number): string {
  const c = NOTIFY_CODE[code] ?? "Unrecognized Error Code";
  if (code === 4 || code === 8) return c;
  return c + (NOTIFY_SUB[code]?.[subcode] ?? "/Unrecognized Error Subcode");
}

// --- tcpdump (print-bgp.c style, -v decode) ---
const MSG_NAME: Record<number, string> = { 1: "Open", 2: "Update", 3: "Notification", 4: "Keepalive", 5: "Route Refresh" };
const CAP_NAME: Record<number, string> = { 1: "Multiprotocol Extensions", 2: "Route Refresh", 6: "Extended Message", 65: "32-Bit AS Number", 70: "Enhanced Route Refresh", 73: "Hostname" };

/** print-bgp.c bgp_attr_print BGPTYPE_COMMUNITIES. */
function tcpdumpCommunity(v: number): string {
  const wk: Record<number, string> = { 0xffffff01: "NO_EXPORT", 0xffffff02: "NO_ADVERTISE", 0xffffff03: "NO_EXPORT_SUBCONFED" };
  return wk[v] ?? `${v >>> 16}:${v & 0xffff}`;
}

export function describeBgpPayload(bytes: Uint8Array, verbose: boolean): string {
  if (!verbose) return "BGP";
  const lines = ["BGP"];
  let msgs: BgpMsg[];
  try {
    msgs = decodeMessages(bytes, true);
  } catch {
    return "BGP [|BGP]";
  }
  let o = 0;
  for (const m of msgs) {
    const len = (bytes[o + 16] << 8) | bytes[o + 17];
    o += len;
    lines.push(`\t${MSG_NAME[m.type]} Message (${m.type}), length: ${len}`);
    if (m.type === 1) {
      const { as } = openAs(m);
      lines.push(`\t  Version ${m.version}, my AS ${as}, Holdtime ${m.holdTime}s, ID ${m.bgpId}`);
      lines.push(`\t  Optional parameters, length: ${m.caps.reduce((n, c) => n + c.value.length + 4, 0)}`);
      for (const c of m.caps) lines.push(`\t    Option Capabilities Advertisement (2), length: ${c.value.length + 2}`, `\t      ${CAP_NAME[c.code] ?? "Unknown"} (${c.code}), length: ${c.value.length}`);
    } else if (m.type === 2) {
      if (m.withdrawn.length) lines.push("\t  Withdrawn routes:", ...m.withdrawn.map((p) => `\t    ${p}`));
      // tcpdump print-bgp.c has no AFI 25 / SAFI 70 decoder: header lines + our NLRI strings.
      const mp = (code: number, routes: EvpnRoute[], nh?: string) => {
        lines.push(`\t  Multi-Protocol ${code === 14 ? "Reach" : "Unreach"} NLRI (${code}), Flags [OE]: `, `\t    AFI: Layer-2 VPN (25), SAFI: Unknown SAFI (70)`);
        if (nh) lines.push(`\t    nexthop: ${nh}, nh-length: 4, no SNPA`);
        lines.push(`\t    no AFI 25 / SAFI 70 decoder`, ...routes.map((r) => `\t      RD ${r.rd} ${evpnPrefixStr(r)}${r.vni !== undefined ? ` VNI ${r.vni}` : ""}`));
      };
      const mp6 = (code: number, nlri: string[], nh?: string, ll?: string) => {
        lines.push(`\t  Multi-Protocol ${code === 14 ? "Reach" : "Unreach"} NLRI (${code}), Flags [OE]: `, `\t    AFI: IPv6 (2), SAFI: Unicast (1)`);
        if (nh) lines.push(`\t    nexthop: ${nh}${ll ? `, ${ll}` : ""}, nh-length: ${ll ? 32 : 16}, no SNPA`);
        lines.push(...nlri.map((p) => `\t      ${p}`));
      };
      if (m.v6Unreach) mp6(15, m.v6Unreach);
      if (m.v6Reach) mp6(14, m.v6Reach.nlri, m.v6Reach.nextHop, m.v6Reach.nextHopLL);
      if (m.evpnUnreach) mp(15, m.evpnUnreach);
      if (m.evpnReach) mp(14, m.evpnReach.nlri, m.evpnReach.nextHop);
      if (m.attrs && m.attrs.origin !== undefined) {
        const a = m.attrs;
        lines.push(`\t  Origin (1), length: 1, Flags [T]: ${["IGP", "EGP", "Incomplete"][a.origin] ?? a.origin}`);
        lines.push(`\t  AS Path (2), length: ${a.asPath.length ? 2 + a.asPath.length * 4 : 0}, Flags [TE]: ${a.asPath.length ? a.asPath.join(" ") : "empty"}`);
        if (a.nextHop) lines.push(`\t  Next Hop (3), length: 4, Flags [T]: ${a.nextHop}`);
        if (a.med !== undefined) lines.push(`\t  Multi Exit Discriminator (4), length: 4, Flags [O]: ${a.med}`);
        if (a.localPref !== undefined) lines.push(`\t  Local Preference (5), length: 4, Flags [T]: ${a.localPref}`);
        if (a.communities?.length) lines.push(`\t  Community (8), length: ${a.communities.length * 4}, Flags [OT]: ${a.communities.map(tcpdumpCommunity).join(", ")}`);
        if (a.extComms?.length) lines.push(`\t  Extended Community (16), length: ${a.extComms.length * 8}, Flags [OT]: ${ecListStr(a.extComms)}`);
        if (a.pmsi) {
          const label = a.pmsi.vni >> 4;
          lines.push(`\t  PMSI Tunnel (22), length: 9, Flags [OT]: `, `\t    Tunnel-type ${a.pmsi.tunnelType === 6 ? "Ingress Replication" : "Unknown"} (${a.pmsi.tunnelType}), Flags [none], MPLS Label ${label}`, `\t    Tunnel-Endpoint ${a.pmsi.endpoint}`);
        }
      }
      if (m.nlri.length) lines.push("\t  Updated routes:", ...m.nlri.map((p) => `\t    ${p}`));
      if (!m.withdrawn.length && !m.attrs && !m.nlri.length && !m.evpnUnreach && !m.v6Unreach) lines.push("\t  End-of-Rib Marker (empty NLRI)");
    } else if (m.type === 3) {
      lines.push(`\t  ${NOTIFY_CODE[m.code] ?? "Unknown"} (${m.code}), subcode ${m.subcode}`);
    }
  }
  return lines.join("\n");
}
