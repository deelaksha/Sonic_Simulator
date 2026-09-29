/**
 * QoS modal behaviour. QoS config lives in dedicated per-object SUB-VIEWS in the
 * captured KLISH grammar (qos_map_dscp.xml, qos_map_tc_queue.xml, the WRED view),
 * so this follows the bgp.ts SUB-MODE pattern: a configure-view ENTRY handler that
 * drops into the sub-view, plus handlers registered for each sub-view that delegate
 * the in-mode commands to the tested Click `config qos ...` module. It also clones
 * the per-interface bindings (interface.ts pattern) in configure-if-view.
 *
 *   sonic(config)# qos map dscp-tc dmap            -> enters config-dscp-tc-map
 *   sonic(config-dscp-tc-map)# dscp 10 traffic-class 3   -> config qos map dscp-tc add dmap 10 3
 *   sonic(config)# qos map tc-queue tqm            -> enters config-tc-queue-map
 *   sonic(config-tc-queue-map)# traffic-class 3 queue 5  -> config qos map tc-queue add tqm 3 5
 *   sonic(config)# qos wred-policy wp1             -> enters config-wred
 *   sonic(config-wred)# green minimum-threshold 1000 maximum-threshold 2000 drop-probability 5
 *                                                  -> config qos wred-policy add wp1 green 1000 2000 5
 *   sonic(config)# no qos map dscp-tc dmap         -> config qos map dscp-tc del dmap
 *   sonic(config-if-Ethernet0)# qos-map dscp-tc dmap     -> config qos interface bind Ethernet0 dscp-tc dmap
 *   sonic(config-if-Ethernet0)# no qos-map tc-queue      -> config qos interface unbind Ethernet0 tc-queue
 *
 * Behaviour/output are not duplicated or faked — everything runs through Click.
 */
import { err } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";

// configure-view: `qos map dscp-tc|tc-queue <name>`, `qos wred-policy <name>` enter
// the matching sub-view; `no qos ...` deletes the whole map/policy via Click.
registerModal({
  id: "qos-enter",
  views: ["configure-view"],
  keywords: ["qos"],
  run({ isNo, args, delegate }) {
    const a0 = args[0]?.toLowerCase();

    if (a0 === "map") {
      const kind = args[1]?.toLowerCase();
      const name = args[2];
      if (kind !== "dscp-tc" && kind !== "tc-queue") return null; // other map kinds not modelled by Click
      if (isNo) {
        if (!name) return { output: [err("% map name required.")] };
        return { output: delegate(`config qos map ${kind} del ${name}`) };
      }
      if (!name) return { output: [err("% map name required.")] };
      const view = kind === "dscp-tc" ? "configure-dscp-tc-map-view" : "configure-tc-queue-map-view";
      return { output: [], enter: subViewFrame(view, name) };
    }

    if (a0 === "wred-policy") {
      const name = args[1];
      if (isNo) {
        if (!name) return { output: [err("% policy name required.")] };
        return { output: delegate(`config qos wred-policy del ${name}`) };
      }
      if (!name) return { output: [err("% policy name required.")] };
      return { output: [], enter: subViewFrame("configure-wred-view", name) };
    }

    return null; // scheduler-policy et al. — see notes; not delegated here
  },
});

// config-dscp-tc-map-view: `dscp <d> traffic-class <t>` -> add one map entry.
registerModal({
  id: "qos-dscp-tc-map",
  views: ["configure-dscp-tc-map-view"],
  keywords: ["dscp"],
  run({ isNo, args, viewctx, delegate }) {
    if (isNo) return null; // single-entry delete not modelled by Click (whole-map del only)
    const dscp = args[0];
    const tc = args[1]?.toLowerCase() === "traffic-class" ? args[2] : undefined;
    if (dscp === undefined || tc === undefined) return { output: [err("% Usage: dscp <0-63> traffic-class <0-7>")] };
    return { output: delegate(`config qos map dscp-tc add ${viewctx} ${dscp} ${tc}`) };
  },
});

// config-tc-queue-map-view: `traffic-class <t> queue <q>` -> add one map entry.
registerModal({
  id: "qos-tc-queue-map",
  views: ["configure-tc-queue-map-view"],
  keywords: ["traffic-class"],
  run({ isNo, args, viewctx, delegate }) {
    if (isNo) return null; // single-entry delete not modelled by Click (whole-map del only)
    const tc = args[0];
    const queue = args[1]?.toLowerCase() === "queue" ? args[2] : undefined;
    if (tc === undefined || queue === undefined) return { output: [err("% Usage: traffic-class <0-7> queue <0-7>")] };
    return { output: delegate(`config qos map tc-queue add ${viewctx} ${tc} ${queue}`) };
  },
});

// config-wred-view: `<color> minimum-threshold <min> maximum-threshold <max> drop-probability <prob>`.
registerModal({
  id: "qos-wred",
  views: ["configure-wred-view"],
  keywords: ["green", "yellow", "red"],
  run({ head, isNo, args, viewctx, delegate }) {
    if (isNo) return null; // per-color threshold delete not modelled by Click (whole-policy del only)
    if (args[0]?.toLowerCase() !== "minimum-threshold" || args[2]?.toLowerCase() !== "maximum-threshold" || args[4]?.toLowerCase() !== "drop-probability") {
      return { output: [err(`% Usage: ${head} minimum-threshold <min> maximum-threshold <max> drop-probability <0-100>`)] };
    }
    const [, min, , max, , prob] = args;
    return { output: delegate(`config qos wred-policy add ${viewctx} ${head} ${min} ${max} ${prob}`) };
  },
});

// configure-if-view: `qos-map dscp-tc|tc-queue <name>` bind / `no qos-map ...` unbind.
registerModal({
  id: "qos-interface",
  views: ["configure-if-view"],
  keywords: ["qos-map"],
  run({ isNo, args, ifname, delegate }) {
    const port = ifname ?? "";
    const kind = args[0]?.toLowerCase();
    if (kind !== "dscp-tc" && kind !== "tc-queue") return null; // other qos-map kinds not modelled by Click
    if (isNo) return { output: delegate(`config qos interface unbind ${port} ${kind}`) };
    const name = args[1];
    if (!name) return { output: [err(`% qos-map ${kind}: map name required.`)] };
    return { output: delegate(`config qos interface bind ${port} ${kind} ${name}`) };
  },
});
