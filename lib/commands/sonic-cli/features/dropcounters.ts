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
 * Drop counting is a DATA-PLANE feature (the ASIC increments per-reason drop
 * counters). The sim cannot forward/drop packets, so we store + show the config
 * honestly and mark dataPlaneNotSimulated. Runtime counters and hardware
 * `capabilities` are operational state we do not model, so they are never
 * fabricated on show.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";

type Counter = {
  name: string;
  description?: string;
  alias?: string;
  group?: string;
  type?: string;
  enabled?: boolean;
  mirror?: string;
  reasons?: string[];
};

// DEBUG_COUNTER_TYPE ptype enum (dropcounters.xml `type` param).
const COUNTER_TYPES = ["PORT_INGRESS_DROPS", "PORT_EGRESS_DROPS", "SWITCH_INGRESS_DROPS", "SWITCH_EGRESS_DROPS"];

function getCounter(counters: Counter[], name: string): Counter | undefined {
  return counters.find((c) => c.name === name);
}

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
      cpRemove(ctx.device, "dropcounters", "counters", "name", name);
      return { output: [] };
    }
    cpUpsert(ctx.device, "dropcounters", "counters", { name }, "name");
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
    const upsert = (patch: Partial<Counter>) => {
      cpUpsert(ctx.device, "dropcounters", "counters", { name, ...patch }, "name");
      return { output: [] as OutputLine[] };
    };
    switch (head) {
      case "description":
        return upsert({ description: isNo ? "" : args.join(" ").replace(/^"|"$/g, "") });
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
        if (!COUNTER_TYPES.includes(t)) return { output: [err(`% type must be one of ${COUNTER_TYPES.join("|")}`)] };
        return upsert({ type: t });
      }
      case "add-reason":
      case "delete-reason": {
        if (!args[0]) return { output: [err("% reason required.")] };
        const incoming = args[0].split(",").map((r) => r.trim().toUpperCase()).filter(Boolean);
        const current = getCounter(cpList(ctx.device, "dropcounters", "counters") as Counter[], name)?.reasons ?? [];
        const reasons =
          head === "add-reason"
            ? [...current, ...incoming.filter((r) => !current.includes(r))]
            : current.filter((r) => !incoming.includes(r));
        return upsert({ reasons });
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
    // `capabilities` is hardware runtime data (not CONFIG_DB); we never fabricate it.
    if (args[1]?.toLowerCase() === "capabilities")
      return { output: [muted("Drop-counter capabilities are hardware runtime data; not simulated")] };

    const counters = cpList(ctx.device, "dropcounters", "counters") as Counter[];
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
