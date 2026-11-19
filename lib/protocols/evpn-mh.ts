/**
 * EVPN multihoming, basic subset (RFC 7432 §8, RFC 8365 §8, RFC 8584 DF preference)
 * as FRR 10.3 zebra/bgpd implement it (zebra_evpn_mh.c, bgp_evpn_mh.c).
 *
 * Config (KLISH interface.xml:1480-1530, PortChannel view): `evpn ethernet-segment
 * <ESI>` (type-0) or `evpn ethernet-segment auto-system-mac` (type-3: 03 + the
 * PortChannel's system MAC + the PortChannel number as discriminator), then
 * `df-preference <1-65535>` (default 32767, lib/vxlan.h:20). Stored by
 * lib/commands/sonic-cli/features/evpn_mh.ts in cp_evpn_mh "es".
 *
 * Routes (built by lib/protocols/vxlan-daemon.ts):
 *   type-4 ES    [4]:[ESI]:[32]:[VTEP]  ext. comm. ET:8, ES-Import-Rt (ESI bytes 1-6),
 *                DF: (alg: 2, pref: N)  (bgp_evpn_mh.c:595 type4_route_extcomm_build)
 *   type-1 EAD   per ES (EthTag 4294967295, label 0, ESI-label-Rt:AA + the RT of every
 *                L2 VNI, bgp_evpn_mh.c:862) and per EVI (EthTag 0, label VNI, RT of the
 *                VNI, :917)
 *   type-2       MACs learnt on an ES port carry the ESI in the NLRI.
 *
 * DF election (zebra_evpn_mh.c:1725-1784): a VTEP is non-DF when its ES is not ready
 * or oper-down, or a peer VTEP that sent a type-4 for the ES has a higher preference,
 * or the same preference and a lower IP. Only VTEPs that advertised the ESR take part.
 * The df-election-time hold-down after ES creation is not modelled.
 *
 * Data plane:
 *   BUM  frames decapsulated from a tunnel are sent to an ES port only by the DF, and
 *        never when the sending VTEP is attached to the same ES (local bias, RFC 8365
 *        §8.3.1 — "split horizon").
 *   unicast to a remote MAC carrying an ESI is load-balanced over every VTEP that
 *        advertised type-1 for that ES (aliasing, RFC 7432 §8.4); a remote MAC on an ES
 *        that is also local is programmed on the local ES port.
 */
import { Device, interfaceByName, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { featureState, peekFeatureState } from "../models/feature-state";
import { isBroadcast, isMulticast, normalizeMac } from "../models/mac";
import { registerDataPlaneHook } from "../control/hooks";
import { vxlanConfig } from "./vxlan";

export const DF_PREF_DEFAULT = 32767;

export interface LocalEs {
  ifname: string;
  esi: string;
  dfPref: number;
  iface?: NetInterface;
  /** PortChannel exists, admin and oper up. */
  up: boolean;
}

export interface EsPeer {
  /** Type-4 received (takes part in DF election). */
  esr: boolean;
  /** Type-1 per-ES received (aliasing target). */
  ead: boolean;
  alg: number;
  pref: number;
}

interface MhRt {
  /** ESI → remote VTEP IP → what it advertised. */
  peers: Record<string, Record<string, EsPeer>>;
}

type Row = Record<string, string>;

/** Type-3 ESI from a system MAC and discriminator (RFC 7432 §5). */
export function esiType3(mac: string, disc: number): string {
  const m = normalizeMac(mac).toLowerCase();
  return `03:${m}:${[(disc >> 16) & 0xff, (disc >> 8) & 0xff, disc & 0xff].map((x) => x.toString(16).padStart(2, "0")).join(":")}`;
}

/** Ethernet segments configured on this switch's PortChannels. */
export function localEss(device: Device): LocalEs[] {
  if (!isSwitch(device.type)) return [];
  const st = peekFeatureState<Record<string, unknown>>(device, "cp_evpn_mh");
  return ((st?.es as Row[] | undefined) ?? [])
    .filter(Boolean)
    .map((r) => {
      const iface = interfaceByName(device, r.ifname);
      const esi = r.esi === "auto-system-mac" ? (iface ? esiType3(iface.mac, Number(r.ifname.replace(/\D/g, "")) || 0) : "") : r.esi;
      return { ifname: r.ifname, esi, dfPref: Number(r.df_pref) || DF_PREF_DEFAULT, iface, up: !!iface && iface.adminState === "up" && iface.operState === "up" };
    })
    .filter((e) => /^([0-9a-f]{2}:){9}[0-9a-f]{2}$/.test(e.esi));
}

export function esOfIface(device: Device, iface: NetInterface): LocalEs | undefined {
  return localEss(device).find((e) => e.iface?.id === iface.id);
}

export function esPeers(device: Device, esi: string): Record<string, EsPeer> {
  return peekFeatureState<MhRt>(device, "evpn-mh-rt")?.peers[esi] ?? {};
}

/** The VXLAN module hands over what remote VTEPs advertised (type-1 / type-4). */
export function setEsPeers(device: Device, peers: Record<string, Record<string, EsPeer>>): void {
  const cur = peekFeatureState<MhRt>(device, "evpn-mh-rt");
  if (!cur && !Object.keys(peers).length) return;
  featureState<MhRt>(device, "evpn-mh-rt", () => ({ peers: {} })).peers = peers;
}

const ipNum = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);

/** DF election result for a local ES (zebra_evpn_mh.c:1725-1784). */
export function isDf(device: Device, es: LocalEs): boolean {
  const me = vxlanConfig(device)?.sourceIp;
  if (!es.up || !me) return false;
  for (const [ip, p] of Object.entries(esPeers(device, es.esi))) {
    if (!p.esr) continue;
    if (p.alg !== 2) return false; // service carving not supported → stop BUM (zebra_evpn_mh.c:1766-1772)
    if (p.pref > es.dfPref || (p.pref === es.dfPref && ipNum(ip) < ipNum(me))) return false;
  }
  return true;
}

/** Remote VTEPs a MAC on this ES can be reached through (aliasing). */
export function aliasVteps(device: Device, esi: string): string[] {
  return Object.entries(esPeers(device, esi))
    .filter(([, p]) => p.ead)
    .map(([ip]) => ip)
    .sort((a, b) => ipNum(a) - ipNum(b));
}

registerDataPlaneHook({
  id: "evpn-mh",
  allowEgress(_ctx, sw, ingressId, egress, vid, frame) {
    if (!ingressId?.startsWith("vtep:")) return true;
    const es = esOfIface(sw, egress);
    if (!es) return true;
    const dst = normalizeMac(frame.ethernet.dstMac);
    const bum = isBroadcast(dst) || isMulticast(dst) || !sw.macTable.some((e) => e.vlan === vid && normalizeMac(e.mac) === dst && e.interfaceId === egress.id);
    if (!bum) return true;
    if (esPeers(sw, es.esi)[ingressId.slice(5)]) return false; // local bias: the sender serves this ES itself
    return isDf(sw, es);
  },
});
