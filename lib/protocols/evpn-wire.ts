/**
 * BGP EVPN wire format (RFC 7432 §7, RFC 8365 §5) as FRR 10.3 bgpd encodes it:
 *
 *   NLRI           bgp_evpn.c:6122 bgp_evpn_encode_prefix
 *                    type 2 (MAC/IP)  len 33 (+4 with an IPv4): RD(8) ESI(10)
 *                                     EthTag(4) MAClen=48 MAC(6) IPlen [IP] VNI(3)
 *                                     + 3 with a 2nd label (L3VNI, symmetric IRB)
 *                    type 3 (IMET)    len 17: RD(8) EthTag(4) IPlen=32 OrigIP(4)
 *                    type 1 (EAD)     len 25: RD(8) ESI(10) EthTag(4) Label(3)
 *                    type 4 (ES)      len 23: RD(8) ESI(10) IPlen=32 OrigIP(4)
 *                    type 5 (prefix)  len 34: RD(8) ESI(10) EthTag(4) IPlen(1) IP(4)
 *                                     GW-IP(4) Label(3)  (evpn_mpattr_encode_type5)
 *                  The 3-byte "MPLS label" carries the VNI itself (RFC 8365 §5.1.3,
 *                  FRR vni2label). A received type-1 has no VTEP IP in its prefix
 *                  (bgp_evpn_mh.c:1229-1233 "EAD route prefix doesn't include the
 *                  nexthop in the global table"), so the simulator keeps 0.0.0.0.
 *   RD             type 1 "IP:nn" — FRR auto RD is RouterId:rd_id
 *                  (bgp_evpn.c:6450 bgp_evpn_derive_auto_rd).
 *   Ext. comm.     RT     type 0x00/0x02  (AS & 0xFFFF):VNI   (bgp_evpn.c:627 form_auto_rt)
 *                  Encap  type 0x03/0x0c  tunnel type 8 = VXLAN (encode_encap_extcomm)
 *                  MM     type 0x06/0x00  MAC mobility sequence (RFC 7432 §7.7)
 *                  ESI label 0x06/0x01, ES-Import RT 0x06/0x02, Router MAC 0x06/0x03,
 *                  DF election 0x06/0x06 (bgp_ecommunity.h:67-71; strings
 *                  bgp_ecommunity.c:1251-1339 "Rmac:", "ES-Import-Rt:", "ESI-label-Rt:AA",
 *                  "DF: (alg: 2, pref: 32767)")
 *                  Local routes carry [Encap, RT, (MM)] in that order (bgp_evpn.c:1129-1173,
 *                  ecommunity_merge appends); a received attribute is re-sorted by value
 *                  (bgp_ecommunity.c:127 ecommunity_add_val inserts in memcmp order).
 *   PMSI tunnel    flags 0, type 6 = ingress replication, label = VNI, endpoint =
 *                  originator IP (bgp_attr.c:4951-4961).
 *   Strings        prefix  lib/prefix.c:980 prefixevpn_macip2str / :1006 imet2str /
 *                          :962 ead2str / :1022 es2str / :1039 prefix2str
 *                  ecomm   "RT:65001:10100 ET:8 MM:1" (bgp_ecommunity.c ecommunity_ecom2str)
 */
export const AFI_L2VPN = 25;
export const SAFI_EVPN = 70;
export const ENCAP_VXLAN = 8;
export const PMSI_INGRESS_REPLICATION = 6;

export interface EvpnRoute {
  type: 1 | 2 | 3 | 4 | 5;
  rd: string; // "10.0.0.1:2"
  ethTag: number;
  /** type 2: lower-case "aa:bb:cc:dd:ee:ff" */
  mac?: string;
  ip?: string;
  /** type 2: L2 VNI (label 1); type 1: label; type 5: L3 VNI */
  vni?: number;
  /** type 2 with IP: L3 VNI (label 2, symmetric IRB) */
  vni2?: number;
  /** type 3 / 4: originating router's IP */
  origIp?: string;
  /** type 1 / 4 (prefix), type 2 (the MAC's ES, not part of the prefix): "00:11:…" 10 bytes */
  esi?: string;
  /** type 5: IP prefix length (the prefix itself is `ip`) */
  ipLen?: number;
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

// --- ESI ------------------------------------------------------------------

export const ESI_ZERO = "00:00:00:00:00:00:00:00:00:00";
export const esiBytes = (esi: string | undefined) => (esi ? esi.split(":").map((h) => parseInt(h, 16) & 0xff) : new Array(10).fill(0));
const esiStr = (b: ArrayLike<number>, o: number) => Array.from({ length: 10 }, (_, i) => b[o + i].toString(16).padStart(2, "0")).join(":");

// --- NLRI ---------------------------------------------------------------

const vni3 = (v: number) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const rd24 = (b: ArrayLike<number>, o: number) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

export function encodeEvpnNlri(r: EvpnRoute): number[] {
  let body: number[];
  if (r.type === 2) {
    const ip = r.ip ? ipBytes(r.ip) : [];
    const l2 = ip.length && r.vni2 !== undefined ? vni3(r.vni2) : [];
    body = [...encodeRd(r.rd), ...esiBytes(r.esi), ...u32(r.ethTag), 48, ...macBytes(r.mac!), ip.length * 8, ...ip, ...vni3(r.vni ?? 0), ...l2];
  } else if (r.type === 1) body = [...encodeRd(r.rd), ...esiBytes(r.esi), ...u32(r.ethTag), ...vni3(r.vni ?? 0)];
  else if (r.type === 4) body = [...encodeRd(r.rd), ...esiBytes(r.esi), 32, ...ipBytes(r.origIp!)];
  else if (r.type === 5) body = [...encodeRd(r.rd), ...esiBytes(r.esi), ...u32(r.ethTag), r.ipLen ?? 32, ...ipBytes(r.ip!), 0, 0, 0, 0, ...vni3(r.vni ?? 0)];
  else body = [...encodeRd(r.rd), ...u32(r.ethTag), 32, ...ipBytes(r.origIp!)];
  return [r.type, body.length, ...body];
}

export function decodeEvpnNlri(b: Uint8Array, o: number, end: number): EvpnRoute[] {
  const out: EvpnRoute[] = [];
  while (o + 2 <= end) {
    const type = b[o];
    const len = b[o + 1];
    const p = o + 2;
    const esi = type === 3 ? ESI_ZERO : esiStr(b, p + 8);
    const esiOpt = esi !== ESI_ZERO ? { esi } : {};
    if (type === 2) {
      const rd = decodeRd(b, p);
      const ethTag = rd32(b, p + 18);
      const mac = macStr(b, p + 23);
      const ipLen = b[p + 29] / 8;
      const ip = ipLen === 4 ? ipStr(b, p + 30) : undefined;
      const lo = p + 30 + ipLen;
      const vni = rd24(b, lo);
      const vni2 = ip && len >= 30 + ipLen + 6 ? { vni2: rd24(b, lo + 3) } : {};
      out.push({ type: 2, rd, ethTag, mac, ...(ip ? { ip } : {}), vni, ...vni2, ...esiOpt });
    } else if (type === 3) {
      out.push({ type: 3, rd: decodeRd(b, p), ethTag: rd32(b, p + 8), origIp: ipStr(b, p + 13) });
    } else if (type === 1) {
      out.push({ type: 1, rd: decodeRd(b, p), esi, ethTag: rd32(b, p + 18), vni: rd24(b, p + 22) });
    } else if (type === 4) {
      out.push({ type: 4, rd: decodeRd(b, p), esi, ethTag: 0, origIp: ipStr(b, p + 19) });
    } else if (type === 5) {
      out.push({ type: 5, rd: decodeRd(b, p), ethTag: rd32(b, p + 18), ipLen: b[p + 22], ip: ipStr(b, p + 23), vni: rd24(b, p + 31), ...esiOpt });
    }
    o = p + len;
  }
  return out;
}

/** FRR %pFX for an EVPN prefix (without the RD). */
export function evpnPrefixStr(r: EvpnRoute): string {
  if (r.type === 2) return r.ip ? `[2]:[${r.ethTag}]:[48]:[${r.mac}]:[32]:[${r.ip}]` : `[2]:[${r.ethTag}]:[48]:[${r.mac}]`;
  if (r.type === 1) return `[1]:[${r.ethTag}]:[${r.esi ?? ESI_ZERO}]:[32]:[0.0.0.0]:[0]`;
  if (r.type === 4) return `[4]:[${r.esi ?? ESI_ZERO}]:[32]:[${r.origIp}]`;
  if (r.type === 5) return `[5]:[${r.ethTag}]:[${r.ipLen ?? 32}]:[${r.ip}]`;
  return `[3]:[${r.ethTag}]:[32]:[${r.origIp}]`;
}

/** Loc-RIB key: RD + prefix (the label/VNI is not part of the prefix). */
export const evpnKey = (r: EvpnRoute) => `${r.rd}|${evpnPrefixStr(r)}`;

// --- extended communities -----------------------------------------------

export const ecRt = (as: number, vni: number): number[] => [0x00, 0x02, ...u16(as & 0xffff), ...u32(vni)];
export const ecEncap = (tunnelType = ENCAP_VXLAN): number[] => [0x03, 0x0c, 0, 0, 0, 0, ...u16(tunnelType)];
export const ecMacMobility = (seq: number, sticky = false): number[] => [0x06, 0x00, sticky ? 1 : 0, 0, ...u32(seq)];

export const ecRouterMac = (mac: string): number[] => [0x06, 0x03, ...macBytes(mac)];
export const ecEsiLabel = (singleActive = false, label = 0): number[] => [0x06, 0x01, singleActive ? 1 : 0, 0, 0, ...vni3(label)];
/** ES-Import RT: bytes 1-6 of a type-0/3 ESI (RFC 7432 §7.6, bgp_evpn_mh.c es import RT). */
export const ecEsImportRt = (esi: string): number[] => [0x06, 0x02, ...esiBytes(esi).slice(1, 7)];
export const DF_ALG_PREF = 2;
export const ecDfElection = (pref: number, alg = DF_ALG_PREF): number[] => [0x06, 0x06, alg & 0x1f, 0, 0, 0, ...u16(pref)];

/** Router MAC carried in a route (symmetric IRB), lower-case. */
export function ecRouterMacOf(ecs: number[][]): string | undefined {
  const m = ecs.find((e) => e[0] === 0x06 && e[1] === 0x03);
  return m ? macStr(m, 2) : undefined;
}

/** DF election extended community: { alg, pref } (zebra_evpn_mh.c DF election input). */
export function ecDfOf(ecs: number[][]): { alg: number; pref: number } | undefined {
  const m = ecs.find((e) => e[0] === 0x06 && e[1] === 0x06);
  return m ? { alg: m[2] & 0x1f, pref: rd16(m, 6) } : undefined;
}

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
  if (ec[0] === 0x06 && ec[1] === 0x03) return `Rmac:${macStr(ec, 2)}`;
  if (ec[0] === 0x06 && ec[1] === 0x02) return `ES-Import-Rt:${macStr(ec, 2)}`;
  if (ec[0] === 0x06 && ec[1] === 0x01) return `ESI-label-Rt:${ec[2] & 1 ? "SA" : "AA"}`;
  if (ec[0] === 0x06 && ec[1] === 0x06) {
    const bmap = rd16(ec, 3);
    return bmap ? `DF: (alg: ${ec[2] & 0x1f}, bmap: 0x${bmap.toString(16)} pref: ${rd16(ec, 6)})` : `DF: (alg: ${ec[2] & 0x1f}, pref: ${rd16(ec, 6)})`;
  }
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
