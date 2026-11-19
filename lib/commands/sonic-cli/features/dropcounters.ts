/**
 * Drop counters — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 *   sonic(config)# dropcounters DEBUG_0                 -> create + enter sub-view
 *   sonic(config-dropcounters-DEBUG_0)# alias RX_LEGIT
 *   sonic(config-dropcounters-DEBUG_0)# group LEGIT
 *   sonic(config-dropcounters-DEBUG_0)# type PORT_INGRESS_DROPS
 *   sonic(config-dropcounters-DEBUG_0)# add-reason SMAC_EQUALS_DMAC
 *   sonic(config-dropcounters-DEBUG_0)# mirror Session1
 *   sonic(config)# no dropcounters DEBUG_0             -> delete
 *   sonic# show dropcounters configuration            -> render from stored config
 *
 * `dropcounters <name>` (configure-view, dropcounters.xml) has its config in a
 * DEDICATED SUB-MODE (grammar view="configure-dropcounters-view"), so we follow
 * the sub-mode pattern: the entry handler upserts the counter and returns
 * `enter: subViewFrame(...)`, and a sub-view handler stores each field keyed on
 * the counter name. viewctx carries the counter name into the sub-view.
 *
 * The counters live in the shared drop-counter CONFIG_DB (lib/control/drops.ts),
 * the same store Click `config dropcounters install` writes, so a counter
 * configured here gets a live column in `show dropcounters counts` (the engine
 * attributes every drop to a SAI drop reason). `show dropcounters capabilities`
 * renders the simulated DEBUG_COUNTER_CAPABILITIES (the reasons the engine can
 * attribute) in the dropcounters.xml DOCGEN layout.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";
import {
  CAPABILITIES,
  COUNTER_TYPES,
  addCounterReasons,
  debugCounters,
  deleteDebugCounter,
  removeCounterReasons,
  upsertDebugCounter,
} from "../../../control/drops";

// configure-view: `dropcounters <name>` — create (upsert) + enter the sub-view;
// `no dropcounters <name>` — delete the counter.
registerModal({
  id: "dropcounters-enter",
  views: ["configure-view"],
  keywords: ["dropcounters"],
  run({ isNo, args, ctx }) {
    const name = args[0];
    if (!name) return { output: [err("% Dropcounter name required.")] };
    if (isNo) {
      deleteDebugCounter(ctx.device, name);
      return { output: [] };
    }
    upsertDebugCounter(ctx.device, name, {});
    return { output: [], enter: subViewFrame("configure-dropcounters-view", name) };
  },
});

// configure-dropcounters-view: per-counter fields keyed on the counter name (viewctx).
registerModal({
  id: "dropcounters",
  views: ["configure-dropcounters-view"],
  keywords: ["description", "alias", "group", "enable", "type", "add-reason", "delete-reason", "mirror"],
  run({ head, isNo, args, viewctx, ctx }) {
    const name = viewctx;
    if (!name) return null;
    const upsert = (patch: Parameters<typeof upsertDebugCounter>[2]) => {
      upsertDebugCounter(ctx.device, name, patch);
      return { output: [] as OutputLine[] };
    };
    switch (head) {
      case "description":
        return upsert({ desc: isNo ? "" : args.join(" ").replace(/^"|"$/g, "") });
      case "alias":
        return upsert({ alias: isNo ? "" : args[0] ?? "" });
      case "group":
        return upsert({ group: isNo ? "" : args[0] ?? "" });
      case "enable":
        return upsert({ enabled: !isNo });
      case "mirror":
        return upsert({ mirror: isNo ? "" : args[0] ?? "" });
      case "type": {
        if (isNo) return upsert({ type: "" });
        const t = (args[0] ?? "").toUpperCase();
        if (!(COUNTER_TYPES as readonly string[]).includes(t)) return { output: [err(`% type must be one of ${COUNTER_TYPES.join("|")}`)] };
        return upsert({ type: t });
      }
      case "add-reason":
      case "delete-reason": {
        if (!args[0]) return { output: [err("% reason required.")] };
        const incoming = args[0].split(",").map((r) => r.trim().toUpperCase()).filter(Boolean);
        if (head === "add-reason") addCounterReasons(ctx.device, name, incoming);
        else removeCounterReasons(ctx.device, name, incoming);
        return { output: [] };
      }
    }
    return null;
  },
});

// `show dropcounters configuration` render format (dropcounters.xml DOCGEN example).
const HDR = "Counter   Alias     Group  Type                Mirror          Reasons";
const CONT = 63; // Reasons column start; wrapped reasons align under it.
const p = (v: string | undefined, w: number): string => String(v ?? "").padEnd(w);

// enable-view: `show dropcounters [configuration [detail]]` — render what was configured.
registerModal({
  id: "dropcounters-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "dropcounters") return null; // not ours
    if (args[1]?.toLowerCase() === "capabilities") {
      // dropcounters.xml:28-36 DOCGEN: tabulate table, then each type with its reasons indented.
      const w = Math.max(...COUNTER_TYPES.map((t) => t.length), "Counter Type".length + 2);
      const out: OutputLine[] = [line(`${"Counter Type".padEnd(w)}    Total`), line(`${"-".repeat(w)}  -------`)];
      for (const t of COUNTER_TYPES) out.push(line(`${t.padEnd(w)}  ${String(CAPABILITIES[t].count).padStart(7)}`));
      for (const t of COUNTER_TYPES) {
        out.push(line(""), line(t));
        for (const r of CAPABILITIES[t].reasons) out.push(line(`  ${r}`));
      }
      return { output: out };
    }

    const counters = debugCounters(ctx.device);
    if (!counters.length) return { output: [muted("No drop counters configured")] };

    const out: OutputLine[] = [line(HDR), muted("-".repeat(HDR.length))];
    for (const c of counters) {
      const reasons = c.reasons ?? [];
      out.push(
        line(p(c.name, 10) + p(c.alias || "", 10) + p(c.group || "None", 7) + p(c.type || "", 20) + p(c.mirror || "NA", 16) + (reasons[0] ?? "")),
      );
      for (const r of reasons.slice(1)) out.push(line(" ".repeat(CONT) + r));
    }
    return { output: out };
  },
});
