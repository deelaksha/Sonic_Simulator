/**
 * KLISH `show copp classifiers|protocols|actions|policy` (enable-view, copp.xml:22-30:
 * the copp-protocols-or-groups switch is mandatory, so bare `show copp` is incomplete).
 * Rendered by sonic_cli_fbs show_copp_protocols with the 4.5 templates
 * show_copp_classifier.j2 ("Class-map <n> match-type copp" / "  protocol <id>"),
 * show_copp_protocols.j2, show_copp_actions.j2 ("CoPP action group <n>" + 4-space
 * fields) and show_copp_policy.j2 ("Policy copp-system-policy Type copp", "  Flow",
 * "    Action", 6-space fields, 8-space meter lines).
 *
 * Reads the live CoPP config (feature state "copp": action groups, classifiers and the
 * copp-system-policy bindings written by the KLISH/Click copp commands) and the
 * classifier protocol list the trap daemon supports (TRAP_PROTOCOLS).
 */
import { CommandContext } from "../../types";
import { registerModal } from "../registry";
import { peekFeatureState } from "../../../models/feature-state";
import { CoppActionGroup, CoppState, TRAP_PROTOCOLS } from "../../../protocols/cpu-traps";
import { lines, noAction } from "./klish-show-util";

function groupFields(g: CoppActionGroup, ind: string): string[] {
  const out: string[] = [];
  if (g.trapAction !== undefined) out.push(`${ind}trap-action ${g.trapAction.toLowerCase()}`);
  if (g.trapPriority !== undefined) out.push(`${ind}trap-priority ${g.trapPriority}`);
  if (g.trapQueue !== undefined) out.push(`${ind}trap-queue ${g.trapQueue}`);
  if (g.cir !== undefined) out.push(`${ind}police cir ${g.cir}${g.cbs !== undefined ? ` cbs ${g.cbs}` : ""}`);
  return out;
}

function render(ctx: CommandContext, what: string): string[] {
  const st = peekFeatureState<CoppState>(ctx.device, "copp");
  const byName = <T extends { name: string }>(l: T[] = []) => [...l].sort((x, y) => x.name.localeCompare(y.name));
  if (what === "protocols") return ["Class-map match-type copp protocols", ...TRAP_PROTOCOLS.map((p) => `  protocol ${p}`)];
  if (what === "classifiers") return byName(st?.classifiers).flatMap((c) => [`Class-map ${c.name} match-type copp`, ...c.protocols.map((p) => `  protocol ${p}`)]);
  if (what === "actions") return byName(st?.actions).flatMap((g) => [`CoPP action group ${g.name}`, ...groupFields(g, "    ")]);
  // policy
  const out = ["Policy copp-system-policy Type copp"];
  for (const b of [...(st?.bindings ?? [])].sort((x, y) => x.classifier.localeCompare(y.classifier))) {
    out.push(`  Flow ${b.classifier}`, `    Action ${b.action.toLowerCase()}`);
    const g = st?.actions.find((x) => x.name === b.action);
    if (!g) continue;
    out.push(...groupFields(g, "      "));
    if (g.cir !== undefined && g.meterType !== undefined) out.push(`        meter-type ${g.meterType.toLowerCase()}`);
  }
  return out;
}

registerModal({
  id: "copp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "copp") return null;
    const what = args[1]?.toLowerCase();
    if (what === undefined) return noAction();
    if (!["classifiers", "protocols", "actions", "policy"].includes(what) || args.length > 2) return null;
    return lines(render(ctx, what));
  },
});
