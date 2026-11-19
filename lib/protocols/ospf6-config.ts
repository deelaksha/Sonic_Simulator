/**
 * OSPFv3 configuration (FRR ospf6d `router ospf6` + interface `ipv6 ospf6 …`),
 * stored in device.config.features.ospf6. Written by the KLISH handlers in
 * lib/commands/sonic-cli/features/ipv6.ts, read by ospf6-daemon.ts.
 *
 * Defaults are FRR 10.3 ospf6d's: hello 10 s, dead 40 s, retransmit 5 s,
 * priority 1 (ospf6_interface.c ospf6_interface_create), network type
 * broadcast on Ethernet, cost = reference bandwidth 100000 Mb/s / speed
 * rounded, at least 1 (ospf6_interface_get_cost, OSPF6_REFERENCE_BANDWIDTH).
 */
import { Device, isRouter, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { isLinkLocal6 } from "../models/ipv6";
import { peekFeatureState } from "../models/feature-state";
import { vrfOf, DEFAULT_VRF } from "../models/vrf";
import { ospfRouterId } from "./ospf-config";

export interface Ospf6IfParams {
  area?: string;
  cost?: number;
  hello?: number;
  dead?: number;
  priority?: number;
  network?: "point-to-point" | "broadcast";
  passive?: boolean;
}

export interface Ospf6Config {
  routerId?: string;
  /** `log-adjacency-changes [detail]` (default on in the simulator, as OSPFv2). */
  logAdjacencyChanges?: boolean | "detail";
  ifParams: Record<string, Ospf6IfParams>;
}

export const OSPF6_KEY = "ospf6";
export const OSPF6_HELLO_DEFAULT = 10;
export const OSPF6_DEAD_DEFAULT = 40;
export const OSPF6_RXMT_DEFAULT = 5;
export const OSPF6_REF_BW = 100000;

export function ospf6Config(device: Device): Ospf6Config | undefined {
  return peekFeatureState<Ospf6Config>(device, OSPF6_KEY);
}

export function ospf6Capable(device: Device): boolean {
  return isRouter(device.type) || isSwitch(device.type);
}

const isLoopback = (iface: NetInterface) => /^(Loopback|lo)/.test(iface.name);

/** Router ID: configured, else what zebra hands ospf6d (highest loopback, else highest IPv4). */
export function ospf6RouterId(device: Device, cfg: Ospf6Config): string {
  return ospfRouterId(device, { routerId: cfg.routerId, networks: [], areas: [] });
}

export function ospf6Cost(p: Ospf6IfParams, iface: NetInterface): number {
  if (p.cost !== undefined) return p.cost;
  if (isLoopback(iface)) return 0;
  return Math.max(1, Math.floor(OSPF6_REF_BW / (iface.speed || 10000) + 0.5));
}

export interface Ospf6IfSpec {
  iface: NetInterface;
  /** Interface ID carried in Hellos / LSAs (the simulated ifindex). */
  ifIndex: number;
  area: string;
  type: "broadcast" | "point-to-point" | "loopback";
  cost: number;
  hello: number;
  dead: number;
  priority: number;
  passive: boolean;
  /** Global prefixes advertised for the link. */
  prefixes: { address: string; prefix: number }[];
  up: boolean;
}

/** Interfaces with `ipv6 ospf6 area <id>` in the default VRF. */
export function ospf6Interfaces(device: Device, cfg: Ospf6Config): Ospf6IfSpec[] {
  const out: Ospf6IfSpec[] = [];
  device.interfaces.forEach((iface, idx) => {
    const p = cfg.ifParams[iface.name];
    if (!p?.area || iface.management || vrfOf(device, iface) !== DEFAULT_VRF) return;
    const hello = p.hello ?? OSPF6_HELLO_DEFAULT;
    out.push({
      iface,
      ifIndex: idx + 1,
      area: p.area,
      type: isLoopback(iface) ? "loopback" : (p.network ?? "broadcast"),
      cost: ospf6Cost(p, iface),
      hello,
      dead: p.dead ?? (p.hello !== undefined ? 4 * hello : OSPF6_DEAD_DEFAULT),
      priority: p.priority ?? 1,
      passive: !!p.passive,
      prefixes: iface.ipv6.filter((a) => !isLinkLocal6(a.address)).map((a) => ({ address: a.address, prefix: a.prefix })),
      up: iface.adminState === "up" && (iface.operState === "up" || isLoopback(iface)),
    });
  });
  return out;
}
