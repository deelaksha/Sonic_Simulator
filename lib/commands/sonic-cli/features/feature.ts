/**
 * Feature management — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# feature state <name> <enabled|disabled>       store FEATURE|<name>:state
 *   sonic(config)# feature autorestart <name> <enabled|disabled> store FEATURE|<name>:auto_restart
 *   sonic(config)# no feature <name>                             clear stored config for <name>
 *   sonic# show feature status [<name>]                          render Feature/State/AutoRestart
 *   sonic# show feature autorestart [<name>]                     render Feature/AutoRestart
 *   sonic# show feature config [<name>]                          render Feature/State/AutoRestart
 *
 * Mirrors the real box's CONFIG_DB FEATURE table (`config feature state|autorestart`).
 * State / AutoRestart shown by `show feature status` are configured values, not
 * runtime data — we reflect only what was set. The real box also STARTS/STOPS the
 * systemd service when a feature is toggled; that runtime effect is NOT simulated.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";

type FeatureRow = { name: string; state?: string; autorestart?: string };

const STATES = ["enabled", "disabled"];

// enable/disable a feature, or set its auto-restart policy — writes CONFIG_DB FEATURE table.
registerModal({
  id: "feature",
  views: ["configure-view"],
  keywords: ["feature"],
  run({ isNo, args, ctx }) {
    if (isNo) {
      const name = args[0];
      if (!name) return { output: [err("% Usage: no feature <name>")] };
      cpRemove(ctx.device, "feature", "features", "name", name);
      return { output: [] };
    }
    const sub = (args[0] ?? "").toLowerCase();
    if (sub !== "state" && sub !== "autorestart")
      return { output: [err("% Usage: feature <state|autorestart> <name> <enabled|disabled>")] };
    const name = args[1];
    if (!name) return { output: [err("% feature name required")] };
    const value = (args[2] ?? "").toLowerCase();
    if (!STATES.includes(value))
      return { output: [err(`% ${sub} must be one of ${STATES.join("|")}`)] };
    const field = sub === "state" ? "state" : "autorestart";
    cpUpsert(ctx.device, "feature", "features", { name, [field]: value }, "name");
    return { output: [] };
  },
});

// tabulate "simple"-style table: header, dashed separator, then rows.
function table(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").replace(/\s+$/, "");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(fmt(headers)), line(sep), ...rows.map((r) => line(fmt(r)))];
}

// show feature status|autorestart|config [<name>] — render from stored FEATURE config.
registerModal({
  id: "feature-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "feature") return null; // not ours
    const sub = (args[1] ?? "status").toLowerCase();
    if (!["status", "autorestart", "config"].includes(sub))
      return { output: [err("% Usage: show feature <status|autorestart|config> [<name>]")] };
    const filter = args[2];
    let feats = (cpList(ctx.device, "feature", "features") as FeatureRow[]).slice();
    if (filter) feats = feats.filter((f) => f.name === filter);
    feats.sort((a, b) => a.name.localeCompare(b.name));
    if (!feats.length) return { output: [muted("No features configured")] };
    if (sub === "autorestart")
      return { output: table(["Feature", "AutoRestart"], feats.map((f) => [f.name, f.autorestart ?? ""])) };
    return { output: table(["Feature", "State", "AutoRestart"], feats.map((f) => [f.name, f.state ?? "", f.autorestart ?? ""])) };
  },
});
