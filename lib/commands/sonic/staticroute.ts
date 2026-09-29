/**
 * Static-route SONiC feature module. Commands are traceable to staticroute.txt.
 * Follows the ./vlan.ts pattern.
 *
 *   config route add prefix <cidr> nexthop <ip>
 *   config route del prefix <cidr> nexthop <ip>
 *   show ip route [<cidr>]
 *
 * The cheatsheet exercises static routes in the FRR/klish `ip route <prefix>
 * <nexthop>` config-mode form (e.g. `ip route 100.1.1.0/24 192.168.200.1`); this
 * module implements the equivalent SONiC click form advertised by config's help.
 * A route added here lands in ctx.device.routingTable and is read by the packet
 * engine via longestPrefixMatch, so it changes real forwarding (spec §9, §61).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { isValidIpv4, isValidPrefix, networkAddress } from "../../models/ip";
import { formatRouteLine } from "../ip";

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

const config: SonicCmd[] = [
  {
    path: ["route", "add"],
    summary: "Add a static route (config route add prefix <cidr> nexthop <ip>)",
    run(args, ctx): CommandResult {
      const cidr = parseCidr(valueAfter(args, "prefix"));
      const nh = valueAfter(args, "nexthop");
      if (!cidr || !nh || !isValidIpv4(nh)) {
        return { output: [err("Usage: config route add prefix <ip/prefix> nexthop <ip>")] };
      }
      // Egress = the interface whose subnet contains the next hop (so it can be ARPed).
      const egress = ctx.device.interfaces.find((i) =>
        i.ipv4.some((a) => networkAddress(a.address, a.prefix) === networkAddress(nh, a.prefix)),
      );
      if (!egress) {
        return { output: [err(`config route: no interface on the subnet of nexthop ${nh}`)] };
      }
      const exists = ctx.device.routingTable.some(
        (r) => r.type === "static" && r.destination === cidr.network && r.prefix === cidr.prefix && r.nextHop === nh,
      );
      if (!exists) {
        ctx.device.routingTable.push({
          destination: cidr.network,
          prefix: cidr.prefix,
          nextHop: nh,
          interfaceId: egress.id,
          type: "static",
          metric: 1,
        });
      }
      return { output: [muted(`route added: ${cidr.network}/${cidr.prefix} nexthop ${nh} dev ${egress.name}`)] };
    },
  },
  {
    path: ["route", "del"],
    summary: "Remove a static route (config route del prefix <cidr> nexthop <ip>)",
    run(args, ctx): CommandResult {
      const cidr = parseCidr(valueAfter(args, "prefix"));
      const nh = valueAfter(args, "nexthop");
      if (!cidr || !nh || !isValidIpv4(nh)) {
        return { output: [err("Usage: config route del prefix <ip/prefix> nexthop <ip>")] };
      }
      const before = ctx.device.routingTable.length;
      ctx.device.routingTable = ctx.device.routingTable.filter(
        (r) => !(r.type === "static" && r.destination === cidr.network && r.prefix === cidr.prefix && r.nextHop === nh),
      );
      const removed = ctx.device.routingTable.length !== before;
      return {
        output: [muted(removed ? `route removed: ${cidr.network}/${cidr.prefix} nexthop ${nh}` : "no matching static route")],
      };
    },
  },
];

function renderRoutes(ctx: CommandContext, filter?: Cidr): OutputLine[] {
  let routes = ctx.device.routingTable;
  if (filter) {
    routes = routes.filter((r) => r.destination === filter.network && r.prefix === filter.prefix);
  }
  if (routes.length === 0) return [muted("(no routes)")];
  // longest prefix first — mirrors `show ip route` ordering.
  return [...routes].sort((a, b) => b.prefix - a.prefix).map((r) => line(formatRouteLine(ctx.device, r)));
}

const show: SonicCmd[] = [
  {
    path: ["ip", "route"],
    summary: "Show the IPv4 routing table (optionally one prefix)",
    run(args, ctx): CommandResult {
      const arg = positional(args)[0];
      if (arg) {
        const cidr = parseCidr(arg);
        if (!cidr) return { output: [err(`show ip route: invalid prefix "${arg}"`)] };
        return { output: renderRoutes(ctx, cidr) };
      }
      return { output: renderRoutes(ctx) };
    },
  },
];

export const staticRouteModule: SonicFeatureModule = { id: "staticroute", config, show };
