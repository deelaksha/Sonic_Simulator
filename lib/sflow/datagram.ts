/**
 * sFlow v5 datagram encode/decode (sflow.org sflow_version_5.txt), shaped like
 * what SONiC's hsflowd puts on the wire. Captured from the live switch
 * (data/device-capture/sflow-live/): EXPANDED counter samples (format 4) holding
 * a port-name record (1005) + generic interface counters (1), agent sub-id
 * 100000, datagrams capped at 1400 bytes. Flow samples use the expanded format
 * (3) built with the same SFL_USE_32BIT_INDEX setting, carrying one sampled
 * header record (1): header_protocol 1 (Ethernet), stripped = 4 (FCS),
 * frame_length = wire length + 4, header ≤ max-header-size (128).
 */

export const SFLOW_VERSION = 5;
export const SFLOW_MAX_DATAGRAM = 1400;
export const FLOW_SAMPLE_EXPANDED = 3;
export const COUNTER_SAMPLE_EXPANDED = 4;
export const FLOW_SAMPLE = 1;
export const COUNTER_SAMPLE = 2;
export const REC_SAMPLED_HEADER = 1;
export const REC_GENERIC_IF = 1;
export const REC_PORT_NAME = 1005;
export const HEADER_PROTO_ETHERNET = 1;

export interface FlowSample {
  kind: "flow";
  seq: number;
  dsClass: number;
  dsIndex: number;
  samplingRate: number;
  samplePool: number;
  drops: number;
  input: number;
  output: number;
  header?: SampledHeader;
}

export interface SampledHeader {
  protocol: number;
  frameLength: number;
  stripped: number;
  bytes: Uint8Array;
}

export interface GenericIfCounters {
  ifIndex: number;
  ifType: number;
  ifSpeed: number; // bps
  ifDirection: number;
  ifStatus: number; // bit0 admin up, bit1 oper up
  inOctets: number;
  inUcast: number;
  inMulticast: number;
  inBroadcast: number;
  inDiscards: number;
  inErrors: number;
  inUnknownProtos: number;
  outOctets: number;
  outUcast: number;
  outMulticast: number;
  outBroadcast: number;
  outDiscards: number;
  outErrors: number;
  promiscuous: number;
}

export interface CounterSample {
  kind: "counter";
  seq: number;
  dsClass: number;
  dsIndex: number;
  generic?: GenericIfCounters;
  portName?: string;
  /** Record formats present but not decoded (e.g. hsflowd host records 2000-2010). */
  otherRecords: number[];
}

export type Sample = FlowSample | CounterSample;

export interface Datagram {
  version: number;
  agentIp: string;
  subAgentId: number;
  seq: number;
  uptimeMs: number;
  samples: Sample[];
}

// ---------------------------------------------------------------- encoding

class XdrWriter {
  bytes: number[] = [];
  u32(n: number): void {
    this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  u64(n: number): void {
    this.u32(Math.floor(n / 2 ** 32));
    this.u32(n >>> 0);
  }
  opaque(b: ArrayLike<number>): void {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i]);
    while (this.bytes.length % 4) this.bytes.push(0);
  }
  string(s: string): void {
    this.u32(s.length);
    this.opaque(Array.from(s, (c) => c.charCodeAt(0) & 0xff));
  }
}

function record(w: XdrWriter, format: number, body: XdrWriter): void {
  w.u32(format); // enterprise 0
  w.u32(body.bytes.length);
  w.opaque(body.bytes);
}

export function encodeSample(s: Sample): number[] {
  const w = new XdrWriter();
  const body = new XdrWriter();
  if (s.kind === "flow") {
    body.u32(s.seq);
    body.u32(s.dsClass);
    body.u32(s.dsIndex);
    body.u32(s.samplingRate);
    body.u32(s.samplePool);
    body.u32(s.drops);
    body.u32(0); // input format: single interface
    body.u32(s.input);
    body.u32(0);
    body.u32(s.output);
    body.u32(s.header ? 1 : 0);
    if (s.header) {
      const h = new XdrWriter();
      h.u32(s.header.protocol);
      h.u32(s.header.frameLength);
      h.u32(s.header.stripped);
      h.u32(s.header.bytes.length);
      h.opaque(s.header.bytes);
      record(body, REC_SAMPLED_HEADER, h);
    }
    record(w, FLOW_SAMPLE_EXPANDED, body);
  } else {
    body.u32(s.seq);
    body.u32(s.dsClass);
    body.u32(s.dsIndex);
    body.u32((s.portName !== undefined ? 1 : 0) + (s.generic ? 1 : 0));
    if (s.portName !== undefined) {
      const p = new XdrWriter();
      p.string(s.portName);
      record(body, REC_PORT_NAME, p);
    }
    if (s.generic) {
      const g = s.generic;
      const c = new XdrWriter();
      c.u32(g.ifIndex);
      c.u32(g.ifType);
      c.u64(g.ifSpeed);
      c.u32(g.ifDirection);
      c.u32(g.ifStatus);
      c.u64(g.inOctets);
      c.u32(g.inUcast);
      c.u32(g.inMulticast);
      c.u32(g.inBroadcast);
      c.u32(g.inDiscards);
      c.u32(g.inErrors);
      c.u32(g.inUnknownProtos);
      c.u64(g.outOctets);
      c.u32(g.outUcast);
      c.u32(g.outMulticast);
      c.u32(g.outBroadcast);
      c.u32(g.outDiscards);
      c.u32(g.outErrors);
      c.u32(g.promiscuous);
      record(body, REC_GENERIC_IF, c);
    }
    record(w, COUNTER_SAMPLE_EXPANDED, body);
  }
  return w.bytes;
}

const DATAGRAM_HEADER_BYTES = 28; // version, addr type, IPv4, sub-agent, seq, uptime, count

export function encodeDatagram(d: Omit<Datagram, "samples">, encodedSamples: number[][]): number[] {
  const w = new XdrWriter();
  w.u32(d.version);
  w.u32(1); // IPv4 agent address
  w.opaque(d.agentIp.split(".").map((o) => parseInt(o, 10) & 0xff));
  w.u32(d.subAgentId);
  w.u32(d.seq);
  w.u32(d.uptimeMs >>> 0);
  w.u32(encodedSamples.length);
  for (const s of encodedSamples) w.opaque(s);
  return w.bytes;
}

/** Split encoded samples into groups that each fit one ≤1400-byte datagram. */
export function packSamples(encoded: number[][]): number[][][] {
  const groups: number[][][] = [];
  let cur: number[][] = [];
  let size = DATAGRAM_HEADER_BYTES;
  for (const s of encoded) {
    if (cur.length && size + s.length > SFLOW_MAX_DATAGRAM) {
      groups.push(cur);
      cur = [];
      size = DATAGRAM_HEADER_BYTES;
    }
    cur.push(s);
    size += s.length;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ---------------------------------------------------------------- decoding

class XdrReader {
  constructor(
    private b: ArrayLike<number>,
    public off = 0,
  ) {}
  u32(): number {
    const b = this.b;
    const o = this.off;
    if (o + 4 > b.length) throw new Error("sFlow datagram truncated");
    this.off += 4;
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  u64(): number {
    return this.u32() * 2 ** 32 + this.u32();
  }
  bytes(n: number): Uint8Array {
    if (this.off + n > this.b.length) throw new Error("sFlow datagram truncated");
    const out = Uint8Array.from(Array.prototype.slice.call(this.b, this.off, this.off + n));
    this.off += n + ((4 - (n % 4)) % 4);
    return out;
  }
}

function decodeFlow(r: XdrReader, expanded: boolean, end: number): FlowSample {
  const seq = r.u32();
  let dsClass: number;
  let dsIndex: number;
  if (expanded) {
    dsClass = r.u32();
    dsIndex = r.u32();
  } else {
    const id = r.u32();
    dsClass = id >>> 24;
    dsIndex = id & 0xffffff;
  }
  const s: FlowSample = { kind: "flow", seq, dsClass, dsIndex, samplingRate: r.u32(), samplePool: r.u32(), drops: r.u32(), input: 0, output: 0 };
  if (expanded) {
    r.u32();
    s.input = r.u32();
    r.u32();
    s.output = r.u32();
  } else {
    s.input = r.u32() & 0x3fffffff;
    s.output = r.u32() & 0x3fffffff;
  }
  const n = r.u32();
  for (let i = 0; i < n && r.off < end; i++) {
    const fmt = r.u32();
    const len = r.u32();
    const recEnd = r.off + len;
    if ((fmt & 0xfff) === REC_SAMPLED_HEADER && fmt >>> 12 === 0) {
      const protocol = r.u32();
      const frameLength = r.u32();
      const stripped = r.u32();
      const hlen = r.u32();
      s.header = { protocol, frameLength, stripped, bytes: r.bytes(hlen) };
    }
    r.off = recEnd;
  }
  return s;
}

function decodeCounter(r: XdrReader, expanded: boolean, end: number): CounterSample {
  const seq = r.u32();
  let dsClass: number;
  let dsIndex: number;
  if (expanded) {
    dsClass = r.u32();
    dsIndex = r.u32();
  } else {
    const id = r.u32();
    dsClass = id >>> 24;
    dsIndex = id & 0xffffff;
  }
  const s: CounterSample = { kind: "counter", seq, dsClass, dsIndex, otherRecords: [] };
  const n = r.u32();
  for (let i = 0; i < n && r.off < end; i++) {
    const fmt = r.u32();
    const len = r.u32();
    const recEnd = r.off + len;
    const f = fmt & 0xfff;
    if (fmt >>> 12 === 0 && f === REC_GENERIC_IF) {
      s.generic = {
        ifIndex: r.u32(),
        ifType: r.u32(),
        ifSpeed: r.u64(),
        ifDirection: r.u32(),
        ifStatus: r.u32(),
        inOctets: r.u64(),
        inUcast: r.u32(),
        inMulticast: r.u32(),
        inBroadcast: r.u32(),
        inDiscards: r.u32(),
        inErrors: r.u32(),
        inUnknownProtos: r.u32(),
        outOctets: r.u64(),
        outUcast: r.u32(),
        outMulticast: r.u32(),
        outBroadcast: r.u32(),
        outDiscards: r.u32(),
        outErrors: r.u32(),
        promiscuous: r.u32(),
      };
    } else if (fmt >>> 12 === 0 && f === REC_PORT_NAME) {
      const slen = r.u32();
      s.portName = String.fromCharCode(...r.bytes(slen));
    } else {
      s.otherRecords.push(fmt);
    }
    r.off = recEnd;
  }
  return s;
}

export function decodeDatagram(bytes: ArrayLike<number>): Datagram {
  const r = new XdrReader(bytes);
  const version = r.u32();
  if (version !== SFLOW_VERSION) throw new Error(`not an sFlow v5 datagram (version ${version})`);
  const addrType = r.u32();
  const addr = r.bytes(addrType === 1 ? 4 : 16);
  const agentIp = addrType === 1 ? Array.from(addr).join(".") : Array.from(addr, (b) => b.toString(16).padStart(2, "0")).join("");
  const d: Datagram = { version, agentIp, subAgentId: r.u32(), seq: r.u32(), uptimeMs: r.u32(), samples: [] };
  const n = r.u32();
  for (let i = 0; i < n; i++) {
    const fmt = r.u32();
    const len = r.u32();
    const end = r.off + len;
    const f = fmt & 0xfff;
    if (fmt >>> 12 === 0 && (f === FLOW_SAMPLE || f === FLOW_SAMPLE_EXPANDED)) {
      d.samples.push(decodeFlow(r, f === FLOW_SAMPLE_EXPANDED, end));
    } else if (fmt >>> 12 === 0 && (f === COUNTER_SAMPLE || f === COUNTER_SAMPLE_EXPANDED)) {
      d.samples.push(decodeCounter(r, f === COUNTER_SAMPLE_EXPANDED, end));
    }
    r.off = end;
  }
  return d;
}

// ------------------------------------------------- sampled header decoding

export interface DecodedHeader {
  srcMac: string;
  dstMac: string;
  vlan?: number;
  etherType: number;
  srcIp?: string;
  dstIp?: string;
  protocol?: "ICMP" | "TCP" | "UDP" | "ARP" | string;
  srcPort?: number;
  dstPort?: number;
}

const mac = (b: Uint8Array, o: number) => Array.from(b.slice(o, o + 6), (x) => x.toString(16).padStart(2, "0")).join(":");
const ip4 = (b: Uint8Array, o: number) => Array.from(b.slice(o, o + 4)).join(".");

/** Decode an Ethernet sampled header down to L4 ports (what a collector shows). */
export function decodeEthernetHeader(b: Uint8Array): DecodedHeader {
  const h: DecodedHeader = { dstMac: mac(b, 0), srcMac: mac(b, 6), etherType: (b[12] << 8) | b[13] };
  let o = 14;
  if (h.etherType === 0x8100) {
    h.vlan = ((b[14] << 8) | b[15]) & 0xfff;
    h.etherType = (b[16] << 8) | b[17];
    o = 18;
  }
  if (h.etherType === 0x0806) {
    h.protocol = "ARP";
    h.srcIp = ip4(b, o + 14);
    h.dstIp = ip4(b, o + 24);
  } else if (h.etherType === 0x0800 && b.length >= o + 20) {
    const ihl = (b[o] & 0x0f) * 4;
    const proto = b[o + 9];
    h.srcIp = ip4(b, o + 12);
    h.dstIp = ip4(b, o + 16);
    h.protocol = proto === 1 ? "ICMP" : proto === 6 ? "TCP" : proto === 17 ? "UDP" : `proto ${proto}`;
    const l4 = o + ihl;
    if ((proto === 6 || proto === 17) && b.length >= l4 + 4) {
      h.srcPort = (b[l4] << 8) | b[l4 + 1];
      h.dstPort = (b[l4 + 2] << 8) | b[l4 + 3];
    }
  }
  return h;
}
