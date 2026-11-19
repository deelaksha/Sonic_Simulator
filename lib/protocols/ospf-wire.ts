/**
 * OSPFv2 wire format (RFC 2328 Appendix A) — encode/decode real bytes so
 * tcpdump, sFlow and Scapy see exactly what ospfd would send.
 *
 *   packet header      A.3.1 (24 bytes, Internet checksum over the packet minus
 *                      the 64-bit authentication field; AuType 0 = Null)
 *   Hello              A.3.2      Database Description  A.3.3
 *   LS Request         A.3.4      LS Update             A.3.5
 *   LS Acknowledgment  A.3.6
 *   LSA header         A.4.1 (Fletcher checksum from the Options byte on, the
 *                      way FRR computes it: lib/checksum.c fletcher_checksum,
 *                      ospfd/ospf_lsa.c:164 ospf_lsa_checksum)
 *   Router-LSA         A.4.2      Network-LSA           A.4.3
 *   Summary-LSA        A.4.4 (type 3 network / type 4 ASBR, mask 0.0.0.0)
 *   AS-external-LSA    A.4.5 (type 5; type 7 NSSA-LSA, RFC 3101 A.2, same body)
 */
import { inetChecksum } from "../sflow/wire";

export const OSPF_ALL_SPF = "224.0.0.5";
export const OSPF_ALL_DR = "224.0.0.6";
export const OSPF_PROTO = 89;

export const T_HELLO = 1;
export const T_DBD = 2;
export const T_LSR = 3;
export const T_LSU = 4;
export const T_ACK = 5;
export const PACKET_NAMES: Record<number, string> = { 1: "Hello", 2: "Database Description", 3: "LS-Request", 4: "LS-Update", 5: "LS-Ack" };

export const LSA_ROUTER = 1;
export const LSA_NETWORK = 2;
export const LSA_SUMMARY = 3;
export const LSA_ASBR_SUMMARY = 4;
export const LSA_EXTERNAL = 5;
export const LSA_NSSA = 7;
/** LSInfinity (RFC 2328 Appendix B; OSPF_LS_INFINITY lib/libospf.h). */
export const LS_INFINITY = 0xffffff;

/** DD flags (A.3.3). */
export const DD_I = 0x04;
export const DD_M = 0x02;
export const DD_MS = 0x01;

/** Options: E-bit (external routing capability), N/P-bit (NSSA, RFC 3101 A.1). */
export const OPT_E = 0x02;
export const OPT_NP = 0x08;

/** Router-LSA flags (A.4.2; ospf_lsa.h ROUTER_LSA_*): B = ABR, E = ASBR, Nt = NSSA translator. */
export const RTR_B = 0x01;
export const RTR_E = 0x02;
export const RTR_NT = 0x10;

export const MAX_AGE = 3600; // OSPF_LSA_MAXAGE (lib/libospf.h:34)
export const MAX_AGE_DIFF = 900;
export const INITIAL_SEQ = 0x80000001 | 0; // OSPF_INITIAL_SEQUENCE_NUMBER (lib/libospf.h:39), signed
export const MAX_SEQ = 0x7fffffff;

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ipb = (ip: string) => ip.split(".").map((o) => Number(o) & 0xff);
const rd16 = (b: ArrayLike<number>, o: number) => ((b[o] << 8) | b[o + 1]) >>> 0;
const rd32 = (b: ArrayLike<number>, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const rdip = (b: ArrayLike<number>, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

export interface OspfHeader {
  type: number;
  length: number;
  routerId: string;
  areaId: string;
  checksum: number;
}

/** Wrap a body in the 24-byte OSPF header with a valid checksum. */
export function encodePacket(type: number, routerId: string, areaId: string, body: number[]): number[] {
  const len = 24 + body.length;
  const pkt = [2, type, ...u16(len), ...ipb(routerId), ...ipb(areaId), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...body];
  // Checksum covers the whole packet except the 8-byte authentication field.
  const ck = inetChecksum([...pkt.slice(0, 16), ...pkt.slice(24)]);
  pkt[12] = ck >> 8;
  pkt[13] = ck & 0xff;
  return pkt;
}

/** Parse + validate (version 2, length, checksum). Returns the body bytes. */
export function decodePacket(b: ArrayLike<number>): { hdr: OspfHeader; body: number[] } | null {
  if (b.length < 24 || b[0] !== 2) return null;
  const length = rd16(b, 2);
  if (length < 24 || length > b.length) return null;
  const all = Array.from({ length }, (_, i) => b[i]);
  if (inetChecksum([...all.slice(0, 16), ...all.slice(24)]) !== 0) return null;
  return {
    hdr: { type: b[1], length, routerId: rdip(b, 4), areaId: rdip(b, 8), checksum: rd16(b, 12) },
    body: all.slice(24),
  };
}

// --- Hello (A.3.2) ---
export interface Hello {
  mask: string;
  helloInterval: number;
  options: number;
  priority: number;
  deadInterval: number;
  dr: string;
  bdr: string;
  neighbors: string[];
}

export function encodeHello(h: Hello): number[] {
  return [...ipb(h.mask), ...u16(h.helloInterval), h.options, h.priority, ...u32(h.deadInterval), ...ipb(h.dr), ...ipb(h.bdr), ...h.neighbors.flatMap(ipb)];
}

export function decodeHello(b: number[]): Hello | null {
  if (b.length < 20) return null;
  const neighbors: string[] = [];
  for (let o = 20; o + 4 <= b.length; o += 4) neighbors.push(rdip(b, o));
  return { mask: rdip(b, 0), helloInterval: rd16(b, 4), options: b[6], priority: b[7], deadInterval: rd32(b, 8), dr: rdip(b, 12), bdr: rdip(b, 16), neighbors };
}

// --- LSA header (A.4.1) ---
export interface LsaHeader {
  age: number;
  options: number;
  type: number;
  id: string;
  adv: string;
  /** Signed 32-bit sequence number (compare directly). */
  seq: number;
  checksum: number;
  length: number;
}

export function parseLsaHeader(b: ArrayLike<number>, o = 0): LsaHeader {
  return { age: rd16(b, o), options: b[o + 2], type: b[o + 3], id: rdip(b, o + 4), adv: rdip(b, o + 8), seq: rd32(b, o + 12) | 0, checksum: rd16(b, o + 16), length: rd16(b, o + 18) };
}

export const lsaKey = (h: { type: number; id: string; adv: string }) => `${h.type}/${h.id}/${h.adv}`;

/** Fletcher checksum as FRR computes it (lib/checksum.c:93, offset from the Options byte). */
function fletcher(buf: number[], offset: number): [number, number] {
  let c0 = 0;
  let c1 = 0;
  for (const x of buf) {
    c0 = (c0 + x) % 255;
    c1 = (c1 + c0) % 255;
  }
  let x = ((buf.length - offset - 1) * c0 - c1) % 255;
  if (x <= 0) x += 255;
  let y = 510 - c0 - x;
  if (y > 255) y -= 255;
  return [x & 0xff, y & 0xff];
}

/** Build a complete LSA (header + body) with length and Fletcher checksum. */
export function buildLsa(h: { age: number; options: number; type: number; id: string; adv: string; seq: number }, body: number[]): number[] {
  const len = 20 + body.length;
  const lsa = [...u16(h.age), h.options, h.type, ...ipb(h.id), ...ipb(h.adv), ...u32(h.seq >>> 0), 0, 0, ...u16(len), ...body];
  const [x, y] = fletcher(lsa.slice(2), 14);
  lsa[16] = x;
  lsa[17] = y;
  return lsa;
}

/** Fletcher validation over the LSA minus its age field (sum of both bytes must be 0 mod 255). */
export function lsaChecksumOk(lsa: number[]): boolean {
  let c0 = 0;
  let c1 = 0;
  for (const x of lsa.slice(2)) {
    c0 = (c0 + x) % 255;
    c1 = (c1 + c0) % 255;
  }
  return c0 === 0 && c1 === 0 && rd16(lsa, 16) !== 0;
}

/** Copy of an LSA with a new LS age (age is outside the checksum). */
export function withAge(lsa: number[], age: number): number[] {
  const out = lsa.slice();
  out[0] = (age >> 8) & 0xff;
  out[1] = age & 0xff;
  return out;
}

/** RFC 2328 13.1: >0 when a is newer than b, <0 when older, 0 when the same instance. */
type LsaInstance = Pick<LsaHeader, "seq" | "checksum" | "age">;
export function compareLsa(a: LsaInstance, b: LsaInstance): number {
  if (a.seq !== b.seq) return a.seq > b.seq ? 1 : -1;
  if (a.checksum !== b.checksum) return a.checksum > b.checksum ? 1 : -1;
  const am = a.age >= MAX_AGE;
  const bm = b.age >= MAX_AGE;
  if (am !== bm) return am ? 1 : -1;
  if (Math.abs(a.age - b.age) > MAX_AGE_DIFF) return a.age < b.age ? 1 : -1;
  return 0;
}

// --- Router-LSA body (A.4.2) ---
export interface RouterLink {
  /** 1 point-to-point, 2 transit, 3 stub, 4 virtual. */
  type: number;
  linkId: string;
  linkData: string;
  metric: number;
}

export function encodeRouterBody(flags: number, links: RouterLink[]): number[] {
  return [flags, 0, ...u16(links.length), ...links.flatMap((l) => [...ipb(l.linkId), ...ipb(l.linkData), l.type, 0, ...u16(l.metric)])];
}

export function decodeRouterBody(lsa: number[]): { flags: number; links: RouterLink[] } {
  const flags = lsa[20];
  const n = rd16(lsa, 22);
  const links: RouterLink[] = [];
  let o = 24;
  for (let i = 0; i < n && o + 12 <= lsa.length; i++) {
    const tos = lsa[o + 9];
    links.push({ linkId: rdip(lsa, o), linkData: rdip(lsa, o + 4), type: lsa[o + 8], metric: rd16(lsa, o + 10) });
    o += 12 + tos * 4;
  }
  return { flags, links };
}

// --- Network-LSA body (A.4.3) ---
export function encodeNetworkBody(mask: string, routers: string[]): number[] {
  return [...ipb(mask), ...routers.flatMap(ipb)];
}

export function decodeNetworkBody(lsa: number[]): { mask: string; routers: string[] } {
  const routers: string[] = [];
  for (let o = 24; o + 4 <= lsa.length; o += 4) routers.push(rdip(lsa, o));
  return { mask: rdip(lsa, 20), routers };
}

// --- Summary-LSA body (A.4.4): mask, 0, 24-bit metric ---
export function encodeSummaryBody(mask: string, metric: number): number[] {
  return [...ipb(mask), 0, (metric >> 16) & 0xff, (metric >> 8) & 0xff, metric & 0xff];
}

export function decodeSummaryBody(lsa: number[]): { mask: string; metric: number } {
  return { mask: rdip(lsa, 20), metric: ((lsa[25] << 16) | (lsa[26] << 8) | lsa[27]) >>> 0 };
}

// --- AS-external / NSSA-external body (A.4.5): mask, E|0, 24-bit metric, forwarding address, tag ---
export interface ExternalBody {
  mask: string;
  /** Metric type 2 (E-bit set). */
  e2: boolean;
  metric: number;
  fwd: string;
  tag: number;
}

export function encodeExternalBody(x: ExternalBody): number[] {
  return [...ipb(x.mask), x.e2 ? 0x80 : 0, (x.metric >> 16) & 0xff, (x.metric >> 8) & 0xff, x.metric & 0xff, ...ipb(x.fwd), ...u32(x.tag)];
}

export function decodeExternalBody(lsa: number[]): ExternalBody {
  return { mask: rdip(lsa, 20), e2: (lsa[24] & 0x80) !== 0, metric: ((lsa[25] << 16) | (lsa[26] << 8) | lsa[27]) >>> 0, fwd: rdip(lsa, 28), tag: rd32(lsa, 32) };
}

// --- Database Description (A.3.3) ---
export interface Dbd {
  mtu: number;
  options: number;
  flags: number;
  seq: number;
  headers: LsaHeader[];
}

export function encodeDbd(d: { mtu: number; options: number; flags: number; seq: number; headers: number[][] }): number[] {
  return [...u16(d.mtu), d.options, d.flags, ...u32(d.seq >>> 0), ...d.headers.flat()];
}

export function decodeDbd(b: number[]): Dbd | null {
  if (b.length < 8) return null;
  const headers: LsaHeader[] = [];
  for (let o = 8; o + 20 <= b.length; o += 20) headers.push(parseLsaHeader(b, o));
  return { mtu: rd16(b, 0), options: b[2], flags: b[3], seq: rd32(b, 4), headers };
}

// --- LS Request (A.3.4) ---
export interface LsrEntry {
  type: number;
  id: string;
  adv: string;
}

export function encodeLsr(entries: LsrEntry[]): number[] {
  return entries.flatMap((e) => [...u32(e.type), ...ipb(e.id), ...ipb(e.adv)]);
}

export function decodeLsr(b: number[]): LsrEntry[] {
  const out: LsrEntry[] = [];
  for (let o = 0; o + 12 <= b.length; o += 12) out.push({ type: rd32(b, o), id: rdip(b, o + 4), adv: rdip(b, o + 8) });
  return out;
}

// --- LS Update (A.3.5) ---
export function encodeLsu(lsas: number[][]): number[] {
  return [...u32(lsas.length), ...lsas.flat()];
}

export function decodeLsu(b: number[]): number[][] {
  const out: number[][] = [];
  const n = b.length >= 4 ? rd32(b, 0) : 0;
  let o = 4;
  for (let i = 0; i < n && o + 20 <= b.length; i++) {
    const len = rd16(b, o + 18);
    if (len < 20 || o + len > b.length) break;
    out.push(b.slice(o, o + len));
    o += len;
  }
  return out;
}

// --- LS Acknowledgment (A.3.6) ---
export function decodeAck(b: number[]): LsaHeader[] {
  const out: LsaHeader[] = [];
  for (let o = 0; o + 20 <= b.length; o += 20) out.push(parseLsaHeader(b, o));
  return out;
}

// --- tcpdump text (print-ospf.c layout) ---
function optionsText(o: number): string {
  const names: string[] = [];
  if (o & 0x02) names.push("External");
  if (o & 0x08) names.push("NSSA");
  if (o & 0x40) names.push("Opaque");
  if (o & 0x20) names.push("Demand Circuit");
  return names.join(", ") || "none";
}

/** `OSPFv2, Hello, length 48` (+ -v detail lines in tcpdump's layout). */
export function describeOspf(payload: ArrayLike<number>, verbose: boolean): string | undefined {
  if (payload.length < 24 || payload[0] !== 2) return undefined;
  const type = payload[1];
  const len = rd16(payload, 2);
  const name = PACKET_NAMES[type] ?? `unknown packet type (${type})`;
  let s = `OSPFv2, ${name}, length ${len}`;
  if (!verbose) return s;
  const area = rdip(payload, 8);
  s += `\n\tRouter-ID ${rdip(payload, 4)}, ${area === "0.0.0.0" ? "Backbone Area" : `Area ${area}`}, Authentication Type: none (${rd16(payload, 14)})`;
  const body = Array.from(payload).slice(24, len);
  if (type === T_HELLO) {
    const h = decodeHello(body);
    if (h) {
      s += `\n\tOptions [${optionsText(h.options)}]`;
      s += `\n\t  Hello Timer ${h.helloInterval}s, Dead Timer ${h.deadInterval}s, Mask ${h.mask}, Priority ${h.priority}`;
      if (h.dr !== "0.0.0.0") s += `\n\t  Designated Router ${h.dr}`;
      if (h.bdr !== "0.0.0.0") s += `\n\t  Backup Designated Router ${h.bdr}`;
      if (h.neighbors.length) s += `\n\t  Neighbor List:${h.neighbors.map((n) => `\n\t    ${n}`).join("")}`;
    }
  } else if (type === T_DBD) {
    const d = decodeDbd(body);
    if (d) {
      const f = [d.flags & DD_I ? "Init" : "", d.flags & DD_M ? "More" : "", d.flags & DD_MS ? "Master" : ""].filter(Boolean).join(", ");
      s += `\n\tOptions [${optionsText(d.options)}], DD Flags [${f || "none"}]`;
      s += `\n\tMTU: ${d.mtu}, Sequence: 0x${d.seq.toString(16).padStart(8, "0")}`;
      for (const h of d.headers) s += `\n\t  ${lsaHeaderText(h)}`;
    }
  } else if (type === T_LSR) {
    for (const e of decodeLsr(body)) s += `\n\t  Advertising Router: ${e.adv}, ${lsaTypeName(e.type)} LSA (${e.type}), LSA-ID: ${e.id}`;
  } else if (type === T_LSU) {
    for (const l of decodeLsu(body)) s += `\n\t  ${lsaHeaderText(parseLsaHeader(l))}`;
  } else if (type === T_ACK) {
    for (const h of decodeAck(body)) s += `\n\t  ${lsaHeaderText(h)}`;
  }
  return s;
}

function lsaTypeName(t: number): string {
  // print-ospf.c lsa_values[]
  return t === 1 ? "Router" : t === 2 ? "Network" : t === 3 ? "Summary" : t === 4 ? "ASBR Summary" : t === 5 ? "External" : t === 7 ? "NSSA" : `Type-${t}`;
}

function lsaHeaderText(h: LsaHeader): string {
  return `Advertising Router ${h.adv}, seq 0x${(h.seq >>> 0).toString(16).padStart(8, "0")}, age ${h.age}s, length ${h.length - 20}\n\t    ${lsaTypeName(h.type)} LSA (${h.type}), LSA-ID: ${h.id}`;
}
