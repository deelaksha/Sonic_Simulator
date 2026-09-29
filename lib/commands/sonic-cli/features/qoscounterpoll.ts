/**
 * QoS / buffer counter-poll (flex-counter) modal behaviour. configure-view:
 *   counterpoll <type> enable            enable polling for a type
 *   counterpoll <type> disable           disable polling for a type
 *   counterpoll <type> interval <ms>     set poll interval (ms)
 *   no counterpoll <type>                disable polling for a type
 *
 * <type> is one of the SONiC flex-counter types: port | queue | pg-drop |
 * port-buffer-drop | rif | flowcnt-trap | watermark (real KLISH keyword path;
 * see data/sonic-command-catalog). Delegates to the tested Click
 * `config counterpoll <type> <verb> [<ms>]` (lib/commands/sonic/qoscounterpoll.ts)
 * so type/interval validation, error strings and CONFIG_DB state are not
 * duplicated. The `no counterpoll <type>` KLISH form disables that type, which is
 * exactly `config counterpoll <type> disable`.
 */
import { registerModal } from "../registry";

registerModal({
  id: "qos-counterpoll",
  views: ["configure-view"],
  keywords: ["counterpoll"],
  run({ isNo, args, delegate }) {
    // `no counterpoll <type>` -> disable that type's flex-counter polling.
    if (isNo) return { output: delegate(`config counterpoll ${args.join(" ")} disable`) };
    // `counterpoll <type> enable|disable|interval <ms>` -> delegate verbatim.
    return { output: delegate(`config counterpoll ${args.join(" ")}`) };
  },
});
