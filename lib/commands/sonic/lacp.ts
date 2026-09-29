/**
 * LACP / PortChannel SONiC feature module. Config-plane only (simulated
 * CONFIG_DB): commands mutate per-device feature state and `show portchannel`
 * renders SOLELY from that stored state.
 *
 * IMPORTANT: LACPDU exchange / actor-partner negotiation needs a packet engine
 * that is not present, so this module never fabricates LACP negotiated/selected
 * member state (no S/D "selected"/"deselected" flags, no oper-up inference). It
 * renders the CONFIGURED LAG + members plus an explicit note.
 *
 * Commands are the SONiC click `config portchannel` family (path
 * ["portchannel", ...]); the fields and validation ranges come from lacp.txt,
 * which drives the equivalent management-framework IS-CLI forms:
 *
 *   config portchannel add <name> [--min-links n] [--fallback enable/disable]
 *                                              <- interface PortChannel <id> / min-links n / fallback
 *   config portchannel del <name>              <- no interface PortChannel <id>
 *   config portchannel member add <name> <iface>   <- interface <iface> / channel-group <id>
 *   config portchannel member del <name> <iface>   <- interface <iface> / no channel-group
 *   show portchannel [summary]                 <- show PortChannel summary
 *
 * From lacp.txt: PortChannel is named "PortChannel<id>" with LAG id 1..256
 * (TC-40 rejects channel-group 999, LAG_ID range 1..256); min-links range is
 * 1..1024 (TC-37 accepts 1024, TC-38 rejects 0, TC-39 rejects 1025); LACP mode
 * is always ACTIVE in community SONiC (TC-6/TC-44); an empty summary prints
 * "No PortChannels configured" (TC-30/TC-41/TC-43).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { interfaceByName } from "../../models/device";

interface PortChannel {
  name: string;
  members: string[];
  minLinks?: number;
  fallback?: boolean;
  mode?: string;
}

interface LacpState {
  portchannels: PortChannel[];
}

/** LAG_ID range is 1..256 (lacp.txt TC-40, sonic_types.xml LAG_ID). */
const LAG_ID = { min: 1, max: 256 };
/** MIN_LINK range is 1..1024 (lacp.txt TC-37/38/39, sonic_types.xml MIN_LINK). */
const MIN_LINKS = { min: 1, max: 1024 };

function state(ctx: CommandContext): LacpState {
  return featureState<LacpState>(ctx.device, "lacp", () => ({ portchannels: [] }));
}

/** Parse a "PortChannel<id>" name to its LAG id (1..256), or null if invalid. */
function lagId(name: string | undefined): number | null {
  if (!name) return null;
  const m = /^PortChannel(\d+)$/.exec(name);
  if (!m) return null;
  const id = Number(m[1]);
  if (id < LAG_ID.min || id > LAG_ID.max) return null;
  return id;
}

/** Value following a space-separated `--flag value` (undefined if absent). */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const config: SonicCmd[] = [
  {
    path: ["portchannel", "add"],
    summary: "Create a PortChannel (LAG) [--min-links n] [--fallback enable/disable]",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) {
        return { output: [err("Usage: config portchannel add <PortChannelN> [--min-links n] [--fallback enable/disable]")] };
      }
      if (lagId(name) === null) {
        return { output: [err(`config portchannel add: invalid name '${name}' (expected PortChannel<${LAG_ID.min}-${LAG_ID.max}>)`)] };
      }
      const st = state(ctx);
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
        if (v !== "enable" && v !== "disable") {
          return { output: [err(`config portchannel add: --fallback must be enable or disable (got '${fb}')`)] };
        }
        fallback = v === "enable";
      }

      st.portchannels.push({ name, members: [], minLinks, fallback, mode: "LACP" });
      const extras = [
        minLinks !== undefined ? `min-links ${minLinks}` : null,
        fallback !== undefined ? `fallback ${fallback ? "enabled" : "disabled"}` : null,
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
      const st = state(ctx);
      const before = st.portchannels.length;
      st.portchannels = st.portchannels.filter((p) => p.name !== name);
      if (st.portchannels.length === before) {
        return { output: [err(`config portchannel del: ${name} does not exist`)] };
      }
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
      const st = state(ctx);
      const pc = st.portchannels.find((p) => p.name === name);
      if (!pc) return { output: [err(`config portchannel member add: ${name} does not exist`)] };
      if (!interfaceByName(ctx.device, iface)) {
        return { output: [err(`config portchannel member add: interface ${iface} not found`)] };
      }
      const owner = st.portchannels.find((p) => p.members.includes(iface));
      if (owner) {
        return { output: [err(`config portchannel member add: ${iface} already a member of ${owner.name}`)] };
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
      const st = state(ctx);
      const pc = st.portchannels.find((p) => p.name === name);
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

function renderSummary(ctx: CommandContext): OutputLine[] {
  const pcs = [...(peekFeatureState<LacpState>(ctx.device, "lacp")?.portchannels ?? [])].sort(
    (a, b) => (lagId(a.name) ?? 0) - (lagId(b.name) ?? 0),
  );
  if (pcs.length === 0) return [muted("No PortChannels configured")];
  const out: OutputLine[] = [
    line(`${"No.".padEnd(6)}${"Team Dev".padEnd(17)}${"Protocol".padEnd(10)}${"Min-Links".padEnd(11)}${"Fallback".padEnd(10)}Member Ports`),
    line("-".repeat(78)),
  ];
  for (const pc of pcs) {
    const minLinks = pc.minLinks !== undefined ? String(pc.minLinks) : "-";
    const fallback = pc.fallback === undefined ? "-" : pc.fallback ? "enabled" : "disabled";
    out.push(
      line(
        `${String(lagId(pc.name) ?? "?").padEnd(6)}${pc.name.padEnd(17)}${(pc.mode ?? "LACP").padEnd(10)}${minLinks.padEnd(11)}${fallback.padEnd(10)}${pc.members.length ? pc.members.join(" ") : "-"}`,
      ),
    );
  }
  out.push(muted("Note: LACP negotiation (actor/partner, selected state) is not simulated; members shown are configured only."));
  return out;
}

const show: SonicCmd[] = [
  { path: ["portchannel", "summary"], summary: "Show PortChannels with their members", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
  { path: ["portchannel"], summary: "Show PortChannels with their members", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
];

export const lacpModule: SonicFeatureModule = { id: "lacp", config, show };
