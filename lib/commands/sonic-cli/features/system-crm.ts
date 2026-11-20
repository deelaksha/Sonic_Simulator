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
 *   sonic# show crm resources all|<resource>                   live usage (show_crm_resources_*.j2)
 *
 * Mirrors the real box's CONFIG_DB CRM|Config table (see
 * data/device-capture/klish-xml/system-crm.xml): polling interval and per-resource
 * threshold type/low/high are stored honestly and rendered back exactly as
 * configured. `<resource>` is any of the KLISH resource paths (all, acl group,
 * acl table, dnat, snat, fdb, ipmc, l2mc, ipv4|ipv6 neighbor|nexthop|route,
 * nexthop group member|object, ...); it is stored as an underscore-joined key to
 * match CONFIG_DB naming.
 *
 * `show crm resources` renders the CRM counters orchagent reads from SAI: "used"
 * is counted from the live tables (routes, next hops, neighbours, FDB, ACL
 * bindings); "available" is what the virtual-switch SAI reports — fixed values
 * (sonic-sairedis vslib/SwitchStateBase.h:719-741, set_static_crm_values()).
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, cpList } from "../config-plane";
import { Device } from "../../../models/device";
import { peekFeatureState } from "../../../models/feature-state";
import { AclState } from "../../../protocols/acl-rules";

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

    if (sub === "resources") return { output: crmResources(ctx.device, args.slice(2).map((t) => t.toLowerCase())) };

    return null; // other `show crm ...` — not ours
  },
});

// ---------------------------------------------------------------- show crm resources

/** saivs static AVAILABLE_* values (SwitchStateBase.h:719-741). */
const VS_AVAILABLE: Record<string, number> = {
  ipv4_route: 100000, ipv6_route: 10000, ipv4_nexthop: 32000, ipv6_nexthop: 32000, ipv4_neighbor: 4000,
  ipv6_neighbor: 2000, nexthop_group_member: 16000, nexthop_group: 400, fdb_entry: 800, snat_entry: 100,
  dnat_entry: 100, ipmc_entry: 100,
};
const ORDER = Object.keys(VS_AVAILABLE);
const STAGES_CRM = ["egress", "ingress"];
const BIND_POINTS = ["port", "lag", "vlan", "rif", "switch"];

function crmUsed(dev: Device): Record<string, number> {
  const ecmp = (routes: Device["routingTable"]) => {
    const by = new Map<string, Set<string>>();
    for (const r of routes) {
      if (!r.nextHop) continue;
      const key = `${r.vrf ?? ""}|${r.destination}/${r.prefix}`;
      if (!by.has(key)) by.set(key, new Set());
      by.get(key)!.add(r.nextHop);
    }
    const groups = [...by.values()].filter((s) => s.size > 1);
    return { groups: groups.length, members: groups.reduce((n, s) => n + s.size, 0) };
  };
  const g4 = ecmp(dev.routingTable);
  const g6 = ecmp(dev.routingTable6);
  const nh = (routes: Device["routingTable"]) => new Set(routes.filter((r) => r.nextHop).map((r) => r.nextHop)).size;
  return {
    ipv4_route: dev.routingTable.length, ipv6_route: dev.routingTable6.length,
    ipv4_nexthop: nh(dev.routingTable), ipv6_nexthop: nh(dev.routingTable6),
    ipv4_neighbor: dev.arpTable.length, ipv6_neighbor: dev.ndpTable.length,
    nexthop_group_member: g4.members + g6.members, nexthop_group: g4.groups + g6.groups,
    fdb_entry: dev.macTable.length, snat_entry: 0, dnat_entry: 0, ipmc_entry: 0,
  };
}

/** ACL groups/tables in use per stage + bind point (one group per bound port, one table per bound ACL). */
function aclUsage(dev: Device): Record<string, { groups: number; tables: number }> {
  const out: Record<string, { groups: number; tables: number }> = {};
  for (const st of STAGES_CRM) for (const bp of BIND_POINTS) out[`${st}|${bp}`] = { groups: 0, tables: 0 };
  const tables = peekFeatureState<AclState>(dev, "acl")?.tables ?? [];
  const bpOf = (p: string) => (p.startsWith("PortChannel") ? "lag" : p.startsWith("Vlan") ? "vlan" : p === "Switch" ? "switch" : "port");
  for (const stage of STAGES_CRM) {
    const groupPorts = new Set<string>();
    for (const t of tables.filter((x) => (x.stage ?? "ingress").toLowerCase() === stage && x.ports.length)) {
      for (const bp of new Set(t.ports.map(bpOf))) out[`${stage}|${bp}`].tables++;
      for (const p of t.ports) groupPorts.add(p);
    }
    for (const p of groupPorts) out[`${stage}|${bpOf(p)}`].groups++;
  }
  return out;
}

const D_RES = "--------------------  ------------  -----------------";
const H_RES = "Resource Name           Used Count    Available Count";
const H_ACL = "Stage    Bind Point    Resource Name      Used Count    Available Count";
const D_ACL = "-------  ------------  ---------------  ------------  -----------------";
const resRow = (name: string, used: number, avail: number) => line(name.padEnd(22) + String(used).padStart(12) + String(avail).padStart(19));

function aclRows(dev: Device, which: ("acl_group" | "acl_table")[]): OutputLine[] {
  const acl = aclUsage(dev);
  const out: OutputLine[] = [];
  for (const st of STAGES_CRM) {
    for (const bp of BIND_POINTS) {
      const u = acl[`${st}|${bp}`];
      const pre = st.toUpperCase().padEnd(9) + bp.toUpperCase().padEnd(14);
      for (const w of which) {
        const [used, avail] = w === "acl_group" ? [u.groups, 200] : [u.tables, 3];
        out.push(line(pre + w.padEnd(17) + String(used).padStart(12) + String(avail).padStart(19)));
      }
    }
  }
  return out;
}

/** show_crm_resources_all.j2 / show_crm_resources_<resource>.j2 */
function crmResources(dev: Device, k: string[]): OutputLine[] {
  const used = crmUsed(dev);
  const what = k.join("_").replace(/^nexthop_group_object$/, "nexthop_group").replace(/^(dnat|snat|fdb|ipmc)$/, "$1_entry");
  if (what === "all" || what === "") {
    return [
      line(" "), line(" "), line(H_RES), line(D_RES), ...ORDER.map((r) => resRow(r, used[r], VS_AVAILABLE[r])),
      line(" "), line(" "), line(H_ACL), line(D_ACL), ...aclRows(dev, ["acl_group", "acl_table"]),
      line(" "), line(" "), line("Table ID    Resource Name    Used Count    Available Count"), line("----------  ---------------  ------------  -----------------"),
    ];
  }
  if (what === "acl_group" || what === "acl_table") return [line(H_ACL), line(D_ACL), ...aclRows(dev, [what])];
  if (VS_AVAILABLE[what] === undefined) return [err(`% Unknown CRM resource "${k.join(" ")}"`)];
  return [line(H_RES), line(D_RES), line(""), resRow(what, used[what], VS_AVAILABLE[what])];
}
