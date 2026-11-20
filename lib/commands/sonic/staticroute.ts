/**
 * Static-route SONiC feature module. Commands are traceable to staticroute.txt.
 * Follows the ./vlan.ts pattern.
 *
 *   config route add prefix [vrf <name>] <cidr> nexthop <ip>
 *   config route del prefix [vrf <name>] <cidr> nexthop <ip>
 *   show ip route [vrf <name>|all] [<cidr>]
 *
 * The cheatsheet exercises static routes in the FRR/klish `ip route <prefix>
 * <nexthop>` config-mode form (e.g. `ip route 100.1.1.0/24 192.168.200.1`); this
 * module implements the equivalent SONiC click form advertised by config's help.
 * A route added here lands in ctx.device.routingTable and is read by the packet
 * engine via longestPrefixMatch, so it changes real forwarding (spec §9, §61).
 */
import { renderFrrRoutes, frrRouteLookup, frrRouteSummary } from "./frr-route";
import { vrfOf, vrfNames, DEFAULT_VRF } from "../../models/vrf";
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { isValidIpv4, isValidPrefix, networkAddress } from "../../models/ip";
import { Route } from "../../models/route";
import { isValidIpv6, isValidPrefix6, isLinkLocal6, networkAddress6, normalizeIpv6, contains6 } from "../../models/ipv6";
import { inactiveStatics, setInactiveStatics } from "../../models/static-routes";

interface Cidr {
  network: string; // normalized network address
  prefix: number;
}

/** Parse "<addr>/<prefix>" into a normalized network + prefix, or null. */
function parseCidr(token: string | undefined): Cidr | null {
  if (!token || !token.includes("/")) return null;
  const [addr, p] = token.split("/");
  const prefix = Number(p);
  if (!isValidIpv4(addr) || !isValidPrefix(prefix)) return null;
  return { network: networkAddress(addr, prefix), prefix };
}

/** Token following a keyword, e.g. valueAfter(args, "prefix"). */
function valueAfter(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  return i >= 0 ? args[i + 1] : undefined;
}

/** `prefix vrf <name> <cidr>` → { vrf, cidr }; plain `prefix <cidr>` → default VRF. */
function prefixArg(args: string[]): { vrf: string; cidr: Cidr | null } {
  const i = args.indexOf("prefix");
  if (args[i + 1] === "vrf") return { vrf: args[i + 2] ?? "", cidr: parseCidr(args[i + 3]) };
  return { vrf: DEFAULT_VRF, cidr: parseCidr(args[i + 1]) };
}

/** The `prefix [vrf <name>] <cidr>` token is an IPv6 prefix. */
function isV6Route(args: string[]): boolean {
  const i = args.indexOf("prefix");
  return (args[i + 1] === "vrf" ? args[i + 3] : args[i + 1])?.includes(":") ?? false;
}

/**
 * IPv6 form of `config route add|del` (config/main.py cli_sroute_to_config takes either
 * family; key "[vrf|]<prefix>" in STATIC_ROUTE). The route lands in routingTable6 with
 * the interface whose IPv6 subnet (in that VRF) holds the next hop. Simulator limit: a
 * next hop that is not on a connected IPv6 subnet (link-local next hops included) is
 * rejected instead of being kept inactive as staticd would.
 */
function route6(args: string[], ctx: CommandContext, add: boolean): CommandResult {
  const i = args.indexOf("prefix");
  const vrf = args[i + 1] === "vrf" ? (args[i + 2] ?? "") : DEFAULT_VRF;
  const tok = args[i + 1] === "vrf" ? args[i + 3] : args[i + 1];
  const [addr, len] = (tok ?? "").split("/");
  const prefix = Number(len);
  const nh = valueAfter(args, "nexthop");
  if (!tok?.includes("/") || !isValidIpv6(addr) || !isValidPrefix6(prefix) || !nh || !isValidIpv6(nh)) {
    return { output: [err(`Usage: config route ${add ? "add" : "del"} prefix [vrf <name>] <ip/prefix> nexthop <ip>`)] };
  }
  if (!vrfNames(ctx.device).includes(vrf)) return { output: [err(`config route: VRF ${vrf} does not exist`)] };
  const destination = networkAddress6(addr, prefix);
  const gw = normalizeIpv6(nh);
  const table = (ctx.device.routingTable6 ??= []);
  const match = (r: Route) => r.type === "static" && (r.vrf ?? DEFAULT_VRF) === vrf && r.destination === destination && r.prefix === prefix && r.nextHop === gw;
  if (!add) {
    const removed = table.some(match);
    ctx.device.routingTable6 = table.filter((r) => !match(r));
    return { output: [muted(removed ? `route removed: ${destination}/${prefix} nexthop ${gw}` : "no matching static route")] };
  }
  const egress = ctx.device.interfaces.find(
    (x) => vrfOf(ctx.device, x) === vrf && x.ipv6.some((a) => !isLinkLocal6(a.address) && contains6(networkAddress6(a.address, a.prefix), a.prefix, gw)),
  );
  if (!egress) return { output: [err(`config route: IPv6 next hop ${gw} is not on a connected subnet`)] };
  if (!table.some(match)) {
    table.push({ destination, prefix, nextHop: gw, interfaceId: egress.id, type: "static", metric: 0, installedAtMs: Date.now(), ...(vrf !== DEFAULT_VRF ? { vrf } : {}) });
  }
  return { output: [muted(`route added: ${destination}/${prefix} nexthop ${gw} dev ${egress.name}`)] };
}

const config: SonicCmd[] = [
  {
    path: ["route", "add"],
    summary: "Add a static route (config route add prefix <cidr> nexthop <ip>)",
    run(args, ctx): CommandResult {
      if (isV6Route(args)) return route6(args, ctx, true);
      const { vrf, cidr } = prefixArg(args);
      const nh = valueAfter(args, "nexthop");
      if (!cidr || !nh || !isValidIpv4(nh)) {
        return { output: [err("Usage: config route add prefix [vrf <name>] <ip/prefix> nexthop <ip>")] };
      }
      if (!vrfNames(ctx.device).includes(vrf)) return { output: [err(`config route: VRF ${vrf} does not exist`)] };
      // Egress = the interface (in this VRF) whose subnet contains the next hop.
      const egress = ctx.device.interfaces.find(
        (i) => vrfOf(ctx.device, i) === vrf && i.ipv4.some((a) => networkAddress(a.address, a.prefix) === networkAddress(nh, a.prefix)),
      );
      if (!egress) {
        // FRR keeps a route whose next hop does not resolve, inactive, and installs it later
        // (lib/models/static-routes.ts).
        const parked = inactiveStatics(ctx.device);
        const dup = parked.some((r) => (r.vrf ?? DEFAULT_VRF) === vrf && r.destination === cidr.network && r.prefix === cidr.prefix && r.nextHop === nh);
        if (!dup) {
          setInactiveStatics(ctx.device, [
            ...parked,
            { destination: cidr.network, prefix: cidr.prefix, nextHop: nh, interfaceId: "", type: "static", metric: 0, installedAtMs: Date.now(), ...(vrf !== DEFAULT_VRF ? { vrf } : {}) },
          ]);
        }
        return { output: [muted(`route added: ${cidr.network}/${cidr.prefix} nexthop ${nh} (inactive: nexthop not resolved)`)] };
      }
      const exists = ctx.device.routingTable.some(
        (r) => r.type === "static" && (r.vrf ?? DEFAULT_VRF) === vrf && r.destination === cidr.network && r.prefix === cidr.prefix && r.nextHop === nh,
      );
      if (!exists) {
        ctx.device.routingTable.push({
          destination: cidr.network,
          prefix: cidr.prefix,
          nextHop: nh,
          interfaceId: egress.id,
          type: "static",
          metric: 0, // FRR static routes carry metric 0 ([1/0] in show ip route)
          installedAtMs: Date.now(),
          ...(vrf !== DEFAULT_VRF ? { vrf } : {}),
        });
      }
      return { output: [muted(`route added: ${cidr.network}/${cidr.prefix} nexthop ${nh} dev ${egress.name}`)] };
    },
  },
  {
    path: ["route", "del"],
    summary: "Remove a static route (config route del prefix <cidr> nexthop <ip>)",
    run(args, ctx): CommandResult {
      if (isV6Route(args)) return route6(args, ctx, false);
      const { vrf, cidr } = prefixArg(args);
      const nh = valueAfter(args, "nexthop");
      if (!cidr || !nh || !isValidIpv4(nh)) {
        return { output: [err("Usage: config route del prefix [vrf <name>] <ip/prefix> nexthop <ip>")] };
      }
      const match = (r: Route) =>
        r.type === "static" && (r.vrf ?? DEFAULT_VRF) === vrf && r.destination === cidr.network && r.prefix === cidr.prefix && r.nextHop === nh;
      const before = ctx.device.routingTable.length;
      ctx.device.routingTable = ctx.device.routingTable.filter((r) => !match(r));
      const parked = inactiveStatics(ctx.device);
      setInactiveStatics(ctx.device, parked.filter((r) => !match(r)));
      const removed = ctx.device.routingTable.length !== before || parked.some(match);
      return {
        output: [muted(removed ? `route removed: ${cidr.network}/${cidr.prefix} nexthop ${nh}` : "no matching static route")],
      };
    },
  },
];

/** show_ip_route_summary_rpc.j2: per-VRF "Route Source / Routes / FIB" table with totals. */
function routeSummary(ctx: CommandContext, vrfs: string[], notInstalled: boolean): OutputLine[] {
  const out: string[] = [];
  vrfs.forEach((v, i) => {
    const rows = notInstalled ? [] : frrRouteSummary(ctx.device, Date.now(), v);
    out.push(`Route Source         Routes               FIB  (vrf ${v})`);
    for (const r of rows) out.push(`${r.type.padEnd(21)}${String(r.rib).padEnd(21)}${String(r.fib).padEnd(18)}`);
    out.push("------", `Totals               ${String(rows.reduce((s, r) => s + r.rib, 0)).padEnd(21)}${String(rows.reduce((s, r) => s + r.fib, 0)).padEnd(18)}`);
    if (i < vrfs.length - 1) out.push(" ");
  });
  return out.map((t) => line(t));
}

function renderRoutes(ctx: CommandContext, filter?: Cidr, vrf = DEFAULT_VRF, omitCodes = false): OutputLine[] {
  // FRR zebra format, shared by every route source (lib/commands/sonic/frr-route.ts).
  return renderFrrRoutes(ctx.device, Date.now(), filter, vrf, omitCodes).map((t) => line(t));
}

const show: SonicCmd[] = [
  {
    path: ["ip", "route"],
    summary: "Show the IPv4 routing table (optionally one prefix)",
    run(args, ctx): CommandResult {
      const a = [...args];
      let vrfs = [DEFAULT_VRF];
      const vi = a.indexOf("vrf");
      if (vi >= 0) {
        const name = a[vi + 1];
        if (!name) return { output: [err("show ip route vrf: VRF name required")] };
        if (name !== "all" && !vrfNames(ctx.device).includes(name)) return { output: [err(`% VRF ${name} not found`)] };
        vrfs = name === "all" ? vrfNames(ctx.device) : [name];
        a.splice(vi, 2);
      }
      // KLISH route-cmd (ipv4.xml:19-59): summary | not-installed [summary] | <proto> | nexthop-group | verbose | <ip> | <prefix>
      const p = positional(a).filter((x) => x !== "verbose");
      const arg = p[0];
      if (arg === "summary" || (arg === "not-installed" && p[1] === "summary")) {
        return { output: routeSummary(ctx, vrfs, arg === "not-installed") };
      }
      const PROTO: Record<string, string> = { static: "static", connected: "connected", bgp: "bgp", ospf: "ospf", "attached-host": "attached-host" };
      if (arg && (PROTO[arg] || arg === "not-installed")) {
        // Every route the simulator selects is programmed, so not-installed lists none.
        const types = arg === "not-installed" ? [] : [PROTO[arg]];
        return { output: vrfs.flatMap((v, i) => renderFrrRoutes(ctx.device, Date.now(), undefined, v, i > 0, types).map((t) => line(t))) };
      }
      if (arg === "nexthop-group" || !arg) return { output: vrfs.flatMap((v, i) => renderRoutes(ctx, undefined, v, i > 0)) };
      if (isValidIpv4(arg)) {
        // `show ip route <A.B.C.D>`: the longest-prefix match (zebra rib_match).
        return { output: vrfs.flatMap((v, i) => {
          const hit = frrRouteLookup(ctx.device, Date.now(), arg, v);
          return hit ? renderRoutes(ctx, hit, v, i > 0) : [line("% Network not in table")];
        }) };
      }
      const cidr = parseCidr(arg);
      if (!cidr) return { output: [err(`show ip route: invalid prefix "${arg}"`)] };
      return { output: vrfs.flatMap((v, i) => renderRoutes(ctx, cidr, v, i > 0)) };
    },
  },
];

export const staticRouteModule: SonicFeatureModule = { id: "staticroute", config, show };
