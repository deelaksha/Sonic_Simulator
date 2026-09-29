/**
 * SNMP modal behaviour. configure-view (KLISH "snmp-server ..." family), mapped
 * onto the tested Click `config snmp ...` commands so nothing is duplicated:
 *
 *   snmp-server location <text>        -> config snmp location add <text>
 *   no snmp-server location            -> config snmp location del
 *   snmp-server contact <text>         -> config snmp contact add <text>
 *   no snmp-server contact             -> config snmp contact del
 *   snmp-server community <name>       -> config snmp community add <name>
 *   no snmp-server community <name>    -> config snmp community del <name>
 *   snmp-server user <name>            -> config snmp user add <name>
 *   no snmp-server user <name>         -> config snmp user del <name>
 *
 * Only the sub-commands the Click module actually models are wired. The KLISH
 * optional `community ... group <g>` / `user ... group|auth|priv ...` extras have
 * no Click equivalent, so the community/user is still created but those extra
 * attributes are dropped. Everything else in the grammar (snmp-server
 * enable/engine/agentaddress/group/view/host and the per-interface `snmp trap`)
 * has no Click command, so this handler returns null for it and the engine falls
 * back to its "recognized but not cloned" grammar handling.
 */
import { err } from "../../types";
import { registerModal } from "../registry";

registerModal({
  id: "snmp",
  views: ["configure-view"],
  keywords: ["snmp-server"],
  run({ isNo, args, delegate }) {
    const sub = args[0]?.toLowerCase();
    const rest = args.slice(1);

    if (sub === "location") {
      if (isNo) return { output: delegate("config snmp location del") };
      const text = rest.join(" ").trim();
      if (!text) return { output: [err("% SNMP location text required.")] };
      return { output: delegate(`config snmp location add ${text}`) };
    }

    if (sub === "contact") {
      if (isNo) return { output: delegate("config snmp contact del") };
      const text = rest.join(" ").trim();
      if (!text) return { output: [err("% SNMP contact text required.")] };
      return { output: delegate(`config snmp contact add ${text}`) };
    }

    if (sub === "community") {
      const name = rest[0];
      if (!name) return { output: [err("% SNMP community name required.")] };
      // KLISH allows an optional `group <group-name>` the Click layer does not
      // model; the community is still created, the group association is dropped.
      return { output: delegate(`config snmp community ${isNo ? "del" : "add"} ${name}`) };
    }

    if (sub === "user") {
      const name = rest[0];
      if (!name) return { output: [err("% SNMP user name required.")] };
      // KLISH allows optional group/auth/priv params the Click layer does not
      // model; the user is still created, those extra attributes are dropped.
      return { output: delegate(`config snmp user ${isNo ? "del" : "add"} ${name}`) };
    }

    // enable/engine/agentaddress/group/view/host and bare "snmp-server": no Click
    // equivalent -> not ours, fall through to the grammar fallback.
    return null;
  },
});
