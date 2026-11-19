/**
 * Router Solicitation / Router Advertisement wire format (RFC 4861 4.1, 4.2,
 * 4.6) — real ICMPv6 bytes with the pseudo-header checksum, so tcpdump and
 * Scapy (ICMPv6ND_RA / ICMPv6NDOptPrefixInfo) decode what radvd would send.
 *
 * Option order follows radvd send.c (send_ra): prefix information, MTU,
 * source link-layer address.
 */
import { ipv6Bytes, ipv6FromBytes } from "../models/ipv6";
import { IPV6_NH, pseudoChecksum6 } from "./ipv6";

export const ICMP6_RS = 133;
export const ICMP6_RA = 134;
export const ALL_NODES = "ff02::1";
export const ALL_ROUTERS = "ff02::2";
/** radvd AdvValidLifetime / AdvPreferredLifetime "infinity". */
export const INFINITY = 0xffffffff;

const OPT_SLLA = 1;
const OPT_PREFIX = 3;
const OPT_MTU = 5;

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const rd16 = (b: ArrayLike<number>, o: number) => ((b[o] << 8) | b[o + 1]) >>> 0;
const rd32 = (b: ArrayLike<number>, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const macBytes = (mac: string) => mac.split(/[:-]/).map((x) => parseInt(x, 16) & 0xff);
const macStr = (b: ArrayLike<number>, o: number) => Array.from({ length: 6 }, (_, i) => (b[o + i] ?? 0).toString(16).padStart(2, "0")).join(":");

export interface RaPrefix {
  prefix: string;
  len: number;
  onLink: boolean;
  autonomous: boolean;
  valid: number;
  preferred: number;
}

export interface RouterAdvert {
  curHopLimit: number;
  managed: boolean;
  other: boolean;
  lifetime: number;
  reachable: number;
  retrans: number;
  prefixes: RaPrefix[];
  mtu?: number;
  slla?: string;
}

function withChecksum(src: string, dst: string, msg: number[]): number[] {
  const ck = pseudoChecksum6(src, dst, IPV6_NH.ICMPV6, msg);
  msg[2] = ck >> 8;
  msg[3] = ck & 0xff;
  return msg;
}

export function encodeRa(src: string, dst: string, ra: RouterAdvert): number[] {
  const flags = (ra.managed ? 0x80 : 0) | (ra.other ? 0x40 : 0);
  const msg = [ICMP6_RA, 0, 0, 0, ra.curHopLimit & 0xff, flags, ...u16(ra.lifetime), ...u32(ra.reachable), ...u32(ra.retrans)];
  for (const p of ra.prefixes) {
    const pf = (p.onLink ? 0x80 : 0) | (p.autonomous ? 0x40 : 0);
    msg.push(OPT_PREFIX, 4, p.len, pf, ...u32(p.valid), ...u32(p.preferred), 0, 0, 0, 0, ...ipv6Bytes(p.prefix));
  }
  if (ra.mtu !== undefined) msg.push(OPT_MTU, 1, 0, 0, ...u32(ra.mtu));
  if (ra.slla) msg.push(OPT_SLLA, 1, ...macBytes(ra.slla));
  return withChecksum(src, dst, msg);
}

export function encodeRs(src: string, dst: string, slla?: string): number[] {
  const msg = [ICMP6_RS, 0, 0, 0, 0, 0, 0, 0];
  if (slla && src !== "::") msg.push(OPT_SLLA, 1, ...macBytes(slla));
  return withChecksum(src, dst, msg);
}

/** True when the ICMPv6 checksum over the pseudo-header verifies. */
export function icmp6ChecksumOk(src: string, dst: string, msg: number[]): boolean {
  return pseudoChecksum6(src, dst, IPV6_NH.ICMPV6, msg) === 0;
}

function options(msg: number[], from: number): { type: number; o: number; len: number }[] {
  const out: { type: number; o: number; len: number }[] = [];
  for (let o = from; o + 2 <= msg.length; ) {
    const len = msg[o + 1] * 8;
    if (len === 0 || o + len > msg.length) break;
    out.push({ type: msg[o], o, len });
    o += len;
  }
  return out;
}

export function decodeRa(msg: number[]): RouterAdvert | null {
  if (msg.length < 16 || msg[0] !== ICMP6_RA || msg[1] !== 0) return null;
  const ra: RouterAdvert = {
    curHopLimit: msg[4],
    managed: !!(msg[5] & 0x80),
    other: !!(msg[5] & 0x40),
    lifetime: rd16(msg, 6),
    reachable: rd32(msg, 8),
    retrans: rd32(msg, 12),
    prefixes: [],
  };
  for (const { type, o, len } of options(msg, 16)) {
    if (type === OPT_PREFIX && len === 32) {
      ra.prefixes.push({
        len: msg[o + 2],
        onLink: !!(msg[o + 3] & 0x80),
        autonomous: !!(msg[o + 3] & 0x40),
        valid: rd32(msg, o + 4),
        preferred: rd32(msg, o + 8),
        prefix: ipv6FromBytes(msg, o + 16),
      });
    } else if (type === OPT_MTU && len === 8) ra.mtu = rd32(msg, o + 4);
    else if (type === OPT_SLLA && len === 8) ra.slla = macStr(msg, o + 2);
  }
  return ra;
}

export function decodeRs(msg: number[]): { slla?: string } | null {
  if (msg.length < 8 || msg[0] !== ICMP6_RS || msg[1] !== 0) return null;
  const sl = options(msg, 8).find((x) => x.type === OPT_SLLA && x.len === 8);
  return { slla: sl ? macStr(msg, sl.o + 2) : undefined };
}

const life = (n: number) => (n === INFINITY ? "infinity" : `${n}s`);

/** tcpdump print-icmp6.c text: `ICMP6, router advertisement, length 64` (+ -v lines). */
export function describeNd(msg: number[], verbose: boolean): string | undefined {
  if (msg[0] === ICMP6_RS) {
    let s = `ICMP6, router solicitation, length ${msg.length}`;
    const rs = verbose ? decodeRs(msg) : null;
    if (rs?.slla) s += `\n\t  source link-address option (1), length 8 (1): ${rs.slla}`;
    return s;
  }
  if (msg[0] !== ICMP6_RA) return undefined;
  let s = `ICMP6, router advertisement, length ${msg.length}`;
  const ra = verbose ? decodeRa(msg) : null;
  if (ra) {
    const f = [ra.managed ? "managed" : "", ra.other ? "other stateful" : ""].filter(Boolean).join(", ");
    s += `\n\thop limit ${ra.curHopLimit}, Flags [${f || "none"}], pref medium, router lifetime ${ra.lifetime}s, reachable time ${ra.reachable}ms, retrans timer ${ra.retrans}ms`;
    for (const p of ra.prefixes) {
      const pf = [p.onLink ? "onlink" : "", p.autonomous ? "auto" : ""].filter(Boolean).join(", ");
      s += `\n\t  prefix info option (3), length 32 (4): ${p.prefix}/${p.len}, Flags [${pf || "none"}], valid time ${life(p.valid)}, pref. time ${life(p.preferred)}`;
    }
    if (ra.mtu !== undefined) s += `\n\t  mtu option (5), length 8 (1):  ${ra.mtu}`;
    if (ra.slla) s += `\n\t  source link-address option (1), length 8 (1): ${ra.slla}`;
  }
  return s;
}
