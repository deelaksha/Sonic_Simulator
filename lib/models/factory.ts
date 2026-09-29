/**
 * Device construction + derived-state helpers.
 *
 * Connected/default routes are DERIVED from interface addressing + the
 * configured gateway. They are rebuilt whenever addressing changes so that
 * `ip route` always reflects reality (spec §61 single source of truth).
 */
import { Device, DeviceType, isHost, isRouter, isSwitch } from "./device";
import { NetInterface, createInterface } from "./interface";
import { generateMac } from "./mac";
import { networkAddress } from "./ip";
import { networkAddress6, isLinkLocal6, sameSubnet6 } from "./ipv6";
import { Route } from "./route";

let macCounter = 1;

/** Reset the global MAC counter (used by tests for determinism). */
export function resetMacCounter(start = 1): void {
  macCounter = start;
}

function nextMac(): string {
  return generateMac(macCounter++);
}

function ifacePrefix(type: DeviceType): string {
  return isSwitch(type) ? "Ethernet" : "eth";
}

function defaultPorts(type: DeviceType): number {
  if (isSwitch(type)) return 4;
  if (isRouter(type)) return 2;
  return 1; // hosts
}

export interface CreateDeviceOptions {
  id: string;
  type: DeviceType;
  name: string;
  x: number;
  y: number;
  ports?: number;
}

export function createDevice(opts: CreateDeviceOptions): Device {
  const ports = opts.ports ?? defaultPorts(opts.type);
  const prefix = ifacePrefix(opts.type);
  const interfaces: NetInterface[] = [];
  for (let i = 0; i < ports; i++) {
    interfaces.push(createInterface(`${opts.id}-if${i}`, `${prefix}${i}`, nextMac()));
  }
  // SONiC switches expose a single out-of-band management port (eth0) that
  // carries the box's management IP. It is not part of the switching fabric.
  if (isSwitch(opts.type)) {
    const mgmt = createInterface(`${opts.id}-mgmt`, "eth0", nextMac());
    mgmt.management = true;
    mgmt.operState = "up";
    mgmt.ipv4 = [{ address: "192.168.100.1", prefix: 24 }];
    interfaces.push(mgmt);
  }
  return {
    id: opts.id,
    name: opts.name,
    type: opts.type,
    interfaces,
    routingTable: [],
    routingTable6: [],
    arpTable: [],
    ndpTable: [],
    macTable: [],
    services: [],
    config: { hostname: opts.name },
    state: "up",
    ui: { x: opts.x, y: opts.y },
  };
}

/**
 * Rebuild connected + default routes for a host/router from its interface
 * addressing and configured gateway. Static routes (added by the user) are
 * preserved. Switches have no IP routing table.
 */
export function rebuildConnectedRoutes(device: Device): void {
  if (!isHost(device.type) && !isRouter(device.type)) {
    device.routingTable = [];
    return;
  }

  const statics = device.routingTable.filter((r) => r.type === "static");
  const derived: Route[] = [];

  for (const iface of device.interfaces) {
    if (iface.operState !== "up" && iface.adminState !== "up") continue;
    for (const addr of iface.ipv4) {
      derived.push({
        destination: networkAddress(addr.address, addr.prefix),
        prefix: addr.prefix,
        nextHop: null,
        interfaceId: iface.id,
        type: "connected",
        metric: 0,
      });
    }
  }

  const gw = device.config.defaultGateway;
  if (gw) {
    // Install the default route via whichever interface owns the gateway's subnet.
    const egress = device.interfaces.find((iface) =>
      iface.ipv4.some((a) => networkAddress(a.address, a.prefix) === networkAddress(gw, a.prefix)),
    );
    if (egress) {
      derived.push({
        destination: "0.0.0.0",
        prefix: 0,
        nextHop: gw,
        interfaceId: egress.id,
        type: "default",
        metric: 1,
      });
    }
  }

  device.routingTable = [...derived, ...statics];
}

/**
 * Rebuild connected + default IPv6 routes from interface addressing + the
 * configured v6 gateway. Link-local (fe80::/10) addresses do not create global
 * routes. Static v6 routes are preserved.
 */
export function rebuildConnectedRoutes6(device: Device): void {
  if (!isHost(device.type) && !isRouter(device.type)) {
    device.routingTable6 = [];
    return;
  }

  const statics = (device.routingTable6 ?? []).filter((r) => r.type === "static");
  const derived: Route[] = [];

  for (const iface of device.interfaces) {
    if (iface.operState !== "up" && iface.adminState !== "up") continue;
    for (const addr of iface.ipv6 ?? []) {
      if (isLinkLocal6(addr.address)) continue;
      derived.push({
        destination: networkAddress6(addr.address, addr.prefix),
        prefix: addr.prefix,
        nextHop: null,
        interfaceId: iface.id,
        type: "connected",
        metric: 0,
      });
    }
  }

  const gw = device.config.defaultGateway6;
  if (gw) {
    const egress = device.interfaces.find((iface) =>
      iface.ipv6.some((a) => sameSubnet6(a.address, gw, a.prefix)),
    );
    if (egress) {
      derived.push({
        destination: "::",
        prefix: 0,
        nextHop: gw,
        interfaceId: egress.id,
        type: "default",
        metric: 1,
      });
    }
  }

  device.routingTable6 = [...derived, ...statics];
}
