/**
 * LLDP modal behaviour. Maps the real KLISH `lldp ...` config commands onto the
 * existing, tested Click `config lldp ...` family (see lib/commands/sonic/lldp.ts)
 * via a.delegate, so no engine behaviour is duplicated.
 *
 * configure-view (global) — grammar: data/device-capture/klish-xml/lldp.xml:
 *   lldp enable                         -> config lldp enable
 *   no lldp enable                      -> config lldp disable
 *   lldp receive|transmit               -> config lldp receive|transmit
 *   no lldp receive|transmit            -> config lldp no-receive|no-transmit
 *   lldp timer <5-254>                  -> config lldp timer <n>
 *   no lldp timer                       -> config lldp no-timer
 *   lldp multiplier <1-10>              -> config lldp multiplier <n>
 *   no lldp multiplier                  -> config lldp no-multiplier
 *   lldp system-name <name>            -> config lldp system-name <name>
 *   no lldp system-name                -> config lldp no-system-name
 *   lldp system-description <text>     -> config lldp system-description <text>
 *   no lldp system-description         -> config lldp no-system-description
 *
 * configure-if-view (physical interface):
 *   lldp enable                         -> config lldp interface <port> enable
 *   no lldp enable                      -> config lldp interface <port> disable
 *   lldp receive|transmit               -> config lldp interface <port> receive|transmit
 *   no lldp receive|transmit            -> config lldp interface <port> no-receive|no-transmit
 *
 * Any lldp subcommand without a Click equivalent (tlv-select, tlv-set,
 * med-tlv-select, vlan-name-tlv, and the `network-policy` command) returns null
 * so the grammar fallback reports it as recognized-but-not-cloned.
 */
import { registerModal } from "../registry";

registerModal({
  id: "lldp",
  views: ["configure-view", "configure-if-view"],
  keywords: ["lldp"],
  run({ view, isNo, args, ifname, delegate }) {
    const sub = args[0]?.toLowerCase();

    if (view === "configure-if-view") {
      const port = ifname ?? "";
      switch (sub) {
        case "enable":
          return { output: delegate(`config lldp interface ${port} ${isNo ? "disable" : "enable"}`) };
        case "receive":
          return { output: delegate(`config lldp interface ${port} ${isNo ? "no-receive" : "receive"}`) };
        case "transmit":
          return { output: delegate(`config lldp interface ${port} ${isNo ? "no-transmit" : "transmit"}`) };
        default:
          return null; // tlv-set / med-tlv-select / tlv-select / vlan-name-tlv: no Click equivalent
      }
    }

    // configure-view (global)
    switch (sub) {
      case "enable":
        return { output: delegate(`config lldp ${isNo ? "disable" : "enable"}`) };
      case "receive":
        return { output: delegate(`config lldp ${isNo ? "no-receive" : "receive"}`) };
      case "transmit":
        return { output: delegate(`config lldp ${isNo ? "no-transmit" : "transmit"}`) };
      case "timer":
        return { output: delegate(`config lldp ${isNo ? "no-timer" : `timer ${args[1] ?? ""}`}`) };
      case "multiplier":
        return { output: delegate(`config lldp ${isNo ? "no-multiplier" : `multiplier ${args[1] ?? ""}`}`) };
      case "system-name":
        return { output: delegate(`config lldp ${isNo ? "no-system-name" : `system-name ${args[1] ?? ""}`}`) };
      case "system-description":
        return {
          output: delegate(
            `config lldp ${isNo ? "no-system-description" : `system-description ${args.slice(1).join(" ")}`}`,
          ),
        };
      default:
        return null; // tlv-select: no Click equivalent -> grammar fallback
    }
  },
});
