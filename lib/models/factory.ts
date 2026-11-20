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
import { Route, carryInstallTime } from "./route";
import { vrfOf, DEFAULT_VRF } from "./vrf";
import { resolveStatics } from "./static-routes";
import { vxlanConfig } from "../protocols/vxlan";

let macCounter = 1;

/** Reset the global MAC counter (used by tests for determinism). */
export function resetMacCounter(start = 1): void {
  macCounter = start;
}

/**
 * Keep the counter past every factory-assigned MAC already in the lab (an
 * imported / restored lab, or devices added before a reset), so later devices
 * never collide. Only factory ports (`<id>-if<n>`, `<id>-mgmt`) count.
 */
export function reserveMacsOf(devices: Device[]): void {
  for (const d of devices) {
    for (const i of d.interfaces) {
      const m = /^02:00:00:([0-9a-f]{2}):([0-9a-f]{2}):([0-9a-f]{2})$/i.exec(i.mac);
      if (m && /-(if\d+|mgmt)$/.test(i.id)) macCounter = Math.max(macCounter, parseInt(m[1] + m[2] + m[3], 16) + 1);
    }
  }
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
  const dev: Device = {
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
  rebuildConnectedRoutes(dev);
  return dev;
}

/**
 * Rebuild connected + default routes for a host/router from its interface
 * addressing and configured gateway. Static routes (added by the user) are
 * preserved. Switches have no IP routing table.
 */
export function rebuildConnectedRoutes(device: Device): void {
  // Switches route too: SONiC installs connected routes for eth0 and every SVI.
  if (!isHost(device.type) && !isRouter(device.type) && !isSwitch(device.type)) {
    device.routingTable = [];
    return;
  }

  if (isSwitch(device.type)) refreshSviOperState(device);

  // Static and protocol-learned (OSPF/BGP) routes survive a connected-route rebuild.
  const statics = device.routingTable.filter((r) => r.type !== "connected" && r.type !== "default");
  const derived: Route[] = [];

  for (const iface of device.interfaces) {
    if (iface.operState !== "up" && iface.adminState !== "up") continue;
    // zebra withdraws the connected route of an operationally down interface
    // (if_down → connected_down): an SVI without an up member, a cabled routed
    // port whose far end is down.
    if (isSwitch(device.type) && !iface.management && (iface.logical ? iface.operState !== "up" : portDown(iface))) continue;
    const vrf = vrfOf(device, iface);
    for (const addr of iface.ipv4) {
      derived.push({
        destination: networkAddress(addr.address, addr.prefix),
        prefix: addr.prefix,
        nextHop: null,
        interfaceId: iface.id,
        type: "connected",
        metric: 0,
        ...(vrf !== DEFAULT_VRF ? { vrf } : {}),
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

  const prev = device.routingTable;
  device.routingTable = [...derived, ...statics];
  carryInstallTime(prev, device.routingTable, Date.now());
  // zebra re-resolves static next hops when connected routes change.
  resolveStatics(device);
}

/**
 * SVI autostate (enabled by default on the device: sonic_cli_vlan.py reports
 * "autostate Enable"): VlanN is operationally up only while at least one of its
 * member ports (access/trunk switchports and PortChannels, not routed ports) is
 * up (see portDown). A VLAN without any member port is left as it is, as is a
 * VLAN mapped to a VXLAN VNI (the VTEP is a bridge member too).
 */
/**
 * A front-panel port counts as down when it is shut or has no carrier — an
 * unplugged port included (zebra: if_is_operative needs the link up, so an
 * address on an unplugged port has no connected route, as on the device).
 */
const portDown = (i: NetInterface) => i.adminState !== "up" || i.operState !== "up";

function refreshSviOperState(device: Device): void {
  const vnis = new Set(vxlanConfig(device)?.maps.map((m) => m.vlan) ?? []);
  for (const svi of device.interfaces) {
    const m = svi.logical ? /^Vlan(\d+)$/.exec(svi.name) : null;
    if (!m) continue;
    const id = Number(m[1]);
    const members = device.interfaces.filter(
      (i) =>
        !i.management &&
        !i.name.includes(".") &&
        !i.ipv4.length &&
        (!i.logical || i.name.startsWith("PortChannel")) &&
        ((i.vlan.mode === "access" && i.vlan.accessVlan === id) || (i.vlan.mode === "trunk" && i.vlan.allowedVlans.includes(id))),
    );
    if (!members.length || vnis.has(id)) {
      if (svi.adminState === "up") svi.operState = "up";
      continue;
    }
    svi.operState = svi.adminState === "up" && members.some((i) => !portDown(i)) ? "up" : "down";
  }
}

/**
 * Rebuild connected + default IPv6 routes from interface addressing + the
 * configured v6 gateway. Link-local (fe80::/10) addresses do not create global
 * routes. Static v6 routes are preserved.
 */
export function rebuildConnectedRoutes6(device: Device): void {
  if (!isHost(device.type) && !isRouter(device.type) && !isSwitch(device.type)) {
    device.routingTable6 = [];
    return;
  }

  const gw = device.config.defaultGateway6;
  // Keep protocol routes (static, OSPFv3, BGP, RA-learned defaults); only the
  // connected routes and the configured-gateway default are derived here.
  const kept = (device.routingTable6 ?? []).filter(
    (r) => r.type !== "connected" && !(r.type === "default" && r.nextHop === gw),
  );
  const derived: Route[] = [];

  for (const iface of device.interfaces) {
    if (iface.operState !== "up" && iface.adminState !== "up") continue;
    if (iface.management && isSwitch(device.type)) continue;
    const vrf = vrfOf(device, iface);
    for (const addr of iface.ipv6 ?? []) {
      if (isLinkLocal6(addr.address)) continue;
      derived.push({
        destination: networkAddress6(addr.address, addr.prefix),
        prefix: addr.prefix,
        nextHop: null,
        interfaceId: iface.id,
        type: "connected",
        metric: 0,
        ...(vrf !== DEFAULT_VRF ? { vrf } : {}),
      });
    }
  }

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

  device.routingTable6 = [...derived, ...kept];
}
