/**
 * FIPS — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# crypto fips enable        store fips_mode=true
 *   sonic(config)# no crypto fips enable      unconfigure (back to default)
 *   sonic# show fips status                    render from stored state
 *
 * The real box (sonic-fips:sonic-fips/FIPS/global/fips_mode) is a single global
 * boolean in CONFIG_DB. We store exactly what was configured and render the
 * FIPS mode status on `show`. The actual cryptographic FIPS-mode enforcement and
 * the `fips self-test` operational result are runtime behaviour this sim does not
 * model — only the configured mode is stored and shown.
 */
import { line, err } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

// configure-view: [no] crypto fips enable
registerModal({
  id: "fips",
  views: ["configure-view"],
  keywords: ["crypto"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "fips") return null; // a different `crypto ...` command
    if ((args[1] ?? "").toLowerCase() !== "enable") return { output: [err("% Usage: [no] crypto fips enable")] };
    if (isNo) {
      cpUnset(ctx.device, "fips", "fips_mode");
      return { output: [] };
    }
    cpSet(ctx.device, "fips", "fips_mode", true);
    return { output: [] };
  },
});

// enable-view: show fips [status]
registerModal({
  id: "fips-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "fips") return null; // not ours
    const enabled = cpGet(ctx.device, "fips")?.fips_mode === true;
    return { output: [line(`${"FIPS Mode".padEnd(20)}: ${enabled ? "Enabled" : "Disabled"}`)] };
  },
});
