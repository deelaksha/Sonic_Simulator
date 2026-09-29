/**
 * Errdisable — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# errdisable recovery cause <udld|bpduguard|link-flap|coa>   enable a cause
 *   sonic(config)# no errdisable recovery cause <cause>                       disable a cause
 *   sonic(config)# errdisable recovery interval <30..65535>                   set recovery interval
 *   sonic(config)# no errdisable recovery interval                           reset interval to default (300)
 *   sonic# show errdisable [recovery]                                         render recovery table from stored state
 *   sonic# show errdisable link-flap                                          per-interface operational state (not simulated)
 *
 * Config-plane-only: the config commands write to the config-plane store and
 * `show errdisable recovery` renders exactly what was configured. The DATA-plane
 * effect (ports actually transitioning to err-disabled and auto-recovering after
 * the interval) is NOT simulated — only the CONFIG_DB values are modelled.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpGet, cpUpsert, cpRemove, cpList, cpSet, cpUnset } from "../config-plane";

// Valid recovery causes accepted by `errdisable recovery cause` (from KLISH grammar).
const CAUSES = ["udld", "bpduguard", "link-flap", "coa"];
// Causes rendered in the `show errdisable recovery` table (matches golden order).
const RECOVERY_CAUSES = ["udld", "coa", "bpduguard"];
const DEFAULT_INTERVAL = 300;

registerModal({
  id: "errdisable",
  views: ["configure-view"],
  keywords: ["errdisable"],
  run({ isNo, args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "recovery") {
      return { output: [err("% Invalid input: expected 'errdisable recovery ...'")] };
    }
    const what = (args[1] ?? "").toLowerCase();

    if (what === "cause") {
      const cause = (args[2] ?? "").toLowerCase();
      if (!CAUSES.includes(cause)) {
        return { output: [err(`% errdisable cause must be one of ${CAUSES.join("|")}`)] };
      }
      if (isNo) cpRemove(ctx.device, "errdisable", "causes", "cause", cause);
      else cpUpsert(ctx.device, "errdisable", "causes", { cause }, "cause");
      return { output: [] };
    }

    if (what === "interval") {
      if (isNo) {
        cpUnset(ctx.device, "errdisable", "interval");
        return { output: [] };
      }
      const n = Number(args[2]);
      if (!Number.isInteger(n) || n < 30 || n > 65535) {
        return { output: [err("% recovery interval must be an integer in 30..65535")] };
      }
      cpSet(ctx.device, "errdisable", "interval", n);
      return { output: [] };
    }

    return { output: [err("% Invalid input: expected 'cause' or 'interval'")] };
  },
});

registerModal({
  id: "errdisable-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "errdisable") return null; // not ours
    const sub = (args[1] ?? "").toLowerCase();

    // `show errdisable link-flap` is per-interface OPERATIONAL state (which ports
    // flapped, current status) — runtime data the sim does not fabricate. Only the
    // configured recovery enable is reflected.
    if (sub === "link-flap") {
      const enabled = cpList(ctx.device, "errdisable", "causes").some((c) => c.cause === "link-flap");
      return {
        output: [
          line(`link-flap recovery: ${enabled ? "enabled" : "disabled"}`),
          muted("Per-interface link-flap operational state is not simulated"),
        ],
      };
    }

    // `show errdisable` and `show errdisable recovery` render the recovery table.
    const configured = new Set(cpList(ctx.device, "errdisable", "causes").map((c) => c.cause));
    const interval = (cpGet(ctx.device, "errdisable")?.interval as number | undefined) ?? DEFAULT_INTERVAL;
    const out = [
      line("Errdisable Cause    Status"),
      line("------------------  --------"),
      ...RECOVERY_CAUSES.map((c) => line(`${c.padEnd(20)}${configured.has(c) ? "enabled" : "disabled"}`)),
      line(`Timeout for Auto-recovery:  ${interval} seconds`),
    ];
    return { output: out };
  },
});
