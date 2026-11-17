/**
 * Frame → on-the-wire bytes (no FCS). The simulator's Frame is a typed object;
 * sFlow's sampled-header record (and `tcpdump -X`) need the real octets, so this
 * serializes Ethernet / 802.1Q / ARP / IPv4 (with header checksum) / ICMP / UDP /
 * TCP headers and zero-fills the rest of the frame up to its recorded size.
 */
import { Frame } from "../models/packet";
import { ETH_FCS_BYTES } from "../protocols/ethernet";

const ETHERTYPE: Record<string, number> = { IPv4: 0x0800, ARP: 0x0806, IPv6: 0x86dd };
const IPPROTO: Record<string, number> = { ICMP: 1, TCP: 6, UDP: 17, OSPF: 89 };
const ICMP_TYPE: Record<string, number> = {
  "echo-reply": 0,
  "dest-unreachable": 3,
  "echo-request": 8,
  "time-exceeded": 11,
};
const TCP_FLAG_BITS: Record<string, number> = { FIN: 0x01, SYN: 0x02, RST: 0x04, PSH: 0x08, ACK: 0x10, URG: 0x20 };

function macBytes(mac: string): number[] {
  return mac.split(":").map((h) => parseInt(h, 16) & 0xff);
}

function ipBytes(ip: string): number[] {
  return ip.split(".").map((o) => parseInt(o, 10) & 0xff);
}

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** RFC 1071 internet checksum. */
export function inetChecksum(bytes: number[]): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) + (bytes[i + 1] ?? 0);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

/** Captured length of the frame on the wire (what tcpdump calls "length"). */
export function wireLength(frame: Frame): number {
  return frame.meta.sizeBytes - ETH_FCS_BYTES;
}

export function frameToBytes(frame: Frame): Uint8Array {
  const total = wireLength(frame);
  const out: number[] = [...macBytes(frame.ethernet.dstMac), ...macBytes(frame.ethernet.srcMac)];
  if (frame.vlan) out.push(0x81, 0x00, ...u16(((frame.vlan.priority & 7) << 13) | (frame.vlan.vlanId & 0xfff)));
  out.push(...u16(ETHERTYPE[frame.ethernet.etherType] ?? 0));
  const l2 = out.length;

  if (frame.arp) {
    const a = frame.arp;
    out.push(0, 1, 0x08, 0x00, 6, 4, ...u16(a.op === "request" ? 1 : 2));
    out.push(...macBytes(a.senderMac), ...ipBytes(a.senderIp), ...macBytes(a.targetMac), ...ipBytes(a.targetIp));
  } else if (frame.ipv4) {
    const ip = frame.ipv4;
    const ipTotal = frame.udp ? 20 + frame.udp.length : total - l2;
    const hdr = [
      0x45, 0, ...u16(ipTotal), ...u16(ip.identification & 0xffff), 0x40, 0x00,
      ip.ttl & 0xff, IPPROTO[ip.protocol] ?? 0, 0, 0, ...ipBytes(ip.srcIp), ...ipBytes(ip.dstIp),
    ];
    const ck = inetChecksum(hdr);
    hdr[10] = ck >> 8;
    hdr[11] = ck & 0xff;
    out.push(...hdr);
    if (frame.icmp) {
      const ic = frame.icmp;
      out.push(ICMP_TYPE[ic.type] ?? 0, ic.code & 0xff, 0, 0, ...u16(ic.identifier & 0xffff), ...u16(ic.sequence & 0xffff));
    } else if (frame.udp) {
      out.push(...u16(frame.udp.srcPort), ...u16(frame.udp.dstPort), ...u16(frame.udp.length), 0, 0);
      if (frame.sflow) out.push(...frame.sflow.datagram);
    } else if (frame.tcp) {
      const t = frame.tcp;
      const flags = t.flags.reduce((f, name) => f | (TCP_FLAG_BITS[name] ?? 0), 0);
      out.push(...u16(t.srcPort), ...u16(t.dstPort), ...u32(t.seq), ...u32(t.ack), 0x50, flags, ...u16(t.window), 0, 0, 0, 0);
    }
  }
  while (out.length < total) out.push(0);
  return Uint8Array.from(out.slice(0, Math.max(total, out.length)));
}
