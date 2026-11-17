/**
 * ip (spec §18). Reads and writes the SAME device state the GUI uses, so
 * `ip addr add` / `ip link set` / `ip route add` mutate the one network model
 * and are immediately visible everywhere (spec §60, §61).
 *
 * Supported:
 *   ip addr [show]                       ip addr add <cidr> dev <if>
 *   ip link [show]                       ip addr del <cidr> dev <if>
 *   ip route [show]                      ip link set <if> up|down
 *   ip neigh [show]                      ip route add <cidr|default> via <gw> [dev <if>]
 *                                        ip route del <cidr|default>
 */
import { isPermanent, addStaticArp, deleteArp } from "../protocols/arp";
import { isValidMac, isUnicast, normalizeMac } from "../models/mac";
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { Device, findInterface, interfaceByName } from "../models/device";
import { NetInterface } from "../models/interface";
import { Route } from "../models/route";
import { broadcastAddress, isValidIpv4, isValidPrefix, networkAddress } from "../models/ip";
import { rebuildConnectedRoutes } from "../models/factory";

// ---- formatting shared with other commands ----

export function formatRouteLine(device: Device, r: Route): string {
  const iface = findInterface(device, r.interfaceId);
  const dev = iface ? `dev ${iface.name}` : "";
  if (r.type === "default") return `default via ${r.nextHop} ${dev}`.trim();
  if (r.type === "connected") {
    const src = iface?.ipv4[0]?.address;
    return `${r.destination}/${r.prefix} ${dev} proto kernel scope link${src ? ` src ${src}` : ""}`.trim();
  }
  return `${r.destination}/${r.prefix} via ${r.nextHop} ${dev}`.trim();
}

function showAddr(device: Device, withAddr: boolean): OutputLine[] {
  const out: OutputLine[] = [];
  device.interfaces.forEach((iface, idx) => {
    const flags = ["BROADCAST", "MULTICAST"];
    if (iface.adminState === "up") flags.push("UP");
    if (iface.operState === "up") flags.push("LOWER_UP");
    out.push(line(`${idx + 1}: ${iface.name}: <${flags.join(",")}> mtu 1500 state ${iface.operState.toUpperCase()}`));
    out.push(muted(`    link/ether ${iface.mac} brd ff:ff:ff:ff:ff:ff`));
    if (withAddr) {
      for (const a of iface.ipv4) {
        out.push(line(`    inet ${a.address}/${a.prefix} brd ${broadcastAddress(a.address, a.prefix)} scope global ${iface.name}`));
      }
    }
  });
  return out;
}

function showRoute(device: Device): OutputLine[] {
  if (device.routingTable.length === 0) return [muted("(no routes)")];
  // default routes last, longest prefix first — mirrors typical `ip route` output
  const sorted = [...device.routingTable].sort((a, b) => b.prefix - a.prefix);
  return sorted.map((r) => line(formatRouteLine(device, r)));
}

function showNeigh(device: Device): OutputLine[] {
  if (device.arpTable.length === 0) return [muted("(neighbour table empty)")];
  return device.arpTable.map((e) => {
    const iface = findInterface(device, e.interfaceId);
    const dev = iface ? `dev ${iface.name}` : "";
    if (e.state === "incomplete") return line(`${e.ip} ${dev}  INCOMPLETE`);
    const state = isPermanent(device, e.ip) ? "PERMANENT" : e.state.toUpperCase();
    return line(`${e.ip} ${dev} lladdr ${e.mac.toLowerCase()} ${state}`);
  });
}

// ---- mutating sub-commands ----

function parseCidr(token: string): { address: string; prefix: number } | null {
  const [addr, p] = token.split("/");
  const prefix = Number(p);
  if (!isValidIpv4(addr) || !isValidPrefix(prefix)) return null;
  return { address: addr, prefix };
}

function requireIface(ctx: CommandContext, args: string[]): NetInterface | OutputLine {
  const i = args.indexOf("dev");
  const name = i >= 0 ? args[i + 1] : undefined;
  if (!name) return err("ip: missing 'dev <interface>'");
  const iface = interfaceByName(ctx.device, name);
  if (!iface) return err(`ip: interface "${name}" not found on ${ctx.device.name}`);
  return iface;
}

function addrAdd(ctx: CommandContext, args: string[]): CommandResult {
  const cidr = args.find((a) => a.includes("/"));
  if (!cidr) return { output: [err("Usage: ip addr add <ip>/<prefix> dev <iface>")] };
  const parsed = parseCidr(cidr);
  if (!parsed) return { output: [err(`ip: invalid address "${cidr}"`)] };
  const iface = requireIface(ctx, args);
  if (!("id" in iface)) return { output: [iface] };
  if (iface.ipv4.some((a) => a.address === parsed.address)) {
    return { output: [err(`ip: address ${parsed.address} already assigned`)] };
  }
  iface.ipv4.push(parsed);
  rebuildConnectedRoutes(ctx.device);
  return { output: [muted(`added ${parsed.address}/${parsed.prefix} to ${iface.name}`)] };
}

function addrDel(ctx: CommandContext, args: string[]): CommandResult {
  const cidr = args.find((a) => a.includes("/"));
  if (!cidr) return { output: [err("Usage: ip addr del <ip>/<prefix> dev <iface>")] };
  const parsed = parseCidr(cidr);
  if (!parsed) return { output: [err(`ip: invalid address "${cidr}"`)] };
  const iface = requireIface(ctx, args);
  if (!("id" in iface)) return { output: [iface] };
  iface.ipv4 = iface.ipv4.filter((a) => a.address !== parsed.address);
  rebuildConnectedRoutes(ctx.device);
  return { output: [muted(`removed ${parsed.address}/${parsed.prefix} from ${iface.name}`)] };
}

function linkSet(ctx: CommandContext, args: string[]): CommandResult {
  if (args.length === 0) {
    return { output: [err("Usage: ip link set [dev] <iface> [up|down] [address <mac>]")] };
  }
  let i = 0;
  if (args[i] === "dev") i++;
  const name = args[i++];
  const iface = name ? interfaceByName(ctx.device, name) : undefined;
  if (!iface) return { output: [err(`ip: interface "${name}" not found`)] };

  const msgs: string[] = [];
  while (i < args.length) {
    const token = args[i++];
    if (token === "up" || token === "down") {
      iface.adminState = token;
      iface.operState = token === "up" && iface.connectedTo ? "up" : "down";
      msgs.push(`${iface.name} set ${token}`);
    } else if (token === "address" || token === "addr") {
      const mac = args[i++];
      if (!mac || !isValidMac(mac) || !isUnicast(mac)) {
        return { output: [err(`ip link: invalid unicast MAC address "${mac ?? ""}"`)] };
      }
      iface.mac = normalizeMac(mac);
      msgs.push(`${iface.name} mac set to ${iface.mac}`);
    } else {
      return { output: [err(`ip link set: unknown parameter "${token}"`)] };
    }
  }

  if (msgs.length === 0) {
    return { output: [err("Usage: ip link set [dev] <iface> [up|down] [address <mac>]")] };
  }

  rebuildConnectedRoutes(ctx.device);
  return { output: msgs.map((m) => muted(m)) };
}

function routeAdd(ctx: CommandContext, args: string[]): CommandResult {
  const dest = args[0]; // "default" or "10.0.0.0/8"
  const viaIdx = args.indexOf("via");
  const gw = viaIdx >= 0 ? args[viaIdx + 1] : undefined;
  if (!dest || !gw || !isValidIpv4(gw)) {
    return { output: [err("Usage: ip route add <cidr|default> via <gateway> [dev <iface>]")] };
  }
  let destination = "0.0.0.0";
  let prefix = 0;
  if (dest !== "default") {
    const parsed = parseCidr(dest);
    if (!parsed) return { output: [err(`ip: invalid destination "${dest}"`)] };
    destination = networkAddress(parsed.address, parsed.prefix);
    prefix = parsed.prefix;
  }
  // Choose egress interface: explicit dev, else the one on the gateway's subnet.
  const devIdx = args.indexOf("dev");
  let iface = devIdx >= 0 ? interfaceByName(ctx.device, args[devIdx + 1]) : undefined;
  if (!iface) {
    iface = ctx.device.interfaces.find((i) =>
      i.ipv4.some((a) => networkAddress(a.address, a.prefix) === networkAddress(gw, a.prefix)),
    );
  }
  if (!iface) return { output: [err(`ip: no interface on the subnet of gateway ${gw}`)] };

  if (dest === "default") ctx.device.config.defaultGateway = gw;
  ctx.device.routingTable.push({
    destination,
    prefix,
    nextHop: gw,
    interfaceId: iface.id,
    type: dest === "default" ? "default" : "static",
    metric: 1,
  });
  return { output: [muted(`route added: ${dest} via ${gw} dev ${iface.name}`)] };
}

function routeDel(ctx: CommandContext, args: string[]): CommandResult {
  const dest = args[0];
  if (!dest) return { output: [err("Usage: ip route del <cidr|default>")] };
  if (dest === "default") {
    ctx.device.config.defaultGateway = undefined;
    ctx.device.routingTable = ctx.device.routingTable.filter((r) => r.type !== "default");
    return { output: [muted("default route removed")] };
  }
  const parsed = parseCidr(dest);
  if (!parsed) return { output: [err(`ip: invalid destination "${dest}"`)] };
  const net = networkAddress(parsed.address, parsed.prefix);
  ctx.device.routingTable = ctx.device.routingTable.filter(
    (r) => !(r.destination === net && r.prefix === parsed.prefix && r.type !== "connected"),
  );
  return { output: [muted(`route removed: ${dest}`)] };
}

function neighAddOrReplace(ctx: CommandContext, args: string[], replace = false): CommandResult {
  const ip = args[0];
  if (!ip || !isValidIpv4(ip)) {
    return { output: [err(`Usage: ip neigh ${replace ? "replace" : "add"} <ip> lladdr <mac> dev <iface>`)] };
  }
  const llIdx = args.indexOf("lladdr");
  const mac = llIdx >= 0 ? args[llIdx + 1] : undefined;
  if (!mac || !isValidMac(mac)) {
    return { output: [err(`ip neigh ${replace ? "replace" : "add"}: valid MAC required after 'lladdr'`)] };
  }
  const devIdx = args.indexOf("dev");
  const ifaceName = devIdx >= 0 ? args[devIdx + 1] : undefined;
  const iface = ifaceName ? interfaceByName(ctx.device, ifaceName) : undefined;
  if (!iface) {
    return { output: [err(`ip neigh ${replace ? "replace" : "add"}: valid interface required after 'dev'`)] };
  }
  const existing = ctx.device.arpTable.find((e) => e.ip === ip);
  if (existing && !replace) {
    return { output: [err(`ip neigh add: entry for ${ip} already exists (use replace)`)] };
  }
  addStaticArp(ctx.device, ip, normalizeMac(mac), iface.id, Date.now());
  return { output: [muted(`ip neigh: static neighbour ${ip} is at ${normalizeMac(mac)} dev ${iface.name}`)] };
}

function neighDel(ctx: CommandContext, args: string[]): CommandResult {
  const ip = args[0];
  if (!ip || !isValidIpv4(ip)) {
    return { output: [err("Usage: ip neigh del <ip> [dev <iface>]")] };
  }
  const exists = ctx.device.arpTable.some((e) => e.ip === ip);
  if (!exists) {
    return { output: [err(`ip neigh del: no entry found for ${ip}`)] };
  }
  deleteArp(ctx.device, ip);
  return { output: [muted(`ip neigh: deleted entry for ${ip}`)] };
}

function neighFlush(ctx: CommandContext, args: string[]): CommandResult {
  const devIdx = args.indexOf("dev");
  const ifaceName = devIdx >= 0 ? args[devIdx + 1] : undefined;
  if (ifaceName) {
    const iface = interfaceByName(ctx.device, ifaceName);
    if (!iface) return { output: [err(`ip neigh flush: interface "${ifaceName}" not found`)] };
    const toDelete = ctx.device.arpTable.filter((e) => e.interfaceId === iface.id && !isPermanent(ctx.device, e.ip));
    for (const e of toDelete) deleteArp(ctx.device, e.ip);
    return { output: [muted(`ip neigh: flushed ${toDelete.length} dynamic entries on ${iface.name}`)] };
  }
  const toDelete = ctx.device.arpTable.filter((e) => !isPermanent(ctx.device, e.ip));
  for (const e of toDelete) deleteArp(ctx.device, e.ip);
  return { output: [muted(`ip neigh: flushed ${toDelete.length} dynamic entries`)] };
}

export const ipCommand: CommandHandler = {
  name: "ip",
  summary: "Show / manage addresses, links, routes and neighbours",
  usage: "ip { addr | link | route | neigh } [ show | add | del | replace | flush | set ... ]",
  help: [
    "IP",
    "",
    "Usage:",
    "  ip addr [show]                 ip addr add <cidr> dev <if>",
    "  ip link [show]                 ip addr del <cidr> dev <if>",
    "  ip route [show]                ip link set <if> up|down [address <mac>]",
    "  ip neigh [show]                ip route add <cidr|default> via <gw>",
    "                                 ip route del <cidr|default>",
    "                                 ip neigh add <ip> lladdr <mac> dev <if>",
    "                                 ip neigh del <ip> [dev <if>]",
    "                                 ip neigh flush [dev <if>]",
    "",
    "Purpose:",
    "  Inspect and change the device's L2/L3 configuration — the same state",
    "  the GUI edits and the packet engine uses.",
  ],
  run(args, ctx): CommandResult {
    const object = args[0];
    const action = args[1];
    const rest = args.slice(2);
    const isShow = !action || action === "show" || action === "list";

    switch (object) {
      case "a":
      case "addr":
      case "address":
        if (isShow) return { output: showAddr(ctx.device, true) };
        if (action === "add") return addrAdd(ctx, rest);
        if (action === "del" || action === "delete") return addrDel(ctx, rest);
        return { output: [err(`ip addr: unknown action "${action}"`)] };
      case "l":
      case "link":
        if (isShow) return { output: showAddr(ctx.device, false) };
        if (action === "set") return linkSet(ctx, rest);
        return { output: [err(`ip link: unknown action "${action}"`)] };
      case "r":
      case "route":
        if (isShow) return { output: showRoute(ctx.device) };
        if (action === "add") return routeAdd(ctx, rest);
        if (action === "del" || action === "delete") return routeDel(ctx, rest);
        return { output: [err(`ip route: unknown action "${action}"`)] };
      case "n":
      case "neigh":
      case "neighbour":
        if (isShow) return { output: showNeigh(ctx.device) };
        if (action === "add") return neighAddOrReplace(ctx, rest, false);
        if (action === "replace") return neighAddOrReplace(ctx, rest, true);
        if (action === "del" || action === "delete") return neighDel(ctx, rest);
        if (action === "flush") return neighFlush(ctx, rest);
        return { output: [err(`ip neigh: unknown action "${action}"`)] };
      default:
        return { output: [err(`ip: unknown object "${object ?? ""}". Try: ip addr | ip link | ip route | ip neigh`)] };
    }
  },
};
