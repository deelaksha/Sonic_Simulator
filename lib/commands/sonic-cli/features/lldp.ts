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
 *   network-policy <1-128> | no network-policy  -> LLDP-MED network policy TLVs from
 *                                       that profile (lib/protocols/lldp-daemon.ts)
 *
 * Any lldp subcommand without a Click equivalent (tlv-select, tlv-set,
 * med-tlv-select, vlan-name-tlv) returns null so the grammar fallback reports it
 * as recognized-but-not-cloned.
 */
import { registerModal } from "../registry";
import { err } from "../../types";
import { interfaceByName } from "../../../models/device";
import { renderKlishLldpNeighbor, renderKlishLldpTable, setLldpNetworkPolicy } from "../../sonic/lldp";

registerModal({
  id: "lldp-network-policy",
  views: ["configure-if-view"],
  keywords: ["network-policy"],
  run({ ctx, ifname, isNo, args }) {
    if (isNo) {
      setLldpNetworkPolicy(ctx, ifname ?? "", undefined);
      return { output: [] };
    }
    const n = Number(args[0]);
    if (!Number.isInteger(n) || n < 1 || n > 128) return { output: [err("% Network policy profile number must be 1-128.")] };
    setLldpNetworkPolicy(ctx, ifname ?? "", n);
    return { output: [] };
  },
});

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

/**
 * enable-view `show lldp ...` (sonic-mgmt-framework clitree/cli-xml/lldp.xml:43-55):
 *   show lldp | show lldp table   → lldp_show.j2
 *   show lldp neighbor [<ifname>] → lldp_neighbor_show.j2 (ifname: "Ethernet0" or "Ethernet 0")
 * Both render only neighbours lldpd learned from received LLDPDUs.
 */
registerModal({
  id: "lldp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ ctx, args }) {
    if (args[0]?.toLowerCase() !== "lldp") return null;
    const sub = args[1]?.toLowerCase();
    if (sub === undefined || sub === "table") return { output: renderKlishLldpTable(ctx.device) };
    if (sub === "neighbor" || sub === "neighbors") {
      const ifname = args.length > 2 ? args.slice(2).join("") : undefined;
      if (ifname && !interfaceByName(ctx.device, ifname)) return { output: [err(`% Error: Interface ${ifname} not found`)] };
      return { output: renderKlishLldpNeighbor(ctx.device, ifname) };
    }
    return null; // statistics etc. → Click layer
  },
});
