/**
 * PBO (Port Breakout / Dynamic Port Breakout, DPB) SONiC feature module.
 *
 * Per pbo.txt, PBO breaks a single physical front-panel port (e.g. 1/2) into
 * several logical sub-ports at a chosen speed profile ("breakout mode"), or
 * resets it back to a single port. Config-plane only: commands mutate per-device
 * feature state (the simulated CONFIG_DB BREAKOUT_CFG table, keyed by the master
 * port) and `show pbo ...` renders SOLELY from that stored state. Nothing touches
 * real hardware and no dynamic/ASIC state is fabricated.
 *
 * `interface` / `show interface` are reserved command roots in this simulator, so
 * the real klish forms from pbo.txt are mapped onto the ["pbo", ...] root:
 *
 *   config pbo port <p> mode <m> [num-lanes <n>] [force]
 *        <- interface breakout port <p> mode <m> [num-lanes <n>] [force]
 *   config pbo no port <p>          <- no interface breakout port <p>
 *   show pbo                        <- show interface breakout
 *   show pbo port <p>               <- show interface breakout port <p>
 *   show pbo modes                  <- show interface breakout modes
 *   show pbo resources              <- show interface breakout resources
 *   show pbo dependencies port <p>  <- show interface breakout dependencies port <p>
 *
 * Mode syntax "<count>x<speed>G[(lanes)]" (e.g. 4x200G, 1x800G, 1x400G(4)); the
 * trailing G is accepted case-insensitively (pbo.txt SM_ISCLI_P2_155 uses 8x100g)
 * and stored normalized to upper-case G.
 *
 * SIMULATION LIMITATION: which breakout modes/speeds a given port actually
 * supports, the "modes" / "resources" listings, and cross-subsystem
 * "dependencies" all come from platform data (platform.json / hwsku.json) plus
 * live ASIC/orchagent state that this config-plane simulation does not model.
 * Per pbo.txt those pieces are hardware-specific (the NEGATIVE-TEST "Invalid
 * speed" cases, SM_ISCLI_P2_4 "hwsku.json not found"), so we validate the command
 * FORM only and print a clear SIMULATION LIMITATION note instead of inventing
 * per-platform speed validity.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";

/** One BREAKOUT_CFG entry: the master port and the breakout mode applied to it. */
interface BreakoutEntry {
  port: string;
  mode: string;
  numLanes?: number;
}

interface PboState {
  breakouts: BreakoutEntry[];
}

/** Front-panel port label, e.g. "1/2" (slot/port). */
const PORT_RE = /^\d+\/\d+$/;
/** Breakout mode, e.g. 4x200G, 1x800G, 1x400G(4), 8x100g. */
const MODE_RE = /^(\d+)x(\d+)g(?:\((\d+)\))?$/i;

function state(ctx: CommandContext): PboState {
  return featureState<PboState>(ctx.device, "pbo", () => ({ breakouts: [] }));
}

/** Validate and normalize a mode string (upper-case G); null if malformed. */
function normalizeMode(tok: string): string | null {
  const m = MODE_RE.exec(tok);
  if (!m) return null;
  return `${m[1]}x${m[2]}G${m[3] ? `(${m[3]})` : ""}`;
}

const SET_USAGE = "Usage: config pbo port <slot>/<port> mode <NxSPEEDG[(lanes)]> [num-lanes <n>] [force]";

const config: SonicCmd[] = [
  {
    path: ["pbo", "port"],
    summary: "Break out a port (interface breakout port <p> mode <m> [num-lanes <n>] [force])",
    run(args, ctx): CommandResult {
      const port = args[0];
      if (!port || !PORT_RE.test(port)) {
        return { output: [err(`config pbo port: invalid port '${port ?? ""}' (expected <slot>/<port>, e.g. 1/2)`), muted(SET_USAGE)] };
      }
      if (args[1] !== "mode" || args[2] === undefined) {
        return { output: [err("config pbo port: expected 'mode <breakout-mode>'"), muted(SET_USAGE)] };
      }
      const mode = normalizeMode(args[2]);
      if (!mode) {
        return { output: [err(`config pbo port: invalid breakout mode '${args[2]}' (expected e.g. 4x200G, 1x800G, 1x400G(4))`), muted(SET_USAGE)] };
      }
      let numLanes: number | undefined;
      let force = false;
      for (let i = 3; i < args.length; i++) {
        if (args[i] === "num-lanes") {
          const n = Number(args[i + 1]);
          if (!Number.isInteger(n) || n <= 0) {
            return { output: [err(`config pbo port: num-lanes expects a positive integer (got '${args[i + 1] ?? ""}')`)] };
          }
          numLanes = n;
          i++;
        } else if (args[i] === "force") {
          force = true;
        } else {
          return { output: [err(`config pbo port: unexpected token '${args[i]}'`), muted(SET_USAGE)] };
        }
      }
      const st = state(ctx);
      const existing = st.breakouts.find((b) => b.port === port);
      if (existing) {
        existing.mode = mode;
        existing.numLanes = numLanes;
      } else {
        st.breakouts.push({ port, mode, numLanes });
      }
      const detail = `${mode}${numLanes !== undefined ? ` num-lanes ${numLanes}` : ""}${force ? " (forced)" : ""}`;
      return { output: [muted(`Breakout on port ${port} set to ${detail}`)] };
    },
  },
  {
    path: ["pbo", "no", "port"],
    summary: "Reset breakout on a port (no interface breakout port <p>)",
    run(args, ctx): CommandResult {
      const port = args[0];
      if (!port || !PORT_RE.test(port)) {
        return { output: [err(`config pbo no port: invalid port '${port ?? ""}' (expected <slot>/<port>, e.g. 1/2)`)] };
      }
      const st = state(ctx);
      const before = st.breakouts.length;
      st.breakouts = st.breakouts.filter((b) => b.port !== port);
      // Resetting a port that was never broken out is a silent no-op.
      return {
        output: [muted(st.breakouts.length < before ? `Breakout on port ${port} reset` : `Port ${port} has no breakout configured (no-op)`)],
      };
    },
  },
];

function renderAll(ctx: CommandContext): OutputLine[] {
  const breakouts = [...(peekFeatureState<PboState>(ctx.device, "pbo")?.breakouts ?? [])].sort((a, b) =>
    a.port.localeCompare(b.port, undefined, { numeric: true }),
  );
  if (breakouts.length === 0) return [muted("No breakout configured")];
  const out: OutputLine[] = [
    line(`${"Port".padEnd(10)}${"Breakout Mode".padEnd(20)}Num Lanes`),
    line(`${"-".repeat(9).padEnd(10)}${"-".repeat(13).padEnd(20)}---------`),
  ];
  for (const b of breakouts) {
    out.push(line(`${b.port.padEnd(10)}${b.mode.padEnd(20)}${b.numLanes !== undefined ? String(b.numLanes) : "-"}`));
  }
  return out;
}

function renderPort(ctx: CommandContext, port: string | undefined): OutputLine[] {
  if (!port || !PORT_RE.test(port)) return [err(`show pbo port: invalid port '${port ?? ""}' (expected <slot>/<port>, e.g. 1/2)`)];
  const b = peekFeatureState<PboState>(ctx.device, "pbo")?.breakouts.find((x) => x.port === port);
  if (!b) return [muted(`Port ${port} has no breakout configured`)];
  const out: OutputLine[] = [line(`Port          : ${b.port}`), line(`Breakout Mode : ${b.mode}`)];
  if (b.numLanes !== undefined) out.push(line(`Num Lanes     : ${b.numLanes}`));
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["pbo", "modes"],
    summary: "Show platform-supported breakout modes (show interface breakout modes)",
    run: () => ({
      output: [
        muted("SIMULATION LIMITATION: the supported breakout-mode list comes from platform.json /"),
        muted("  hwsku.json, which this config-plane simulation does not model. Per pbo.txt the set of"),
        muted("  valid modes/speeds is platform-specific (e.g. the NEGATIVE-TEST 'Invalid speed' cases),"),
        muted("  so per-port speed validity is not enforced and no mode list is shown."),
      ],
    }),
  },
  {
    path: ["pbo", "resources"],
    summary: "Show breakout resources (show interface breakout resources)",
    run: () => ({
      output: [
        muted("SIMULATION LIMITATION: breakout resource usage is system/ASIC-wide platform data"),
        muted("  (hwsku.json; see pbo.txt SM_ISCLI_P2_4) that this config-plane simulation does not model."),
      ],
    }),
  },
  {
    path: ["pbo", "dependencies", "port"],
    summary: "Show breakout dependencies for a port (show interface breakout dependencies port <p>)",
    run: (args): CommandResult => {
      const port = args[0];
      if (!port || !PORT_RE.test(port)) return { output: [err(`show pbo dependencies port: invalid port '${port ?? ""}' (expected <slot>/<port>, e.g. 1/2)`)] };
      return {
        output: [
          muted(`SIMULATION LIMITATION: breakout dependencies for port ${port} require cross-subsystem`),
          muted("  and live ASIC/orchagent state (child-port IP/VLAN membership, platform data) that this"),
          muted("  config-plane simulation does not model, so no dependency list is shown."),
        ],
      };
    },
  },
  { path: ["pbo", "port"], summary: "Show breakout config of one port (show interface breakout port <p>)", run: (args, ctx) => ({ output: renderPort(ctx, args[0]) }) },
  { path: ["pbo"], summary: "Show configured port breakouts (show interface breakout)", run: (_a, ctx) => ({ output: renderAll(ctx) }) },
];

export const pboModule: SonicFeatureModule = { id: "pbo", config, show };
