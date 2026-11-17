/**
 * Wire-accurate packet construction for control-plane daemons. Protocol PDUs
 * are real bytes (Frame.rawL3 = IP header onward, or the L2 payload for non-IP),
 * so tcpdump, sFlow and the Scapy inspector see exactly what the protocol sent,
 * and the forwarding engine routes them like any other packet.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame, IpProtocol, TcpHeader } from "../models/packet";
import { SimContext } from "../engine/context";
import { inetChecksum } from "../sflow/wire";
import { ipOutput, IpOutputResult } from "../protocols/ipv4";
import { buildFrame } from "../protocols/ethernet";
import { nextFrameId } from "../engine/ids";
import { ETH_FCS_BYTES, MIN_FRAME_BYTES } from "../protocols/ethernet";

const ipBytes = (ip: string) => ip.split(".").map((o) => Number(o) & 0xff);
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

export const IPPROTO = { ICMP: 1, TCP: 6, UDP: 17, OSPF: 89 } as const;

/** IPv4 header (20 bytes, valid checksum) + payload. */
export function ipv4Packet(o: { src: string; dst: string; proto: number; ttl: number; id?: number; tos?: number; payload: number[] }): number[] {
  const hdr = [0x45, o.tos ?? 0, ...u16(20 + o.payload.length), ...u16(o.id ?? 0), 0x40, 0x00, o.ttl & 0xff, o.proto, 0, 0, ...ipBytes(o.src), ...ipBytes(o.dst)];
  const ck = inetChecksum(hdr);
  hdr[10] = ck >> 8;
  hdr[11] = ck & 0xff;
  return [...hdr, ...o.payload];
}

function pseudoChecksum(src: string, dst: string, proto: number, l4: number[]): number {
  return inetChecksum([...ipBytes(src), ...ipBytes(dst), 0, proto, ...u16(l4.length), ...l4]);
}

/** UDP header (valid checksum) + payload. */
export function udpSegment(src: string, dst: string, sport: number, dport: number, payload: number[]): number[] {
  const seg = [...u16(sport), ...u16(dport), ...u16(8 + payload.length), 0, 0, ...payload];
  const ck = pseudoChecksum(src, dst, IPPROTO.UDP, seg) || 0xffff;
  seg[6] = ck >> 8;
  seg[7] = ck & 0xff;
  return seg;
}

const TCP_BITS: Record<string, number> = { FIN: 0x01, SYN: 0x02, RST: 0x04, PSH: 0x08, ACK: 0x10, URG: 0x20 };

/** TCP header (20 bytes, valid checksum) + payload. */
export function tcpSegment(src: string, dst: string, t: TcpHeader, payload: number[]): number[] {
  const flags = t.flags.reduce((f, n) => f | (TCP_BITS[n] ?? 0), 0);
  const seg = [...u16(t.srcPort), ...u16(t.dstPort), ...u32(t.seq), ...u32(t.ack), 0x50, flags, ...u16(t.window), 0, 0, 0, 0, ...payload];
  const ck = pseudoChecksum(src, dst, IPPROTO.TCP, seg);
  seg[16] = ck >> 8;
  seg[17] = ck & 0xff;
  return seg;
}

export interface ControlIpv4 {
  src: string;
  dst: string;
  ttl?: number;
  tos?: number;
  /** Exactly one of udp / tcp / proto (raw IP protocol, e.g. 89 for OSPF). */
  udp?: { sport: number; dport: number };
  tcp?: TcpHeader;
  proto?: number;
  payload: number[];
  summary: string;
}

function assemble(o: ControlIpv4): { rawL3: number[]; protocol: IpProtocol; protocolNumber?: number } {
  const ttl = o.ttl ?? 64;
  if (o.udp) {
    return { rawL3: ipv4Packet({ src: o.src, dst: o.dst, proto: IPPROTO.UDP, ttl, tos: o.tos, payload: udpSegment(o.src, o.dst, o.udp.sport, o.udp.dport, o.payload) }), protocol: "UDP" };
  }
  if (o.tcp) {
    return { rawL3: ipv4Packet({ src: o.src, dst: o.dst, proto: IPPROTO.TCP, ttl, tos: o.tos, payload: tcpSegment(o.src, o.dst, o.tcp, o.payload) }), protocol: "TCP" };
  }
  const proto = o.proto ?? 0;
  const protocol: IpProtocol = proto === IPPROTO.OSPF ? "OSPF" : proto === IPPROTO.ICMP ? "ICMP" : "OTHER";
  return { rawL3: ipv4Packet({ src: o.src, dst: o.dst, proto, ttl, tos: o.tos, payload: o.payload }), protocol, protocolNumber: protocol === "OTHER" ? proto : undefined };
}

/** Send a unicast control packet through normal routing (route lookup + ARP). */
export function sendIpv4(ctx: SimContext, device: Device, o: ControlIpv4): IpOutputResult {
  const a = assemble(o);
  return ipOutput(ctx, device, {
    srcIp: o.src,
    dstIp: o.dst,
    ttl: o.ttl ?? 64,
    protocol: a.protocol,
    protocolNumber: a.protocolNumber,
    identification: 0,
    udp: o.udp ? { srcPort: o.udp.sport, dstPort: o.udp.dport, length: 8 + o.payload.length } : undefined,
    tcp: o.tcp,
    rawL3: a.rawL3,
    upperBytes: 0,
    summary: o.summary,
  });
}

/** IPv4 multicast group → Ethernet MAC (01:00:5E + low 23 bits). */
export function multicastMac(group: string): string {
  const [, b, c, d] = ipBytes(group);
  return ["01", "00", "5E", (b & 0x7f).toString(16), c.toString(16), d.toString(16)].map((x) => x.padStart(2, "0").toUpperCase()).join(":");
}

/**
 * Send a control packet out of one specific interface to a given MAC (multicast
 * Hellos, link-scoped peers) — no route lookup, no ARP.
 */
export function transmitIpv4(ctx: SimContext, device: Device, iface: NetInterface, dstMac: string, o: ControlIpv4): void {
  const a = assemble(o);
  const frame = buildFrame(
    { srcMac: iface.mac, dstMac, etherType: "IPv4", payloadBytes: a.rawL3.length, summary: o.summary },
    {
      ipv4: { srcIp: o.src, dstIp: o.dst, ttl: o.ttl ?? 64, protocol: a.protocol, identification: 0, ...(a.protocolNumber !== undefined ? { protocolNumber: a.protocolNumber } : {}) },
      udp: o.udp ? { srcPort: o.udp.sport, dstPort: o.udp.dport, length: 8 + o.payload.length } : undefined,
      tcp: o.tcp,
    },
  );
  frame.rawL3 = a.rawL3;
  ctx.transmit(device.id, iface.id, frame);
}

/** Send a non-IP L2 control frame (e.g. LLDP, EtherType 0x88CC) out of an interface. */
export function transmitL2(ctx: SimContext, device: Device, iface: NetInterface, dstMac: string, etherType: number, payload: number[], summary: string): void {
  const frame: Frame = {
    id: nextFrameId(),
    ethernet: { srcMac: iface.mac, dstMac, etherType: "Other", typeCode: etherType },
    meta: { sizeBytes: Math.max(MIN_FRAME_BYTES, 14 + payload.length + ETH_FCS_BYTES), summary },
    rawL3: payload,
  };
  ctx.transmit(device.id, iface.id, frame);
}

/** Bytes after the IPv4 header (e.g. the OSPF packet). */
export function ipPayload(frame: Frame): Uint8Array | undefined {
  const r = frame.rawL3;
  if (!r || !frame.ipv4 || r.length < 20) return undefined;
  return Uint8Array.from(r.slice((r[0] & 0x0f) * 4));
}

/** Bytes after the UDP/TCP header (the application PDU). */
export function l4Payload(frame: Frame): Uint8Array | undefined {
  const ip = ipPayload(frame);
  if (!ip) return undefined;
  if (frame.udp) return ip.slice(8);
  if (frame.tcp) return ip.slice((ip[12] >> 4) * 4);
  return undefined;
}

/** Device's own IPv4 addresses. */
export function ownsAddress(device: Device, ip: string): boolean {
  return device.interfaces.some((i) => i.ipv4.some((a) => a.address === ip));
}
