/**
 * PFC / PFC-Watchdog SONiC feature module. Config-plane only (simulated
 * CONFIG_DB): commands mutate per-device feature state and `show pfcwd ...` /
 * `show pfc ...` render SOLELY from that stored state. Nothing touches a real
 * ASIC/SAI — this is educational, and (per task §32) intentionally does NOT
 * fabricate watchdog storm/drop counters (there is no traffic engine behind it).
 *
 * Commands are the SONiC click `config pfcwd` / `config interface pfc` family.
 * The Klish/OC-CLI source cheatsheet (qos_pfc_pfcwd.txt) drives the equivalent
 * `priority-flow-control ...` forms; the fields, defaults and platform-limitation
 * notes below are taken from it (TC references in comments):
 *
 *   config pfcwd start [-a|--action drop|forward|alert] [-r|--restoration-time n]
 *                      <detection-time> [ports...]   <- priority-flow-control watchdog on ...
 *   config pfcwd stop                                <- priority-flow-control watchdog off
 *   config pfcwd interval <n>                        <- ...watchdog polling-interval <n>
 *   config pfc asymmetric <iface> on|off            <- priority-flow-control asymmetric  (GAP1)
 *   config pfc priority <iface> <0-7> on|off        <- priority-flow-control priority <list>
 *   show pfcwd config                               <- show priority-flow-control watchdog
 *   show pfcwd stats                                <- show priority-flow-control watchdog statistics
 *   show pfc asymmetric [iface] / priority [iface]  <- show qos interface <if>
 *
 * CONFIG_DB backing (qos_pfc_pfcwd.txt DB reference):
 *   PFC_WD|GLOBAL.POLL_INTERVAL                (polling interval; unset => default 100ms, TC-1)
 *   PFC_WD|<if>.{action,detection_time,restoration_time}   (per-watchdog, TC-24/26)
 *   PORT|<if>.pfc_asym                         (asymmetric, GAP1 / TC-19/22)
 *   PORT_QOS_MAP|<if>.pfc_enable               (priority list, TC-18/66/67)
 *
 * Platform limitation (task §32): on this platform asymmetric PFC is stored but
 * NOT applied in hardware (unsupported by platform/SAI) — reproduced verbatim as
 * a warning on config (TC-19) and a "(NOT APPLIED ...)" tag on show (TC-22).
 * Watchdog priority range is 0-7; a single out-of-range value is rejected (TC-67).
 * `config pfcwd stop` does NOT retain the last watchdog action/detect/restore —
 * they clear fully (TC-25).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { interfaceByName } from "../../models/device";

type WatchdogAction = "drop" | "forward" | "alert";

interface PfcwdState {
  started: boolean;
  action?: WatchdogAction;
  detectionTime?: number;
  restorationTime?: number;
  /** Global polling interval (ms); undefined => "Not Configured (default 100ms)" (TC-1). */
  pollInterval?: number;
  /** Ports the watchdog was armed on; undefined/["all"] => all ports. */
  ports?: string[];
}

interface PfcInterface {
  asymmetric?: boolean;
  priorities?: number[];
}

interface PfcState {
  pfcwd: PfcwdState;
  interfaces: Record<string, PfcInterface>;
}

function state(ctx: CommandContext): PfcState {
  return featureState<PfcState>(ctx.device, "pfc", () => ({
    pfcwd: { started: false },
    interfaces: {} as Record<string, PfcInterface>,
  }));
}

/** "on"/"off" (case-insensitive) -> boolean; else null. */
function parseOnOff(tok: string | undefined): boolean | null {
  if (tok === undefined) return null;
  const t = tok.toLowerCase();
  if (t === "on") return true;
  if (t === "off") return false;
  return null;
}

/** A whole non-negative integer, else null (rejects "abc" TC-69, "-5" TC-70). */
function parseWholeInt(tok: string | undefined): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  return Number(tok);
}

const ACTIONS: WatchdogAction[] = ["drop", "forward", "alert"];

const config: SonicCmd[] = [
  {
    path: ["pfcwd", "start"],
    summary: "Start PFC watchdog: [-a drop|forward|alert] [-r restore] <detect-time> [ports]",
    run(args, ctx): CommandResult {
      // Parse click-style options (--action/-a, --restoration-time/-r) + positionals.
      let action: WatchdogAction = "drop"; // SONiC default action (TC-26/56).
      let restoration: number | undefined;
      const pos: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--action" || a === "-a") {
          const v = (args[++i] ?? "").toLowerCase();
          if (!ACTIONS.includes(v as WatchdogAction)) {
            return { output: [err(`config pfcwd start: action must be ${ACTIONS.join("|")} (got '${v || undefined}')`)] };
          }
          action = v as WatchdogAction;
        } else if (a === "--restoration-time" || a === "-r") {
          const n = parseWholeInt(args[++i]);
          if (n === null) return { output: [err("config pfcwd start: restoration-time must be a non-negative integer")] };
          restoration = n;
        } else {
          pos.push(a);
        }
      }
      const detection = parseWholeInt(pos[0]);
      if (detection === null) {
        return { output: [err("Usage: config pfcwd start [-a drop|forward|alert] [-r <ms>] <detection-time> [ports...]")] };
      }
      const ports = pos.slice(1);
      // SONiC default restoration-time is 2 * detection-time.
      const restore = restoration ?? detection * 2;

      const st = state(ctx).pfcwd;
      st.started = true;
      st.action = action;
      st.detectionTime = detection;
      st.restorationTime = restore;
      st.ports = ports.length ? ports : ["all"];

      const out: OutputLine[] = [
        muted(`PFC watchdog started on ${st.ports.join(", ")} (action ${action}, detect ${detection}ms, restore ${restore}ms)`),
      ];
      // TC-23: restoration below 2*detection is warned but still applied.
      if (restore < detection * 2) {
        out.push(err(`%Warning: restore_time is less than 2*detect_time(${detection}) on the interface`));
      }
      return { output: out };
    },
  },
  {
    path: ["pfcwd", "stop"],
    summary: "Stop PFC watchdog (clears action/detect/restore, TC-25)",
    run(_args, ctx): CommandResult {
      const st = state(ctx).pfcwd;
      st.started = false;
      // TC-25: the last-configured action/detection/restoration are NOT retained.
      st.action = undefined;
      st.detectionTime = undefined;
      st.restorationTime = undefined;
      st.ports = undefined;
      return { output: [muted("PFC watchdog stopped")] };
    },
  },
  {
    path: ["pfcwd", "interval"],
    summary: "Set the PFC watchdog global polling interval (ms)",
    run(args, ctx): CommandResult {
      const n = parseWholeInt(positional(args)[0]);
      if (n === null) return { output: [err("Usage: config pfcwd interval <poll-interval-ms>")] };
      state(ctx).pfcwd.pollInterval = n;
      return { output: [muted(`PFC watchdog polling interval set to ${n}ms`)] };
    },
  },
  {
    path: ["pfc", "asymmetric"],
    summary: "Enable/disable asymmetric PFC on an interface (config interface pfc asymmetric)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const ifname = pos[0];
      const onoff = parseOnOff(pos[1]);
      if (!ifname || onoff === null) {
        return { output: [err("Usage: config pfc asymmetric <interface> on|off")] };
      }
      if (!interfaceByName(ctx.device, ifname)) {
        return { output: [err(`config pfc asymmetric: interface ${ifname} not found`)] };
      }
      const st = state(ctx);
      const intf = (st.interfaces[ifname] ??= {});
      intf.asymmetric = onoff;
      const out: OutputLine[] = [muted(`asymmetric PFC ${onoff ? "on" : "off"} on ${ifname}`)];
      // §32 / TC-19: stored in CONFIG_DB but not applied by this platform/SAI.
      if (onoff) {
        out.push(
          err(
            `Warning: asymmetric PFC could not be applied on ${ifname}: not supported by this platform/SAI. Configuration is stored but not active in hardware.`,
          ),
        );
      }
      return { output: out };
    },
  },
  {
    path: ["pfc", "priority"],
    summary: "Enable/disable a PFC lossless priority (0-7) on an interface",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const ifname = pos[0];
      const prio = parseWholeInt(pos[1]);
      const onoff = parseOnOff(pos[2]);
      if (!ifname || onoff === null || prio === null) {
        return { output: [err("Usage: config pfc priority <interface> <0-7> on|off")] };
      }
      if (!interfaceByName(ctx.device, ifname)) {
        return { output: [err(`config pfc priority: interface ${ifname} not found`)] };
      }
      // TC-67: a single out-of-range priority (valid 0-7) is rejected.
      if (prio < 0 || prio > 7) {
        return { output: [err(`config pfc priority: invalid priority ${prio} (valid range 0-7)`)] };
      }
      const st = state(ctx);
      const intf = (st.interfaces[ifname] ??= {});
      const list = new Set(intf.priorities ?? []);
      if (onoff) list.add(prio);
      else list.delete(prio);
      intf.priorities = [...list].sort((a, b) => a - b);
      return { output: [muted(`PFC priority ${prio} ${onoff ? "on" : "off"} on ${ifname} (now: ${intf.priorities.join(",") || "none"})`)] };
    },
  },
];

function pollLine(st: PfcwdState | undefined): OutputLine {
  // TC-1: unset polling interval renders as the default-100ms notice.
  return st?.pollInterval !== undefined
    ? line(`Polling Interval:   ${st.pollInterval}ms`)
    : line("Polling Interval:   Not Configured (default 100ms)");
}

function renderPfcwdConfig(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<PfcState>(ctx.device, "pfc")?.pfcwd;
  const out: OutputLine[] = [line("Watchdog Summary"), line("----------------"), pollLine(st)];
  if (!st?.started) {
    out.push(muted("PFC watchdog: not started"));
    return out;
  }
  out.push(line("PFC watchdog: started"), line(""));
  const IFW = 12, AW = 10, DW = 16;
  out.push(line(`${"PORT".padEnd(IFW)}${"ACTION".padEnd(AW)}${"DETECTION TIME".padEnd(DW)}RESTORATION TIME`));
  out.push(line(`${"-".repeat(IFW - 2).padEnd(IFW)}${"-".repeat(AW - 2).padEnd(AW)}${"-".repeat(DW - 2).padEnd(DW)}----------------`));
  for (const p of st.ports ?? ["all"]) {
    out.push(line(`${p.padEnd(IFW)}${(st.action ?? "drop").padEnd(AW)}${`${st.detectionTime}ms`.padEnd(DW)}${st.restorationTime}ms`));
  }
  return out;
}

function renderPfcwdStats(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<PfcState>(ctx.device, "pfc")?.pfcwd;
  const out: OutputLine[] = [
    // §32: no storm/drop counters are simulated — do not fabricate them.
    muted("PFC watchdog per-queue storm/drop counters are not simulated (config-plane only)."),
  ];
  if (st?.started) {
    out.push(muted(`Watchdog armed on ${(st.ports ?? ["all"]).join(", ")} (action ${st.action ?? "drop"}); no live counters available.`));
  } else {
    out.push(muted("PFC watchdog not started."));
  }
  return out;
}

function renderAsymmetric(ctx: CommandContext, only?: string): OutputLine[] {
  const intfs = peekFeatureState<PfcState>(ctx.device, "pfc")?.interfaces ?? {};
  const names = Object.keys(intfs)
    .filter((n) => (only ? n === only : true) && intfs[n].asymmetric !== undefined)
    .sort();
  if (names.length === 0) return [muted("No interfaces with asymmetric PFC configured")];
  const out: OutputLine[] = [line(`${"Interface".padEnd(13)}Asymmetric`)];
  for (const n of names) {
    // TC-22: an enabled-but-unsupported interface is tagged NOT APPLIED.
    const val = intfs[n].asymmetric ? "on  (NOT APPLIED -- unsupported by platform)" : "off";
    out.push(line(`${n.padEnd(13)}${val}`));
  }
  return out;
}

function renderPriority(ctx: CommandContext, only?: string): OutputLine[] {
  const intfs = peekFeatureState<PfcState>(ctx.device, "pfc")?.interfaces ?? {};
  const names = Object.keys(intfs)
    .filter((n) => (only ? n === only : true) && (intfs[n].priorities?.length ?? 0) > 0)
    .sort();
  if (names.length === 0) return [muted("No interfaces with PFC priorities configured")];
  const out: OutputLine[] = [line(`${"Interface".padEnd(13)}PFC Priorities`)];
  for (const n of names) out.push(line(`${n.padEnd(13)}${intfs[n].priorities!.join(",")}`));
  return out;
}

const show: SonicCmd[] = [
  { path: ["pfcwd", "config"], summary: "Show PFC watchdog global + per-port config", run: (_a, ctx) => ({ output: renderPfcwdConfig(ctx) }) },
  { path: ["pfcwd", "stats"], summary: "Show PFC watchdog statistics (not simulated)", run: (_a, ctx) => ({ output: renderPfcwdStats(ctx) }) },
  { path: ["pfc", "asymmetric"], summary: "Show asymmetric PFC per interface", run: (a, ctx) => ({ output: renderAsymmetric(ctx, positional(a)[0]) }) },
  { path: ["pfc", "priority"], summary: "Show PFC priorities per interface", run: (a, ctx) => ({ output: renderPriority(ctx, positional(a)[0]) }) },
  {
    path: ["pfc"],
    summary: "Show PFC (asymmetric + priorities) per interface",
    run(_a, ctx): CommandResult {
      return { output: [...renderAsymmetric(ctx), line(""), ...renderPriority(ctx)] };
    },
  },
];

export const qosPfcModule: SonicFeatureModule = { id: "qos-pfc-pfcwd", config, show };
