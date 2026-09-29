/**
 * Network interface model (spec §6). Physical/logical port on a device.
 * Connectivity itself lives in the topology's connection list; `connectedTo`
 * is a denormalized cache the engine keeps in sync for fast peer lookup.
 */
import { Ipv4Addr } from "./ip";
import { Ipv6Addr, normalizeIpv6 } from "./ipv6";
import { InterfaceVlanConfig, defaultVlanConfig } from "./vlan";

export type AdminState = "up" | "down";
export type OperState = "up" | "down";
export type Duplex = "full" | "half";

export interface InterfaceStats {
  rxFrames: number;
  txFrames: number;
  rxBytes: number;
  txBytes: number;
  rxDropped: number;
  txDropped: number;
}

export interface NetInterface {
  id: string;
  name: string; // "eth0" on hosts, "Ethernet0" on switches
  mac: string;
  /** True for a switch's out-of-band management port (eth0): has an IP but is
   *  not part of the L2 switching fabric and is not cabled on the canvas. */
  management?: boolean;
  /** True for a logical interface created in the CLI (Vlan SVI / Loopback /
   *  PortChannel): configurable + shown, but not a cablable physical port. */
  logical?: boolean;
  ipv4: Ipv4Addr[];
  ipv6: Ipv6Addr[];
  adminState: AdminState;
  operState: OperState;
  speed: number; // Mbps
  duplex: Duplex;
  vlan: InterfaceVlanConfig;
  statistics: InterfaceStats;
  connectedTo?: { deviceId: string; interfaceId: string };
}

export function emptyStats(): InterfaceStats {
  return { rxFrames: 0, txFrames: 0, rxBytes: 0, txBytes: 0, rxDropped: 0, txDropped: 0 };
}

export function createInterface(id: string, name: string, mac: string): NetInterface {
  return {
    id,
    name,
    mac,
    ipv4: [],
    ipv6: [],
    adminState: "up",
    operState: "down", // comes up when a link is attached
    speed: 1000,
    duplex: "full",
    vlan: defaultVlanConfig(),
    statistics: emptyStats(),
  };
}

/** Primary IPv4 address of an interface, if configured. */
export function primaryIpv4(iface: NetInterface): Ipv4Addr | undefined {
  return iface.ipv4[0];
}

/** True when the interface owns the given IPv4 address. */
export function ownsIp(iface: NetInterface, ip: string): boolean {
  return iface.ipv4.some((a) => a.address === ip);
}

/** Primary IPv6 address of an interface, if configured. */
export function primaryIpv6(iface: NetInterface): Ipv6Addr | undefined {
  return iface.ipv6[0];
}

/** True when the interface owns the given IPv6 address (normalized compare). */
export function ownsIp6(iface: NetInterface, ip: string): boolean {
  const target = normalizeIpv6(ip);
  return iface.ipv6.some((a) => normalizeIpv6(a.address) === target);
}
