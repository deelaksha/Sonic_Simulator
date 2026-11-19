/**
 * ECMP hash inputs from `ip load-share hash ...` (KLISH loadshare.xml →
 * ECMP_LOADSHARE_TABLE_IPV4 / SWITCH hash seed; stored by
 * lib/commands/sonic-cli/features/loadshare.ts in features.cp_loadshare).
 *
 *   ipv4 field list   which 5-tuple fields feed the hash. Unset = the SONiC
 *                     default (all five: ipv4-src-ip, ipv4-dst-ip, ipv4-ip-proto,
 *                     ipv4-l4-src-port, ipv4-l4-dst-port); a field left out is
 *                     not hashed, so e.g. without the L4 ports every flow
 *                     between two hosts shares one next hop.
 *   symmetric         A→B and B→A hash the same (addresses/ports ordered).
 *   seed              mixed into the hash: a different seed reshuffles which
 *                     next hop each flow takes.
 */
import { Device } from "../models/device";
import { flowHash5 } from "../models/route";

export const IPV4_HASH_DEFAULT = ["ipv4-src-ip", "ipv4-dst-ip", "ipv4-ip-proto", "ipv4-l4-src-port", "ipv4-l4-dst-port"];

interface LoadshareCfg {
  seed?: string;
  ipv4?: { field: string }[];
}

export function ecmpFlowHash(device: Device, srcIp: string, dstIp: string, proto: string | number, srcPort: number, dstPort: number): number {
  const cfg = device.config.features?.cp_loadshare as LoadshareCfg | undefined;
  if (!cfg) return flowHash5(srcIp, dstIp, proto, srcPort, dstPort);
  const fields = new Set((cfg.ipv4 ?? IPV4_HASH_DEFAULT.map((field) => ({ field }))).map((f) => f.field));
  let a = fields.has("ipv4-src-ip") ? srcIp : "";
  let b = fields.has("ipv4-dst-ip") ? dstIp : "";
  let pa = fields.has("ipv4-l4-src-port") ? srcPort : 0;
  let pb = fields.has("ipv4-l4-dst-port") ? dstPort : 0;
  if (fields.has("symmetric")) {
    if (a > b) [a, b] = [b, a];
    if (pa > pb) [pa, pb] = [pb, pa];
  }
  return flowHash5(a, b, fields.has("ipv4-ip-proto") ? proto : "", pa, pb, Number(cfg.seed ?? 0) >>> 0);
}
