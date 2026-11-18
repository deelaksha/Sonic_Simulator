/**
 * VXLAN configuration model — the simulated CONFIG_DB tables, stored in the
 * config-plane store "cp_vxlan" that the KLISH VTEP sub-mode writes
 * (lib/commands/sonic-cli/features/vxlan.ts) and the Click `config vxlan ...`
 * commands write (lib/protocols/vxlan-cli.ts):
 *
 *   vteps    VXLAN_TUNNEL|<name>            source_ip (IPv4 or a Loopback name in KLISH)
 *   nvo      VXLAN_EVPN_NVO|<name>          source_vtep
 *   vlanmap  VXLAN_TUNNEL_MAP|<vtep>|map_<vni>_Vlan<vid>   vlan, vni
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
  maps: VxlanMap[];
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
  return { vtep: v.name, sourceIp, sourceIface, nvo, maps };
}

export const vniForVlan = (cfg: VxlanConfig, vid: number) => cfg.maps.find((m) => m.vlan === vid)?.vni;
export const vlanForVni = (cfg: VxlanConfig, vni: number) => cfg.maps.find((m) => m.vni === vni)?.vlan;

/** SONiC's per-VNI kernel netdev for EVPN maps: "<vtep>-<vid>" (vxlanmgr.cpp:601). */
export const vxlanNetdev = (cfg: VxlanConfig, vid: number) => `${cfg.vtep}-${vid}`;
