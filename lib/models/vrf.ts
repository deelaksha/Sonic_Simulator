/**
 * VRF membership for the forwarding engine. The VRF config module
 * (lib/commands/sonic/vrf.ts, CONFIG_DB VRF + INTERFACE vrf_name) is the source
 * of truth; the engine only asks "which VRF is this interface in?".
 */
import { Device } from "./device";
import { NetInterface } from "./interface";

export const DEFAULT_VRF = "default";

interface VrfState {
  vrfs: { name: string; interfaces: string[] }[];
}

export function vrfOf(device: Device, iface: NetInterface | undefined): string {
  if (!iface) return DEFAULT_VRF;
  const st = device.config.features?.vrf as VrfState | undefined;
  return st?.vrfs.find((v) => v.interfaces.includes(iface.name))?.name ?? DEFAULT_VRF;
}

export function vrfNames(device: Device): string[] {
  const st = device.config.features?.vrf as VrfState | undefined;
  return [DEFAULT_VRF, ...(st?.vrfs.map((v) => v.name) ?? [])];
}

/**
 * Does any interface in `vrf` own `ip`? (local delivery is per VRF). An
 * admin-down interface's addresses are not local any more (Linux flushes their
 * local routes on NETDEV_DOWN, fib_disable_ip).
 */
export function ownsIpInVrf(device: Device, ip: string, vrf: string): boolean {
  return device.interfaces.some((i) => i.adminState === "up" && vrfOf(device, i) === vrf && i.ipv4.some((a) => a.address === ip));
}
