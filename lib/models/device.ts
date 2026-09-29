/**
 * Device model (spec §5). A device owns interfaces plus the L2/L3 tables the
 * simulation engine reads and mutates.
 */
import { NetInterface } from "./interface";
import { Route } from "./route";
import { Vlan } from "./vlan";

export type DeviceType =
  | "pc"
  | "server"
  | "switch"
  | "router"
  | "firewall"
  | "internet"
  | "dns-server"
  | "dhcp-server"
  | "ntp-server";

/** L3 neighbor cache entry (spec §11, shown by `ip neigh` / `arp`). */
export interface ArpEntry {
  ip: string;
  mac: string;
  interfaceId: string;
  state: "reachable" | "stale" | "incomplete";
}

/** IPv6 neighbor cache entry (NDP — the v6 counterpart of ARP, spec §40). */
export interface NdpEntry {
  ip: string;
  mac: string;
  interfaceId: string;
  state: "reachable" | "stale" | "incomplete";
}

/** L2 forwarding-table entry (spec §7, shown in the MAC table viewer). */
export interface MacEntry {
  mac: string;
  interfaceId: string;
  vlan: number;
}

export interface DeviceConfig {
  hostname: string;
  /** Hosts: default gateway used to build the default route. */
  defaultGateway?: string;
  /** Hosts: IPv6 default gateway (::/0). */
  defaultGateway6?: string;
  /** Switches: configured VLAN database. */
  vlans?: Vlan[];
  /**
   * Generic per-feature config/state store (the simulated CONFIG_DB, task §15).
   * Feature modules stash their state here keyed by feature id, so new features
   * need no model changes. Access via lib/models/feature-state.ts.
   */
  features?: Record<string, unknown>;
}

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  interfaces: NetInterface[];
  routingTable: Route[];
  routingTable6: Route[];
  arpTable: ArpEntry[];
  ndpTable: NdpEntry[];
  macTable: MacEntry[];
  services: string[];
  config: DeviceConfig;
  state: "up" | "down";
  ui: { x: number; y: number };
}

/** Devices that terminate an IP stack (originate/consume L3 traffic). */
export function isHost(type: DeviceType): boolean {
  return (
    type === "pc" ||
    type === "server" ||
    type === "dns-server" ||
    type === "dhcp-server" ||
    type === "ntp-server" ||
    type === "internet"
  );
}

/** Devices that forward IP between interfaces (decrement TTL, re-frame). */
export function isRouter(type: DeviceType): boolean {
  return type === "router" || type === "firewall";
}

/** Devices that switch frames at L2 (MAC learning, flood/forward). */
export function isSwitch(type: DeviceType): boolean {
  return type === "switch";
}

export function findInterface(device: Device, interfaceId: string): NetInterface | undefined {
  return device.interfaces.find((i) => i.id === interfaceId);
}

export function interfaceByName(device: Device, name: string): NetInterface | undefined {
  return device.interfaces.find((i) => i.name === name);
}
