/**
 * IPv6 SONiC feature module (ipvx, spec §40). Config-plane writes to the SAME
 * interface + v6 routing state the packet engine uses, so `config interface ipv6
 * add` makes `ping6` work and populates `show ipv6 route`. `show ipv6 neighbors`
 * lives in arpnd.ts (it reads the NDP cache the engine fills).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { interfaceByName, findInterface } from "../../models/device";
import { isValidIpv6, isValidPrefix6, normalizeIpv6 } from "../../models/ipv6";
import { rebuildConnectedRoutes6 } from "../../models/factory";

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
      iface.ipv6.push(cidr);
      rebuildConnectedRoutes6(ctx.device);
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
      rebuildConnectedRoutes6(ctx.device);
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

function showIpv6Route(ctx: CommandContext): OutputLine[] {
  const routes = ctx.device.routingTable6 ?? [];
  if (routes.length === 0) return [muted("(no IPv6 routes)")];
  return [...routes]
    .sort((a, b) => b.prefix - a.prefix)
    .map((r) => {
      const iface = findInterface(ctx.device, r.interfaceId);
      const via = r.nextHop ? `via ${r.nextHop}` : "connected";
      return line(`${r.destination}/${r.prefix} ${via} dev ${iface?.name ?? r.interfaceId} (${r.type})`);
    });
}

const show: SonicCmd[] = [
  { path: ["ipv6", "interfaces"], summary: "IPv6 interface addresses", run: (_a, ctx) => ({ output: showIpv6Interfaces(ctx) }) },
  { path: ["ipv6", "route"], summary: "IPv6 routing table", run: (_a, ctx) => ({ output: showIpv6Route(ctx) }) },
];

export const ipv6Module: SonicFeatureModule = { id: "ipvx", config, show };
