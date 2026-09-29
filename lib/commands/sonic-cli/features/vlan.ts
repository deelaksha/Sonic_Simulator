/**
 * VLAN modal behaviour (reference feature). configure-view:
 *   vlan <id|range>          create VLAN(s)
 *   no vlan <id|range>       delete VLAN(s)
 * Delegates to the tested Click `config vlan add/del` so behaviour is not duplicated.
 */
import { err } from "../../types";
import { registerModal } from "../registry";
import { expandVlanSpec } from "../util";

registerModal({
  id: "vlan",
  views: ["configure-view"],
  keywords: ["vlan"],
  run({ isNo, args, delegate }) {
    const ids = expandVlanSpec(args[0] ?? "");
    if (!ids) return { output: [err(`% Invalid VLAN "${args[0] ?? ""}".`)] };
    const output = ids.flatMap((id) => delegate(`config vlan ${isNo ? "del" : "add"} ${id}`));
    return { output };
  },
});
