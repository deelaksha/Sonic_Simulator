/**
 * VRRP (Virtual Router Redundancy Protocol) — gateway redundancy with failover.
 *
 * Reads the SAME per-device config the Click `config vrrp ...` layer writes:
 * device.config.features.vrrp.instances = [{ iface, vrid, vip, priority }]. The
 * highest-priority router with an UP interface is Master and owns the VIP: it
 * answers ARP for the VIP (virtual MAC), replies to pings to the VIP, and
 * forwards LAN traffic to the virtual MAC. If the Master's interface goes down,
 * election recomputes and a Backup takes over the same VIP + virtual MAC.
 * Election is a pure function of live state, so "shut the master" re-elects instantly.
 */
import { Device } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { NetworkState } from "../models/topology";
import { ipToInt } from "../models/ip";

export interface VrrpInstance {
  iface: string;
  vrid: number;
  vip?: string;
  priority?: number;
  preempt?: boolean;
  version?: number;
}
export interface VrrpConfig {
  instances: VrrpInstance[];
}

const DEFAULT_PRIORITY = 100;

/** IANA virtual MAC for a VRRP group: 00-00-5E-00-01-{VRID}. */
export function vrrpMac(vrid: number): string {
  return `00:00:5E:00:01:${(vrid & 0xff).toString(16).padStart(2, "0").toUpperCase()}`;
}

function instancesOf(device: Device): VrrpInstance[] {
  return (device.config.features?.vrrp as VrrpConfig | undefined)?.instances ?? [];
}

interface Contender { device: Device; iface: NetInterface; inst: VrrpInstance }

function contendersFor(state: NetworkState, vip: string): Contender[] {
  const out: Contender[] = [];
  for (const device of Object.values(state.devices)) {
    for (const inst of instancesOf(device)) {
      if (inst.vip !== vip) continue;
      const iface = device.interfaces.find((i) => i.name === inst.iface);
      if (iface) out.push({ device, iface, inst });
    }
  }
  return out;
}

/** Address owner (interface really owns the VIP) advertises priority 255. */
function effectivePriority(c: Contender): number {
  if (c.iface.ipv4.some((a) => a.address === c.inst.vip)) return 255;
  return c.inst.priority ?? DEFAULT_PRIORITY;
}

function live(c: Contender): boolean {
  return c.iface.adminState === "up" && c.iface.operState === "up" && c.device.state !== "down";
}

/** The elected Master for a VIP (highest live priority; tiebreak highest interface IP). */
export function electMaster(state: NetworkState, vip: string): Contender | undefined {
  const up = contendersFor(state, vip).filter(live);
  if (!up.length) return undefined;
  up.sort(
    (a, b) =>
      effectivePriority(b) - effectivePriority(a) ||
      ipToInt(primaryIpv4(b.iface)?.address ?? "0.0.0.0") - ipToInt(primaryIpv4(a.iface)?.address ?? "0.0.0.0"),
  );
  return up[0];
}

export function isMasterForVip(state: NetworkState, device: Device, vip: string): boolean {
  return electMaster(state, vip)?.device.id === device.id;
}

/** VIP+vMAC+iface entries this device is currently Master for. */
export function masteredVips(state: NetworkState, device: Device): { vip: string; vrid: number; vmac: string; iface: string }[] {
  const seen = new Set<string>();
  const out: { vip: string; vrid: number; vmac: string; iface: string }[] = [];
  for (const inst of instancesOf(device)) {
    if (!inst.vip || seen.has(inst.vip)) continue;
    seen.add(inst.vip);
    if (isMasterForVip(state, device, inst.vip)) out.push({ vip: inst.vip, vrid: inst.vrid, vmac: vrrpMac(inst.vrid), iface: inst.iface });
  }
  return out;
}

/** True if a frame's dstMac is a virtual MAC this device currently masters. */
export function acceptsVMac(state: NetworkState, device: Device, dstMac: string): boolean {
  return masteredVips(state, device).some((v) => v.vmac.toUpperCase() === dstMac.toUpperCase());
}

/** True if this device is Master for the given VIP (used for ping-to-VIP local delivery). */
export function ownsVipAsMaster(state: NetworkState, device: Device, ip: string): boolean {
  return masteredVips(state, device).some((v) => v.vip === ip);
}

/** VRRP role of a device for a VIP, for `show vrrp`. */
export function vrrpRole(state: NetworkState, device: Device, vip: string): "Master" | "Backup" | "Init" {
  const c = contendersFor(state, vip).find((x) => x.device.id === device.id);
  if (!c || !live(c)) return "Init";
  return isMasterForVip(state, device, vip) ? "Master" : "Backup";
}
