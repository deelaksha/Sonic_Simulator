/**
 * simctl — SIMULATOR-ONLY control command (real SONiC has no such command).
 * Lets a learner or a mission switch a switch's data-plane model from its own
 * terminal, the same setting as the GUI's "Data plane" toggle
 * (features["dataplane-mode"], store setDataplaneMode):
 *   vs        SONiC-VS: the Linux kernel forwards, tcpdump sees all traffic
 *   hardware  ASIC: forwarding in hardware, tcpdump sees only CPU (trapped / sent) frames
 */
import { CommandHandler, CommandResult, line, err, muted } from "./types";
import { isSwitch } from "../models/device";

const USAGE = "Usage: simctl dataplane [hardware|vs]";

export const simctlCommand: CommandHandler = {
  name: "simctl",
  summary: "Simulator-only controls (data-plane mode) — not a SONiC command",
  usage: "simctl dataplane [hardware|vs]",
  help: [
    "SIMCTL  (simulator-only — real SONiC has no such command)",
    "",
    "Usage:",
    "  simctl dataplane              show this switch's data-plane model",
    "  simctl dataplane hardware     hardware ASIC: tcpdump sees only CPU traffic",
    "  simctl dataplane vs           SONiC-VS: the kernel forwards, tcpdump sees everything",
    "",
    "Same setting as the GUI inspector's \"Data plane\" toggle.",
  ],
  run(args, ctx): CommandResult {
    if (args[0] !== "dataplane" || args.length > 2) return { output: [err(USAGE)] };
    if (!isSwitch(ctx.device.type)) return { output: [err("simctl: the data-plane mode only applies to a switch")] };
    const features = (ctx.device.config.features ??= {});
    const mode = args[1];
    if (!mode) {
      const cur = (features["dataplane-mode"] as { mode?: string } | undefined)?.mode === "hardware" ? "hardware" : "vs";
      return { output: [line(`dataplane: ${cur}`)] };
    }
    if (mode !== "hardware" && mode !== "vs") return { output: [err(USAGE)] };
    features["dataplane-mode"] = { mode };
    return { output: [muted(`dataplane set to ${mode} (simulator setting)`)] };
  },
};
