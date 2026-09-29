/**
 * ARP/ND SONiC feature module. Source: arpnd.txt. Follows the ./vlan.ts pattern.
 *
 * A data-driven view over device.arpTable (the neighbour cache the packet engine
 * populates during ping via ARP request/reply). Traceable to arpnd.txt:
 *
 *   show ip arp [interface <name>]      (TC-1..TC-7, TC-17..TC-20)  -> "No ARP entries found."
 *   show ipv6 neighbors                 (TC-8..TC-14)               -> "No IPv6 neighbor entries found."
 *   ip arp <ip> <mac>                   (static entry)              -> config arp add <ip> <mac> <iface>
 *   clear ip arp                        (TC-35)                     -> config arp clear
 *
 * The model has only an IPv4 arpTable (no IPv6 neighbor table), so ND views
 * render the real "no entries" message rather than fabricating neighbours.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { ArpEntry } from "../../models/device";
import { findInterface, interfaceByName } from "../../models/device";

/** Interface name an entry resolves to (e.g. "eth0" / "Ethernet0"), or the raw id. */
function ifaceName(ctx: CommandContext, e: ArpEntry): string {
  return findInterface(ctx.device, e.interfaceId)?.name ?? e.interfaceId;
}

/** Optional filter from `show arp` args: an IP, or `interface <name>` (name may be "Ethernet 4"). */
function parseFilter(args: string[]): { ip?: string; iface?: string } {
  const pos = positional(args);
  const ifIdx = pos.indexOf("interface");
  if (ifIdx >= 0) {
    const rest = pos.slice(ifIdx + 1);
    // KLISH spells the port as two tokens ("Ethernet 4"); click uses one ("Ethernet0").
    const iface = rest.length >= 2 && /^\d+$/.test(rest[1]) ? `${rest[0]}${rest[1]}` : rest[0];
    return { iface };
  }
  const ip = pos.find((t) => t.includes("."));
  return { ip };
}

function renderArp(ctx: CommandContext, args: string[]): OutputLine[] {
  const { ip, iface } = parseFilter(args);
  let entries = ctx.device.arpTable;
  if (ip) entries = entries.filter((e) => e.ip === ip);
  if (iface) entries = entries.filter((e) => ifaceName(ctx, e) === iface || e.interfaceId === iface);

  if (entries.length === 0) return [muted("No ARP entries found.")];

  const out: OutputLine[] = [
    line(`${"Address".padEnd(16)} ${"MacAddress".padEnd(18)} ${"Iface".padEnd(11)} State`),
    line(`${"-".repeat(16)} ${"-".repeat(18)} ${"-".repeat(11)} -----`),
  ];
  for (const e of entries) {
    const mac = e.state === "incomplete" ? "(incomplete)" : e.mac;
    out.push(line(`${e.ip.padEnd(16)} ${mac.padEnd(18)} ${ifaceName(ctx, e).padEnd(11)} ${e.state}`));
  }
  out.push(muted(`Total number of entries ${entries.length}`));
  return out;
}

/** Render the IPv6 neighbor cache (NDP) the engine populates during ping6. */
function renderNdp(ctx: CommandContext): OutputLine[] {
  const table = ctx.device.ndpTable ?? [];
  if (table.length === 0) return [muted("No IPv6 neighbor entries found.")];
  const out: OutputLine[] = [
    line(`${"Address".padEnd(28)} ${"MacAddress".padEnd(18)} ${"Iface".padEnd(11)} State`),
    line(`${"-".repeat(28)} ${"-".repeat(18)} ${"-".repeat(11)} -----`),
  ];
  for (const e of table) {
    const name = findInterface(ctx.device, e.interfaceId)?.name ?? e.interfaceId;
    const mac = e.state === "incomplete" ? "(incomplete)" : e.mac;
    out.push(line(`${e.ip.padEnd(28)} ${mac.padEnd(18)} ${name.padEnd(11)} ${e.state}`));
  }
  out.push(muted(`Total number of entries ${table.length}`));
  return out;
}

const config: SonicCmd[] = [
  {
    path: ["arp", "add"],
    summary: "Add a static ARP entry (ip arp <ip> <mac>)",
    run(args, ctx): CommandResult {
      const [ip, mac, ifName] = positional(args);
      if (!ip || !mac || !ifName) {
        return { output: [err("Usage: config arp add <ip> <mac> <iface>")] };
      }
      const iface = interfaceByName(ctx.device, ifName);
      if (!iface) return { output: [err(`config arp add: ${ifName}: no such interface`)] };
      ctx.device.arpTable = ctx.device.arpTable.filter((e) => e.ip !== ip);
      ctx.device.arpTable.push({ ip, mac, interfaceId: iface.id, state: "reachable" });
      return { output: [muted(`ARP entry ${ip} -> ${mac} added on ${iface.name}`)] };
    },
  },
  {
    path: ["arp", "clear"],
    summary: "Clear the ARP / neighbour cache (clear ip arp)",
    run(_args, ctx): CommandResult {
      const n = ctx.device.arpTable.length;
      ctx.device.arpTable = [];
      return { output: [muted(`Dynamic ipv4 neighbors cleared successfully (${n} removed)`)] };
    },
  },
];

const show: SonicCmd[] = [
  { path: ["arp"], summary: "Show the ARP table", run: (a, ctx) => ({ output: renderArp(ctx, a) }) },
  { path: ["ip", "arp"], summary: "Show the ARP table", run: (a, ctx) => ({ output: renderArp(ctx, a) }) },
  { path: ["ndp"], summary: "Show IPv6 neighbors (ND)", run: (_a, ctx) => ({ output: renderNdp(ctx) }) },
  { path: ["ipv6", "neighbors"], summary: "Show IPv6 neighbors (ND)", run: (_a, ctx) => ({ output: renderNdp(ctx) }) },
];

export const arpndModule: SonicFeatureModule = { id: "arpnd", config, show };
