/**
 * IPv4 multicast wire formats: IGMPv1/v2/v3 and PIMv2 (real bytes, Frame.rawL3),
 * plus the tcpdump text for both.
 *
 * IGMP (RFC 2236 / RFC 3376): the IP header carries the Router Alert option
 * (RFC 2113, 0x94 0x04 0x00 0x00 → IHL 6), TTL 1, TOS 0xc0 — as Linux builds
 * host reports (net/ipv4/igmp.c igmp_send_report: tos 0xc0, IP_DF, IPOPT_RA)
 * and as FRR's IGMP socket sends queries (pimd/pim_sock.c:112-120 router alert,
 * :255 IPTOS_PREC_INTERNETCONTROL).
 *   v2 message: type | max-resp (ds) | checksum | group      (8 bytes)
 *   v3 query:   … | group | S/QRV | QQIC | #src=0            (12 bytes)
 *   v3 report:  0x22 | 0 | checksum | 0 | #records | records (type, auxlen, #src, group)
 *
 * PIMv2 (RFC 7761 §4.9; FRR pimd/pim_msg.c, pim_hello.c, pim_join.c,
 * pim_register.c): header ver 2 | type, reserved, checksum. TTL 1 for Hello and
 * Join/Prune to 224.0.0.13, 64 (IPDEFTTL) for unicast Register / Register-Stop
 * (pim_pim.c:691-708), TOS 0xc0 (pim_pim.c:720). The Register checksum covers
 * only the 8-byte header + flags (pim_msg.c:44-45).
 *   Hello options (pim_hello.c:370-450): Holdtime(1) 105, LAN Prune Delay(2)
 *     500/2500 ms, DR Priority(19), Generation ID(20).
 *   Join/Prune: upstream neighbor, holdtime 210, groups with joined / pruned
 *     encoded sources; source flags S=0x04 W=0x02 R=0x01.
 *   Register: flags (B 0x80, N 0x40 null-register) + the original IP packet.
 *   Register-Stop: encoded group + encoded source.
 */
import { inetChecksum } from "../sflow/wire";
import { Frame } from "../models/packet";
import { buildFrame } from "./ethernet";
import { ipToInt } from "../models/ip";

export const IPPROTO_IGMP = 2;
export const IPPROTO_PIM = 103;
export const ALL_HOSTS = "224.0.0.1";
export const ALL_ROUTERS = "224.0.0.2";
export const ALL_PIM_ROUTERS = "224.0.0.13";
export const IGMPV3_ROUTERS = "224.0.0.22";

const ipBytes = (ip: string) => ip.split(".").map((o) => Number(o) & 0xff);
const ipStr = (b: ArrayLike<number>, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** 224.0.0.0/4. */
export function isMulticastIp(ip: string): boolean {
  const a = Number(ip.split(".")[0]);
  return a >= 224 && a <= 239;
}

/** 224.0.0.0/24 link-local control groups: never routed, always flooded (RFC 4541 §2.1.2). */
export function isLinkLocalGroup(ip: string): boolean {
  return ip.startsWith("224.0.0.");
}

/** 232.0.0.0/8 — FRR's default SSM range (no RP, no (*,G)). */
export function isSsmGroup(ip: string): boolean {
  return ip.startsWith("232.");
}

/** IPv4 header with optional Router Alert option + payload. */
export function ipv4WithOptions(o: { src: string; dst: string; proto: number; ttl: number; tos?: number; id?: number; ra?: boolean; payload: number[] }): number[] {
  const opts = o.ra ? [0x94, 0x04, 0x00, 0x00] : [];
  const ihl = 5 + opts.length / 4;
  const hdr = [0x40 | ihl, o.tos ?? 0, ...u16(ihl * 4 + o.payload.length), ...u16(o.id ?? 0), 0x40, 0x00, o.ttl & 0xff, o.proto, 0, 0, ...ipBytes(o.src), ...ipBytes(o.dst), ...opts];
  const ck = inetChecksum(hdr);
  hdr[10] = ck >> 8;
  hdr[11] = ck & 0xff;
  return [...hdr, ...o.payload];
}

function withChecksum(msg: number[], at = 2, over = msg.length): number[] {
  msg[at] = msg[at + 1] = 0;
  const ck = inetChecksum(msg.slice(0, over));
  msg[at] = ck >> 8;
  msg[at + 1] = ck & 0xff;
  return msg;
}

// ---------------------------------------------------------------------------
// IGMP

export type IgmpMsg =
  | { kind: "query"; version: 1 | 2 | 3; maxRespDs: number; group: string; qrv?: number; qqic?: number }
  | { kind: "report"; version: 1 | 2; group: string }
  | { kind: "leave"; group: string }
  | { kind: "v3report"; records: { type: number; group: string; sources: string[] }[] };

/** IGMPv3 group record types (RFC 3376 §4.2.12). */
export const V3_MODE_IS_INCLUDE = 1;
export const V3_MODE_IS_EXCLUDE = 2;
export const V3_CHANGE_TO_INCLUDE = 3;
export const V3_CHANGE_TO_EXCLUDE = 4;

export function encodeIgmp(m: IgmpMsg): number[] {
  switch (m.kind) {
    case "query":
      if (m.version === 3) return withChecksum([0x11, m.maxRespDs & 0xff, 0, 0, ...ipBytes(m.group), (m.qrv ?? 2) & 7, m.qqic ?? 125, 0, 0]);
      return withChecksum([0x11, m.version === 1 ? 0 : m.maxRespDs & 0xff, 0, 0, ...ipBytes(m.group)]);
    case "report":
      return withChecksum([m.version === 1 ? 0x12 : 0x16, 0, 0, 0, ...ipBytes(m.group)]);
    case "leave":
      return withChecksum([0x17, 0, 0, 0, ...ipBytes(m.group)]);
    case "v3report": {
      const recs = m.records.flatMap((r) => [r.type, 0, ...u16(r.sources.length), ...ipBytes(r.group), ...r.sources.flatMap(ipBytes)]);
      return withChecksum([0x22, 0, 0, 0, 0, 0, ...u16(m.records.length), ...recs]);
    }
  }
}

export function decodeIgmp(b: Uint8Array): IgmpMsg | undefined {
  if (b.length < 8) return undefined;
  const type = b[0];
  if (type === 0x11) {
    if (b.length >= 12) return { kind: "query", version: 3, maxRespDs: b[1], group: ipStr(b, 4), qrv: b[8] & 7, qqic: b[9] };
    return { kind: "query", version: b[1] === 0 ? 1 : 2, maxRespDs: b[1] === 0 ? 100 : b[1], group: ipStr(b, 4) };
  }
  if (type === 0x12 || type === 0x16) return { kind: "report", version: type === 0x12 ? 1 : 2, group: ipStr(b, 4) };
  if (type === 0x17) return { kind: "leave", group: ipStr(b, 4) };
  if (type === 0x22) {
    const n = (b[6] << 8) | b[7];
    const records: { type: number; group: string; sources: string[] }[] = [];
    let o = 8;
    for (let i = 0; i < n && o + 8 <= b.length; i++) {
      const ns = (b[o + 2] << 8) | b[o + 3];
      const sources: string[] = [];
      for (let s = 0; s < ns; s++) sources.push(ipStr(b, o + 8 + s * 4));
      records.push({ type: b[o], group: ipStr(b, o + 4), sources });
      o += 8 + ns * 4 + b[o + 1] * 4;
    }
    return { kind: "v3report", records };
  }
  return undefined;
}

/** tcpdump print-igmp.c text. */
export function describeIgmp(m: IgmpMsg): string {
  switch (m.kind) {
    case "query": {
      if (m.version === 3) {
        let s = "igmp query v3";
        if (m.maxRespDs !== 100) s += ` [max resp time ${m.maxRespDs / 10}s]`;
        if (m.group !== "0.0.0.0") s += ` [gaddr ${m.group}]`;
        return s;
      }
      let s = `igmp query v${m.version}`;
      if (m.version === 2 && m.maxRespDs !== 100) s += ` [max resp time ${m.maxRespDs}]`;
      if (m.group !== "0.0.0.0") s += ` [gaddr ${m.group}]`;
      return s;
    }
    case "report":
      return `igmp v${m.version} report ${m.group}`;
    case "leave":
      return `igmp leave ${m.group}`;
    case "v3report":
      return `igmp v3 report, ${m.records.length} group record(s)`;
  }
}

// ---------------------------------------------------------------------------
// PIMv2

export const PIM_HELLO = 0;
export const PIM_REGISTER = 1;
export const PIM_REGISTER_STOP = 2;
export const PIM_JOIN_PRUNE = 3;

export const SRC_S = 0x04;
export const SRC_WC = 0x02;
export const SRC_RPT = 0x01;

export interface JpSource {
  addr: string;
  flags: number;
}
export interface JpGroup {
  group: string;
  joins: JpSource[];
  prunes: JpSource[];
}

export type PimMsg =
  | { kind: "hello"; holdtime: number; drPriority: number; genId: number; propagationDelay: number; overrideInterval: number }
  | { kind: "joinprune"; upstream: string; holdtime: number; groups: JpGroup[] }
  | { kind: "register"; border: boolean; nullRegister: boolean; inner: number[] }
  | { kind: "registerstop"; group: string; source: string };

const encUnicast = (ip: string) => [1, 0, ...ipBytes(ip)];
const encGroup = (ip: string) => [1, 0, 0, 32, ...ipBytes(ip)];
const encSource = (s: JpSource) => [1, 0, s.flags & 7, 32, ...ipBytes(s.addr)];

export function encodePim(m: PimMsg): number[] {
  switch (m.kind) {
    case "hello":
      return withChecksum([
        0x20 | PIM_HELLO, 0, 0, 0,
        ...u16(1), ...u16(2), ...u16(m.holdtime),
        ...u16(2), ...u16(4), ...u16(m.propagationDelay & 0x7fff), ...u16(m.overrideInterval),
        ...u16(19), ...u16(4), ...u32(m.drPriority),
        ...u16(20), ...u16(4), ...u32(m.genId),
      ]);
    case "joinprune": {
      const body = m.groups.flatMap((g) => [...encGroup(g.group), ...u16(g.joins.length), ...u16(g.prunes.length), ...g.joins.flatMap(encSource), ...g.prunes.flatMap(encSource)]);
      return withChecksum([0x20 | PIM_JOIN_PRUNE, 0, 0, 0, ...encUnicast(m.upstream), 0, m.groups.length, ...u16(m.holdtime), ...body]);
    }
    case "register":
      return withChecksum([0x20 | PIM_REGISTER, 0, 0, 0, (m.border ? 0x80 : 0) | (m.nullRegister ? 0x40 : 0), 0, 0, 0, ...m.inner], 2, 8);
    case "registerstop":
      return withChecksum([0x20 | PIM_REGISTER_STOP, 0, 0, 0, ...encGroup(m.group), ...encUnicast(m.source)]);
  }
}

export function decodePim(b: Uint8Array): PimMsg | undefined {
  if (b.length < 4 || b[0] >> 4 !== 2) return undefined;
  const type = b[0] & 0x0f;
  if (type === PIM_HELLO) {
    const h = { kind: "hello" as const, holdtime: 105, drPriority: 1, genId: 0, propagationDelay: 500, overrideInterval: 2500 };
    for (let o = 4; o + 4 <= b.length; ) {
      const t = (b[o] << 8) | b[o + 1];
      const len = (b[o + 2] << 8) | b[o + 3];
      const v = o + 4;
      if (t === 1) h.holdtime = (b[v] << 8) | b[v + 1];
      if (t === 2) {
        h.propagationDelay = ((b[v] & 0x7f) << 8) | b[v + 1];
        h.overrideInterval = (b[v + 2] << 8) | b[v + 3];
      }
      if (t === 19) h.drPriority = ((b[v] << 24) | (b[v + 1] << 16) | (b[v + 2] << 8) | b[v + 3]) >>> 0;
      if (t === 20) h.genId = ((b[v] << 24) | (b[v + 1] << 16) | (b[v + 2] << 8) | b[v + 3]) >>> 0;
      o = v + len;
    }
    return h;
  }
  if (type === PIM_JOIN_PRUNE && b.length >= 14) {
    const upstream = ipStr(b, 6);
    const ngroups = b[11];
    const holdtime = (b[12] << 8) | b[13];
    const groups: JpGroup[] = [];
    let o = 14;
    for (let i = 0; i < ngroups && o + 12 <= b.length; i++) {
      const group = ipStr(b, o + 4);
      const nj = (b[o + 8] << 8) | b[o + 9];
      const np = (b[o + 10] << 8) | b[o + 11];
      o += 12;
      const src = (): JpSource => {
        const s = { flags: b[o + 2] & 7, addr: ipStr(b, o + 4) };
        o += 8;
        return s;
      };
      const joins = Array.from({ length: nj }, src);
      const prunes = Array.from({ length: np }, src);
      groups.push({ group, joins, prunes });
    }
    return { kind: "joinprune", upstream, holdtime, groups };
  }
  if (type === PIM_REGISTER && b.length >= 8) {
    return { kind: "register", border: (b[4] & 0x80) !== 0, nullRegister: (b[4] & 0x40) !== 0, inner: Array.from(b.slice(8)) };
  }
  if (type === PIM_REGISTER_STOP && b.length >= 18) return { kind: "registerstop", group: ipStr(b, 8), source: ipStr(b, 14) };
  return undefined;
}

/** tcpdump print-pim.c pimv2_print first line. */
export function describePim(b: Uint8Array): string {
  const names: Record<number, string> = { 0: "Hello", 1: "Register", 2: "Register Stop", 3: "Join / Prune", 4: "Bootstrap", 5: "Assert" };
  return `PIMv${b[0] >> 4}, ${names[b[0] & 0x0f] ?? "Unknown Type"}, length ${b.length}`;
}

// ---------------------------------------------------------------------------
// Frames

/** A frame carrying an IGMP or PIM message (rawL3 = IP header onward). */
export function controlFrame(o: { srcMac: string; dstMac: string; src: string; dst: string; proto: number; ttl: number; ra?: boolean; payload: number[]; summary: string }): Frame {
  const rawL3 = ipv4WithOptions({ src: o.src, dst: o.dst, proto: o.proto, ttl: o.ttl, tos: 0xc0, ra: o.ra, payload: o.payload });
  const frame = buildFrame(
    { srcMac: o.srcMac, dstMac: o.dstMac, etherType: "IPv4", payloadBytes: rawL3.length, summary: o.summary },
    { ipv4: { srcIp: o.src, dstIp: o.dst, ttl: o.ttl, protocol: "OTHER", protocolNumber: o.proto, identification: 0, dscp: 0x30 } },
  );
  frame.rawL3 = rawL3;
  return frame;
}

/** IP protocol number of a frame (UDP 17, IGMP 2, PIM 103, …). */
export function ipProtoOf(f: Frame): number | undefined {
  if (!f.ipv4) return undefined;
  if (f.rawL3 && f.rawL3.length >= 20) return f.rawL3[9];
  return f.ipv4.protocolNumber ?? { ICMP: 1, TCP: 6, UDP: 17, OSPF: 89, OTHER: 0 }[f.ipv4.protocol];
}

/** Bytes after the IPv4 header (honouring IHL, so options are skipped). */
export function l3Payload(f: Frame): Uint8Array | undefined {
  const r = f.rawL3;
  if (!r || r.length < 20) return undefined;
  return Uint8Array.from(r.slice((r[0] & 0x0f) * 4));
}

/** Deterministic 32-bit value from a string (Generation IDs, report delays). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Numeric compare of dotted quads. */
export function ipCmp(a: string, b: string): number {
  return ipToInt(a) - ipToInt(b);
}
