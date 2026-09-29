/**
 * BGP modal behaviour (reference feature for SUB-MODE cloning).
 *
 *   sonic(config)# router bgp 65001            -> sets the local AS + enters the sub-view
 *   sonic(config-router-bgp)# router-id 1.1.1.1
 *   sonic(config-router-bgp)# neighbor 10.0.0.2 remote-as 65002
 *   sonic(config-router-bgp)# network 10.1.1.0/24
 *   sonic(config-router-bgp)# no neighbor 10.0.0.2
 *
 * Entry runs its effect (config router bgp <as>) AND enters the sub-view via
 * `enter: subViewFrame(...)`. In the sub-view we delegate to the tested Click
 * `config router bgp ...` commands. Behaviour/output are not duplicated or faked.
 */
import { err } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";

// configure-view: `router bgp <as>` — apply the AS, then drop into the BGP sub-view.
registerModal({
  id: "bgp-enter",
  views: ["configure-view"],
  keywords: ["router"],
  run({ isNo, args, delegate }) {
    if (args[0]?.toLowerCase() !== "bgp") return null; // not ours (e.g. `router ospf`)
    const as = args[1];
    if (isNo) return { output: delegate("config router bgp no") };
    if (!as) return { output: [err("% AS number required.")] };
    return { output: delegate(`config router bgp ${as}`), enter: subViewFrame("configure-router-bgp-view", as) };
  },
});

// config-router-bgp-view: neighbor / network / router-id.
registerModal({
  id: "bgp",
  views: ["configure-router-bgp-view"],
  keywords: ["neighbor", "network", "router-id"],
  run({ head, isNo, args, delegate }) {
    if (head === "router-id") {
      if (isNo || !args[0]) return null;
      return { output: delegate(`config router bgp router-id ${args[0]}`) };
    }
    if (head === "neighbor") {
      if (isNo) return { output: delegate(`config router bgp no neighbor ${args[0] ?? ""}`) };
      return { output: delegate(`config router bgp neighbor ${args.join(" ")}`) };
    }
    if (head === "network") {
      if (!args[0]) return { output: [err("% prefix required.")] };
      return { output: delegate(`config router bgp ${isNo ? "no " : ""}network ${args[0]}`) };
    }
    return null;
  },
});
