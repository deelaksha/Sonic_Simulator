/**
 * VXLAN configuration model — the simulated CONFIG_DB tables, stored in the
 * config-plane store "cp_vxlan" that the KLISH VTEP sub-mode writes
 * (lib/commands/sonic-cli/features/vxlan.ts) and the Click `config vxlan ...`
 * commands write (lib/protocols/vxlan-cli.ts):
 *
 *   vteps    VXLAN_TUNNEL|<name>            source_ip (IPv4 or a Loopback name in KLISH)
 *   nvo      VXLAN_EVPN_NVO|<name>          source_vtep
 *   vlanmap  VXLAN_TUNNEL_MAP|<vtep>|map_<vni>_Vlan<vid>   vlan, vni
 *   vrfmap   VRF|<vrf> vni                  the L3 VNI of a tenant VRF (KLISH `map vni N vrf V`,
 *                                           Click `config vrf add_vrf_vni_map`, config/main.py:7387)
 *   suppress SUPPRESS_VLAN_NEIGH|Vlan<vid>  suppress=on (KLISH interface.xml:1142 `neigh-suppress`)
 *   bgpvrf   `router bgp <as> vrf <vrf>` + l2vpn evpn `advertise ipv4 unicast` (type-5)
 *
 * An L3 VNI also has a VLAN map (sonic-utilities refuses add_vrf_vni_map without one,
 * config/main.py:7410 "VLAN VNI not mapped"); its SVI VlanN is bound to the VRF and
 * its MAC is the router MAC (zebra zl3vni_rmac2str: the SVI's MAC).
 *
 * SONiC allows one VTEP per switch (sonic-utilities config/vxlan.py:43
 * "VTEP already configured."). EVPN control of the tunnels needs the NVO
 * (vxlanorch EVPN_NVO table, sonic-utilities show/vxlan.py interface).
 */
import { Device, interfaceByName } from "../models/device";
import { peekFeatureState } from "../models/feature-state";

type Row = Record<string, string>;

export interface VxlanMap {
  vlan: number;
  vni: number;
}

export interface VxlanConfig {
  vtep: string;
  /** Resolved source IPv4 (Loopback name → its address), "" when unset. */
  sourceIp: string;
  /** The Loopback whose /32 is the source IP (show vxlan interface). */
  sourceIface?: string;
  nvo?: string;
  /** VLAN↔VNI maps (L2 and L3 VNIs alike, as in VXLAN_TUNNEL_MAP). */
  maps: VxlanMap[];
  /** VRF → L3 VNI. */
  vrfMaps: { vrf: string; vni: number }[];
  /** VLANs with ARP/ND suppression on. */
  suppress: number[];
  /** VRFs whose BGP instance advertises IPv4 unicast as EVPN type-5. */
  advertiseIpv4: string[];
}

const isIpv4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

function rows(device: Device, key: string): Row[] {
  const st = peekFeatureState<Record<string, unknown>>(device, "cp_vxlan");
  return ((st?.[key] as Row[] | undefined) ?? []).filter(Boolean);
}

/** The switch's VTEP config, or undefined when no VTEP is configured. */
export function vxlanConfig(device: Device): VxlanConfig | undefined {
  const v = rows(device, "vteps")[0];
  if (!v) return undefined;
  const src = v.source_ip ?? "";
  let sourceIp = "";
  let sourceIface: string | undefined;
  if (isIpv4(src)) {
    sourceIp = src;
    sourceIface = device.interfaces.find((i) => /^Loopback/.test(i.name) && i.ipv4.some((a) => a.address === src && a.prefix === 32))?.name;
  } else if (src) {
    const lo = interfaceByName(device, src.replace(/\s+/g, ""));
    sourceIp = lo?.ipv4[0]?.address ?? "";
    sourceIface = lo?.name;
  }
  const nvo = rows(device, "nvo").find((n) => n.source_vtep === v.name)?.name;
  const maps = rows(device, "vlanmap")
    .map((m) => ({ vlan: Number(String(m.vlan).replace(/^Vlan/, "")), vni: Number(m.vni) }))
    .filter((m) => Number.isInteger(m.vlan) && Number.isInteger(m.vni));
  const vrfMaps = rows(device, "vrfmap")
    .map((m) => ({ vrf: m.vrf, vni: Number(m.vni) }))
    .filter((m) => m.vrf && Number.isInteger(m.vni) && m.vni > 0);
  const suppress = rows(device, "suppress")
    .filter((r) => r.suppress === "on")
    .map((r) => Number(String(r.name).replace(/^Vlan/, "")));
  const advertiseIpv4 = rows(device, "bgpvrf")
    .filter((r) => r.advertise_ipv4 === "true")
    .map((r) => r.vrf);
  return { vtep: v.name, sourceIp, sourceIface, nvo, maps, vrfMaps, suppress, advertiseIpv4 };
}

/** VNIs that are L3 VNIs (mapped to a VRF). */
export const isL3Vni = (cfg: VxlanConfig, vni: number) => cfg.vrfMaps.some((m) => m.vni === vni);
/** The L2 VNI maps (VLAN extensions), L3 VNI maps excluded. */
export const l2Maps = (cfg: VxlanConfig) => cfg.maps.filter((m) => !isL3Vni(cfg, m.vni));

export const vniForVlan = (cfg: VxlanConfig, vid: number) => cfg.maps.find((m) => m.vlan === vid)?.vni;
export const vlanForVni = (cfg: VxlanConfig, vni: number) => cfg.maps.find((m) => m.vni === vni)?.vlan;

/** SONiC's per-VNI kernel netdev for EVPN maps: "<vtep>-<vid>" (vxlanmgr.cpp:601). */
export const vxlanNetdev = (cfg: VxlanConfig, vid: number) => `${cfg.vtep}-${vid}`;
