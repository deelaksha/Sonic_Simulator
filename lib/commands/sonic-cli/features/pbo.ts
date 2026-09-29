/**
 * PBO (Dynamic Port Breakout) modal behaviour. configure-view only.
 *
 * Real KLISH (data/device-capture/klish-xml/dynamic_port_breakout.xml,
 * VIEW configure-view):
 *   interface breakout port <p> mode <m> [total-lane-count <n>]
 *   no interface breakout port <p>
 *   auto-breakout / no auto-breakout
 *
 * The modal engine reserves the `interface` (and `show interface`) command root
 * for per-interface mode-entry: `configMode` intercepts head === "interface"
 * before feature handlers run, so the real `interface breakout ...` form can
 * never reach a handler here. The tested Click pbo module hit the SAME
 * reservation and therefore exposes breakout under a dedicated `config pbo`
 * root (see lib/commands/sonic/pbo.ts). We follow that established simulator
 * convention at the modal layer, delegating straight to those Click commands:
 *
 *   pbo port <p> mode <m> [num-lanes <n>] [force]  -> config pbo port <p> mode <m> ...
 *   no pbo port <p>                                -> config pbo no port <p>
 *
 * Validation and all output (success note / errors) come from the Click module,
 * so nothing is duplicated or faked here.
 *
 * NOT wired (see structured "skipped"):
 *   - auto-breakout / no auto-breakout : the Click pbo module models only
 *     per-port breakout (BREAKOUT_CFG); the global DEVICE_METADATA auto-breakout
 *     flag has no Click command, so we don't fake it.
 */
import { registerModal } from "../registry";

registerModal({
  id: "pbo",
  views: ["configure-view"],
  keywords: ["pbo"],
  run({ isNo, args, delegate }) {
    // Only the per-port breakout set/reset has a tested Click backing.
    if (args[0]?.toLowerCase() !== "port") return null;
    const cmd = ["config", "pbo", ...(isNo ? ["no"] : []), "port", ...args.slice(1)];
    return { output: delegate(cmd.join(" ")) };
  },
});
