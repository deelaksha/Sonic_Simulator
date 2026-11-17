/**
 * ARP/ND SONiC feature module — renders the live neighbour cache the packet
 * engine and the ARP daemon maintain (device.arpTable + lib/protocols/arp.ts).
 *
 *   show arp [<ip>] [-if <iface>]   sonic-utilities show/main.py:409-428 → scripts/nbrshow
 *       ArpShow: parses `arp -n` (only "ether" lines, so INCOMPLETE is hidden,
 *       nbrshow:187-192); Vlan column = VLAN id for VlanN entries with Iface
 *       replaced by the FDB port of that MAC or "-" (nbrshow:132-146); natsorted
 *       by address (nbrshow:149); python-tabulate "simple"; then
 *       "Total number of entries N " (nbrshow:152, trailing space included).
 *   show ip arp                     Click has no `show ip arp`; it renders the KLISH
 *       show_arp.j2 output (same renderer the KLISH modal uses).
 *   sonic-clear arp [<ip>]          sonic-utilities clear/main.py:509-526 →
 *       `ip -4 -s -s neigh flush all` / `ip -4 neigh del <ip> dev <dev>`.
 *       Exported as `sonicClearCommand` (needs registering in commands/registry.ts).
 *   config arp add <ip> <mac> <if>  static (PERMANENT) entry, KLISH `ip arp`.
 *   config arp clear                flush dynamic entries (static ones stay, like
 *       `clear ip arp`, ipv4.xml:205-212).
 */
import { CommandContext, CommandHandler, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { ArpEntry, Device } from "../../models/device";
import { findInterface, interfaceByName } from "../../models/device";
import { addStaticArp, deleteArp, isPermanent, peekArpRuntime } from "../../protocols/arp";
import { normalizeMac } from "../../models/mac";

/** Interface name an entry resolves to (e.g. "eth0" / "Ethernet0"), or the raw id. */
function ifaceName(device: Device, e: ArpEntry): string {
  return findInterface(device, e.interfaceId)?.name ?? e.interfaceId;
}

/** natsort key comparison (natsort.natsorted): digit runs compare numerically. */
export function natCompare(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === y) continue;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}

/**
 * python-tabulate tablefmt="simple": header cells get MIN_PADDING 2, columns
 * separated by two spaces, numeric columns right-aligned, lines right-stripped.
 */
export function tabulateSimple(headers: string[], rows: (string | number)[][]): string[] {
  const numeric = headers.map((_, c) => rows.length > 0 && rows.every((r) => typeof r[c] === "number"));
  const width = headers.map((h, c) => Math.max(h.length + 2, ...rows.map((r) => String(r[c]).length)));
  const cell = (v: string | number, c: number) => (numeric[c] ? String(v).padStart(width[c]) : String(v).padEnd(width[c]));
  return [
    headers.map(cell).join("  ").trimEnd(),
    width.map((w) => "-".repeat(w)).join("  "),
    ...rows.map((r) => r.map(cell).join("  ").trimEnd()),
  ];
}

/** `arp -n` view: complete neighbours (INCOMPLETE has no "ether" line). */
export function kernelArpRows(device: Device): ArpEntry[] {
  return device.arpTable.filter((e) => e.state !== "incomplete");
}

/** Parse `show arp [<ip>] [-if <iface>]` (also accepts KLISH-style `interface Ethernet 4`). */
function parseFilter(args: string[]): { ip?: string; iface?: string } {
  const out: { ip?: string; iface?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-if" || a === "--iface") out.iface = args[++i];
    else if (a === "interface") {
      const rest = args.slice(i + 1);
      out.iface = rest.length >= 2 && /^\d+$/.test(rest[1]) ? `${rest[0]}${rest[1]}` : rest[0];
      break;
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) out.ip = a;
  }
  return out;
}

function renderNbrshow(ctx: CommandContext, args: string[]): OutputLine[] {
  const { ip, iface } = parseFilter(args);
  let entries = kernelArpRows(ctx.device);
  if (ip) entries = entries.filter((e) => e.ip === ip);
  if (iface) entries = entries.filter((e) => ifaceName(ctx.device, e) === iface);
  const rows = entries.map((e): (string | number)[] => {
    const name = ifaceName(ctx.device, e);
    const mac = e.mac.toLowerCase();
    const vm = /^Vlan(\d+)$/.exec(name);
    if (!vm) return [e.ip, mac, name, "-"];
    const vid = Number(vm[1]);
    const fdb = ctx.device.macTable.find((f) => f.vlan === vid && normalizeMac(f.mac) === normalizeMac(e.mac));
    return [e.ip, mac, fdb ? (findInterface(ctx.device, fdb.interfaceId)?.name ?? "-") : "-", vid];
  });
  rows.sort((a, b) => natCompare(String(a[0]), String(b[0])));
  return [...tabulateSimple(["Address", "MacAddress", "Iface", "Vlan"], rows).map((t) => line(t)), line(`Total number of entries ${rows.length} `)];
}

/** KLISH "Ethernet 0" / "Ethernet0" / "Management 0" → native name (Management0 → eth0). */
export function nativeIf(tokens: string[]): string | undefined {
  const m = tokens.join("").match(/^([A-Za-z]+)(\d+)$/);
  if (!m) return undefined;
  const type = m[1].toLowerCase();
  if (type === "management") return `eth${m[2]}`;
  const canon: Record<string, string> = { ethernet: "Ethernet", vlan: "Vlan", portchannel: "PortChannel", loopback: "Loopback", eth: "eth" };
  return canon[type] ? `${canon[type]}${m[2]}` : undefined;
}

const displayIf = (name: string) => (name.startsWith("eth") ? `Management${name.slice(3)}` : name);
const SEP = "-".repeat(121);

/** KLISH `show ip arp` — renderer/templates/show_arp.j2 (sonic-mgmt-framework CLI): one row per neighbour, interface order with Management0 spliced last. */
export function renderShowIpArp(ctx: CommandContext, args: string[]): OutputLine[] {
  const d = ctx.device;
  let ip: string | undefined;
  let mac: string | undefined;
  let iface: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === "mac-address") mac = args[++i]?.toLowerCase();
    else if (a === "interface") {
      iface = nativeIf(args.slice(i + 1, i + 3));
      break;
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) ip = a;
  }
  const name = (e: { interfaceId: string }) => findInterface(d, e.interfaceId)?.name ?? e.interfaceId;
  let rows = kernelArpRows(d);
  if (iface) rows = rows.filter((e) => name(e) === iface);
  if (ip) rows = rows.filter((e) => e.ip === ip);
  if (mac) rows = rows.filter((e) => e.mac.toLowerCase() === mac);
  const ifRank = (n: string) => (n.startsWith("eth") ? 1 : 0);
  rows = [...rows].sort((a, b) => ifRank(name(a)) - ifRank(name(b)) || natCompare(name(a), name(b)) || natCompare(a.ip, b.ip));
  if (rows.length === 0) return [line("No ARP entries found.")];
  const out = [
    line(SEP),
    line(`${"Address".padEnd(32)}${"Hardware address".padEnd(18)}${"Interface".padEnd(16)}${"Egress Interface".padEnd(18)}${"Type".padEnd(8)}Action`),
    line(SEP),
  ];
  for (const e of rows) {
    const type = isPermanent(d, e.ip) ? "STATIC" : "DYNAMIC";
    out.push(line(`${e.ip.padEnd(32)}${e.mac.toLowerCase().padEnd(18)}${displayIf(name(e)).padEnd(16)}${"-".padEnd(18)}${type.padEnd(8)}Fwd`));
  }
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

/** Flush the dynamic neighbours (optionally one interface); static entries stay. Returns the flushed entries. */
export function flushDynamicArp(device: Device, ifName?: string): ArpEntry[] {
  const victims = device.arpTable.filter((e) => !isPermanent(device, e.ip) && (!ifName || ifaceName(device, e) === ifName));
  for (const e of victims) deleteArp(device, e.ip);
  return victims;
}

const NUD: Record<ArpEntry["state"], string> = { reachable: "REACHABLE", stale: "STALE", incomplete: "INCOMPLETE" };

/** `ip -s neigh` line for an entry: "<ip> dev <if> lladdr <mac> used a/b/c probes n STATE". */
function neighStatLine(device: Device, e: ArpEntry, now: number): string {
  const t = peekArpRuntime(device)?.nb?.[e.ip];
  const secs = (ms: number | undefined) => Math.max(0, Math.floor((now - (ms ?? now)) / 1000));
  const used = `${secs(t?.used ?? t?.t)}/${secs(t?.t)}/${secs(t?.t)}`;
  const ll = e.state === "incomplete" ? "" : ` lladdr ${e.mac.toLowerCase()}`;
  return `${e.ip} dev ${ifaceName(device, e)}${ll} used ${used} probes ${t?.probes ?? 0} ${NUD[e.state]}`;
}

/** sonic-clear arp [<ip>] (clear/main.py:509-526). */
function sonicClearArp(ctx: CommandContext, args: string[]): OutputLine[] {
  const ip = positional(args)[0];
  if (ip) {
    const e = ctx.device.arpTable.find((x) => x.ip === ip);
    if (!e) return [line(`Neighbor ${ip} not found`)];
    deleteArp(ctx.device, ip); // `ip -4 neigh del <ip> dev <dev>` prints nothing
    return [];
  }
  // `ip -4 -s -s neigh flush all`: prints each flushed entry, then the round summary (iproute2 ipneigh.c).
  const now = Date.now();
  const victims = ctx.device.arpTable.filter((e) => !isPermanent(ctx.device, e.ip));
  if (victims.length === 0) return [line("Nothing to flush.")];
  const lines = victims.map((e) => line(neighStatLine(ctx.device, e, now)));
  flushDynamicArp(ctx.device);
  return [...lines, line(""), line(`*** Round 1, deleting ${victims.length} entries ***`), line("*** Flush is complete after 1 round ***")];
}

export const sonicClearCommand: CommandHandler = {
  name: "sonic-clear",
  cli: "sonic",
  summary: "SONiC clear commands (sonic-clear arp ...)",
  usage: "sonic-clear arp [<ip>] | sonic-clear ip arp [<ip>]",
  help: ["SONIC-CLEAR", "", "Usage:", "  sonic-clear arp [<ipaddress>]     Clear IP ARP table", "  sonic-clear ip arp [<ipaddress>]"],
  run(args, ctx): CommandResult {
    const rest = args[0] === "ip" ? args.slice(1) : args;
    if (rest[0] === "arp") return { output: sonicClearArp(ctx, rest.slice(1)) };
    return { output: [err(`Error: No such command "${args[0] ?? ""}".`)] };
  },
};

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
      addStaticArp(ctx.device, ip, mac, iface.id, Date.now());
      return { output: [muted(`ARP entry ${ip} -> ${mac} added on ${iface.name}`)] };
    },
  },
  {
    path: ["arp", "clear"],
    summary: "Clear the dynamic ARP / neighbour cache (clear ip arp)",
    run(_args, ctx): CommandResult {
      const n = flushDynamicArp(ctx.device).length;
      return { output: [muted(`Dynamic ipv4 neighbors cleared successfully (${n} removed)`)] };
    },
  },
];

const show: SonicCmd[] = [
  { path: ["arp"], summary: "Show IP ARP table", run: (a, ctx) => ({ output: renderNbrshow(ctx, a) }) },
  // Click has no `show ip arp`; it is the KLISH command, so render its template.
  { path: ["ip", "arp"], summary: "Show IP ARP table (KLISH format)", run: (a, ctx) => ({ output: renderShowIpArp(ctx, a) }) },
  { path: ["ndp"], summary: "Show IPv6 neighbors (ND)", run: (_a, ctx) => ({ output: renderNdp(ctx) }) },
  { path: ["ipv6", "neighbors"], summary: "Show IPv6 neighbors (ND)", run: (_a, ctx) => ({ output: renderNdp(ctx) }) },
];

export const arpndModule: SonicFeatureModule = { id: "arpnd", config, show };
