/**
 * OSPFv3 wire format (RFC 5340 Appendix A) — real bytes so tcpdump, sFlow and
 * Scapy (scapy.contrib.ospf OSPFv3_*) decode exactly what ospf6d sends.
 *
 *   packet header   A.3.1: version 3, 16 bytes, Instance ID, checksum = the
 *                   standard IPv6 upper-layer checksum over the pseudo-header
 *                   (RFC 8200 8.1, Next Header 89) — no authentication field
 *   Hello           A.3.2 (Interface ID, priority, 24-bit Options, DR/BDR as
 *                   Router IDs)       Database Description  A.3.3
 *   LS Request      A.3.4 (same 12-byte layout as OSPFv2)
 *   LS Update/Ack   A.3.5 / A.3.6
 *   LSA header      A.4.2 (16-bit LS type; Fletcher checksum as OSPFv2)
 *   Router-LSA A.4.3, Network-LSA A.4.4, Link-LSA A.4.9,
 *   Intra-Area-Prefix-LSA A.4.10, prefix encoding A.4.1.
 */
import { ipv6Bytes, ipv6FromBytes } from "../models/ipv6";
import { IPV6_NH, pseudoChecksum6 } from "./ipv6";
import { buildLsa as buildLsa2, DD_I, DD_M, DD_MS, decodeLsr, decodeLsu } from "./ospf-wire";

export { lsaChecksumOk, withAge, compareLsa, encodeLsr, decodeLsr, encodeLsu, decodeLsu, MAX_AGE, INITIAL_SEQ, DD_I, DD_M, DD_MS, T_HELLO, T_DBD, T_LSR, T_LSU, T_ACK, PACKET_NAMES } from "./ospf-wire";

export const ALL_SPF6 = "ff02::5";
export const ALL_DR6 = "ff02::6";

export const LSA6_ROUTER = 0x2001;
export const LSA6_NETWORK = 0x2002;
export const LSA6_LINK = 0x0008;
export const LSA6_INTRA_PREFIX = 0x2009;

/** Options (A.2): V6 | E | R — what FRR ospf6d sets in a normal area. */
export const OPT6_V6 = 0x01;
export const OPT6_E = 0x02;
export const OPT6_R = 0x10;
export const OPTIONS6 = OPT6_V6 | OPT6_E | OPT6_R;

/** Prefix options (A.4.1.1): LA bit (a host address). */
export const PFX_LA = 0x02;

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u24 = (n: number) => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ipb = (ip: string) => ip.split(".").map((o) => Number(o) & 0xff);
const rd16 = (b: ArrayLike<number>, o: number) => ((b[o] << 8) | b[o + 1]) >>> 0;
const rd24 = (b: ArrayLike<number>, o: number) => ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0;
const rd32 = (b: ArrayLike<number>, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const rdip = (b: ArrayLike<number>, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
export const intToDotted = (n: number) => `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;

export interface Ospf6Header {
  type: number;
  length: number;
  routerId: string;
  areaId: string;
  instance: number;
}

/** 16-byte OSPFv3 header + body, checksum over the IPv6 pseudo-header. */
export function encodePacket6(type: number, routerId: string, areaId: string, body: number[], src: string, dst: string, instance = 0): number[] {
  const pkt = [3, type, ...u16(16 + body.length), ...ipb(routerId), ...ipb(areaId), 0, 0, instance & 0xff, 0, ...body];
  const ck = pseudoChecksum6(src, dst, IPV6_NH.OSPF, pkt);
  pkt[12] = ck >> 8;
  pkt[13] = ck & 0xff;
  return pkt;
}

/** Parse + validate (version 3, length, pseudo-header checksum). */
export function decodePacket6(b: ArrayLike<number>, src: string, dst: string): { hdr: Ospf6Header; body: number[] } | null {
  if (b.length < 16 || b[0] !== 3) return null;
  const length = rd16(b, 2);
  if (length < 16 || length > b.length) return null;
  const all = Array.from({ length }, (_, i) => b[i]);
  if (pseudoChecksum6(src, dst, IPV6_NH.OSPF, all) !== 0) return null;
  return { hdr: { type: b[1], length, routerId: rdip(b, 4), areaId: rdip(b, 8), instance: b[14] }, body: all.slice(16) };
}

// --- Hello (A.3.2) ---
export interface Hello6 {
  ifId: number;
  priority: number;
  options: number;
  helloInterval: number;
  deadInterval: number;
  dr: string;
  bdr: string;
  neighbors: string[];
}

export function encodeHello6(h: Hello6): number[] {
  return [...u32(h.ifId), h.priority, ...u24(h.options), ...u16(h.helloInterval), ...u16(h.deadInterval), ...ipb(h.dr), ...ipb(h.bdr), ...h.neighbors.flatMap(ipb)];
}

export function decodeHello6(b: number[]): Hello6 | null {
  if (b.length < 20) return null;
  const neighbors: string[] = [];
  for (let o = 20; o + 4 <= b.length; o += 4) neighbors.push(rdip(b, o));
  return { ifId: rd32(b, 0), priority: b[4], options: rd24(b, 5), helloInterval: rd16(b, 8), deadInterval: rd16(b, 10), dr: rdip(b, 12), bdr: rdip(b, 16), neighbors };
}

// --- Database Description (A.3.3) ---
export interface Dbd6 {
  options: number;
  mtu: number;
  flags: number;
  seq: number;
  headers: Lsa6Header[];
}

export function encodeDbd6(d: { options: number; mtu: number; flags: number; seq: number; headers: number[][] }): number[] {
  return [0, ...u24(d.options), ...u16(d.mtu), 0, d.flags, ...u32(d.seq >>> 0), ...d.headers.flat()];
}

export function decodeDbd6(b: number[]): Dbd6 | null {
  if (b.length < 12) return null;
  const headers: Lsa6Header[] = [];
  for (let o = 12; o + 20 <= b.length; o += 20) headers.push(parseLsa6Header(b, o));
  return { options: rd24(b, 1), mtu: rd16(b, 4), flags: b[7], seq: rd32(b, 8), headers };
}

// --- LSA header (A.4.2) ---
export interface Lsa6Header {
  age: number;
  type: number;
  id: string;
  adv: string;
  seq: number;
  checksum: number;
  length: number;
}

export function parseLsa6Header(b: ArrayLike<number>, o = 0): Lsa6Header {
  return { age: rd16(b, o), type: rd16(b, o + 2), id: rdip(b, o + 4), adv: rdip(b, o + 8), seq: rd32(b, o + 12) | 0, checksum: rd16(b, o + 16), length: rd16(b, o + 18) };
}

export const lsa6Key = (h: { type: number; id: string; adv: string }) => `${h.type.toString(16).padStart(4, "0")}/${h.adv}/${h.id}`;

/** Complete LSA with length and Fletcher checksum (the OSPFv2 algorithm, 16-bit type split over bytes 2-3). */
export function buildLsa6(h: { age: number; type: number; id: string; adv: string; seq: number }, body: number[]): number[] {
  return buildLsa2({ age: h.age, options: (h.type >> 8) & 0xff, type: h.type & 0xff, id: h.id, adv: h.adv, seq: h.seq }, body);
}

export function decodeAck6(b: number[]): Lsa6Header[] {
  const out: Lsa6Header[] = [];
  for (let o = 0; o + 20 <= b.length; o += 20) out.push(parseLsa6Header(b, o));
  return out;
}

// --- Prefixes (A.4.1) ---
export interface Prefix6 {
  len: number;
  options: number;
  /** Metric in Intra-Area-Prefix-LSAs; unused (0) in Link-LSAs. */
  metric: number;
  prefix: string;
}

const prefixWords = (len: number) => Math.ceil(len / 32) * 4;

function encodePrefix(p: Prefix6): number[] {
  return [p.len, p.options, ...u16(p.metric), ...ipv6Bytes(p.prefix).slice(0, prefixWords(p.len))];
}

function decodePrefixes(b: number[], o: number, n: number): Prefix6[] {
  const out: Prefix6[] = [];
  for (let i = 0; i < n && o + 4 <= b.length; i++) {
    const len = b[o];
    const w = prefixWords(len);
    const bytes = [...b.slice(o + 4, o + 4 + w), ...new Array(16 - w).fill(0)];
    out.push({ len, options: b[o + 1], metric: rd16(b, o + 2), prefix: ipv6FromBytes(bytes) });
    o += 4 + w;
  }
  return out;
}

// --- Router-LSA (A.4.3) ---
export interface RouterIf6 {
  /** 1 point-to-point, 2 transit. */
  type: number;
  metric: number;
  ifId: number;
  nbrIfId: number;
  nbrRid: string;
}

export function encodeRouter6(flags: number, ifs: RouterIf6[]): number[] {
  return [flags, ...u24(OPTIONS6), ...ifs.flatMap((l) => [l.type, 0, ...u16(l.metric), ...u32(l.ifId), ...u32(l.nbrIfId), ...ipb(l.nbrRid)])];
}

export function decodeRouter6(lsa: number[]): RouterIf6[] {
  const out: RouterIf6[] = [];
  for (let o = 24; o + 16 <= lsa.length; o += 16) out.push({ type: lsa[o], metric: rd16(lsa, o + 2), ifId: rd32(lsa, o + 4), nbrIfId: rd32(lsa, o + 8), nbrRid: rdip(lsa, o + 12) });
  return out;
}

// --- Network-LSA (A.4.4) ---
export function encodeNetwork6(routers: string[]): number[] {
  return [0, ...u24(OPTIONS6), ...routers.flatMap(ipb)];
}

export function decodeNetwork6(lsa: number[]): string[] {
  const out: string[] = [];
  for (let o = 24; o + 4 <= lsa.length; o += 4) out.push(rdip(lsa, o));
  return out;
}

// --- Link-LSA (A.4.9) ---
export function encodeLink6(priority: number, linkLocal: string, prefixes: Prefix6[]): number[] {
  return [priority, ...u24(OPTIONS6), ...ipv6Bytes(linkLocal), ...u32(prefixes.length), ...prefixes.flatMap((p) => encodePrefix({ ...p, metric: 0 }))];
}

export function decodeLink6(lsa: number[]): { priority: number; linkLocal: string; prefixes: Prefix6[] } {
  return { priority: lsa[20], linkLocal: ipv6FromBytes(lsa, 24), prefixes: decodePrefixes(lsa, 44, rd32(lsa, 40)) };
}

// --- Intra-Area-Prefix-LSA (A.4.10) ---
export interface IntraPrefix6 {
  refType: number;
  refId: string;
  refAdv: string;
  prefixes: Prefix6[];
}

export function encodeIntraPrefix6(p: IntraPrefix6): number[] {
  return [...u16(p.prefixes.length), ...u16(p.refType), ...ipb(p.refId), ...ipb(p.refAdv), ...p.prefixes.flatMap(encodePrefix)];
}

export function decodeIntraPrefix6(lsa: number[]): IntraPrefix6 {
  return { refType: rd16(lsa, 22), refId: rdip(lsa, 24), refAdv: rdip(lsa, 28), prefixes: decodePrefixes(lsa, 32, rd16(lsa, 20)) };
}

// --- tcpdump text (print-ospf6.c layout) ---
const NAMES6: Record<number, string> = { 1: "Hello", 2: "Database Description", 3: "LS-Request", 4: "LS-Update", 5: "LS-Ack" };
const LSA_NAMES: Record<number, string> = { [LSA6_ROUTER]: "Router", [LSA6_NETWORK]: "Network", [LSA6_LINK]: "Link", [LSA6_INTRA_PREFIX]: "Intra-Area Prefix" };

function options6Text(o: number): string {
  const n = [o & OPT6_V6 ? "V6" : "", o & OPT6_E ? "External" : "", o & OPT6_R ? "Router" : ""].filter(Boolean);
  return n.join(", ") || "none";
}

function lsaText(h: Lsa6Header): string {
  return `${LSA_NAMES[h.type] ?? `0x${h.type.toString(16)}`} LSA (${h.type & 0x1fff}), ${h.type & 0x2000 ? "Area" : "Link-local"} Scope, Advertising Router ${h.adv}, seq 0x${(h.seq >>> 0).toString(16).padStart(8, "0")}, age ${h.age}s, length ${h.length - 20}, Link State ID ${h.id}`;
}

/** `OSPFv3, Hello, length 40` (+ -v lines). */
export function describeOspf6(p: number[], verbose: boolean): string | undefined {
  if (p.length < 16 || p[0] !== 3) return undefined;
  const type = p[1];
  const len = rd16(p, 2);
  let s = `OSPFv3, ${NAMES6[type] ?? `unknown packet type (${type})`}, length ${len}`;
  if (!verbose) return s;
  const area = rdip(p, 8);
  s += `\n\tRouter-ID ${rdip(p, 4)}, ${area === "0.0.0.0" ? "Backbone Area" : `Area ${area}`}`;
  const body = p.slice(16, len);
  if (type === 1) {
    const h = decodeHello6(body);
    if (h) {
      s += `\n\tOptions [${options6Text(h.options)}]`;
      s += `\n\t  Hello Timer ${h.helloInterval}s, Dead Timer ${h.deadInterval}s, Interface-ID ${intToDotted(h.ifId)}, Priority ${h.priority}`;
      if (h.dr !== "0.0.0.0") s += `\n\t  Designated Router ${h.dr}`;
      if (h.bdr !== "0.0.0.0") s += `\n\t  Backup Designated Router ${h.bdr}`;
      if (h.neighbors.length) s += `\n\t  Neighbor List:${h.neighbors.map((n) => `\n\t    ${n}`).join("")}`;
    }
  } else if (type === 2) {
    const d = decodeDbd6(body);
    if (d) {
      const f = [d.flags & DD_I ? "Init" : "", d.flags & DD_M ? "More" : "", d.flags & DD_MS ? "Master" : ""].filter(Boolean).join(", ");
      s += `\n\tOptions [${options6Text(d.options)}], DD Flags [${f || "none"}], MTU ${d.mtu}, DD-Sequence 0x${d.seq.toString(16).padStart(8, "0")}`;
      for (const h of d.headers) s += `\n\t  ${lsaText(h)}`;
    }
  } else if (type === 3) {
    for (const e of decodeLsr(body)) s += `\n\t  Advertising Router ${e.adv}, ${LSA_NAMES[e.type] ?? e.type} LSA, Link State ID ${e.id}`;
  } else if (type === 4) {
    for (const l of decodeLsu(body)) s += `\n\t  ${lsaText(parseLsa6Header(l))}`;
  } else if (type === 5) {
    for (const h of decodeAck6(body)) s += `\n\t  ${lsaText(h)}`;
  }
  return s;
}
