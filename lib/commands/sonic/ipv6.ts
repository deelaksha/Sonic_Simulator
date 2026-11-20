/**
 * IPv6 SONiC feature module (ipvx, spec §40). Config-plane writes to the SAME
 * interface + v6 routing state the packet engine uses, so `config interface ipv6
 * add` makes `ping6` work and populates `show ipv6 route`. `show ipv6 neighbors`
 * lives in arpnd.ts (it reads the NDP cache the engine fills).
 *
 * Shows (FRR 10.3 vtysh, as SONiC's `show ipv6 …` runs vtysh):
 *   show ipv6 route [<prefix>]     zebra_vty.c vty_show_ip_route, IPv6 header
 *                                  from route_types.pl SHOW_ROUTE_V6_HEADER
 *   show ipv6 ospf6 neighbor       lib/protocols/ospf6-show.ts
 *   show ipv6 ospf6 database
 *   show ipv6 ospf6 interface [IF] / show ipv6 ospf6
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { Device, interfaceByName, findInterface, isSwitch } from "../../models/device";
import { isValidIpv6, isValidPrefix6, normalizeIpv6, isLinkLocal6, parseIpv6, networkAddress6 } from "../../models/ipv6";
import { RouteType, routeDistance } from "../../models/route";
import { rebuildConnectedRoutes6 } from "../../models/factory";
import { syncConnected6, linkLocalOf } from "../../protocols/ipv6";
import { frrUptime } from "./frr-route";
import { vrfNames } from "../../models/vrf";
import { Route } from "../../models/route";
import { linkLocalFromMac } from "../../models/ipv6";
import { vrfOf, DEFAULT_VRF } from "../../models/vrf";
import { listVlans } from "../../models/vlan-ops";
import { lagConfigs } from "../../protocols/lacp-daemon";
import { frontPanel, tab } from "./interface";
import { clickGroup } from "./types";
import { natCompare } from "./counters";
import { gridTable } from "./sflow";
import { renderOspf6Neighbors, renderOspf6Database, renderOspf6Interface, renderOspf6Summary } from "../../protocols/ospf6-show";

/**
 * Recompute connected/default v6 routes after an address change without
 * losing protocol routes (OSPFv3, BGP). Switches route too (connected routes
 * on routed ports / SVIs).
 */
function refreshRoutes6(device: Device): void {
  const proto = (device.routingTable6 ?? []).filter((r) => r.type === "ospf" || r.type === "bgp");
  if (!isSwitch(device.type)) {
    rebuildConnectedRoutes6(device);
    device.routingTable6 = [...device.routingTable6.filter((r) => r.type !== "ospf" && r.type !== "bgp"), ...proto];
  }
  syncConnected6(device);
}

function parseCidr6(tok: string | undefined): { address: string; prefix: number } | null {
  if (!tok) return null;
  const i = tok.lastIndexOf("/");
  if (i < 0) return null;
  const address = tok.slice(0, i);
  const prefix = Number(tok.slice(i + 1));
  if (!isValidIpv6(address) || !isValidPrefix6(prefix)) return null;
  return { address: normalizeIpv6(address), prefix };
}

const config: SonicCmd[] = [
  {
    path: ["interface", "ipv6", "add"],
    summary: "Assign an IPv6 address to a port",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = interfaceByName(ctx.device, pos[0]);
      if (!iface) return { output: [err(`config interface ipv6 add: no such interface '${pos[0] ?? ""}'`)] };
      const cidr = parseCidr6(pos[1]);
      if (!cidr) return { output: [err("Usage: config interface ipv6 add <port> <ipv6>/<prefix>")] };
      if (iface.ipv6.some((a) => normalizeIpv6(a.address) === cidr.address)) {
        return { output: [muted(`${iface.name} already has ${cidr.address}/${cidr.prefix}`)] };
      }
      // Global addresses go before any link-local (the primary/source address stays global).
      const ll = iface.ipv6.findIndex((a) => isLinkLocal6(a.address));
      if (ll < 0 || isLinkLocal6(cidr.address)) iface.ipv6.push(cidr);
      else iface.ipv6.splice(ll, 0, cidr);
      refreshRoutes6(ctx.device);
      return { output: [muted(`${cidr.address}/${cidr.prefix} added to ${iface.name}`)] };
    },
  },
  {
    path: ["interface", "ipv6", "del"],
    summary: "Remove an IPv6 address from a port",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = interfaceByName(ctx.device, pos[0]);
      if (!iface) return { output: [err(`config interface ipv6 del: no such interface '${pos[0] ?? ""}'`)] };
      const cidr = parseCidr6(pos[1]);
      if (!cidr) return { output: [err("Usage: config interface ipv6 del <port> <ipv6>/<prefix>")] };
      const before = iface.ipv6.length;
      iface.ipv6 = iface.ipv6.filter((a) => normalizeIpv6(a.address) !== cidr.address);
      if (iface.ipv6.length === before) return { output: [err(`${iface.name} has no address ${cidr.address}`)] };
      refreshRoutes6(ctx.device);
      return { output: [muted(`${cidr.address}/${cidr.prefix} removed from ${iface.name}`)] };
    },
  },
];

/**
 * scripts/ipintutil (`show ip interfaces` / `show ipv6 interfaces`): every interface with an
 * address of the family, natsorted, one row per address (natsorted), Master = the VRF the
 * kernel enslaves it to, BGP Neighbor / Neighbor IP from BGP_NEIGHBOR local_addr (N/A).
 * The kernel's EUI-64 link-local is listed with the IPv6 addresses.
 */
export function ipintutil(ctx: CommandContext, af: "ipv4" | "ipv6"): OutputLine[] {
  const d = ctx.device;
  const rows: string[][] = [];
  for (const i of [...d.interfaces].sort((a, b) => natCompare(a.name, b.name))) {
    const addrs = (af === "ipv4" ? i.ipv4 : i.ipv6).map((a) => `${a.address}/${a.prefix}`);
    if (!addrs.length) continue;
    if (af === "ipv6" && !i.ipv6.some((a) => isLinkLocal6(a.address))) addrs.push(`${linkLocalFromMac(i.mac)}/64`);
    addrs.sort(natCompare);
    const vrf = vrfOf(d, i);
    rows.push([i.name, vrf === DEFAULT_VRF ? "" : vrf, addrs[0], `${i.adminState}/${i.operState}`, "N/A", "N/A"]);
    for (const a of addrs.slice(1)) rows.push(["", "", a, "", "N/A", "N/A"]);
  }
  return tab(["Interface", "Master", af === "ipv4" ? "IPv4 address/mask" : "IPv6 address/mask", "Admin/Oper", "BGP Neighbor", "Neighbor IP"], rows).map((t) => line(t));
}

export const FRR_ROUTE_CODES_V6 = [
  "Codes: K - kernel route, C - connected, L - local, S - static,",
  "       R - RIPng, O - OSPFv3, I - IS-IS, B - BGP, N - NHRP,",
  "       T - Table, v - VNC, V - VNC-Direct, A - Babel, F - PBR,",
  "       f - OpenFabric, t - Table-Direct,",
  "       > - selected route, * - FIB route, q - queued, r - rejected, b - backup",
  "       t - trapped, o - offload failure",
];

const CODE6: Record<RouteType | "local", string> = { connected: "C", local: "L", static: "S", default: "S", ospf: "O", bgp: "B" };

interface Entry6 {
  type: RouteType | "local";
  dest: string;
  prefix: number;
  distance: number;
  metric: number;
  nextHop: string | null;
  ifName: string;
  since: number;
}

/**
 * `show ipv6 route` (FRR 10.3 zebra): every RIB entry, plus the /128 local
 * route of each global address and fe80::/64 per link-local interface, as
 * zebra holds them.
 */
export function renderFrrRoutes6(device: Device, nowMs: number, filter?: { network: string; prefix: number }, vrf = "default", types?: string[]): string[] {
  let all: Entry6[] = [];
  const ifName = (id: string) => findInterface(device, id)?.name ?? id;
  for (const r of device.routingTable6 ?? []) {
    if ((r.vrf ?? "default") !== vrf) continue;
    const e: Entry6 = { type: r.type, dest: r.destination, prefix: r.prefix, distance: routeDistance(r), metric: r.metric, nextHop: r.nextHop, ifName: ifName(r.interfaceId), since: r.installedAtMs ?? nowMs };
    all.push(e);
    if (r.type === "connected") {
      for (const a of findInterface(device, r.interfaceId)?.ipv6 ?? []) {
        if (a.prefix < 128 && !isLinkLocal6(a.address) && networkAddress6(a.address, a.prefix) === r.destination && a.prefix === r.prefix)
          all.push({ ...e, type: "local", dest: a.address, prefix: 128 });
      }
    }
  }
  for (const i of device.interfaces) {
    if (i.management || !linkLocalOf(i) || vrfOf(device, i) !== vrf) continue;
    const since = (device.routingTable6 ?? []).find((r) => r.type === "connected" && r.interfaceId === i.id)?.installedAtMs ?? nowMs;
    all.push({ type: "connected", dest: "fe80::", prefix: 64, distance: 0, metric: 0, nextHop: null, ifName: i.name, since });
  }
  if (types) all = all.filter((e) => types.includes(e.type === "default" ? "static" : e.type));
  const shown = filter ? all.filter((e) => e.dest === filter.network && e.prefix === filter.prefix) : all;
  const lines = [...FRR_ROUTE_CODES_V6, "", `IPv6 unicast VRF ${vrf}:`];
  const byPrefix = new Map<string, Entry6[]>();
  for (const e of shown) byPrefix.set(`${e.dest}/${e.prefix}`, [...(byPrefix.get(`${e.dest}/${e.prefix}`) ?? []), e]);
  const key = (k: string) => parseIpv6(k.split("/")[0]) ?? 0n;
  const keys = [...byPrefix.keys()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : Number(a.split("/")[1]) - Number(b.split("/")[1])));
  for (const k of keys) {
    const group = byPrefix.get(k)!;
    const best = group.reduce((b, e) => (e.distance < b.distance || (e.distance === b.distance && e.metric < b.metric) ? e : b));
    if (best.type === "connected" && group.filter((e) => e.type === "connected").length > 1) {
      // One zebra route per connected interface (fe80::/64): one selected, the rest FIB-only.
      group.forEach((e, i) => lines.push(`${CODE6[e.type]}${i === 0 ? ">" : " "}* ${k} is directly connected, ${e.ifName}, ${frrUptime(nowMs - e.since)}`));
      continue;
    }
    const bySource = new Map<string, Entry6[]>();
    for (const e of group) bySource.set(`${e.type}/${e.distance}/${e.metric}`, [...(bySource.get(`${e.type}/${e.distance}/${e.metric}`) ?? []), e]);
    for (const [, set] of bySource) {
      const head = set[0];
      const selected = head.type === best.type && head.distance === best.distance && head.metric === best.metric;
      const showDm = head.type !== "connected" && head.type !== "local";
      const prefixText = `${CODE6[head.type]}${selected ? ">" : " "}${selected ? "*" : " "} ${k}${showDm ? ` [${head.distance}/${head.metric}]` : ""}`;
      set.forEach((e, i) => {
        const w = showDm ? ", weight 1" : "";
        const nh = e.nextHop ? ` via ${e.nextHop}, ${e.ifName}${w}` : ` is directly connected, ${e.ifName}${w}`;
        const lead = i === 0 ? prefixText : `  ${selected ? "*" : " "}${" ".repeat(Math.max(1, prefixText.length - 3))}`;
        lines.push(`${lead}${nh}, ${frrUptime(nowMs - e.since)}`);
      });
    }
  }
  return lines;
}

/** `show ipv6 route [vrf <name>|all] [summary | <proto> | nexthop-group | verbose | <addr> | <prefix>]` (ipv6.xml:598). */
function showIpv6Route(args: string[], ctx: CommandContext): OutputLine[] {
  let filter: { network: string; prefix: number } | undefined;
  let p = positional(args).filter((x) => x !== "verbose");
  let vrfs = ["default"];
  if (p[0] === "vrf") {
    if (!p[1]) return [err("% VRF name required")];
    const known = ["default", ...vrfNames(ctx.device).filter((v) => v !== "default")];
    if (p[1] !== "all" && !known.includes(p[1])) return [err(`% VRF ${p[1]} not found`)];
    vrfs = p[1] === "all" ? known : [p[1]];
    p = p.slice(2);
  }
  const tok = p[0];
  if (tok === "summary" || (tok === "not-installed" && p[1] === "summary")) {
    // show_ip_route_summary_rpc.j2 (shared with IPv4)
    return vrfs.flatMap((v, i) => {
      const counts = new Map<string, number>();
      if (tok === "summary") for (const r of ctx.device.routingTable6 ?? []) if ((r.vrf ?? "default") === v) { const t = r.type === "default" ? "static" : r.type === "ospf" ? "ospf6" : r.type; counts.set(t, (counts.get(t) ?? 0) + 1); }
      const total = [...counts.values()].reduce((s, n) => s + n, 0);
      return [
        `Route Source         Routes               FIB  (vrf ${v})`,
        ...[...counts].map(([t, n]) => `${t.padEnd(21)}${String(n).padEnd(21)}${String(n).padEnd(18)}`),
        "------",
        `Totals               ${String(total).padEnd(21)}${String(total).padEnd(18)}`,
        ...(i < vrfs.length - 1 ? [" "] : []),
      ].map((t) => line(t));
    });
  }
  const PROTO: Record<string, string> = { static: "static", connected: "connected", bgp: "bgp", ospfv3: "ospf", "attached-host": "attached-host" };
  if (tok && (PROTO[tok] || tok === "not-installed" || tok === "nexthop-group")) {
    const types = tok === "nexthop-group" ? undefined : tok === "not-installed" ? [] : [PROTO[tok]];
    return vrfs.flatMap((v) => renderFrrRoutes6(ctx.device, Date.now(), undefined, v, types).map((t) => line(t)));
  }
  if (tok) {
    const [a, p] = tok.split("/");
    if (!isValidIpv6(a) || (p !== undefined && !isValidPrefix6(Number(p)))) return [err(`% Malformed address: ${tok}`)];
    const prefix = p === undefined ? 128 : Number(p);
    filter = { network: networkAddress6(a, prefix), prefix };
  }
  return vrfs.flatMap((v) => renderFrrRoutes6(ctx.device, Date.now(), filter, v).map((t) => line(t)));
}

// --- Click `show ip` / `show ipv6` group commands (show/main.py:1314-1566) ---------

const IP_CMDS: [string, string][] = [
  ["bgp", "Show IPv4 BGP (Border Gateway Protocol) information"],
  ["fib", "Show IP FIB table"],
  ["interfaces", ""],
  ["prefix-list", "show ip prefix-list"],
  ["protocol", "Show IPv4 protocol information"],
  ["route", "Show IP (IPv4) routing table"],
];
const IPV6_CMDS: [string, string][] = [
  ["bgp", "Show IPv6 BGP (Border Gateway Protocol) information"],
  ["fib", "Show IP FIB table"],
  ["interfaces", ""],
  ["link-local-mode", "show ipv6 link-local-mode"],
  ["prefix-list", "show ip prefix-list"],
  ["protocol", "Show IPv6 protocol information"],
  ["route", "Show IPv6 routing table"],
];

/**
 * scripts/fibshow -4|-6 [-ip <prefix>]: APPL_DB ROUTE_TABLE (what fpmsyncd installed: the
 * selected route per prefix, ECMP next hops comma-joined; connected routes have next hop
 * 0.0.0.0 / ::, IPv6 link-local prefixes are not installed), sorted by key.
 */
function fibshow(ctx: CommandContext, af: "ipv4" | "ipv6", address: string | undefined): OutputLine[] {
  const d = ctx.device;
  const table = af === "ipv4" ? d.routingTable : (d.routingTable6 ?? []);
  const best = new Map<string, Route[]>();
  for (const r of table) {
    if (af === "ipv6" && isLinkLocal6(r.destination)) continue;
    if (findInterface(d, r.interfaceId)?.management) continue; // eth0 routes stay in the kernel
    const key = `${r.vrf && r.vrf !== DEFAULT_VRF ? `VRF-${r.vrf}:` : ""}${r.destination}/${r.prefix}`;
    const cur = best.get(key);
    if (!cur || routeDistance(r) < routeDistance(cur[0])) best.set(key, [r]);
    else if (routeDistance(r) === routeDistance(cur[0])) cur.push(r);
  }
  const rows: string[][] = [];
  for (const key of [...best.keys()].sort()) {
    if (address !== undefined && key !== address) continue;
    const rs = best.get(key)!;
    const vrf = key.startsWith("VRF-") ? key.slice(4, key.indexOf(":")) : "";
    const prefix = key.startsWith("VRF-") ? key.slice(key.indexOf(":") + 1) : key;
    const nh = rs.map((r) => r.nextHop ?? (af === "ipv4" ? "0.0.0.0" : "::")).join(",");
    const ifn = rs.map((r) => findInterface(d, r.interfaceId)?.name ?? "").join(",");
    rows.push([String(rows.length + 1), vrf, prefix, nh, ifn]);
  }
  return [...tab(["No.", "Vrf", "Route", "Nexthop", "Ifname"], rows), `Total number of entries ${rows.length}`].map((t) => line(t));
}

/** FRR 10.3 zebra route types (route_types.txt) as `show ip|ipv6 protocol` lists them. */
const ZEBRA_ROUTE_TYPES = [
  "system", "kernel", "connected", "local", "static", "rip", "ripng", "ospf", "ospf6", "isis", "bgp", "pim", "eigrp", "nhrp", "hsls", "olsr", "table", "ldp",
  "vnc", "vnc-direct", "vnc-rn", "bgp-direct", "bgp-direct-to-nve-groups", "babel", "sharp", "pbr", "bfd", "openfabric", "vrrp", "nhg", "srte", "table-direct",
];

/** zebra_vty.c show_ip_protocol: no `ip protocol <proto> route-map` configured. */
function showProtocol(): OutputLine[] {
  return ["VRF: default", "Protocol                  : route-map", "-------------------------------------", ...[...ZEBRA_ROUTE_TYPES, "any"].map((p) => `${p.padEnd(24)}  : none`)].map((t) => line(t));
}

/** show ipv6 link-local-mode: PORT, PORTCHANNEL, VLAN keys; ipv6_use_link_local_only is never set. */
function linkLocalMode(ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const names = [
    ...frontPanel(d).map((i) => i.name),
    ...lagConfigs(d).map((l) => l.name).sort(natCompare),
    ...listVlans(d).map((v) => `Vlan${v.id}`).sort(natCompare),
  ];
  return gridTable(["Interface Name", "Mode"], names.map((n) => [n, "Disabled"])).map((t) => line(t));
}

/** Interface argument; the KLISH form splits it ("Ethernet 0"). */
const ifArg = (p: string[]) => (p[1] && /^\d/.test(p[1]) ? p[0] + p[1] : p[0]);

const show: SonicCmd[] = [
  { path: ["ipv6", "interfaces"], summary: "IPv6 interface addresses", run: (_a, ctx) => ({ output: ipintutil(ctx, "ipv6") }) },
  { path: ["ipv6", "route"], summary: "IPv6 routing table (FRR)", run: (a, ctx) => ({ output: showIpv6Route(a, ctx) }) },
  { path: ["ipv6", "ospf6", "neighbor"], summary: "OSPFv3 neighbors", run: (_a, ctx) => ({ output: renderOspf6Neighbors(ctx.device, Date.now()).map((t) => line(t)) }) },
  { path: ["ipv6", "ospf6", "database"], summary: "OSPFv3 link-state database", run: (_a, ctx) => ({ output: renderOspf6Database(ctx.device, Date.now()).map((t) => line(t)) }) },
  { path: ["ipv6", "ospf6", "interface"], summary: "OSPFv3 interfaces", run: (a, ctx) => ({ output: renderOspf6Interface(ctx.device, Date.now(), ifArg(positional(a))).map((t) => line(t)) }) },
  { path: ["ipv6", "ospf6"], summary: "OSPFv3 instance summary", run: (_a, ctx) => ({ output: renderOspf6Summary(ctx.device, Date.now()).map((t) => line(t)) }) },
  clickGroup(["ip"], "Show IP (IPv4) commands", IP_CMDS),
  clickGroup(["ipv6"], "Show IPv6 commands", IPV6_CMDS),
  { path: ["ip", "fib"], summary: "Show IP FIB table", run: (a, ctx) => ({ output: fibshow(ctx, "ipv4", positional(a)[0]) }) },
  { path: ["ipv6", "fib"], summary: "Show IP FIB table", run: (a, ctx) => ({ output: fibshow(ctx, "ipv6", positional(a)[0]) }) },
  { path: ["ip", "protocol"], summary: "Show IPv4 protocol information", run: () => ({ output: showProtocol() }) },
  { path: ["ipv6", "protocol"], summary: "Show IPv6 protocol information", run: () => ({ output: showProtocol() }) },
  { path: ["ipv6", "link-local-mode"], summary: "show ipv6 link-local-mode", run: (_a, ctx) => ({ output: linkLocalMode(ctx) }) },
];

export const ipv6Module: SonicFeatureModule = { id: "ipvx", config, show };
