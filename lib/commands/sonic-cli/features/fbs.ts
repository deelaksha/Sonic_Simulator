/**
 * FBS (Flow-Based Services) modal behaviour. Only the config commands whose real
 * KLISH form lives in a view the engine can currently enter are wired here; each
 * delegates to the tested `config fbs ...` Click commands (lib/commands/sonic/fbs.ts):
 *
 *   configure-if-view / -vlan-view / -lag-view:
 *     service-policy type <t> <in|out> <policy>   bind a policy-map to the interface
 *     no service-policy type <t> <in|out>         remove that type/direction binding
 *   configure-view:
 *     no policy-map <name>                         delete a policy-map
 *     no class-map <name>                          delete a class-map
 *
 * The class-map/policy-map/pbf CREATE commands and all match/set/police/class
 * criteria live in dedicated FBS sub-views (configure-policy-view,
 * configure-*-classifier-view, configure-*-flow-view, the pbf next-hop/replication
 * group views) which the engine cannot enter yet, so they are skipped here.
 */
import { err, muted } from "../../types";
import { registerModal } from "../registry";
import { peekFeatureState } from "../../../models/feature-state";

/**
 * Read-only shape of the FBS state owned by lib/commands/sonic/fbs.ts. Used only
 * to resolve the policy name for `no service-policy`, whose KLISH form omits it
 * (`no service-policy type <t> <in|out>`) while the Click `unbind` requires it.
 */
interface FbsStatePeek {
  policies: { name: string; type: string }[];
  bindings: { policy: string; iface: string; direction: string }[];
}

const DIRECTIONS = ["in", "out"];
const USAGE = err("% Usage: service-policy type <type> <in|out> <policy>");

registerModal({
  id: "fbs",
  views: ["configure-view", "configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["service-policy", "policy-map", "class-map"],
  run({ view, head, isNo, args, ifname, ctx, delegate }) {
    // configure-view: only the `no` deletes — the create forms enter FBS sub-views.
    if (view === "configure-view") {
      if (head === "policy-map") {
        if (!isNo) return null; // `policy-map <name> type ...` enters a sub-mode (skipped)
        if (!args[0]) return { output: [err("% policy-map name required.")] };
        return { output: delegate(`config fbs policy del ${args[0]}`) };
      }
      if (head === "class-map") {
        if (!isNo) return null; // `class-map <name> match-type ...` enters a sub-mode (skipped)
        if (!args[0]) return { output: [err("% class-map name required.")] };
        return { output: delegate(`config fbs classifier del ${args[0]}`) };
      }
      return null; // switch/global service-policy binds to "Switch", not modelled here
    }

    // Interface-family views: service-policy bind / unbind.
    if (head !== "service-policy") return null;
    const iface = ifname ?? "";
    // KLISH: service-policy type <type> <in|out> [<policy>]
    if (args[0]?.toLowerCase() !== "type") return { output: [USAGE] };
    const type = args[1]?.toLowerCase();
    const dir = args[2]?.toLowerCase() ?? "";
    if (!type || !DIRECTIONS.includes(dir)) return { output: [USAGE] };

    if (isNo) {
      // KLISH omits the policy name here; resolve it from the stored binding.
      const st = peekFeatureState<FbsStatePeek>(ctx.device, "fbs");
      const bound = st
        ? st.bindings.find(
            (b) => b.iface === iface && b.direction === dir && st.policies.find((p) => p.name === b.policy)?.type === type,
          )
        : undefined;
      if (!bound) return { output: [muted(`${iface}: no ${type} service-policy bound ${dir} (no-op)`)] };
      return { output: delegate(`config fbs unbind ${bound.policy} ${iface} ${dir}`) };
    }

    const policy = args[3];
    if (!policy) return { output: [USAGE] };
    return { output: delegate(`config fbs bind ${policy} ${iface} ${dir}`) };
  },
});
