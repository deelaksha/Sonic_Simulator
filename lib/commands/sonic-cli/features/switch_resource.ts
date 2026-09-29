/**
 * Switch-resource — CONFIG-PLANE feature with a DEDICATED SUB-MODE (no engine
 * backend; store + show). Mirrors CONFIG_DB SWITCH_RESOURCE_TABLE on the box.
 *
 *   sonic(config)# switch-resource                          -> enters the sub-view
 *   sonic(config-switch-resource)# route-scale routes max
 *   sonic(config-switch-resource)# route-scale hosts layer2-layer3
 *   sonic(config-switch-resource)# ecmp-group level-1-partition 512
 *   sonic(config-switch-resource)# drop-monitor flows min
 *   sonic(config-switch-resource)# vlan-stacking
 *   sonic(config-switch-resource)# l2-nexthop-group
 *   sonic(config-switch-resource)# no route-scale routes
 *   sonic# show switch-resource [route-scale|ecmp-group|drop-monitor|
 *                                vlan-stacking|l2-nexthop-group]
 *
 * The `switch-resource` command in configure-view has view=
 * "configure-switch-resource-view" (a real sub-mode), so entry returns
 * { enter: subViewFrame(...) } and the sub-view commands write config via cp*.
 * `show switch-resource` renders exactly the configured scale/mode settings.
 *
 * NOTE: on the real box `show switch-resource ...` reports live resource
 * UTILIZATION counters (used/free entries) alongside the configured scale.
 * Those runtime counters are operational data the sim cannot model and are NOT
 * fabricated here — only the configured values are stored and rendered.
 * See data/device-capture/klish-xml/switch_resource.xml.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";

const ROUTE_SCALES = ["max", "v6max", "v4v6max"]; // ptype MAX_V6MAX_V4V6MAX
const ECMP_SIZES = ["512", "1024", "1536", "2048", "2560", "3072", "3584"];
const DROP_MONITOR_FLOWS = ["min", "none"]; // ptype MIN_NONE

interface ShowField {
  key: string; // config-plane store key
  label: string; // label used by `show switch-resource`
  sub: string; // `show switch-resource <sub>` this field belongs to
  bool?: boolean; // stored as an enable flag -> rendered "Enabled"
}

// Order matches `show switch-resource` (overall) output.
const FIELDS: ShowField[] = [
  { key: "route-scale-routes", label: "Route Scale (routes)", sub: "route-scale" },
  { key: "route-scale-hosts", label: "Route Scale (hosts)", sub: "route-scale" },
  { key: "ecmp-group-partition", label: "ECMP Group Level-1 Partition", sub: "ecmp-group" },
  { key: "drop-monitor-flows", label: "Drop-Monitor Flows", sub: "drop-monitor" },
  { key: "vlan-stacking", label: "VLAN Stacking", sub: "vlan-stacking", bool: true },
  { key: "l2-nexthop-group", label: "L2 Nexthop Group", sub: "l2-nexthop-group", bool: true },
];

// configure-view: `switch-resource` — enter the switch-resource sub-view.
registerModal({
  id: "switch_resource-enter",
  views: ["configure-view"],
  keywords: ["switch-resource"],
  run({ isNo }) {
    if (isNo) return null; // no `no switch-resource` form on the box
    return { output: [], enter: subViewFrame("configure-switch-resource-view", "") };
  },
});

// configure-switch-resource-view: the scale / mode config commands.
registerModal({
  id: "switch_resource",
  views: ["configure-switch-resource-view"],
  keywords: ["route-scale", "ecmp-group", "drop-monitor", "vlan-stacking", "l2-nexthop-group"],
  run({ head, isNo, args, ctx }) {
    if (head === "route-scale") {
      const kind = (args[0] ?? "").toLowerCase();
      if (kind === "routes") {
        if (isNo) {
          cpUnset(ctx.device, "switch_resource", "route-scale-routes");
          return { output: [] };
        }
        const scale = (args[1] ?? "").toLowerCase();
        if (!ROUTE_SCALES.includes(scale)) return { output: [err(`% route scale must be one of ${ROUTE_SCALES.join("|")}`)] };
        cpSet(ctx.device, "switch_resource", "route-scale-routes", scale);
        return { output: [] };
      }
      if (kind === "hosts") {
        if (isNo) {
          cpUnset(ctx.device, "switch_resource", "route-scale-hosts");
          return { output: [] };
        }
        const scale = args[1];
        if (!scale) return { output: [err("% host scale value required")] };
        cpSet(ctx.device, "switch_resource", "route-scale-hosts", scale);
        return { output: [] };
      }
      return { output: [err("% route-scale: expected `routes` or `hosts`")] };
    }

    if (head === "ecmp-group") {
      if ((args[0] ?? "").toLowerCase() !== "level-1-partition")
        return { output: [err("% ecmp-group: expected `level-1-partition`")] };
      if (isNo) {
        cpUnset(ctx.device, "switch_resource", "ecmp-group-partition");
        return { output: [] };
      }
      const size = args[1];
      if (!ECMP_SIZES.includes(size ?? "")) return { output: [err(`% level-1-partition size must be one of ${ECMP_SIZES.join("|")}`)] };
      cpSet(ctx.device, "switch_resource", "ecmp-group-partition", size);
      return { output: [] };
    }

    if (head === "drop-monitor") {
      if (isNo) return null; // no `no drop-monitor` form on the box
      if ((args[0] ?? "").toLowerCase() !== "flows")
        return { output: [err("% drop-monitor: expected `flows`")] };
      const val = (args[1] ?? "").toLowerCase();
      if (!DROP_MONITOR_FLOWS.includes(val)) return { output: [err(`% drop-monitor flows must be one of ${DROP_MONITOR_FLOWS.join("|")}`)] };
      cpSet(ctx.device, "switch_resource", "drop-monitor-flows", val);
      return { output: [] };
    }

    // vlan-stacking / l2-nexthop-group: enable flags (`no` disables/defaults).
    if (head === "vlan-stacking" || head === "l2-nexthop-group") {
      if (isNo) {
        cpUnset(ctx.device, "switch_resource", head);
        return { output: [] };
      }
      cpSet(ctx.device, "switch_resource", head, "enable");
      return { output: [] };
    }

    return null; // not ours
  },
});

// enable-view: `show switch-resource [<sub>]` renders the configured settings.
registerModal({
  id: "switch_resource-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "switch-resource") return null; // not ours
    const st = cpGet(ctx.device, "switch_resource") ?? {};
    const sub = args[1]?.toLowerCase();
    const subs = FIELDS.map((f) => f.sub);
    const fields = sub && subs.includes(sub) ? FIELDS.filter((f) => f.sub === sub) : FIELDS;
    const width = 28;
    const rows: OutputLine[] = fields
      .filter((f) => st[f.key] !== undefined)
      .map((f) => line(`${f.label.padEnd(width)}: ${f.bool ? "Enabled" : String(st[f.key])}`));
    if (!rows.length) return { output: [muted("No switch-resource configuration")] };
    const dash = "-".repeat(45);
    return { output: [line(dash), line("Switch Resource Configuration"), line(dash), ...rows] };
  },
});
