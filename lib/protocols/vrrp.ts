/**
 * VRRP shared model: configuration (features.vrrp, written by the Click/KLISH
 * layers) and the LIVE protocol state kept by the running daemon
 * (features["vrrpd"], lib/protocols/vrrp-daemon.ts — a model of FRR vrrpd,
 * which is what SONiC runs: sonic-swss/cfgmgr/vrrpmgr.cpp creates the macvlan,
 * frrcfgd renders CONFIG_DB VRRP rows into vrrpd config, and `show vrrp` is
 * `vtysh -c "show vrrp"`, sonic-utilities/show/main.py:1210-1216).
 *
 * Every data-plane question ("does this box own the VIP / the virtual MAC right
 * now?") is answered from the daemon's FSM state, never from a static election:
 * only an instance whose FSM is in Master — on an interface that is still up —
 * answers ARP for the VIP, accepts frames to 00:00:5E:00:01:<VRID> and replies
 * to pings to the VIP. A Backup stays silent (in SONiC its macvlan is protodown,
 * vrrp.c:1412-1431 vrrp_change_state_backup).
 *
 * The exports used by the frozen engine (router.ts, arp.ts, simulation.ts) keep
 * their historical signatures; the NetworkState argument is no longer needed for
 * the answer (the state is per device) but is kept for compatibility.
 *
 * One (interface, VRID) is one FRR vrrp_vrouter carrying an IPv4 and an IPv6
 * vrrp_router (vrrp.h:260-290; frrcfgd maps the VRRP and VRRP6 CONFIG_DB rows onto
 * it, frrcfgd.py:3580-3611): priority, interval, preempt, version and shutdown are
 * shared; each family has its own VIPs, FSM, virtual MAC (00:00:5E:00:01:VRID /
 * 00:00:5E:00:02:VRID, vrrp.c:66-79) and statistics. IPv6 needs version 3
 * (vrrp.c:331-332).
 *
 * Interface tracking (VRRP_TRACK / VRRP6_TRACK rows: Click `config interface
 * vrrp[6] track_interface add <if> <vrid> <track_if> <10-50>`, KLISH
 * `track-interface <if> weight <n>`): nothing in this tree consumes those tables
 * (FRR vrrpd has no tracking); the simulator follows the Broadcom/Dell Enterprise
 * SONiC behaviour the KLISH grammar comes from — every tracked interface that is
 * oper down lowers the priority advertised by that family by its weight (never
 * below 1; an address owner stays at 255).
 */
import { Device } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { NetworkState } from "../models/topology";
import { peekFeatureState } from "../models/feature-state";
import { normalizeIpv6 } from "../models/ipv6";

export interface VrrpTrack {
  iface: string;
  weight: number;
}

export interface VrrpInstance {
  iface: string;
  vrid: number;
  vip?: string;
  /** IPv6 virtual addresses (VRRP6 row 'vip', max 4, config/main.py:6976-6990). */
  vips6?: string[];
  /** VRRP6 row exists (`config interface vrrp6 add`, KLISH address-family ipv6). */
  v6?: boolean;
  /** VRRP_TRACK / VRRP6_TRACK rows. */
  track?: VrrpTrack[];
  track6?: VrrpTrack[];
  priority?: number;
  preempt?: boolean;
  version?: number;
  /** Advertisement interval in ms (FRR vrrpd keeps centiseconds; default 1000 ms). */
  advInterval?: number;
  /** `shutdown` in the VRRP sub-mode (FRR `vrrp <vrid> shutdown`). */
  shutdown?: boolean;
}
export interface VrrpConfig {
  instances: VrrpInstance[];
}

/** Defaults: FRR vrrpd vrrp.h:39-44 and sonic-yang-models sonic-vrrp.yang:103-142. */
export const VRRP_DEFAULTS = { priority: 100, advIntervalMs: 1000, preempt: true, version: 3, accept: true } as const;
export const VRRP_PRIO_MASTER = 255; // vrrp.h:26
export const VRRP_GROUP = "224.0.0.18"; // vrrp.h:27
export const VRRP_PROTO = 112;

export type VrrpFsmState = "Initialize" | "Backup" | "Master";
export type VrrpFamily = "v4" | "v6";
export const VRRP_GROUP6 = "ff02::12"; // vrrp.h:28

/** Live per-instance protocol state (FRR struct vrrp_router, v4 only). */
export interface VrrpRuntime {
  state: VrrpFsmState;
  /** Absolute wall-clock ms of the Adver_Timer (Master) / Master_Down_Timer (Backup). */
  advertAt?: number;
  masterDownAt?: number;
  /** Master_Adver_Interval in centiseconds (RFC 5798 §6.1; 0 when not learned). */
  masterAdverInterval: number;
  /** Source address of the last accepted advertisement (the current Master). */
  masterIp?: string;
  adverTx: number;
  adverRx: number;
  garpTx: number;
  transitions: number;
  /** Instance as last run (needed to send priority 0 after the config row is deleted). */
  last: VrrpInstance;
}
export interface VrrpdState {
  routers: Record<string, VrrpRuntime>;
}
export const VRRP_RT = "vrrpd";

/** IANA virtual MAC: 00-00-5E-00-01-{VRID} (IPv4) / 00-00-5E-00-02-{VRID} (IPv6), vrrp.c:66-79. */
export function vrrpMac(vrid: number, fam: VrrpFamily = "v4"): string {
  return `00:00:5E:00:0${fam === "v6" ? 2 : 1}:${(vrid & 0xff).toString(16).padStart(2, "0").toUpperCase()}`;
}

export const vrrpKey = (iface: string, vrid: number, fam: VrrpFamily = "v4") => `${iface}|${vrid}${fam === "v6" ? "|v6" : ""}`;

export function instancesOf(device: Device): VrrpInstance[] {
  return peekFeatureState<VrrpConfig>(device, "vrrp")?.instances ?? [];
}

export function runtimeOf(device: Device, iface: string, vrid: number, fam: VrrpFamily = "v4"): VrrpRuntime | undefined {
  return peekFeatureState<VrrpdState>(device, VRRP_RT)?.routers[vrrpKey(iface, vrid, fam)];
}

export const advIntervalCs = (inst: VrrpInstance) => Math.round((inst.advInterval ?? VRRP_DEFAULTS.advIntervalMs) / 10);
export const versionOf = (inst: VrrpInstance) => inst.version ?? VRRP_DEFAULTS.version;
export const preemptOf = (inst: VrrpInstance) => inst.preempt ?? VRRP_DEFAULTS.preempt;
export const priorityOf = (inst: VrrpInstance) => inst.priority ?? VRRP_DEFAULTS.priority;

/**
 * Carrier of the interface VRRP runs on. A switch SVI (VlanN) is up while the
 * SVI is admin-up and at least one bridge port in VLAN N is up — the Linux
 * bridge's carrier rule; any other interface needs admin + oper up.
 */
export function vrrpIfaceUp(device: Device, iface: NetInterface): boolean {
  if (device.state === "down" || iface.adminState !== "up") return false;
  const m = iface.logical ? /^Vlan(\d+)$/.exec(iface.name) : null;
  if (!m) return iface.operState === "up";
  const vid = Number(m[1]);
  return device.interfaces.some(
    (p) =>
      !p.management &&
      (!p.logical || p.name.startsWith("PortChannel")) &&
      p.adminState === "up" &&
      p.operState === "up" &&
      (p.vlan.mode === "access" ? p.vlan.accessVlan === vid : p.vlan.allowedVlans.includes(vid)),
  );
}

/**
 * The interface a family's router runs on, if it can run now (vrrp_attach_interface /
 * vrrp_startup preconditions, vrrp.c:300-370): up, not shut, has VIPs; IPv4 needs a
 * primary address, IPv6 needs VRRPv3.
 */
export function liveIface(device: Device, inst: VrrpInstance, fam: VrrpFamily = "v4"): NetInterface | undefined {
  if (inst.shutdown) return undefined;
  if (fam === "v4" ? !inst.vip : !inst.vips6?.length || versionOf(inst) !== 3) return undefined;
  const iface = device.interfaces.find((i) => i.name === inst.iface);
  if (!iface || (fam === "v4" && !primaryIpv4(iface)) || !vrrpIfaceUp(device, iface)) return undefined;
  return iface;
}

/** Address owner: a VIP is configured on the interface itself (vrrp.c:118 vrrp_is_owner). */
export function isOwner(iface: NetInterface, inst: VrrpInstance, fam: VrrpFamily = "v4"): boolean {
  if (fam === "v6") return (inst.vips6 ?? []).some((v) => iface.ipv6.some((a) => normalizeIpv6(a.address) === normalizeIpv6(v)));
  return !!inst.vip && iface.ipv4.some((a) => a.address === inst.vip);
}

/** Total weight of this family's tracked interfaces that are down (see header). */
export function trackPenalty(device: Device, inst: VrrpInstance, fam: VrrpFamily = "v4"): number {
  let p = 0;
  for (const t of (fam === "v6" ? inst.track6 : inst.track) ?? []) {
    const ti = device.interfaces.find((i) => i.name === t.iface);
    if (!ti || !vrrpIfaceUp(device, ti)) p += t.weight;
  }
  return p;
}

/**
 * Priority the router advertises: 255 for the address owner (vrrp.c:1580-1583),
 * else the configured one minus the weights of tracked interfaces that are down.
 */
export function effectivePriority(device: Device, iface: NetInterface, inst: VrrpInstance, fam: VrrpFamily = "v4"): number {
  if (isOwner(iface, inst, fam)) return VRRP_PRIO_MASTER;
  return Math.max(1, priorityOf(inst) - trackPenalty(device, inst, fam));
}

/**
 * Skew_Time and Master_Down_Interval in centiseconds, exactly as
 * vrrp_recalculate_timers (vrrp.c:87-96): v3 skew = ((256-prio) × Master_Adver_Interval)/256,
 * v2 skew = ((256-prio) × 100)/256 (i.e. (256-prio)/256 s); MDI = 3 × interval + skew,
 * where interval is Master_Adver_Interval (v3) or the configured interval (v2).
 */
export function vrrpTimers(inst: VrrpInstance, masterAdverInterval: number): { skew: number; mdi: number } {
  const v3 = versionOf(inst) === 3;
  const mdiadv = v3 ? masterAdverInterval : advIntervalCs(inst);
  const skm = v3 ? masterAdverInterval : 100;
  const skew = Math.floor(((256 - priorityOf(inst)) * skm) / 256);
  return { skew, mdi: 3 * mdiadv + skew };
}

/** True while this instance's family router is Master on an interface that is still up. */
export function liveMaster(device: Device, inst: VrrpInstance, fam: VrrpFamily = "v4"): boolean {
  return runtimeOf(device, inst.iface, inst.vrid, fam)?.state === "Master" && !!liveIface(device, inst, fam);
}

/** VIP+vMAC+iface entries this device is currently Master for. */
export function masteredVips(_state: NetworkState, device: Device): { vip: string; vrid: number; vmac: string; iface: string }[] {
  return instancesOf(device)
    .filter((i) => liveMaster(device, i))
    .map((i) => ({ vip: i.vip!, vrid: i.vrid, vmac: vrrpMac(i.vrid), iface: i.iface }));
}

/** True if a frame's dstMac is a virtual MAC this device currently masters. */
export function acceptsVMac(state: NetworkState, device: Device, dstMac: string): boolean {
  return masteredVips(state, device).some((v) => v.vmac.toUpperCase() === dstMac.toUpperCase());
}

/** True if this device is Master for the given VIP (accept mode: ping-to-VIP is answered). */
export function ownsVipAsMaster(state: NetworkState, device: Device, ip: string): boolean {
  return masteredVips(state, device).some((v) => v.vip === ip);
}

/** VRRPv3 IPv6 VIP this device currently masters (accept mode: echo to the VIP is answered). */
export function ownsVip6AsMaster(device: Device, ip: string): boolean {
  const want = normalizeIpv6(ip);
  return instancesOf(device).some((i) => liveMaster(device, i, "v6") && (i.vips6 ?? []).some((v) => normalizeIpv6(v) === want));
}

/** Virtual MAC (either family) accepted on one specific L3 interface (DataPlaneHook.isLocalMac). */
export function isMasterVMacOn(device: Device, iface: NetInterface, mac: string): boolean {
  const m = mac.toUpperCase();
  return instancesOf(device).some(
    (i) => i.iface === iface.name && ((vrrpMac(i.vrid) === m && liveMaster(device, i)) || (vrrpMac(i.vrid, "v6") === m && liveMaster(device, i, "v6"))),
  );
}

interface Contender { device: Device; iface: NetInterface; inst: VrrpInstance }

/** The device currently acting as Master for a VIP (from the live FSMs), if any. */
export function electMaster(state: NetworkState, vip: string): Contender | undefined {
  const masters: Contender[] = [];
  for (const device of Object.values(state.devices)) {
    for (const inst of instancesOf(device)) {
      if (inst.vip !== vip || !liveMaster(device, inst)) continue;
      masters.push({ device, iface: liveIface(device, inst)!, inst });
    }
  }
  masters.sort((a, b) => effectivePriority(b.device, b.iface, b.inst) - effectivePriority(a.device, a.iface, a.inst));
  return masters[0];
}

export function isMasterForVip(state: NetworkState, device: Device, vip: string): boolean {
  return ownsVipAsMaster(state, device, vip);
}

/** VRRP role of a device for a VIP (simulation.ts runVrrp / `vrrp` command). */
export function vrrpRole(_state: NetworkState, device: Device, vip: string): "Master" | "Backup" | "Init" {
  const inst = instancesOf(device).find((i) => i.vip === vip);
  if (!inst || !liveIface(device, inst)) return "Init";
  const st = runtimeOf(device, inst.iface, inst.vrid)?.state;
  return st === "Master" ? "Master" : st === "Backup" ? "Backup" : "Init";
}

/** FSM state name for show commands (vrrp.c:40-44 vrrp_state_names). */
export function fsmState(device: Device, inst: VrrpInstance, fam: VrrpFamily = "v4"): VrrpFsmState {
  return runtimeOf(device, inst.iface, inst.vrid, fam)?.state ?? "Initialize";
}

/**
 * Link-local source of the IPv6 router: the macvlan's own link-local, which
 * vrrpmgr makes random (`addrgenmode random`, sonic-swss cfgmgr/vrrpmgr.cpp:560-563)
 * so Master and Backup never share the vMAC-derived one. Deterministic here:
 * fe80:: + an interface id hashed from device, interface and VRID.
 */
export function vrrpLinkLocal6(device: Device, inst: VrrpInstance): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of `${device.id}/${inst.iface}/${inst.vrid}`) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch.charCodeAt(0), 0x5bd1e995) >>> 0;
  }
  const w = [h1 >>> 16, h1 & 0xffff, h2 >>> 16, h2 & 0xffff].map((x) => x.toString(16));
  w[0] = ((parseInt(w[0], 16) & 0xfdff) >>> 0).toString(16); // random IIDs clear the U/L bit
  return `fe80::${w.join(":")}`;
}
