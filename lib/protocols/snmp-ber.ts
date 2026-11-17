/**
 * SNMP v1/v2c message codec (ASN.1 BER, RFC 3416 / RFC 1157 framing):
 *
 *   Message ::= SEQUENCE { version INTEGER, community OCTET STRING, data PDU }
 *   PDU     ::= [tag] IMPLICIT SEQUENCE { request-id, error-status, error-index,
 *                                         SEQUENCE OF VarBind }
 *   VarBind ::= SEQUENCE { name OBJECT IDENTIFIER, value ANY }
 *
 * GetBulkRequest reuses error-status/error-index as non-repeaters/max-repetitions.
 * Only the definite-length form is produced; the decoder rejects anything it
 * cannot parse (the agent then drops the datagram, as snmpd counts
 * snmpInASNParseErrs and drops it).
 */
export type Oid = number[];

export const PDU = {
  GET: 0xa0,
  GETNEXT: 0xa1,
  RESPONSE: 0xa2,
  SET: 0xa3,
  TRAP: 0xa4,
  GETBULK: 0xa5,
  INFORM: 0xa6,
  TRAP2: 0xa7,
  REPORT: 0xa8,
} as const;

export type SnmpValue =
  | { type: "integer"; value: number }
  | { type: "string"; value: number[] }
  | { type: "null" }
  | { type: "oid"; value: Oid }
  | { type: "ipaddress"; value: string }
  | { type: "counter32" | "gauge32" | "timeticks"; value: number }
  | { type: "counter64"; value: bigint }
  | { type: "noSuchObject" | "noSuchInstance" | "endOfMibView" };

export interface VarBind {
  oid: Oid;
  value: SnmpValue;
}

export interface SnmpPdu {
  type: number;
  reqId: number;
  /** error-status (non-repeaters for GetBulk). */
  errStatus: number;
  /** error-index (max-repetitions for GetBulk). */
  errIndex: number;
  varbinds: VarBind[];
}

export interface SnmpMessage {
  /** 0 = SNMPv1, 1 = SNMPv2c. */
  version: number;
  community: string;
  pdu: SnmpPdu;
}

/** error-status values (RFC 3416 §3). */
export const ERR = {
  noError: 0,
  tooBig: 1,
  noSuchName: 2,
  badValue: 3,
  readOnly: 4,
  genErr: 5,
  noAccess: 6,
  wrongType: 7,
  wrongLength: 8,
  wrongEncoding: 9,
  wrongValue: 10,
  noCreation: 11,
  inconsistentValue: 12,
  resourceUnavailable: 13,
  commitFailed: 14,
  undoFailed: 15,
  authorizationError: 16,
  notWritable: 17,
  inconsistentName: 18,
} as const;

const TAG = {
  INTEGER: 0x02,
  OCTET: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQ: 0x30,
  IPADDR: 0x40,
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIMETICKS: 0x43,
  COUNTER64: 0x46,
  NOSUCHOBJECT: 0x80,
  NOSUCHINSTANCE: 0x81,
  ENDOFMIBVIEW: 0x82,
} as const;

// ---------------------------------------------------------------- encoding

function len(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  while (n > 0) {
    out.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return [0x80 | out.length, ...out];
}

const tlv = (tag: number, body: number[]): number[] => [tag, ...len(body.length), ...body];

/** Two's-complement minimal INTEGER contents. */
function intBody(v: number): number[] {
  let n = BigInt(Math.trunc(v));
  const out: number[] = [];
  for (;;) {
    const b = Number(n & BigInt(0xff));
    out.unshift(b);
    n >>= BigInt(8);
    if ((n === BigInt(0) && (b & 0x80) === 0) || (n === BigInt(-1) && (b & 0x80) !== 0)) break;
  }
  return out;
}

/** Unsigned contents (Counter32/Gauge32/TimeTicks/Counter64) with a leading 0 when the high bit is set. */
function uintBody(v: bigint): number[] {
  const out: number[] = [];
  let n = v;
  do {
    out.unshift(Number(n & BigInt(0xff)));
    n >>= BigInt(8);
  } while (n > BigInt(0));
  if (out[0] & 0x80) out.unshift(0);
  return out;
}

function oidBody(oid: Oid): number[] {
  const arcs = oid.length >= 2 ? [oid[0] * 40 + oid[1], ...oid.slice(2)] : [oid[0] ?? 0];
  const out: number[] = [];
  for (const a of arcs) {
    const chunk: number[] = [a & 0x7f];
    let n = Math.floor(a / 128);
    while (n > 0) {
      chunk.unshift(0x80 | (n & 0x7f));
      n = Math.floor(n / 128);
    }
    out.push(...chunk);
  }
  return out;
}

export function encodeValue(v: SnmpValue): number[] {
  switch (v.type) {
    case "integer":
      return tlv(TAG.INTEGER, intBody(v.value));
    case "string":
      return tlv(TAG.OCTET, v.value);
    case "null":
      return [TAG.NULL, 0];
    case "oid":
      return tlv(TAG.OID, oidBody(v.value));
    case "ipaddress":
      return tlv(TAG.IPADDR, v.value.split(".").map((o) => Number(o) & 0xff));
    case "counter32":
      return tlv(TAG.COUNTER32, uintBody(BigInt(v.value >>> 0)));
    case "gauge32":
      return tlv(TAG.GAUGE32, uintBody(BigInt(v.value >>> 0)));
    case "timeticks":
      return tlv(TAG.TIMETICKS, uintBody(BigInt(v.value >>> 0)));
    case "counter64":
      return tlv(TAG.COUNTER64, uintBody(BigInt.asUintN(64, v.value)));
    case "noSuchObject":
      return [TAG.NOSUCHOBJECT, 0];
    case "noSuchInstance":
      return [TAG.NOSUCHINSTANCE, 0];
    case "endOfMibView":
      return [TAG.ENDOFMIBVIEW, 0];
  }
}

export function encodeMessage(m: SnmpMessage): number[] {
  const vbs = m.pdu.varbinds.flatMap((vb) => tlv(TAG.SEQ, [...tlv(TAG.OID, oidBody(vb.oid)), ...encodeValue(vb.value)]));
  const pdu = tlv(m.pdu.type, [
    ...tlv(TAG.INTEGER, intBody(m.pdu.reqId)),
    ...tlv(TAG.INTEGER, intBody(m.pdu.errStatus)),
    ...tlv(TAG.INTEGER, intBody(m.pdu.errIndex)),
    ...tlv(TAG.SEQ, vbs),
  ]);
  const community = Array.from(m.community, (c) => c.charCodeAt(0) & 0xff);
  return tlv(TAG.SEQ, [...tlv(TAG.INTEGER, intBody(m.version)), ...tlv(TAG.OCTET, community), ...pdu]);
}

// ---------------------------------------------------------------- decoding

interface Tlv {
  tag: number;
  start: number; // contents start
  end: number; // contents end (exclusive)
  next: number; // offset after this TLV
}

function readTlv(b: ArrayLike<number>, off: number, limit: number): Tlv {
  if (off + 2 > limit) throw new Error("truncated");
  const tag = b[off];
  let l = b[off + 1];
  let p = off + 2;
  if (l & 0x80) {
    const nbytes = l & 0x7f;
    if (nbytes === 0 || nbytes > 4 || p + nbytes > limit) throw new Error("bad length");
    l = 0;
    for (let i = 0; i < nbytes; i++) l = l * 256 + b[p++];
  }
  if (p + l > limit) throw new Error("truncated");
  return { tag, start: p, end: p + l, next: p + l };
}

function readInt(b: ArrayLike<number>, t: Tlv): number {
  if (t.end <= t.start) throw new Error("empty integer");
  let n = b[t.start] & 0x80 ? BigInt(-1) : BigInt(0);
  for (let i = t.start; i < t.end; i++) n = (n << BigInt(8)) | BigInt(b[i]);
  return Number(BigInt.asIntN(64, n));
}

function readUint(b: ArrayLike<number>, t: Tlv): bigint {
  let n = BigInt(0);
  for (let i = t.start; i < t.end; i++) n = (n << BigInt(8)) | BigInt(b[i]);
  return n;
}

function readOid(b: ArrayLike<number>, t: Tlv): Oid {
  const arcs: number[] = [];
  let n = 0;
  for (let i = t.start; i < t.end; i++) {
    n = n * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      arcs.push(n);
      n = 0;
    }
  }
  if (arcs.length === 0) return [];
  const first = arcs[0];
  const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...arcs.slice(1)];
}

function readValue(b: ArrayLike<number>, t: Tlv): SnmpValue {
  const bytes = () => Array.from({ length: t.end - t.start }, (_, i) => b[t.start + i]);
  switch (t.tag) {
    case TAG.INTEGER:
      return { type: "integer", value: readInt(b, t) };
    case TAG.OCTET:
      return { type: "string", value: bytes() };
    case TAG.NULL:
      return { type: "null" };
    case TAG.OID:
      return { type: "oid", value: readOid(b, t) };
    case TAG.IPADDR:
      return { type: "ipaddress", value: bytes().join(".") };
    case TAG.COUNTER32:
      return { type: "counter32", value: Number(readUint(b, t) & BigInt(0xffffffff)) };
    case TAG.GAUGE32:
      return { type: "gauge32", value: Number(readUint(b, t) & BigInt(0xffffffff)) };
    case TAG.TIMETICKS:
      return { type: "timeticks", value: Number(readUint(b, t) & BigInt(0xffffffff)) };
    case TAG.COUNTER64:
      return { type: "counter64", value: BigInt.asUintN(64, readUint(b, t)) };
    case TAG.NOSUCHOBJECT:
      return { type: "noSuchObject" };
    case TAG.NOSUCHINSTANCE:
      return { type: "noSuchInstance" };
    case TAG.ENDOFMIBVIEW:
      return { type: "endOfMibView" };
    default:
      throw new Error(`unsupported value tag 0x${t.tag.toString(16)}`);
  }
}

function expect(t: Tlv, tag: number): Tlv {
  if (t.tag !== tag) throw new Error(`expected tag 0x${tag.toString(16)}, got 0x${t.tag.toString(16)}`);
  return t;
}

/** Decode an SNMPv1/v2c message. Throws on malformed input or a v1 Trap-PDU. */
export function decodeMessage(b: ArrayLike<number>): SnmpMessage {
  const msg = expect(readTlv(b, 0, b.length), TAG.SEQ);
  const ver = expect(readTlv(b, msg.start, msg.end), TAG.INTEGER);
  const com = expect(readTlv(b, ver.next, msg.end), TAG.OCTET);
  const pdu = readTlv(b, com.next, msg.end);
  if (pdu.tag < 0xa0 || pdu.tag > 0xa8 || pdu.tag === PDU.TRAP) throw new Error("unsupported PDU");
  const rid = expect(readTlv(b, pdu.start, pdu.end), TAG.INTEGER);
  const es = expect(readTlv(b, rid.next, pdu.end), TAG.INTEGER);
  const ei = expect(readTlv(b, es.next, pdu.end), TAG.INTEGER);
  const list = expect(readTlv(b, ei.next, pdu.end), TAG.SEQ);
  const varbinds: VarBind[] = [];
  for (let off = list.start; off < list.end; ) {
    const vb = expect(readTlv(b, off, list.end), TAG.SEQ);
    const name = expect(readTlv(b, vb.start, vb.end), TAG.OID);
    const val = readTlv(b, name.next, vb.end);
    varbinds.push({ oid: readOid(b, name), value: readValue(b, val) });
    off = vb.next;
  }
  let community = "";
  for (let i = com.start; i < com.end; i++) community += String.fromCharCode(b[i]);
  return {
    version: readInt(b, ver),
    community,
    pdu: { type: pdu.tag, reqId: readInt(b, rid), errStatus: readInt(b, es), errIndex: readInt(b, ei), varbinds },
  };
}

/** Length of the PDU's contents (tcpdump prints it as `GetRequest(28)`). */
export function pduContentLength(b: ArrayLike<number>): number {
  const msg = readTlv(b, 0, b.length);
  const ver = readTlv(b, msg.start, msg.end);
  const com = readTlv(b, ver.next, msg.end);
  const pdu = readTlv(b, com.next, msg.end);
  return pdu.end - pdu.start;
}

export const str = (s: string): SnmpValue => ({ type: "string", value: Array.from(s, (c) => c.charCodeAt(0) & 0xff) });
export const bytesToString = (v: number[]): string => String.fromCharCode(...v);

export function oidCompare(a: Oid, b: Oid): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}

export const oidStartsWith = (oid: Oid, prefix: Oid): boolean => prefix.length <= oid.length && prefix.every((x, i) => oid[i] === x);
