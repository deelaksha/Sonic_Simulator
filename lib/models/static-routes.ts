/**
 * Next-hop tracking for IPv4 static routes on SONiC switches (FRR staticd +
 * zebra). staticd keeps every configured `ip route`; zebra installs it only
 * while its next hop resolves (zebra_nhg.c nexthop_active — modelled as: a
 * connected route of the route's VRF covers the next hop) and re-evaluates
 * whenever connected routes change, e.g. an address change or an interface
 * moving to another VRF. An unresolved route stays configured (STATIC_ROUTE,
 * `show ip route` prints `S   <prefix> [1/0] via <nh> inactive` —
 * lib/nexthop.c nexthop_vty_helper) but is not in the RIB/FIB.
 *
 * Unresolved routes are parked in feature state (saved with the config), so
 * forwarding, redistribution and kernel views — all reading
 * device.routingTable — never see them.
 */
import { Device, isSwitch } from "./device";
import { Route } from "./route";
import { cidrContains } from "./ip";
import { vrfNames, DEFAULT_VRF } from "./vrf";

const KEY = "static-inactive";

export function inactiveStatics(device: Device): Route[] {
  return (device.config.features?.[KEY] as Route[] | undefined) ?? [];
}

export function setInactiveStatics(device: Device, routes: Route[]): void {
  const f = (device.config.features ??= {});
  if (routes.length) f[KEY] = routes;
  else delete f[KEY];
}

const connectedFor = (table: Route[], nh: string, vrf: string) =>
  table.find((r) => r.type === "connected" && (r.vrf ?? DEFAULT_VRF) === vrf && cidrContains(r.destination, r.prefix, nh));

/** Re-resolve every static route against the connected routes; call after connected routes change. */
export function resolveStatics(device: Device, nowMs = Date.now()): void {
  if (!isSwitch(device.type)) return;
  const parked = inactiveStatics(device);
  if (!parked.length && !device.routingTable.some((r) => r.type === "static")) return;
  const vrfs = vrfNames(device);
  const active: Route[] = [];
  const inactive: Route[] = [];
  for (const r of device.routingTable) {
    if (r.type !== "static" || !r.nextHop) {
      active.push(r);
      continue;
    }
    const c = connectedFor(device.routingTable, r.nextHop, r.vrf ?? DEFAULT_VRF);
    if (c) {
      r.interfaceId = c.interfaceId;
      active.push(r);
    } else inactive.push({ ...r, interfaceId: "" });
  }
  for (const r of parked) {
    if (!vrfs.includes(r.vrf ?? DEFAULT_VRF)) continue; // its VRF was deleted
    const c = connectedFor(active, r.nextHop!, r.vrf ?? DEFAULT_VRF);
    if (c) active.push({ ...r, interfaceId: c.interfaceId, installedAtMs: nowMs });
    else inactive.push(r);
  }
  device.routingTable = active;
  setInactiveStatics(device, inactive);
}
