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

function showIpv6Interfaces(ctx: CommandContext): OutputLine[] {
  const out = [
    line("Interface      IPv6 address/mask                     Admin/Oper"),
    line("-------------  ------------------------------------  ------------"),
  ];
  let any = false;
  for (const i of ctx.device.interfaces) {
    for (const a of i.ipv6) {
      any = true;
      out.push(line(`${i.name.padEnd(13)}  ${`${a.address}/${a.prefix}`.padEnd(36)}  ${i.adminState}/${i.operState}`));
    }
  }
  if (!any) out.push(muted("(no IPv6 addresses configured)"));
  return out;
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
export function renderFrrRoutes6(device: Device, nowMs: number, filter?: { network: string; prefix: number }): string[] {
  const all: Entry6[] = [];
  const ifName = (id: string) => findInterface(device, id)?.name ?? id;
  for (const r of device.routingTable6 ?? []) {
    if ((r.vrf ?? "default") !== "default") continue;
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
    if (i.management || !linkLocalOf(i)) continue;
    const since = (device.routingTable6 ?? []).find((r) => r.type === "connected" && r.interfaceId === i.id)?.installedAtMs ?? nowMs;
    all.push({ type: "connected", dest: "fe80::", prefix: 64, distance: 0, metric: 0, nextHop: null, ifName: i.name, since });
  }
  const shown = filter ? all.filter((e) => e.dest === filter.network && e.prefix === filter.prefix) : all;
  const lines = [...FRR_ROUTE_CODES_V6, "", "IPv6 unicast VRF default:"];
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

function showIpv6Route(args: string[], ctx: CommandContext): OutputLine[] {
  let filter: { network: string; prefix: number } | undefined;
  const tok = positional(args)[0];
  if (tok) {
    const [a, p] = tok.split("/");
    if (!isValidIpv6(a) || (p !== undefined && !isValidPrefix6(Number(p)))) return [err(`% Malformed address: ${tok}`)];
    const prefix = p === undefined ? 128 : Number(p);
    filter = { network: networkAddress6(a, prefix), prefix };
  }
  return renderFrrRoutes6(ctx.device, Date.now(), filter).map((t) => line(t));
}

/** Interface argument; the KLISH form splits it ("Ethernet 0"). */
const ifArg = (p: string[]) => (p[1] && /^\d/.test(p[1]) ? p[0] + p[1] : p[0]);

const show: SonicCmd[] = [
  { path: ["ipv6", "interfaces"], summary: "IPv6 interface addresses", run: (_a, ctx) => ({ output: showIpv6Interfaces(ctx) }) },
  { path: ["ipv6", "route"], summary: "IPv6 routing table (FRR)", run: (a, ctx) => ({ output: showIpv6Route(a, ctx) }) },
  { path: ["ipv6", "ospf6", "neighbor"], summary: "OSPFv3 neighbors", run: (_a, ctx) => ({ output: renderOspf6Neighbors(ctx.device, Date.now()).map((t) => line(t)) }) },
  { path: ["ipv6", "ospf6", "database"], summary: "OSPFv3 link-state database", run: (_a, ctx) => ({ output: renderOspf6Database(ctx.device, Date.now()).map((t) => line(t)) }) },
  { path: ["ipv6", "ospf6", "interface"], summary: "OSPFv3 interfaces", run: (a, ctx) => ({ output: renderOspf6Interface(ctx.device, Date.now(), ifArg(positional(a))).map((t) => line(t)) }) },
  { path: ["ipv6", "ospf6"], summary: "OSPFv3 instance summary", run: (_a, ctx) => ({ output: renderOspf6Summary(ctx.device, Date.now()).map((t) => line(t)) }) },
];

export const ipv6Module: SonicFeatureModule = { id: "ipvx", config, show };
