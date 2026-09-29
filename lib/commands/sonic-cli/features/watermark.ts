/**
 * Watermark — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# watermark interval <1-600>            store snapshot interval
 *   sonic(config)# watermark telemetry interval <1-600>  store telemetry interval
 *   sonic(config)# no watermark interval                 clear snapshot interval
 *   sonic(config)# no watermark telemetry [interval]     clear telemetry interval
 *   sonic(config)# no watermark                          clear both
 *   sonic# show watermark interval                       Snapshot interval : N seconds
 *   sonic# show watermark telemetry interval             Telemetry interval : N seconds
 *
 * These intervals live in CONFIG_DB (SNAPSHOT_TABLE / WATERMARK_TABLE). We store
 * exactly what is configured and render it back on `show`. The runtime effect of
 * the intervals (periodic watermark-counter snapshots / telemetry) is NOT
 * simulated — the sim has no watermark counters to sample.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

/** Parse a RANGE_1_600 interval value; null if not a valid 1-600 integer. */
function parseInterval(tok: string | undefined): number | null {
  if (!tok) return null;
  const n = Number(tok);
  if (!Number.isInteger(n) || n < 1 || n > 600) return null;
  return n;
}

registerModal({
  id: "watermark",
  views: ["configure-view"],
  keywords: ["watermark"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    if (isNo) {
      if (!sub) {
        // no watermark — remove both intervals
        cpUnset(ctx.device, "watermark", "snapshotInterval");
        cpUnset(ctx.device, "watermark", "telemetryInterval");
        return { output: [] };
      }
      if (sub === "interval") {
        cpUnset(ctx.device, "watermark", "snapshotInterval");
        return { output: [] };
      }
      if (sub === "telemetry") {
        cpUnset(ctx.device, "watermark", "telemetryInterval");
        return { output: [] };
      }
      return { output: [err("% watermark: expected interval|telemetry")] };
    }

    if (!sub) return { output: [] }; // bare `watermark` — parent command, no-op

    if (sub === "interval") {
      const v = parseInterval(args[1]);
      if (v == null) return { output: [err("% watermark interval must be 1-600 seconds")] };
      cpSet(ctx.device, "watermark", "snapshotInterval", v);
      return { output: [] };
    }
    if (sub === "telemetry") {
      if ((args[1] ?? "").toLowerCase() !== "interval") return { output: [err("% expected: watermark telemetry interval <1-600>")] };
      const v = parseInterval(args[2]);
      if (v == null) return { output: [err("% watermark telemetry interval must be 1-600 seconds")] };
      cpSet(ctx.device, "watermark", "telemetryInterval", v);
      return { output: [] };
    }
    return { output: [err("% watermark: expected interval|telemetry")] };
  },
});

registerModal({
  id: "watermark-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "watermark") return null; // not ours
    const sub = (args[1] ?? "").toLowerCase();
    if (sub && sub !== "interval" && sub !== "telemetry") return null; // counters etc — not ours

    const st = cpGet(ctx.device, "watermark") ?? {};
    const snap = st.snapshotInterval != null
      ? line(`Snapshot interval : ${st.snapshotInterval} seconds`)
      : muted("Snapshot interval : not configured");
    const tele = st.telemetryInterval != null
      ? line(`Telemetry interval : ${st.telemetryInterval} seconds`)
      : muted("Telemetry interval : not configured");

    if (sub === "interval") return { output: [snap] };
    if (sub === "telemetry") return { output: [tele] };
    return { output: [snap, tele] };
  },
});
