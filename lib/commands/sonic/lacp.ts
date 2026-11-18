/**
 * LACP / PortChannel SONiC feature module (Click `config portchannel` +
 * `show interfaces portchannel`). Config lives in the simulated CONFIG_DB
 * (feature state "lacp"); the LACP runner (lib/protocols/lacp-daemon.ts, teamd)
 * negotiates with the partner and the show commands render its live state.
 *
 *   config portchannel add <name> [--min-links n] [--fallback true|false] [--fast-rate true|false]
 *                                              <- interface PortChannel <id> / min-links / fallback / fast_rate
 *   config portchannel del <name>              <- no interface PortChannel <id>
 *   config portchannel member add <name> <iface>   <- interface <iface> / channel-group <id>
 *   config portchannel member del <name> <iface>   <- interface <iface> / no channel-group
 *   show interfaces portchannel                teamshow (sonic-utilities show/interfaces/portchannel.py)
 *   show portchannel [summary]                 configured LAGs + negotiated member flags
 *
 * Sources: sonic-utilities config/main.py:2766-2826 (add: --min-links IntRange(1,1024),
 * default 1; --fallback; --fast-rate true/false; del refuses while members exist :2825),
 * config/main.py:2837-2945 (member add: Ethernet ports only, not already a member,
 * no IP address), show/interfaces/portchannel.py:97-156 (teamshow flags + tabulate).
 * LAG id range 1..256 (lacp.txt TC-40); min-links 1..1024 (TC-37/38/39); LACP mode is
 * always ACTIVE (teammgr.cpp:609); an empty summary prints "No PortChannels configured".
 * `--fallback enable|disable` is accepted besides true/false (the simulator's earlier
 * syntax, kept so existing labs/tests work).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { Device, interfaceByName } from "../../models/device";
import { createInterface } from "../../models/interface";
import { lacpRuntime, lagConfigs, systemMac, ST } from "../../protocols/lacp-daemon";

export interface PortChannel {
  name: string;
  members: string[];
  minLinks?: number;
  fallback?: boolean;
  fastRate?: boolean;
  mode?: string;
}

export interface LacpState {
  portchannels: PortChannel[];
}

/** LAG_ID range is 1..256 (lacp.txt TC-40, sonic_types.xml LAG_ID). */
const LAG_ID = { min: 1, max: 256 };
/** MIN_LINK range is 1..1024 (lacp.txt TC-37/38/39, sonic_types.xml MIN_LINK). */
export const MIN_LINKS = { min: 1, max: 1024 };

function stateOf(device: Device): LacpState {
  return featureState<LacpState>(device, "lacp", () => ({ portchannels: [] }));
}

/** Parse a "PortChannel<id>" name to its LAG id (1..256), or null if invalid. */
export function lagId(name: string | undefined): number | null {
  if (!name) return null;
  const m = /^PortChannel(\d+)$/.exec(name);
  if (!m) return null;
  const id = Number(m[1]);
  if (id < LAG_ID.min || id > LAG_ID.max) return null;
  return id;
}

/** Create the PortChannel netdev (teamd team device: hwaddr = system MAC, teammgr.cpp:607). */
function ensureLagInterface(device: Device, name: string): void {
  if (interfaceByName(device, name)) return;
  const iface = createInterface(`${device.id}-${name.toLowerCase()}`, name, systemMac(device));
  iface.logical = true;
  iface.operState = "down"; // carrier comes from the LACP runner (min_ports)
  device.interfaces.push(iface);
}

/**
 * Config entry for a PortChannel that exists as an interface (KLISH `interface
 * PortChannel N` creates the interface; its PORTCHANNEL row is created here on
 * first use). Returns undefined when neither exists.
 */
export function lagEntry(device: Device, name: string): PortChannel | undefined {
  const st = stateOf(device);
  let pc = st.portchannels.find((p) => p.name === name);
  if (!pc && interfaceByName(device, name)?.logical && lagId(name) !== null) {
    pc = { name, members: [], mode: "LACP" };
    st.portchannels.push(pc);
  }
  return pc;
}

/** Value following a space-separated `--flag value` (undefined if absent). */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const config: SonicCmd[] = [
  {
    path: ["portchannel", "add"],
    summary: "Create a PortChannel (LAG) [--min-links n] [--fallback true|false] [--fast-rate true|false]",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) {
        return { output: [err("Usage: config portchannel add <PortChannelN> [--min-links n] [--fallback true|false] [--fast-rate true|false]")] };
      }
      if (lagId(name) === null) {
        return { output: [err(`config portchannel add: invalid name '${name}' (expected PortChannel<${LAG_ID.min}-${LAG_ID.max}>)`)] };
      }
      const st = stateOf(ctx.device);
      if (st.portchannels.some((p) => p.name === name)) {
        return { output: [err(`config portchannel add: ${name} already exists`)] };
      }

      let minLinks: number | undefined;
      const ml = flagValue(args, "--min-links");
      if (ml !== undefined) {
        const n = Number(ml);
        if (!Number.isInteger(n) || n < MIN_LINKS.min || n > MIN_LINKS.max) {
          return { output: [err(`config portchannel add: --min-links must be ${MIN_LINKS.min}-${MIN_LINKS.max} (got '${ml}')`)] };
        }
        minLinks = n;
      }

      let fallback: boolean | undefined;
      const fb = flagValue(args, "--fallback");
      if (fb !== undefined) {
        const v = fb.toLowerCase();
        if (!["enable", "disable", "true", "false"].includes(v)) {
          return { output: [err(`config portchannel add: --fallback must be true or false (got '${fb}')`)] };
        }
        fallback = v === "enable" || v === "true";
      }

      let fastRate: boolean | undefined;
      const fr = flagValue(args, "--fast-rate");
      if (fr !== undefined) {
        const v = fr.toLowerCase();
        if (v !== "true" && v !== "false") {
          return { output: [err(`config portchannel add: --fast-rate must be true or false (got '${fr}')`)] }; // click.Choice
        }
        fastRate = v === "true";
      }

      st.portchannels.push({ name, members: [], minLinks, fallback, fastRate, mode: "LACP" });
      ensureLagInterface(ctx.device, name);
      const extras = [
        minLinks !== undefined ? `min-links ${minLinks}` : null,
        fallback !== undefined ? `fallback ${fallback ? "enabled" : "disabled"}` : null,
        fastRate ? "fast-rate" : null,
      ].filter(Boolean);
      return { output: [muted(`PortChannel ${name} created (mode LACP${extras.length ? ", " + extras.join(", ") : ""})`)] };
    },
  },
  {
    path: ["portchannel", "del"],
    summary: "Delete a PortChannel (LAG)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config portchannel del <PortChannelN>")] };
      const st = stateOf(ctx.device);
      const pc = st.portchannels.find((p) => p.name === name);
      if (!pc) return { output: [err(`config portchannel del: ${name} does not exist`)] };
      if (pc.members.length) {
        // config/main.py:2825-2826
        return { output: [err(`Error: Portchannel ${name} contains members. Remove members before deleting Portchannel!`)] };
      }
      st.portchannels = st.portchannels.filter((p) => p.name !== name);
      ctx.device.interfaces = ctx.device.interfaces.filter((i) => !(i.logical && i.name === name));
      return { output: [muted(`PortChannel ${name} deleted`)] };
    },
  },
  {
    path: ["portchannel", "member", "add"],
    summary: "Add a member interface to a PortChannel",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const iface = pos[1];
      if (!name || !iface) return { output: [err("Usage: config portchannel member add <PortChannelN> <interface>")] };
      const st = stateOf(ctx.device);
      const pc = lagEntry(ctx.device, name);
      if (!pc) return { output: [err(`config portchannel member add: ${name} does not exist`)] };
      const port = interfaceByName(ctx.device, iface);
      if (!port || port.logical || !iface.startsWith("Ethernet")) {
        return { output: [err(`config portchannel member add: interface ${iface} not found`)] };
      }
      const owner = st.portchannels.find((p) => p.members.includes(iface));
      if (owner) {
        return { output: [err(`config portchannel member add: ${iface} already a member of ${owner.name}`)] };
      }
      if (port.ipv4.length) {
        return { output: [err(` ${iface} has ip address or ipv6 link-local configured`)] }; // config/main.py:2867-2869
      }
      pc.members.push(iface);
      return { output: [muted(`${iface} added to ${name}`)] };
    },
  },
  {
    path: ["portchannel", "member", "del"],
    summary: "Remove a member interface from a PortChannel",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const iface = pos[1];
      if (!name || !iface) return { output: [err("Usage: config portchannel member del <PortChannelN> <interface>")] };
      const pc = stateOf(ctx.device).portchannels.find((p) => p.name === name);
      if (!pc) return { output: [err(`config portchannel member del: ${name} does not exist`)] };
      const before = pc.members.length;
      pc.members = pc.members.filter((m) => m !== iface);
      if (pc.members.length === before) {
        return { output: [err(`config portchannel member del: ${iface} is not a member of ${name}`)] };
      }
      return { output: [muted(`${iface} removed from ${name}`)] };
    },
  },
];

/** Negotiated member flags as teamshow derives them (portchannel.py:128-141). */
export function memberFlag(device: Device, lag: string, member: string): string {
  const p = lacpRuntime(device)?.lags[lag]?.ports[member];
  if (!p) return "D*"; // no STATE_DB row / no APPL status → not synced
  const selected = !!(p.actor.state & ST.SYNC); // runner.aggregator.selected
  return (selected ? "S" : "D") + (selected !== p.enabled ? "*" : "");
}

function sortedLags(device: Device): PortChannel[] {
  return [...(peekFeatureState<LacpState>(device, "lacp")?.portchannels ?? [])].sort((a, b) => (lagId(a.name) ?? 0) - (lagId(b.name) ?? 0));
}

function renderSummary(ctx: CommandContext): OutputLine[] {
  const pcs = sortedLags(ctx.device);
  if (pcs.length === 0) return [muted("No PortChannels configured")];
  const out: OutputLine[] = [
    line(`${"No.".padEnd(6)}${"Team Dev".padEnd(17)}${"Protocol".padEnd(10)}${"Min-Links".padEnd(11)}${"Fallback".padEnd(10)}Member Ports`),
    line("-".repeat(78)),
  ];
  for (const pc of pcs) {
    const minLinks = pc.minLinks !== undefined ? String(pc.minLinks) : "-";
    const fallback = pc.fallback === undefined ? "-" : pc.fallback ? "enabled" : "disabled";
    const members = pc.members.map((m) => `${m}(${memberFlag(ctx.device, pc.name, m)})`).join(" ");
    out.push(line(`${String(lagId(pc.name) ?? "?").padEnd(6)}${pc.name.padEnd(17)}${(pc.mode ?? "LACP").padEnd(10)}${minLinks.padEnd(11)}${fallback.padEnd(10)}${members || "-"}`));
  }
  return out;
}

/** python-tabulate "simple" format (MIN_PADDING 2 on headers; numbers right-aligned). */
export function tabulate(headers: string[], rows: string[][], numeric: boolean[]): string[] {
  const w = headers.map((h, c) => Math.max(h.length + 2, ...rows.map((r) => r[c].length)));
  const cell = (s: string, c: number) => (numeric[c] ? s.padStart(w[c]) : s.padEnd(w[c]));
  return [headers.map(cell).join("  "), w.map((n) => "-".repeat(n)).join("  "), ...rows.map((r) => r.map(cell).join("  "))];
}

/** `show interfaces portchannel` — teamshow (show/interfaces/portchannel.py:97-156). */
function renderTeamshow(ctx: CommandContext): OutputLine[] {
  const d = ctx.device;
  const rt = lacpRuntime(d);
  const rows: string[][] = [];
  const lags = lagConfigs(d).sort((a, b) => (lagId(a.name) ?? 0) - (lagId(b.name) ?? 0));
  for (const pc of lags) {
    const id = pc.name.slice(11);
    const lr = rt?.lags[pc.name];
    if (!lr) {
      rows.push([id, pc.name, "N/A", ""]);
      continue;
    }
    const oper = interfaceByName(d, pc.name)?.operState;
    const protocol = `LACP(A)${oper === "up" ? "(Up)" : oper === "down" ? "(Dw)" : "(N/A)"}`;
    const members = Object.keys(lr.ports);
    const ports = members.length ? members.map((m) => `${m}(${memberFlag(d, pc.name, m)})`).join(" ") : "N/A";
    rows.push([id, pc.name, protocol, ports]);
  }
  return [
    line("Flags: A - active, I - inactive, Up - up, Dw - Down, N/A - not available,"),
    line("       S - selected, D - deselected, * - not synced"),
    ...tabulate(["No.", "Team Dev", "Protocol", "Ports"], rows, [true, false, false, false]).map((l) => line(l)),
  ];
}

const show: SonicCmd[] = [
  { path: ["interfaces", "portchannel"], summary: "Show PortChannel information (teamshow)", run: (_a, ctx) => ({ output: renderTeamshow(ctx) }) },
  { path: ["portchannel", "summary"], summary: "Show PortChannels with their members", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
  { path: ["portchannel"], summary: "Show PortChannels with their members", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
];

export const lacpModule: SonicFeatureModule = { id: "lacp", config, show };
