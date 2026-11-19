/**
 * VRRP advertisement wire format, as FRR vrrpd builds it (vrrp_packet.c
 * vrrp_pkt_adver_build / vrrp_pkt_checksum, vrrp_packet.h VRRP_PKT_SIZE):
 *
 *   v3 (RFC 5798 §5.1):  ver/type | vrid | prio | naddr | rsvd(4)+max adver int(12, cs) | cksum | addrs
 *                        checksum over the IPv4 pseudo-header + VRRP message (default
 *                        checksum_with_ipv4_pseudoheader = true).
 *   v2 (RFC 3768 §5.1):  ver/type | vrid | prio | naddr | auth type 0 | adver int (s) | cksum | addrs
 *                        | 8 bytes of zero authentication data; checksum over the message only.
 *
 * Sent to 224.0.0.18, IP protocol 112, TTL 255 (vrrp.c:1116-1124).
 *
 * IPv6 (v3 only, vrrp_packet.c:115): 16-byte addresses, checksum over the IPv6
 * pseudo-header (vrrp_pkt_checksum, vrrp_packet.c:70-77); sent from the router's
 * link-local to ff02::12, hop limit 255 (vrrp.c:1225-1226).
 */
import { inetChecksum } from "../sflow/wire";
import { VRRP_GROUP, VRRP_GROUP6, VRRP_PROTO } from "./vrrp";
import { parseIpv6, formatIpv6 } from "../models/ipv6";

const ipBytes = (ip: string) => (ip.includes(":") ? ip6Bytes(ip) : ip.split(".").map((o) => Number(o) & 0xff));
function ip6Bytes(ip: string): number[] {
  const n = parseIpv6(ip) ?? 0n;
  return Array.from({ length: 16 }, (_, i) => Number((n >> BigInt(8 * (15 - i))) & 0xffn));
}

export interface VrrpAdvert {
  version: number;
  type: number;
  vrid: number;
  priority: number;
  /** v3: centiseconds; v2: seconds. */
  adverInt: number;
  authType: number;
  addrs: string[];
  checksumOk: boolean;
}

function checksum(version: number, src: string, msg: number[]): number {
  if (src.includes(":")) {
    const l = msg.length;
    return inetChecksum([...ip6Bytes(src), ...ip6Bytes(VRRP_GROUP6), 0, 0, (l >> 8) & 0xff, l & 0xff, 0, 0, 0, VRRP_PROTO, ...msg]);
  }
  if (version === 3) return inetChecksum([...ipBytes(src), ...ipBytes(VRRP_GROUP), 0, VRRP_PROTO, (msg.length >> 8) & 0xff, msg.length & 0xff, ...msg]);
  return inetChecksum(msg);
}

/** Build an advertisement. `intervalCs` is the configured interval in centiseconds. */
export function encodeVrrp(o: { version: number; vrid: number; priority: number; intervalCs: number; addrs: string[]; src: string }): number[] {
  const hdr =
    o.version === 3
      ? [0x31, o.vrid, o.priority, o.addrs.length, (o.intervalCs >> 8) & 0x0f, o.intervalCs & 0xff, 0, 0]
      : [0x21, o.vrid, o.priority, o.addrs.length, 0, Math.max(Math.floor(o.intervalCs / 100), 1), 0, 0];
  const msg = [...hdr, ...o.addrs.flatMap(ipBytes), ...(o.version === 2 ? new Array(8).fill(0) : [])];
  const ck = checksum(o.version, o.src, msg);
  msg[6] = ck >> 8;
  msg[7] = ck & 0xff;
  return msg;
}

/** Decode; `src` is the IP source (an IPv6 source means 16-byte addresses). */
export function decodeVrrp(b: Uint8Array, src: string): VrrpAdvert | undefined {
  if (b.length < 8) return undefined;
  const version = b[0] >> 4;
  const naddr = b[3];
  const alen = src.includes(":") ? 16 : 4;
  if (b.length < 8 + alen * naddr) return undefined;
  const addrs: string[] = [];
  for (let i = 0; i < naddr; i++) {
    const a = Array.from(b.slice(8 + alen * i, 8 + alen * (i + 1)));
    addrs.push(alen === 4 ? a.join(".") : formatIpv6(a.reduce((n, x) => (n << 8n) | BigInt(x), 0n)));
  }
  return {
    version,
    type: b[0] & 0x0f,
    vrid: b[1],
    priority: b[2],
    adverInt: version === 3 ? ((b[4] & 0x0f) << 8) | b[5] : b[5],
    authType: version === 3 ? 0 : b[4],
    addrs,
    checksumOk: checksum(version, src, Array.from(b)) === 0,
  };
}

const AUTH = ["none", "simple", "ah"];

/**
 * tcpdump print-vrrp.c text (after "IP src > dst: "):
 *   VRRPv2, Advertisement, vrid 1, prio 120, authtype none, intvl 1s, length 20
 *   VRRPv3, Advertisement, vrid 1, prio 120, intvl 100cs, length 12
 * -v adds ", addrs: a.b.c.d" (", addrs(N): a,b" for several).
 */
export function tcpdumpVrrp(b: Uint8Array, ttl: number, verbose: boolean, v6 = false): string {
  const a = decodeVrrp(b, v6 ? "::" : "0.0.0.0");
  if (!a) return `VRRP, length ${b.length}`;
  let s = `VRRPv${a.version}, ${a.type === 1 ? "Advertisement" : `unknown type ${a.type}`}`;
  if (ttl !== 255) s += `, (ttl ${ttl})`;
  s += `, vrid ${a.vrid}, prio ${a.priority}`;
  s += a.version === 2 ? `, authtype ${AUTH[a.authType] ?? a.authType}, intvl ${a.adverInt}s` : `, intvl ${a.adverInt}cs`;
  s += `, length ${b.length}`;
  if (verbose) s += `, addrs${a.addrs.length > 1 ? `(${a.addrs.length})` : ""}: ${a.addrs.join(",")}`;
  return s;
}
