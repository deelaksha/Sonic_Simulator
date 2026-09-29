/**
 * Coredump — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# core enable        store enabled=true
 *   sonic(config)# no core            store enabled=false (disable)
 *   sonic# show core config           render admin state from stored value
 *   sonic# show core list|info        operational crash data — none in the sim
 *
 * Real CONFIG_DB models this as COREDUMP|config { enabled: "true" }, which is
 * the shipped default, so `show core config` reflects Enabled until `no core`
 * disables it. The core-file LIST/INFO are runtime data produced by real kernel
 * crashes; the simulator has no crashing processes, so we never fabricate them.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpGet } from "../config-plane";

registerModal({
  id: "coredump",
  views: ["configure-view"],
  keywords: ["core"],
  run({ isNo, args, ctx }) {
    if (isNo) {
      // `no core` disables the feature (dbpath enabled=false), not a removal.
      cpSet(ctx.device, "coredump", "enabled", false);
      return { output: [] };
    }
    if ((args[0] ?? "").toLowerCase() === "enable") {
      cpSet(ctx.device, "coredump", "enabled", true);
      return { output: [] };
    }
    return { output: [err("% Usage: core enable | no core")] };
  },
});

registerModal({
  id: "coredump-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "core") return null; // not ours
    const sub = (args[1] ?? "").toLowerCase();
    if (sub === "config") {
      // Default reflects the real box CONFIG_DB default (enabled=true).
      const enabled = cpGet(ctx.device, "coredump")?.enabled !== false;
      return { output: [line(`Coredump : ${enabled ? "Enabled" : "Disabled"}`)] };
    }
    if (sub === "list" || sub === "info" || sub === "") {
      // Core files are runtime data from real kernel crashes; the simulator
      // has no crashing processes, so there are none to report — never faked.
      return { output: [muted("No core files present")] };
    }
    return { output: [err(`% Unknown show core subcommand "${args[1] ?? ""}"`)] };
  },
});
