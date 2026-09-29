/**
 * sFlow SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and `show sflow ...` renders SOLELY from that
 * stored state. There is no sampling/record generation — the packet engine has
 * no sFlow hook yet — so this module NEVER fabricates sampled datagrams/counters.
 *
 * Commands are the SONiC click `config sflow` family (path ["sflow", ...]). The
 * fields, ranges and render forms are taken from sflow.txt, whose KLISH transcript
 * drives the equivalent click commands:
 *
 *   config sflow enable                              <- sflow enable            (TC-2)
 *   config sflow disable                             <- no sflow enable         (TC-4)
 *   config sflow collector add <name> <ip> [--port n]<- sflow collector <ip> [port n] (TC-8/12/16)
 *   config sflow collector del <name>                <- no sflow collector <ip> (TC-10)
 *   config sflow agent-id add <intf>                 <- sflow agent-id <intf>   (TC-20/22)
 *   config sflow agent-id del                        <- no sflow agent-id       (TC-24)
 *   config sflow polling-interval <n>                <- sflow polling-interval n (TC-38)
 *   config sflow interface enable <intf>             <- interface X / sflow enable      (TC-26)
 *   config sflow interface disable <intf>            <- interface X / no sflow enable   (TC-29)
 *   config sflow interface sample-rate <intf> <rate> <- interface X / sflow sampling-rate n (TC-58/60)
 *   show sflow                                       <- show sflow              (TC-1/3/9/68)
 *   show sflow interface [<intf>]                    <- show sflow interface    (TC-28/35/97)
 *
 * From sflow.txt: default collector UDP port 6343 and VRF "default" (TC-9); the
 * collector line renders "Name: <name> IP addr: <ip> UDP port: <port> VRF:
 * default"; max 2 collectors (TC-69); UDP port 1-65535 (TC-73/74); polling
 * interval 0 or 5-300 (TC-40/42/44/45); interface sample-rate 256-8388608
 * (TC-53/54/62/63); an enabled interface with no explicit rate shows the default
 * 4294967295 (TC-28/105); an empty interface survey prints "No sFlow interfaces
 * configured" (TC-97).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { isValidIpv4 } from "../../models/ip";
import { interfaceByName } from "../../models/device";

interface SflowCollector {
  name: string;
  ip: string;
  port: number;
}

interface SflowInterface {
  enabled: boolean;
  sampleRate?: number;
}

interface SflowState {
  enabled: boolean;
  collectors: SflowCollector[];
  agentId: string | undefined;
  pollingInterval: number | undefined;
  interfaces: Record<string, SflowInterface>;
}

/** Default collector UDP port (sflow.txt TC-9). */
const DEFAULT_PORT = 6343;
/** UDP port range (sflow.txt TC-73/74). */
const PORT_RANGE = { min: 1, max: 65535 };
/** At most 2 collectors (sflow.txt TC-69). */
const MAX_COLLECTORS = 2;
/** Interface sample-rate range (sflow.txt TC-53/54). */
const SAMPLE_RATE_RANGE = { min: 256, max: 8388608 };
/** Rate shown for an enabled interface with no explicit rate (sflow.txt TC-28). */
const DEFAULT_SAMPLE_RATE = 4294967295;

function state(ctx: CommandContext): SflowState {
  return featureState<SflowState>(ctx.device, "sflow", () => ({
    enabled: false,
    collectors: [],
    agentId: undefined,
    pollingInterval: undefined,
    interfaces: {},
  }));
}

/** Accept IPv4 (validated) or an IPv6 literal (contains ':', sflow.txt TC-16). */
function isCollectorIp(ip: string): boolean {
  return isValidIpv4(ip) || ip.includes(":");
}

/** Value of a `--flag <value>` option, or undefined if absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Parse an integer token; null if missing or not an integer. */
function parseIntTok(tok: string | undefined): number | null {
  if (tok === undefined || tok === "") return null;
  const n = Number(tok);
  return Number.isInteger(n) ? n : null;
}

/** Valid polling intervals: 0 (disable) or 5..300 (sflow.txt TC-40/42/44/45). */
function isValidPolling(n: number): boolean {
  return n === 0 || (n >= 5 && n <= 300);
}

const config: SonicCmd[] = [
  {
    path: ["sflow", "enable"],
    summary: "Enable sFlow globally",
    run(_args, ctx): CommandResult {
      state(ctx).enabled = true;
      return { output: [muted("sFlow enabled")] };
    },
  },
  {
    path: ["sflow", "disable"],
    summary: "Disable sFlow globally",
    run(_args, ctx): CommandResult {
      state(ctx).enabled = false;
      return { output: [muted("sFlow disabled")] };
    },
  },
  {
    path: ["sflow", "collector", "add"],
    summary: "Add an sFlow collector (--port defaults to 6343, max 2 collectors)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const ip = pos[1];
      if (!name || !ip) return { output: [err("Usage: config sflow collector add <name> <ip> [--port <port>]")] };
      if (!isCollectorIp(ip)) return { output: [err(`config sflow collector add: invalid IP address '${ip}'`)] };
      let port = DEFAULT_PORT;
      const portTok = flagValue(args, "--port");
      if (portTok !== undefined) {
        const p = parseIntTok(portTok);
        if (p === null || p < PORT_RANGE.min || p > PORT_RANGE.max) {
          return { output: [err(`config sflow collector add: port must be ${PORT_RANGE.min}-${PORT_RANGE.max} (got '${portTok}')`)] };
        }
        port = p;
      }
      const st = state(ctx);
      const existing = st.collectors.find((c) => c.name === name);
      if (existing) {
        // Re-adding an existing collector name updates it (idempotent, sflow.txt TC-76).
        existing.ip = ip;
        existing.port = port;
      } else {
        if (st.collectors.length >= MAX_COLLECTORS) {
          return { output: [err(`%Error: Max elements limit ${MAX_COLLECTORS} reached`)] };
        }
        st.collectors.push({ name, ip, port });
      }
      return { output: [muted(`sFlow collector ${name} (${ip} udp ${port}) configured`)] };
    },
  },
  {
    path: ["sflow", "collector", "del"],
    summary: "Delete an sFlow collector",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config sflow collector del <name>")] };
      const st = state(ctx);
      const before = st.collectors.length;
      st.collectors = st.collectors.filter((c) => c.name !== name);
      // Deleting a non-existent collector is a silent no-op (sflow.txt TC-78).
      return { output: [muted(st.collectors.length < before ? `sFlow collector ${name} deleted` : `sFlow collector ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["sflow", "agent-id", "add"],
    summary: "Set the sFlow agent-id interface",
    run(args, ctx): CommandResult {
      const intf = positional(args)[0];
      if (!intf) return { output: [err("Usage: config sflow agent-id add <interface>")] };
      // sflow.txt TC-82: the interface is stored verbatim without existence validation.
      state(ctx).agentId = intf;
      return { output: [muted(`sFlow agent-id set to ${intf}`)] };
    },
  },
  {
    path: ["sflow", "agent-id", "del"],
    summary: "Clear the sFlow agent-id",
    run(_args, ctx): CommandResult {
      state(ctx).agentId = undefined;
      return { output: [muted("sFlow agent-id cleared")] };
    },
  },
  {
    path: ["sflow", "polling-interval"],
    summary: "Set the sFlow counter polling interval (0 or 5-300 seconds)",
    run(args, ctx): CommandResult {
      const n = parseIntTok(positional(args)[0]);
      if (n === null || !isValidPolling(n)) {
        return { output: [err("config sflow polling-interval: interval must be 0 or 5-300")] };
      }
      state(ctx).pollingInterval = n;
      return { output: [muted(`sFlow polling-interval set to ${n}`)] };
    },
  },
  {
    path: ["sflow", "interface", "enable"],
    summary: "Enable sFlow on an interface",
    run(args, ctx): CommandResult {
      const intf = positional(args)[0];
      if (!intf) return { output: [err("Usage: config sflow interface enable <interface>")] };
      if (!interfaceByName(ctx.device, intf)) return { output: [err(`config sflow interface enable: no such interface '${intf}'`)] };
      const st = state(ctx);
      const entry = (st.interfaces[intf] ??= { enabled: false });
      entry.enabled = true;
      return { output: [muted(`sFlow enabled on ${intf}`)] };
    },
  },
  {
    path: ["sflow", "interface", "disable"],
    summary: "Disable sFlow on an interface",
    run(args, ctx): CommandResult {
      const intf = positional(args)[0];
      if (!intf) return { output: [err("Usage: config sflow interface disable <interface>")] };
      if (!interfaceByName(ctx.device, intf)) return { output: [err(`config sflow interface disable: no such interface '${intf}'`)] };
      const st = state(ctx);
      const entry = (st.interfaces[intf] ??= { enabled: false });
      entry.enabled = false;
      return { output: [muted(`sFlow disabled on ${intf}`)] };
    },
  },
  {
    path: ["sflow", "interface", "sample-rate"],
    summary: "Set the sFlow sample rate on an interface (256-8388608)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const intf = pos[0];
      if (!intf) return { output: [err("Usage: config sflow interface sample-rate <interface> <rate>")] };
      if (!interfaceByName(ctx.device, intf)) return { output: [err(`config sflow interface sample-rate: no such interface '${intf}'`)] };
      const rate = parseIntTok(pos[1]);
      if (rate === null || rate < SAMPLE_RATE_RANGE.min || rate > SAMPLE_RATE_RANGE.max) {
        return { output: [err(`config sflow interface sample-rate: rate must be ${SAMPLE_RATE_RANGE.min}-${SAMPLE_RATE_RANGE.max} (got '${pos[1]}')`)] };
      }
      const st = state(ctx);
      const entry = (st.interfaces[intf] ??= { enabled: false });
      entry.sampleRate = rate;
      return { output: [muted(`sFlow sample-rate on ${intf} set to ${rate}`)] };
    },
  },
];

function renderGlobal(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<SflowState>(ctx.device, "sflow");
  const enabled = st?.enabled ?? false;
  const polling = st?.pollingInterval;
  const agentId = st?.agentId;
  const collectors = st?.collectors ?? [];
  const out: OutputLine[] = [
    line("sFlow Global Information:"),
    line(`sFlow Admin State: ${enabled ? "up" : "down"}`),
    line(`sFlow Polling Interval: ${polling !== undefined ? polling : "default"}`),
    line(`sFlow AgentID: ${agentId ?? "default"}`),
    line(`${collectors.length} ${collectors.length === 1 ? "Collector" : "Collectors"} configured:`),
  ];
  for (const c of collectors) {
    out.push(line(`Name: ${c.name} IP addr: ${c.ip} UDP port: ${c.port} VRF: default`));
  }
  return out;
}

function renderInterfaces(ctx: CommandContext, only?: string): OutputLine[] {
  const st = peekFeatureState<SflowState>(ctx.device, "sflow");
  const names = Object.keys(st?.interfaces ?? {})
    .filter((n) => (only ? n === only : true))
    .sort();
  const out: OutputLine[] = [line("sFlow interface configurations")];
  if (names.length === 0) {
    out.push(muted("No sFlow interfaces configured"));
    return out;
  }
  for (const n of names) {
    const cfg = st!.interfaces[n];
    const rate = cfg.sampleRate ?? DEFAULT_SAMPLE_RATE;
    out.push(line(`| ${n} | ${cfg.enabled ? "up" : "down"} | ${rate} |`));
  }
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["sflow", "interface"],
    summary: "Show sFlow interface configuration (optionally one interface)",
    run: (args, ctx) => ({ output: renderInterfaces(ctx, positional(args)[0]) }),
  },
  { path: ["sflow"], summary: "Show sFlow global configuration", run: (_a, ctx) => ({ output: renderGlobal(ctx) }) },
];

export const sflowModule: SonicFeatureModule = { id: "sflow", config, show };
