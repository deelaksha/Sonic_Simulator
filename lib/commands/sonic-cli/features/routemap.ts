/**
 * Route-map modal behaviour (SUB-MODE feature, mirrors bgp.ts).
 *
 *   sonic(config)# route-map RM1 permit 10        -> creates the statement + enters the sub-view
 *   sonic(config-route-map)# match metric 12
 *   sonic(config-route-map)# match local-preference 40
 *   sonic(config-route-map)# set metric 75
 *   sonic(config-route-map)# set ip next-hop 15.10.10.3
 *   sonic(config-route-map)# no set metric
 *   sonic(config-route-map)# exit
 *   sonic(config)# no route-map RM1               -> delete the whole map
 *   sonic(config)# no route-map RM1 permit 10     -> delete one statement
 *
 * The KLISH route-map grammar (routemap.xml / route_match.xml) keeps match/set
 * clauses inside `configure-route-map-view`; the tested Click module
 * (lib/commands/sonic/routemap.ts) carries the statement selector + one clause on
 * a single line, so we thread the entered <name>/<action>/<seq> through the
 * sub-view frame's context and delegate `config route-map <name> <action> <seq>
 * [no] match|set <clause>`. Behaviour/output are not duplicated or faked.
 */
import { err } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";

// configure-view: `route-map <name> permit|deny <seq>` — create the statement,
// then drop into the route-map sub-view. Also `no route-map <name> [permit|deny <seq>]`.
registerModal({
  id: "routemap-enter",
  views: ["configure-view"],
  keywords: ["route-map"],
  run({ isNo, args, delegate }) {
    const name = args[0];
    const action = args[1]; // permit | deny
    const seq = args[2];

    if (isNo) {
      if (!name) return { output: [err("% route-map name required.")] };
      if (action === "permit" || action === "deny") {
        return { output: delegate(`config route-map no ${name} ${action} ${seq ?? ""}`) };
      }
      return { output: delegate(`config route-map no ${name}`) };
    }

    if (!name || (action !== "permit" && action !== "deny") || seq === undefined) {
      return { output: [err("% Usage: route-map <name> permit|deny <seq>")] };
    }
    return {
      output: delegate(`config route-map ${name} ${action} ${seq}`),
      enter: subViewFrame("configure-route-map-view", `${name} ${action} ${seq}`),
    };
  },
});

// configure-route-map-view: match / set clauses (and their `no` deletions).
registerModal({
  id: "routemap",
  views: ["configure-route-map-view"],
  keywords: ["match", "set"],
  run({ head, isNo, args, viewctx, delegate }) {
    const [name, action, seq] = (viewctx ?? "").split(" ");
    if (!name || !action || !seq) return { output: [err("% route-map context missing.")] };
    const prefix = `config route-map ${name} ${action} ${seq}`;
    const clause = args.join(" ").trim();
    if (!clause) return { output: [err(`% '${head}' clause required.`)] };
    return { output: delegate(`${prefix} ${isNo ? "no " : ""}${head} ${clause}`) };
  },
});
