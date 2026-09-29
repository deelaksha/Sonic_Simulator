/**
 * QoS / buffer counter-poll (flex-counter) SONiC feature module. Config-plane
 * only (simulated CONFIG_DB FLEX_COUNTER_TABLE): commands mutate per-device
 * feature state and `show counterpoll` renders SOLELY from that stored state.
 * This configures flex-counter POLLING (status + poll interval) — it does NOT
 * produce or fabricate any polled counter values.
 *
 * Commands are the SONiC click `config counterpoll` family (path ["counterpoll",
 * ...]); the counter types, interval ranges/defaults and error strings are taken
 * verbatim from qos_counterpoll.txt (AUTHORITATIVE):
 *
 *   config counterpoll <type> enable        <- counterpoll <type> enable
 *   config counterpoll <type> disable       <- counterpoll <type> disable
 *   config counterpoll <type> interval <ms> <- counterpoll <type> interval <ms>
 *   show counterpoll                         <- show counterpoll  (9-row table)
 *
 * From qos_counterpoll.txt:
 *   - 7 configurable types: port | queue | pg-drop | port-buffer-drop | rif |
 *     flowcnt-trap | watermark  (per-type verb set: enable | disable | interval).
 *   - Interval range & default per type (ms):
 *       port 100-30000/1000, queue 100-30000/10000, pg-drop 1000-30000/10000,
 *       port-buffer-drop 30000-300000/60000, rif 1000-30000/1000,
 *       flowcnt-trap 1000-30000/10000, watermark 1000-60000/60000.
 *   - `watermark` FANS OUT to three CONFIG_DB keys (QUEUE_WATERMARK +
 *     PG_WATERMARK + BUFFER_POOL_WATERMARK) in one command (TC-9/TC-10) — hence
 *     `show counterpoll` shows 9 rows for 7 configurable types.
 *   - enable/disable status and interval are INDEPENDENT: setting an interval on
 *     a disabled type does NOT re-enable it, and vice versa (TC-34/TC-35).
 *   - Out-of-range / non-numeric / unknown-type / trailing-token input:
 *       `% Error: Invalid input detected at "^" marker.`  (TC-15..TC-30, TC-39)
 *     interval value omitted entirely:
 *       `% Error: The command is not completed.`           (TC-37)
 *     type or verb omitted (truncated command):
 *       `% Error: Ambiguous command.`                      (TC-38)
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState } from "../../models/feature-state";

interface CounterEntry {
  enabled: boolean;
  intervalMs?: number;
}

interface CounterpollState {
  types: Record<string, CounterEntry>;
}

/** Per-type interval range/default (ms) and CONFIG_DB display keys (qos_counterpoll.txt). */
interface TypeMeta {
  min: number;
  max: number;
  default: number;
  keys: string[];
}

const TYPES: Record<string, TypeMeta> = {
  port: { min: 100, max: 30000, default: 1000, keys: ["PORT"] },
  queue: { min: 100, max: 30000, default: 10000, keys: ["QUEUE"] },
  "pg-drop": { min: 1000, max: 30000, default: 10000, keys: ["PG_DROP"] },
  "port-buffer-drop": { min: 30000, max: 300000, default: 60000, keys: ["PORT_BUFFER_DROP"] },
  rif: { min: 1000, max: 30000, default: 1000, keys: ["RIF"] },
  "flowcnt-trap": { min: 1000, max: 30000, default: 10000, keys: ["FLOW_CNT_TRAP"] },
  // watermark fans out to all three watermark keys in one command (TC-9/TC-10).
  watermark: { min: 1000, max: 60000, default: 60000, keys: ["QUEUE_WATERMARK", "PG_WATERMARK", "BUFFER_POOL_WATERMARK"] },
};

// Exact CLI error strings (qos_counterpoll.txt ERROR-STRING TAXONOMY note).
const INVALID = '% Error: Invalid input detected at "^" marker.';
const NOT_COMPLETED = "% Error: The command is not completed.";
const AMBIGUOUS = "% Error: Ambiguous command.";

/**
 * Feature state, seeded to the deterministic post-priming baseline (TC-1): every
 * configurable type enabled at its documented default interval, so `show
 * counterpoll` renders the canonical 9-row table before any explicit config.
 */
function state(ctx: CommandContext): CounterpollState {
  return featureState<CounterpollState>(ctx.device, "counterpoll", () => {
    const types: Record<string, CounterEntry> = {};
    for (const [t, meta] of Object.entries(TYPES)) types[t] = { enabled: true, intervalMs: meta.default };
    return { types };
  });
}

const config: SonicCmd[] = [
  {
    path: ["counterpoll"],
    summary: "Configure flex-counter polling per type (enable|disable|interval <ms>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const type = pos[0];
      if (!type) return { output: [err(AMBIGUOUS)] }; // `config counterpoll` (truncated)
      const meta = TYPES[type];
      if (!meta) return { output: [err(INVALID)] }; // unknown type (TC-30)
      const verb = pos[1];
      if (!verb) return { output: [err(AMBIGUOUS)] }; // verb omitted (TC-38)

      const st = state(ctx);
      const entry = st.types[type] ?? (st.types[type] = { enabled: true, intervalMs: meta.default });

      if (verb === "enable" || verb === "disable") {
        if (pos.length > 2) return { output: [err(INVALID)] }; // trailing garbage (TC-39)
        entry.enabled = verb === "enable"; // independent of interval (TC-34)
        return { output: [muted(`counterpoll ${type} ${verb}`)] };
      }

      if (verb === "interval") {
        const valTok = pos[2];
        if (valTok === undefined) return { output: [err(NOT_COMPLETED)] }; // value omitted (TC-37)
        if (pos.length > 3) return { output: [err(INVALID)] }; // trailing garbage
        if (!/^\d+$/.test(valTok)) return { output: [err(INVALID)] }; // non-numeric (TC-29)
        const ms = Number(valTok);
        if (ms < meta.min || ms > meta.max) return { output: [err(INVALID)] }; // out of range (TC-15..TC-28)
        entry.intervalMs = ms; // independent of status (TC-35)
        return { output: [muted(`counterpoll ${type} interval ${ms}`)] };
      }

      return { output: [err(INVALID)] }; // unknown verb
    },
  },
];

/** Render the `show counterpoll` type/interval/status table (9 rows, sorted by key). */
function renderTable(ctx: CommandContext): OutputLine[] {
  const st = state(ctx);
  const rows: { key: string; interval: number; enabled: boolean }[] = [];
  for (const [t, meta] of Object.entries(TYPES)) {
    const e = st.types[t] ?? { enabled: true, intervalMs: meta.default };
    const interval = e.intervalMs ?? meta.default;
    for (const key of meta.keys) rows.push({ key, interval, enabled: e.enabled });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out: OutputLine[] = [
    line(`${"Type".padEnd(24)}${"Interval (in ms)".padEnd(20)}Status`),
    line("-".repeat(56)),
  ];
  for (const r of rows) {
    out.push(line(`${r.key.padEnd(24)}${String(r.interval).padEnd(20)}${r.enabled ? "enable" : "disable"}`));
  }
  return out;
}

const show: SonicCmd[] = [
  { path: ["counterpoll"], summary: "Show flex-counter polling status/interval table", run: (_a, ctx) => ({ output: renderTable(ctx) }) },
];

export const qosCounterpollModule: SonicFeatureModule = { id: "qos-counterpoll", config, show };
