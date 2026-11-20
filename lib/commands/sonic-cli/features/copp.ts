/**
 * CoPP (control-plane policing) modal behaviour, from
 * data/device-capture/klish-xml/copp.xml and flow_based_services.xml:
 *
 *   configure-view:
 *     copp-action <name>                      → copp-action-view;  no copp-action <name>
 *     class-map <name> match-type copp        → configure-copp-classifier-view
 *     policy-map copp-system-policy type copp → configure-policy-view
 *     no class-map <copp classifier> / no policy-map copp-system-policy
 *   copp-action-view:
 *     set trap-action <a> | set trap-queue <0-31> | set trap-priority <0-1023>
 *     police cir <n> [cbs <n>]
 *   configure-copp-classifier-view:
 *     match protocol <trap-id> / no match protocol <trap-id>
 *   configure-policy-view (copp-system-policy):
 *     class <classifier> [priority <n>]      → configure-copp-flow-view;  no class <classifier>
 *   configure-copp-flow-view:
 *     set copp-action <action group>
 *
 * Everything delegates to the tested Click `config copp action|classifier|bind`
 * commands (lib/commands/sonic/copp.ts), whose state the CPU path polices with
 * (lib/protocols/cpu-traps.ts / cpu-daemon.ts). The simulator models the one
 * CoPP policy SONiC installs, copp-system-policy. These handlers are registered
 * before the FBS ones (features/index.ts), so they claim the copp variants of
 * class-map / policy-map first.
 */
import { err, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";
import { peekFeatureState } from "../../../models/feature-state";
import type { CoppState } from "../../../protocols/cpu-traps";

const POLICY = "copp-system-policy";
const errorsOnly = (out: OutputLine[]) => out.filter((o) => o.kind === "error");

registerModal({
  id: "copp",
  views: ["configure-view"],
  keywords: ["copp-action", "class-map", "policy-map"],
  run({ head, isNo, args, ctx, delegate }) {
    const name = args[0];
    if (head === "copp-action") {
      if (!name) return { output: [err("% CoPP action group name required.")] };
      if (isNo) return { output: delegate(`config copp action del ${name}`) };
      const e = errorsOnly(delegate(`config copp action add ${name}`));
      return e.length ? { output: e } : { output: [], enter: subViewFrame("copp-action-view", name) };
    }
    if (head === "class-map") {
      const copp = peekFeatureState<CoppState>(ctx.device, "copp");
      if (isNo) return name && copp?.classifiers.some((c) => c.name === name) ? { output: errorsOnly(delegate(`config copp classifier del ${name}`)) } : null;
      if (!name || args[1]?.toLowerCase() !== "match-type" || args[2]?.toLowerCase() !== "copp") return null; // FBS classifiers
      delegate(`config copp classifier add ${name}`);
      return { output: [], enter: subViewFrame("configure-copp-classifier-view", name) };
    }
    // policy-map
    if (isNo) {
      if (name !== POLICY) return null;
      const st = peekFeatureState<CoppState>(ctx.device, "copp");
      return { output: (st?.bindings ?? []).map((b) => b.classifier).flatMap((c) => errorsOnly(delegate(`config copp unbind ${c}`))) };
    }
    if (args[1]?.toLowerCase() !== "type" || args[2]?.toLowerCase() !== "copp") return null; // FBS policies
    if (name !== POLICY) return { output: [err(`% Error: only the ${POLICY} CoPP policy is modelled`)] };
    return { output: [], enter: subViewFrame("configure-policy-view", POLICY) };
  },
});

registerModal({
  id: "copp-action-view",
  views: ["copp-action-view"],
  keywords: ["set", "police"],
  run({ head, isNo, args, viewctx, delegate }) {
    const name = viewctx ?? "";
    if (isNo) return { output: [err("% Clearing CoPP action fields is not modelled; delete and re-create the action group")] };
    if (head === "police") {
      if (args[0]?.toLowerCase() !== "cir" && args[0]?.toLowerCase() !== "cbs") return { output: [err("% Usage: police cir <n> [cbs <n>]")] };
      return { output: errorsOnly(delegate(`config copp action set ${name} police ${args.join(" ").toLowerCase()}`)) };
    }
    const field = args[0]?.toLowerCase();
    if (!["trap-action", "trap-queue", "trap-priority"].includes(field ?? "") || !args[1]) {
      return { output: [err("% Usage: set trap-action <action> | set trap-queue <0-31> | set trap-priority <0-1023>")] };
    }
    return { output: errorsOnly(delegate(`config copp action set ${name} ${field} ${args[1]}`)) };
  },
});

registerModal({
  id: "copp-classifier-view",
  views: ["configure-copp-classifier-view"],
  keywords: ["match"],
  run({ isNo, args, viewctx, delegate }) {
    if (args[0]?.toLowerCase() !== "protocol" || !args[1]) return { output: [err("% Usage: match protocol <trap-id>")] };
    return { output: errorsOnly(delegate(`config copp classifier ${isNo ? "no-match" : "match"} ${viewctx ?? ""} ${args[1]}`)) };
  },
});

registerModal({
  id: "copp-policy-view",
  views: ["configure-policy-view"],
  keywords: ["class"],
  run({ isNo, args, viewctx, delegate }) {
    if (viewctx !== POLICY) return null; // an FBS policy-map
    const cls = args[0];
    if (!cls) return { output: [err("% class name required.")] };
    if (isNo) return { output: errorsOnly(delegate(`config copp unbind ${cls}`)) };
    const pi = args.findIndex((t) => t.toLowerCase() === "priority");
    const prio = pi >= 0 ? args[pi + 1] ?? "" : "0";
    if (!/^\d+$/.test(prio)) return { output: [err("% Usage: class <name> [priority <0-1023>]")] };
    return { output: [], enter: subViewFrame("configure-copp-flow-view", `${cls} ${prio}`) };
  },
});

registerModal({
  id: "copp-flow-view",
  views: ["configure-copp-flow-view"],
  keywords: ["set"],
  run({ isNo, args, viewctx, delegate }) {
    const [cls, prio] = (viewctx ?? "").split(" ");
    if (args[0]?.toLowerCase() !== "copp-action" || (!isNo && !args[1])) return { output: [err("% Usage: set copp-action <name>")] };
    if (isNo) return { output: errorsOnly(delegate(`config copp unbind ${cls}`)) };
    return { output: errorsOnly(delegate(`config copp bind ${cls} ${args[1]} ${prio}`)) };
  },
});
