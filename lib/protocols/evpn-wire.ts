/**
 * BGP EVPN wire format (RFC 7432 §7, RFC 8365 §5) as FRR 10.3 bgpd encodes it:
 *
 *   NLRI           bgp_evpn.c:6122 bgp_evpn_encode_prefix
 *                    type 2 (MAC/IP)  len 33 (+4 with an IPv4): RD(8) ESI(10)
 *                                     EthTag(4) MAClen=48 MAC(6) IPlen [IP] VNI(3)
 *                    type 3 (IMET)    len 17: RD(8) EthTag(4) IPlen=32 OrigIP(4)
 *                  The 3-byte "MPLS label" carries the VNI itself (RFC 8365 §5.1.3,
 *                  FRR vni2label).
 *   RD             type 1 "IP:nn" — FRR auto RD is RouterId:rd_id
 *                  (bgp_evpn.c:6450 bgp_evpn_derive_auto_rd).
 *   Ext. comm.     RT     type 0x00/0x02  (AS & 0xFFFF):VNI   (bgp_evpn.c:627 form_auto_rt)
 *                  Encap  type 0x03/0x0c  tunnel type 8 = VXLAN (encode_encap_extcomm)
 *                  MM     type 0x06/0x00  MAC mobility sequence (RFC 7432 §7.7)
 *                  Local routes carry [Encap, RT, (MM)] in that order (bgp_evpn.c:1129-1173,
 *                  ecommunity_merge appends); a received attribute is re-sorted by value
 *                  (bgp_ecommunity.c:127 ecommunity_add_val inserts in memcmp order).
 *   PMSI tunnel    flags 0, type 6 = ingress replication, label = VNI, endpoint =
 *                  originator IP (bgp_attr.c:4951-4961).
 *   Strings        prefix  lib/prefix.c:980 prefixevpn_macip2str / :1006 imet2str
 *                  ecomm   "RT:65001:10100 ET:8 MM:1" (bgp_ecommunity.c ecommunity_ecom2str)
 */
export const AFI_L2VPN = 25;
export const SAFI_EVPN = 70;
export const ENCAP_VXLAN = 8;
export const PMSI_INGRESS_REPLICATION = 6;

export interface EvpnRoute {
  type: 2 | 3;
  rd: string; // "10.0.0.1:2"
  ethTag: number;
  /** type 2: lower-case "aa:bb:cc:dd:ee:ff" */
  mac?: string;
  ip?: string;
  /** type 2: L2 VNI (label 1) */
  vni?: number;
  /** type 3: originating router's IP */
  origIp?: string;
}

export interface Pmsi {
  flags: number;
  tunnelType: number;
  vni: number;
  endpoint: string;
}

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ipBytes = (ip: string) => ip.split(".").map((o) => Number(o) & 0xff);
const ipStr = (b: ArrayLike<number>, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const rd16 = (b: ArrayLike<number>, o: number) => (b[o] << 8) | b[o + 1];
const rd32 = (b: ArrayLike<number>, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const macBytes = (m: string) => m.split(":").map((h) => parseInt(h, 16) & 0xff);
const macStr = (b: ArrayLike<number>, o: number) => Array.from({ length: 6 }, (_, i) => b[o + i].toString(16).padStart(2, "0")).join(":");

// --- RD -----------------------------------------------------------------

export function encodeRd(rd: string): number[] {
  const [a, nn] = rd.split(":");
  if (a.includes(".")) return [0, 1, ...ipBytes(a), ...u16(Number(nn))];
  const as = Number(a);
  return as > 0xffff ? [0, 2, ...u32(as), ...u16(Number(nn))] : [0, 0, ...u16(as), ...u32(Number(nn))];
}

export function decodeRd(b: ArrayLike<number>, o: number): string {
  const t = rd16(b, o);
  if (t === 1) return `${ipStr(b, o + 2)}:${rd16(b, o + 6)}`;
  if (t === 2) return `${rd32(b, o + 2)}:${rd16(b, o + 6)}`;
  return `${rd16(b, o + 2)}:${rd32(b, o + 4)}`;
}

// --- NLRI ---------------------------------------------------------------

const vni3 = (v: number) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];

export function encodeEvpnNlri(r: EvpnRoute): number[] {
  if (r.type === 2) {
    const ip = r.ip ? ipBytes(r.ip) : [];
    const body = [...encodeRd(r.rd), ...new Array(10).fill(0), ...u32(r.ethTag), 48, ...macBytes(r.mac!), ip.length * 8, ...ip, ...vni3(r.vni ?? 0)];
    return [2, body.length, ...body];
  }
  const body = [...encodeRd(r.rd), ...u32(r.ethTag), 32, ...ipBytes(r.origIp!)];
  return [3, body.length, ...body];
}

export function decodeEvpnNlri(b: Uint8Array, o: number, end: number): EvpnRoute[] {
  const out: EvpnRoute[] = [];
  while (o + 2 <= end) {
    const type = b[o];
    const len = b[o + 1];
    const p = o + 2;
    if (type === 2) {
      const rd = decodeRd(b, p);
      const ethTag = rd32(b, p + 18);
      const mac = macStr(b, p + 23);
      const ipLen = b[p + 29] / 8;
      const ip = ipLen === 4 ? ipStr(b, p + 30) : undefined;
      const lo = p + 30 + ipLen;
      const vni = (b[lo] << 16) | (b[lo + 1] << 8) | b[lo + 2];
      out.push({ type: 2, rd, ethTag, mac, ...(ip ? { ip } : {}), vni });
    } else if (type === 3) {
      out.push({ type: 3, rd: decodeRd(b, p), ethTag: rd32(b, p + 8), origIp: ipStr(b, p + 13) });
    }
    o = p + len;
  }
  return out;
}

/** FRR %pFX for an EVPN prefix (without the RD). */
export function evpnPrefixStr(r: EvpnRoute): string {
  if (r.type === 2) return r.ip ? `[2]:[${r.ethTag}]:[48]:[${r.mac}]:[32]:[${r.ip}]` : `[2]:[${r.ethTag}]:[48]:[${r.mac}]`;
  return `[3]:[${r.ethTag}]:[32]:[${r.origIp}]`;
}

/** Loc-RIB key: RD + prefix (the label/VNI is not part of the prefix). */
export const evpnKey = (r: EvpnRoute) => `${r.rd}|${evpnPrefixStr(r)}`;

// --- extended communities -----------------------------------------------

export const ecRt = (as: number, vni: number): number[] => [0x00, 0x02, ...u16(as & 0xffff), ...u32(vni)];
export const ecEncap = (tunnelType = ENCAP_VXLAN): number[] => [0x03, 0x0c, 0, 0, 0, 0, ...u16(tunnelType)];
export const ecMacMobility = (seq: number, sticky = false): number[] => [0x06, 0x00, sticky ? 1 : 0, 0, ...u32(seq)];

export function ecIsRt(ec: number[]): boolean {
  return (ec[0] === 0x00 || ec[0] === 0x01 || ec[0] === 0x02) && ec[1] === 0x02;
}

/** RT local-admin field (the VNI for auto RTs): the AS-masked match FRR uses (bgp_evpn.c:431). */
export function ecRtLocalAdmin(ec: number[]): number {
  return ec[0] === 0x00 ? rd32(ec, 4) : rd16(ec, 6);
}

export function ecMacMobilitySeq(ecs: number[][]): number {
  const m = ecs.find((e) => e[0] === 0x06 && e[1] === 0x00);
  return m ? rd32(m, 4) : 0;
}

export function ecStr(ec: number[]): string {
  if (ec[1] === 0x02 && ec[0] === 0x00) return `RT:${rd16(ec, 2)}:${rd32(ec, 4)}`;
  if (ec[1] === 0x02 && ec[0] === 0x01) return `RT:${ipStr(ec, 2)}:${rd16(ec, 6)}`;
  if (ec[1] === 0x02 && ec[0] === 0x02) return `RT:${rd32(ec, 2)}:${rd16(ec, 6)}`;
  if (ec[0] === 0x03 && ec[1] === 0x0c) return `ET:${rd16(ec, 6)}`;
  if (ec[0] === 0x06 && ec[1] === 0x00) return `MM:${rd32(ec, 4)}${ec[2] & 1 ? ", sticky MAC" : ""}`;
  return `?:${ec.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export const ecListStr = (ecs: number[][]) => ecs.map(ecStr).join(" ");

/** Received ext-community attribute: values kept in memcmp order (ecommunity_add_val). */
export function sortEcs(ecs: number[][]): number[][] {
  return [...ecs].sort((a, b) => {
    for (let i = 0; i < 8; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
}

// --- PMSI tunnel ----------------------------------------------------------

export function encodePmsi(p: Pmsi): number[] {
  return [p.flags, p.tunnelType, ...vni3(p.vni), ...ipBytes(p.endpoint)];
}

export function decodePmsi(b: ArrayLike<number>, o: number): Pmsi {
  return { flags: b[o], tunnelType: b[o + 1], vni: (b[o + 2] << 16) | (b[o + 3] << 8) | b[o + 4], endpoint: ipStr(b, o + 5) };
}
