/**
 * sFlow SONiC feature — Click `config sflow …` / `show sflow …`. The config is
 * the simulated CONFIG_DB (SFLOW / SFLOW_COLLECTOR / SFLOW_SESSION, see
 * lib/sflow/agent.ts); `show sflow interface` renders the APPL_DB sessions that
 * sflowmgrd derives from it, and the data plane (lib/sflow/agent.ts) samples
 * and exports from the same state.
 *
 * Behaviour and messages follow sonic-utilities (sonic-buildimage
 * 202505-smci-dev-oc):
 *   config/main.py  — polling 0|5-300, sample-rate 256-8388608|default,
 *                     collector name ≤16 chars, port 0-65535, vrf default|mgmt,
 *                     max 2 collectors, agent-id must be deleted before re-adding
 *   show/sflow.py   — `ljust(30)` global block, natsorted 4-column grid of
 *                     APPL_DB SFLOW_SESSION_TABLE rows
 */
import { CommandContext, CommandResult, OutputLine, line, err } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { isValidIpv4 } from "../../models/ip";
import { interfaceByName } from "../../models/device";
import {
  DEFAULT_COLLECTOR_PORT,
  SampleDirection,
  SflowState,
  peekSflowState,
  sflowSessions,
  sflowState,
} from "../../sflow/agent";

export const MAX_COLLECTORS = 2;
export const SAMPLE_RATE_RANGE = { min: 256, max: 8388608 };
const COLLECTOR_NAME_MAX = 16;

/** Accept IPv4 (validated) or an IPv6 literal. */
export function isCollectorIp(ip: string): boolean {
  return isValidIpv4(ip) || /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":");
}

/** Valid polling intervals: 0 (disable) or 5..300 (sonic-sflow.yang). */
export function isValidPolling(n: number): boolean {
  return n === 0 || (n >= 5 && n <= 300);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function parseIntTok(tok: string | undefined): number | null {
  if (tok === undefined || tok === "") return null;
  const n = Number(tok);
  return Number.isInteger(n) ? n : null;
}

/** Natural sort (natsorted): Ethernet2 before Ethernet10. */
export function natCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** python-tabulate `tablefmt='grid'`: headers get MIN_PADDING 2, numeric columns right-aligned. */
export function gridTable(header: string[], rows: string[][]): string[] {
  const numeric = header.map((_, c) => rows.length > 0 && rows.every((r) => /^-?\d+(\.\d+)?$/.test(r[c] ?? "")));
  const width = header.map((h, c) => Math.max(h.length + 2, ...rows.map((r) => (r[c] ?? "").length)));
  const sep = (ch: string) => "+" + width.map((w) => ch.repeat(w + 2)).join("+") + "+";
  const fmt = (cells: string[]) =>
    "|" + cells.map((v, c) => " " + (numeric[c] ? v.padStart(width[c]) : v.padEnd(width[c])) + " ").join("|") + "|";
  const out = [sep("-"), fmt(header), sep("=")];
  for (const r of rows) out.push(fmt(r), sep("-"));
  if (!rows.length) out.push(sep("-"));
  return out;
}

const config: SonicCmd[] = [
  {
    path: ["sflow", "enable"],
    summary: "Enable sFlow globally",
    run(_args, ctx): CommandResult {
      sflowState(ctx.device).enabled = true;
      return { output: [] };
    },
  },
  {
    path: ["sflow", "disable"],
    summary: "Disable sFlow globally",
    run(_args, ctx): CommandResult {
      sflowState(ctx.device).enabled = false;
      return { output: [] };
    },
  },
  {
    path: ["sflow", "collector", "add"],
    summary: "Add an sFlow collector: <name> <ip> [--port n] [--vrf default|mgmt] (max 2)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const [name, ip] = pos;
      if (!name || !ip) return { output: [err("Usage: config sflow collector add <name> <ip> [--port <port>] [--vrf <vrf>]")] };
      if (name.length > COLLECTOR_NAME_MAX) return { output: [err("Collector name must not exceed 16 characters")] };
      if (!isCollectorIp(ip)) return { output: [err(`Invalid IP address ${ip}`)] };
      let port = DEFAULT_COLLECTOR_PORT;
      const portTok = flagValue(args, "--port");
      if (portTok !== undefined) {
        const p = parseIntTok(portTok);
        if (p === null || p < 0 || p > 65535) return { output: [err("Collector port number must be between 0 and 65535")] };
        port = p;
      }
      const vrf = flagValue(args, "--vrf") ?? "default";
      if (vrf !== "default" && vrf !== "mgmt") return { output: [err("VRF name must be either default or mgmt")] };
      const st = sflowState(ctx.device);
      const existing = st.collectors.find((c) => c.name === name);
      if (existing) {
        Object.assign(existing, { ip, port, vrf });
      } else {
        if (st.collectors.length >= MAX_COLLECTORS) return { output: [err("Only 2 collectors can be configured, please delete one")] };
        st.collectors.push({ name, ip, port, vrf });
      }
      return { output: [] };
    },
  },
  {
    path: ["sflow", "collector", "del"],
    summary: "Delete an sFlow collector",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config sflow collector del <name>")] };
      const st = sflowState(ctx.device);
      if (!st.collectors.some((c) => c.name === name)) return { output: [err(`Invalid collector name ${name}`)] };
      st.collectors = st.collectors.filter((c) => c.name !== name);
      return { output: [] };
    },
  },
  {
    path: ["sflow", "agent-id", "add"],
    summary: "Set the sFlow agent-id interface",
    run(args, ctx): CommandResult {
      const intf = positional(args)[0];
      if (!intf) return { output: [err("Usage: config sflow agent-id add <interface>")] };
      const st = sflowState(ctx.device);
      if (st.agentId) return { output: [err("Agent already configured. Please delete it first.")] };
      st.agentId = intf;
      return { output: [] };
    },
  },
  {
    path: ["sflow", "agent-id", "del"],
    summary: "Clear the sFlow agent-id",
    run(_args, ctx): CommandResult {
      const st = sflowState(ctx.device);
      if (!st.agentId) return { output: [err("sFlow agent not configured.")] };
      st.agentId = undefined;
      return { output: [] };
    },
  },
  {
    path: ["sflow", "polling-interval"],
    summary: "Set the sFlow counter polling interval (0 or 5-300 seconds)",
    run(args, ctx): CommandResult {
      const n = parseIntTok(positional(args)[0]);
      if (n === null || !isValidPolling(n)) return { output: [err("Polling interval must be between 5-300 (0 to disable)")] };
      sflowState(ctx.device).pollingInterval = n;
      return { output: [] };
    },
  },
  {
    path: ["sflow", "sample-direction"],
    summary: "Set the global sample direction (rx | tx | both)",
    run(args, ctx): CommandResult {
      const dir = positional(args)[0];
      if (!dir) return { output: [err("Usage: config sflow sample-direction <rx|tx|both>")] };
      if (!isDirection(dir)) return { output: [err(`Error: Direction ${dir} is invalid`)] };
      sflowState(ctx.device).direction = dir;
      return { output: [] };
    },
  },
  {
    path: ["sflow", "interface", "sample-direction"],
    summary: "Set an interface's (or 'all') sample direction (rx | tx | both)",
    run(args, ctx): CommandResult {
      const [intf, dir] = positional(args);
      if (!intf || !dir) return { output: [err("Usage: config sflow interface sample-direction <interface|all> <rx|tx|both>")] };
      if (intf !== "all" && !interfaceByName(ctx.device, intf)) return { output: [err("Invalid interface name")] };
      if (!isDirection(dir)) return { output: [err(`Error: Direction ${dir} is invalid`)] };
      const st = sflowState(ctx.device);
      if (intf === "all") st.allDirection = dir;
      else (st.interfaces[intf] ??= {}).direction = dir;
      return { output: [] };
    },
  },
  {
    path: ["sflow", "interface", "enable"],
    summary: "Enable sFlow on an interface (or 'all')",
    run: (args, ctx) => setIntfAdmin(args, ctx, true),
  },
  {
    path: ["sflow", "interface", "disable"],
    summary: "Disable sFlow on an interface (or 'all')",
    run: (args, ctx) => setIntfAdmin(args, ctx, false),
  },
  {
    path: ["sflow", "interface", "sample-rate"],
    summary: "Set an interface's sample rate (256-8388608 or 'default' = port speed)",
    run(args, ctx): CommandResult {
      const [intf, rateTok] = positional(args);
      if (!intf || !rateTok) return { output: [err("Usage: config sflow interface sample-rate <interface> <rate|default>")] };
      if (!interfaceByName(ctx.device, intf)) return { output: [err(`Invalid interface name ${intf}`)] };
      const st = sflowState(ctx.device);
      const entry = (st.interfaces[intf] ??= {});
      if (rateTok === "default") {
        delete entry.sampleRate;
        return { output: [] };
      }
      const rate = parseIntTok(rateTok);
      if (rate === null || rate < SAMPLE_RATE_RANGE.min || rate > SAMPLE_RATE_RANGE.max) {
        return { output: [err("Error: Sample rate must be between 256 and 8388608 or default")] };
      }
      entry.sampleRate = rate;
      return { output: [] };
    },
  },
];

function isDirection(d: string): d is SampleDirection {
  return d === "rx" || d === "tx" || d === "both";
}

function setIntfAdmin(args: string[], ctx: CommandContext, up: boolean): CommandResult {
  const intf = positional(args)[0];
  if (!intf) return { output: [err(`Usage: config sflow interface ${up ? "enable" : "disable"} <interface|all>`)] };
  const st = sflowState(ctx.device);
  if (intf === "all") {
    st.allInterfaces = up;
    return { output: [] };
  }
  if (!interfaceByName(ctx.device, intf)) return { output: [err(`Invalid interface name ${intf}`)] };
  (st.interfaces[intf] ??= {}).enabled = up;
  return { output: [] };
}

function renderGlobal(st: SflowState | undefined): OutputLine[] {
  const label = (s: string) => `  ${s}:`.padEnd(30);
  const collectors = [...(st?.collectors ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: OutputLine[] = [
    line(""),
    line("sFlow Global Information:"),
    line(label("sFlow Admin State") + (st?.enabled ? "up" : "down")),
    line(label("sFlow Sample Direction") + (st?.direction ?? "rx")),
    line(label("sFlow Polling Interval") + (st?.pollingInterval ?? "default")),
    line(label("sFlow AgentID") + (st?.agentId ?? "default")),
    line(""),
    line(`  ${collectors.length} Collectors configured:`),
  ];
  for (const c of collectors) {
    out.push(
      line(
        `    Name: ${c.name}`.padEnd(30) + `IP addr: ${c.ip} `.padEnd(25) + `UDP port: ${c.port}`.padEnd(17) + `VRF: ${c.vrf}`,
      ),
    );
  }
  return out;
}

function renderInterfaces(ctx: CommandContext): OutputLine[] {
  const rows = sflowSessions(ctx.device)
    .sort((a, b) => natCompare(a.port, b.port))
    .map((s) => [s.port, s.adminState, String(s.sampleRate), s.direction]);
  return [
    line(""),
    line("sFlow interface configurations"),
    ...gridTable(["Interface", "Admin State", "Sampling Rate", "Sampling Direction"], rows).map((t) => line(t)),
  ];
}

const show: SonicCmd[] = [
  {
    path: ["sflow", "interface"],
    summary: "Show sFlow interface sessions (APPL_DB)",
    run: (_args, ctx) => ({ output: renderInterfaces(ctx) }),
  },
  {
    path: ["sflow"],
    summary: "Show sFlow global configuration",
    run: (_a, ctx) => ({ output: renderGlobal(peekSflowState(ctx.device)) }),
  },
];

export const sflowModule: SonicFeatureModule = { id: "sflow", config, show };
