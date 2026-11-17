/**
 * Bridge: packet-engine wire bytes → simulator Frame. Only the headers the
 * forwarding engine acts on are parsed (Ethernet / 802.1Q / ARP / IPv4 / IPv6 /
 * ICMP / UDP / TCP); everything after the L2 header is kept verbatim in
 * `rawL3`, so the protocol the engine built (DNS, VXLAN, BGP, LLDP, …) is what
 * crosses the simulated network, gets sampled by sFlow and shows in tcpdump.
 */
import { Frame, IcmpType, IpProtocol } from "../models/packet";
import { nextFrameId } from "../engine/ids";
import { ETH_FCS_BYTES, MIN_FRAME_BYTES } from "../protocols/ethernet";

const mac = (b: Uint8Array, o: number) => Array.from(b.slice(o, o + 6), (x) => x.toString(16).padStart(2, "0").toUpperCase()).join(":");
const ip4 = (b: Uint8Array, o: number) => Array.from(b.slice(o, o + 4)).join(".");
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Uncompressed IPv6 text (the simulator compares IPv6 via normalizeIpv6). */
function ip6(b: Uint8Array, o: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(u16(b, o + i).toString(16));
  return groups.join(":");
}

const ICMP_TYPES: Record<number, IcmpType> = { 0: "echo-reply", 3: "dest-unreachable", 8: "echo-request", 11: "time-exceeded" };
const IP_PROTOCOLS: Record<number, IpProtocol> = { 1: "ICMP", 6: "TCP", 17: "UDP", 89: "OSPF" };
const TCP_FLAGS: [number, string][] = [[0x02, "SYN"], [0x10, "ACK"], [0x01, "FIN"], [0x04, "RST"], [0x08, "PSH"], [0x20, "URG"]];

export class FrameParseError extends Error {}

export function bytesToFrame(bytes: Uint8Array, summary: string): Frame {
  if (bytes.length < 14) throw new FrameParseError("frame shorter than an Ethernet header");
  let off = 12;
  let type = u16(bytes, off);
  const frame: Frame = {
    id: nextFrameId(),
    ethernet: { dstMac: mac(bytes, 0), srcMac: mac(bytes, 6), etherType: "Other" },
    meta: { sizeBytes: Math.max(MIN_FRAME_BYTES, bytes.length + ETH_FCS_BYTES), summary },
  };
  if (type === 0x8100) {
    const tci = u16(bytes, 14);
    frame.vlan = { vlanId: tci & 0xfff, priority: tci >> 13 };
    off = 16;
    type = u16(bytes, off);
  }
  const l3 = off + 2;
  frame.rawL3 = Array.from(bytes.slice(l3));

  if (type === 0x0806 && bytes.length >= l3 + 28) {
    frame.ethernet.etherType = "ARP";
    frame.arp = {
      op: u16(bytes, l3 + 6) === 1 ? "request" : "reply",
      senderMac: mac(bytes, l3 + 8),
      senderIp: ip4(bytes, l3 + 14),
      targetMac: mac(bytes, l3 + 18),
      targetIp: ip4(bytes, l3 + 24),
    };
  } else if (type === 0x0800 && bytes.length >= l3 + 20) {
    frame.ethernet.etherType = "IPv4";
    const ihl = (bytes[l3] & 0x0f) * 4;
    const protoNum = bytes[l3 + 9];
    const protocol = IP_PROTOCOLS[protoNum] ?? "OTHER";
    frame.ipv4 = {
      srcIp: ip4(bytes, l3 + 12),
      dstIp: ip4(bytes, l3 + 16),
      ttl: bytes[l3 + 8],
      protocol,
      identification: u16(bytes, l3 + 4),
      ...(protocol === "OTHER" ? { protocolNumber: protoNum } : {}),
    };
    parseL4(frame, bytes, l3 + ihl, protoNum);
  } else if (type === 0x86dd && bytes.length >= l3 + 40) {
    frame.ethernet.etherType = "IPv6";
    const next = bytes[l3 + 6];
    frame.ipv6 = {
      srcIp: ip6(bytes, l3 + 8),
      dstIp: ip6(bytes, l3 + 24),
      hopLimit: bytes[l3 + 7],
      nextHeader: next === 58 ? "ICMPv6" : next === 17 ? "UDP" : next === 6 ? "TCP" : "OTHER",
    };
    parseL4(frame, bytes, l3 + 40, next);
  } else {
    frame.ethernet.typeCode = type;
  }
  return frame;
}

function parseL4(frame: Frame, b: Uint8Array, o: number, proto: number): void {
  if (proto === 58 && b.length >= o + 8 && (b[o] === 128 || b[o] === 129)) {
    frame.icmp6 = { type: b[o] === 128 ? "echo-request" : "echo-reply", code: b[o + 1], identifier: u16(b, o + 4), sequence: u16(b, o + 6) };
  } else if (proto === 1 && b.length >= o + 8) {
    const type = ICMP_TYPES[b[o]];
    if (type) frame.icmp = { type, code: b[o + 1], identifier: u16(b, o + 4), sequence: u16(b, o + 6) };
    else if (frame.ipv4) frame.ipv4 = { ...frame.ipv4, protocol: "OTHER", protocolNumber: 1 };
  } else if (proto === 17 && b.length >= o + 8) {
    frame.udp = { srcPort: u16(b, o), dstPort: u16(b, o + 2), length: u16(b, o + 4) };
  } else if (proto === 6 && b.length >= o + 20) {
    const flagBits = b[o + 13];
    frame.tcp = {
      srcPort: u16(b, o),
      dstPort: u16(b, o + 2),
      seq: u32(b, o + 4),
      ack: u32(b, o + 8),
      flags: TCP_FLAGS.filter(([bit]) => flagBits & bit).map(([, n]) => n),
      window: u16(b, o + 14),
    };
  }
}
