/**
 * CRM (Critical Resource Monitoring) — CONFIG-PLANE feature (no engine backend;
 * store + show).
 *
 *   sonic(config)# crm polling interval <0..9999>              store polling interval
 *   sonic(config)# crm thresholds <resource> type percentage|used|free
 *   sonic(config)# crm thresholds <resource> high <0..4294967295>
 *   sonic(config)# crm thresholds <resource> low  <0..4294967295>
 *   sonic(config)# no crm polling interval                     clear polling interval
 *   sonic(config)# no crm thresholds <resource> [type|high|low] clear (field or all)
 *   sonic(config)# no crm all                                  clear everything
 *   sonic# show crm summary                                    render polling interval
 *   sonic# show crm thresholds [<resource>]                    render configured thresholds
 *   sonic# show crm resources ...                              operational — not simulated
 *
 * Mirrors the real box's CONFIG_DB CRM|Config table (see
 * data/device-capture/klish-xml/system-crm.xml): polling interval and per-resource
 * threshold type/low/high are stored honestly and rendered back exactly as
 * configured. `<resource>` is any of the KLISH resource paths (all, acl group,
 * acl table, dnat, snat, fdb, ipmc, l2mc, ipv4|ipv6 neighbor|nexthop|route,
 * nexthop group member|object, ...); it is stored as an underscore-joined key to
 * match CONFIG_DB naming.
 *
 * NOTE: `show crm resources` / `show crm summary` used/available ASIC counts are
 * OPERATIONAL data produced by the SAI CRM layer. This sim has no data-plane, so
 * that runtime usage is NOT fabricated — only the configured values are modelled.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, cpList } from "../config-plane";

const THRESHOLD_TYPES = ["percentage", "used", "free"];
const FIELD_KW = ["type", "high", "low"];

interface Threshold {
  resource: string;
  type?: string;
  low?: string;
  high?: string;
}

// CRM_POLLING_INTERVAL ptype: unsignedInteger 0..9999.
const validPolling = (v: string) => /^\d+$/.test(v) && Number(v) <= 9999;
// CRM_THRESHOLD ptype: unsignedInteger 0..4294967295.
const validThreshold = (v: string) => /^\d+$/.test(v) && Number(v) <= 4294967295;

// configure-view: `crm polling interval ...` / `crm thresholds ...`.
registerModal({
  id: "system-crm",
  views: ["configure-view"],
  keywords: ["crm"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    // `no crm all` — clear every CRM configuration.
    if (isNo && sub === "all") {
      cpUnset(ctx.device, "system-crm", "polling_interval");
      cpUnset(ctx.device, "system-crm", "thresholds");
      return { output: [] };
    }

    // `crm polling interval <0..9999>` / `no crm polling interval`.
    if (sub === "polling") {
      if ((args[1] ?? "").toLowerCase() !== "interval")
        return { output: [err("% expected `crm polling interval <seconds>`")] };
      if (isNo) {
        cpUnset(ctx.device, "system-crm", "polling_interval");
        return { output: [] };
      }
      const secs = args[2];
      if (!secs || !validPolling(secs))
        return { output: [err("% polling interval must be an integer 0-9999")] };
      cpSet(ctx.device, "system-crm", "polling_interval", secs);
      return { output: [] };
    }

    // `crm thresholds <resource...> <type|high|low> <value>`.
    if (sub === "thresholds") {
      const rest = args.slice(1);
      const ki = rest.findIndex((t) => FIELD_KW.includes(t.toLowerCase()));
      const resource = (ki === -1 ? rest : rest.slice(0, ki)).map((t) => t.toLowerCase()).join("_");
      if (!resource) return { output: [err("% CRM threshold resource required")] };

      if (isNo) {
        if (ki === -1) {
          cpRemove(ctx.device, "system-crm", "thresholds", "resource", resource);
          return { output: [] };
        }
        // Clear a single field; drop the item if nothing remains.
        const field = rest[ki].toLowerCase() as "type" | "low" | "high";
        const item = (cpList(ctx.device, "system-crm", "thresholds") as unknown as Threshold[]).find(
          (t) => t.resource === resource,
        );
        if (item) {
          delete item[field];
          if (item.type === undefined && item.low === undefined && item.high === undefined)
            cpRemove(ctx.device, "system-crm", "thresholds", "resource", resource);
        }
        return { output: [] };
      }

      if (ki === -1)
        return { output: [err("% expected `crm thresholds <resource> type|high|low <value>`")] };
      const field = rest[ki].toLowerCase();
      const value = rest[ki + 1];
      if (value === undefined) return { output: [err(`% ${field} requires a value`)] };
      if (field === "type" && !THRESHOLD_TYPES.includes(value.toLowerCase()))
        return { output: [err(`% threshold type must be one of ${THRESHOLD_TYPES.join("|")}`)] };
      if ((field === "high" || field === "low") && !validThreshold(value))
        return { output: [err("% threshold value must be an integer 0-4294967295")] };
      const item: Record<string, unknown> = { resource };
      item[field] = field === "type" ? value.toLowerCase() : value;
      cpUpsert(ctx.device, "system-crm", "thresholds", item, "resource");
      return { output: [] };
    }

    return { output: [err("% crm: expected `polling` or `thresholds`")] };
  },
});

// enable-view: `show crm summary` / `show crm thresholds [<resource>]`.
registerModal({
  id: "system-crm-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "crm") return null; // not ours
    const sub = (args[1] ?? "").toLowerCase();

    if (sub === "summary") {
      const pi = cpGet(ctx.device, "system-crm")?.polling_interval;
      if (pi === undefined) return { output: [muted("CRM polling interval not configured")] };
      return { output: [line(`Polling Interval: ${pi} second(s)`)] };
    }

    if (sub === "thresholds") {
      const filter = args.slice(2).map((t) => t.toLowerCase()).join("_");
      let rows = cpList(ctx.device, "system-crm", "thresholds") as unknown as Threshold[];
      if (filter) rows = rows.filter((t) => t.resource === filter);
      if (!rows.length) return { output: [muted("No CRM thresholds configured")] };
      const cell = (v: unknown) => (v === undefined || v === "" ? "-" : String(v));
      const row = (r: string, ty: string, lo: string, hi: string) =>
        r.padEnd(24) + ty.padEnd(18) + lo.padEnd(16) + hi;
      const dash = "-".repeat(72);
      const out: OutputLine[] = [
        line(dash),
        line(row("Resource", "Threshold Type", "Low Threshold", "High Threshold")),
        line(dash),
      ];
      for (const t of rows) out.push(line(row(cell(t.resource), cell(t.type), cell(t.low), cell(t.high))));
      return { output: out };
    }

    if (sub === "resources") {
      // Used/available counts come from the ASIC (SAI CRM); no data-plane here.
      return { output: [muted("CRM resource usage is operational data and is not simulated")] };
    }

    return null; // other `show crm ...` — not ours
  },
});
