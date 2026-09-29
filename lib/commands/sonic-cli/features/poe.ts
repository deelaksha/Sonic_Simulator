/**
 * PoE (Power over Ethernet) — CONFIG-PLANE feature. There is no Click module and
 * no packet/engine backend, so we STORE exactly what is configured and RENDER it
 * back on `show`, the way the real box keeps it in CONFIG_DB (POE / POE_PORT).
 * Nothing is fabricated.
 *
 * Wired from data/device-capture/klish-xml/poe.xml:
 *
 * configure-view (global POE):
 *   poe power management <model>     store global power-management model
 *   poe usage-threshold <1-99>       store global power usage threshold
 *   poe auto-reset                   store global auto-reset mode
 *   no poe [power management|usage-threshold|auto-reset]   clear
 *
 * configure-if-view (per physical interface, POE_PORT):
 *   poe disable                      admin down the port PoE
 *   poe power-limit dot3af | <0-99900>
 *   poe priority low|medium|high|critical
 *   poe detection <mode>
 *   poe power-up mode <mode>
 *   poe high-power enable | four-pair enable | spare-pair-power enable
 *   poe power-pairs signal|spare
 *   poe disconnect-type ac|dc
 *   poe power-classification normal|bypass
 *   no poe <setting>                 clear that setting on the interface
 *   no poe                           clear all PoE config on the interface
 *
 * enable-view:
 *   show poe                                  render stored global config
 *   show poe port configuration [all|<intf>]  render stored per-port config
 *   show poe port [info ...]                  operational (STATE_DB) — NOT simulated
 *
 * NOTE: only configured values are reflected. Operational PoE runtime (delivered
 * power, PD class detection, port status, counters) depends on real PoE hardware
 * and is NOT simulated — dataPlaneNotSimulated. Per-card sub-mode (poe card <id>)
 * and interface-range config are not modelled.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpRemove, cpList } from "../config-plane";
import { Device } from "../../../models/device";

const POWER_MODELS = ["dynamic", "dynamic-priority", "static", "static-priority", "class"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const DETECTIONS = ["2pt-dot3af", "2pt-dot3af+legacy", "4pt-dot3af", "4pt-dot3af+legacy", "dot3bt", "dot3bt+legacy", "legacy"];
const POWERUP_MODES = ["dot3at", "pre-dot3at", "pre-dot3bt", "dot3bt-type3", "dot3bt-type4", "dot3bt", "dot3af", "high-inrush"];
const POWER_PAIRS = ["signal", "spare"];
const POWER_CLASS = ["normal", "bypass"];

const GLOBAL_KEYS = ["power_management_model", "power_usage_threshold", "auto_reset_mode"];

// per-port subcommand -> stored field name (shared by set and `no`).
const PORT_FIELD: Record<string, string> = {
  disable: "admin_mode",
  "power-limit": "power_limit",
  priority: "priority",
  detection: "detection_mode",
  "power-up": "powerup_mode",
  "high-power": "high_power_mode",
  "four-pair": "four_pair_mode",
  "spare-pair-power": "use_spare_pair",
  "power-pairs": "power_pairs",
  "disconnect-type": "disconnect_type",
  "power-classification": "power_classification_mode",
};

interface PortEntry {
  id: string; // "<iface>|<field>" — de-dup key
  iface: string;
  field: string;
  value: string;
}

// configure-view: global PoE config.
registerModal({
  id: "poe",
  views: ["configure-view"],
  keywords: ["poe"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    if (!sub) {
      // bare `no poe` clears all global PoE config; bare `poe` is a no-op prefix.
      if (isNo) for (const k of GLOBAL_KEYS) cpUnset(ctx.device, "poe", k);
      return { output: [] };
    }

    if (sub === "power") {
      if ((args[1] ?? "").toLowerCase() !== "management") return { output: [err("% Usage: poe power management <model>")] };
      if (isNo) { cpUnset(ctx.device, "poe", "power_management_model"); return { output: [] }; }
      const model = (args[2] ?? "").toLowerCase();
      if (!POWER_MODELS.includes(model)) return { output: [err(`% power management model must be one of ${POWER_MODELS.join("|")}`)] };
      cpSet(ctx.device, "poe", "power_management_model", model);
      return { output: [] };
    }

    if (sub === "usage-threshold") {
      if (isNo) { cpUnset(ctx.device, "poe", "power_usage_threshold"); return { output: [] }; }
      const n = Number(args[1]);
      if (!args[1] || !Number.isInteger(n) || n < 1 || n > 99) return { output: [err("% usage-threshold must be an integer 1..99")] };
      cpSet(ctx.device, "poe", "power_usage_threshold", String(n));
      return { output: [] };
    }

    if (sub === "auto-reset") {
      if (isNo) cpUnset(ctx.device, "poe", "auto_reset_mode");
      else cpSet(ctx.device, "poe", "auto_reset_mode", "true");
      return { output: [] };
    }

    if (sub === "card") return { output: [muted("% PoE per-card configuration is not modelled in the simulator")] };

    return { output: [err("% Unrecognized poe command")] };
  },
});

// configure-if-view: per-port PoE config.
registerModal({
  id: "poe-port",
  views: ["configure-if-view"],
  keywords: ["poe"],
  run({ isNo, args, ifname, ctx }) {
    const iface = ifname ?? "";
    const sub = (args[0] ?? "").toLowerCase();

    if (!sub) {
      // bare `no poe` removes all PoE config on the port; bare `poe` is a no-op prefix.
      if (isNo) for (const f of Object.values(PORT_FIELD)) cpRemove(ctx.device, "poe", "ports", "id", `${iface}|${f}`);
      return { output: [] };
    }

    const field = PORT_FIELD[sub];
    if (!field) return { output: [err("% Unrecognized poe port command")] };

    const setField = (value: string) => cpUpsert(ctx.device, "poe", "ports", { id: `${iface}|${field}`, iface, field, value }, "id");
    const clearField = () => cpRemove(ctx.device, "poe", "ports", "id", `${iface}|${field}`);

    // `no poe <setting>` clears it (for `disable`, that means re-enabling the port).
    if (isNo) { clearField(); return { output: [] }; }

    switch (sub) {
      case "disable":
        setField("disabled");
        return { output: [] };
      case "high-power":
      case "four-pair":
      case "spare-pair-power":
        if ((args[1] ?? "").toLowerCase() !== "enable") return { output: [err(`% Usage: poe ${sub} enable`)] };
        setField("enable");
        return { output: [] };
      case "power-up": {
        if ((args[1] ?? "").toLowerCase() !== "mode") return { output: [err("% Usage: poe power-up mode <mode>")] };
        const m = (args[2] ?? "").toLowerCase();
        if (!POWERUP_MODES.includes(m)) return { output: [err(`% power-up mode must be one of ${POWERUP_MODES.join("|")}`)] };
        setField(m);
        return { output: [] };
      }
      case "priority": {
        const p = (args[1] ?? "").toLowerCase();
        if (!PRIORITIES.includes(p)) return { output: [err(`% priority must be one of ${PRIORITIES.join("|")}`)] };
        setField(p);
        return { output: [] };
      }
      case "detection": {
        const d = (args[1] ?? "").toLowerCase();
        if (!DETECTIONS.includes(d)) return { output: [err(`% detection must be one of ${DETECTIONS.join("|")}`)] };
        setField(d);
        return { output: [] };
      }
      case "power-pairs": {
        const v = (args[1] ?? "").toLowerCase();
        if (!POWER_PAIRS.includes(v)) return { output: [err(`% power-pairs must be one of ${POWER_PAIRS.join("|")}`)] };
        setField(v);
        return { output: [] };
      }
      case "power-classification": {
        const v = (args[1] ?? "").toLowerCase();
        if (!POWER_CLASS.includes(v)) return { output: [err(`% power-classification must be one of ${POWER_CLASS.join("|")}`)] };
        setField(v);
        return { output: [] };
      }
      case "disconnect-type": {
        const v = (args[1] ?? "").toLowerCase();
        if (v !== "ac" && v !== "dc") return { output: [err("% disconnect-type must be ac|dc")] };
        setField(v === "ac" ? "type-ac" : "type-dc");
        return { output: [] };
      }
      case "power-limit": {
        if ((args[1] ?? "").toLowerCase() === "dot3af") { setField("class-based"); return { output: [] }; }
        const n = Number(args[1]);
        if (!args[1] || !Number.isInteger(n) || n < 0 || n > 99900) return { output: [err("% Usage: poe power-limit dot3af | <0-99900>")] };
        setField(String(n));
        return { output: [] };
      }
    }
    return null;
  },
});

// enable-view: render stored PoE config.
registerModal({
  id: "poe-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "poe") return null; // not ours

    if (args[1]?.toLowerCase() === "port") {
      if (args[2]?.toLowerCase() === "configuration") {
        const rest = args.slice(3).filter((a) => a.toLowerCase() !== "all");
        return { output: renderPortConfig(ctx.device, rest.join("")) };
      }
      // `show poe port info ...` / bare `show poe port` — operational STATE_DB, not simulated.
      return { output: [muted("% PoE operational port data is not available (no PoE hardware in the simulator); only configuration is stored")] };
    }

    return { output: renderGlobal(ctx.device) };
  },
});

function renderGlobal(device: Device): OutputLine[] {
  const st = cpGet(device, "poe") ?? {};
  const g = (k: string) => st[k] as string | undefined;
  const rows: [string, string | undefined][] = [
    ["Power Management Model", g("power_management_model")],
    ["Power Usage Threshold", g("power_usage_threshold")],
    ["Auto Reset Mode", g("auto_reset_mode") ? "Enable" : undefined],
  ];
  const out = rows.filter(([, v]) => v).map(([k, v]) => line(`${k.padEnd(24)}: ${v}`));
  return out.length ? [line("PoE Global Information"), ...out] : [muted("PoE global configuration not set")];
}

const FIELD_LABEL: Record<string, string> = {
  admin_mode: "Admin Mode",
  power_limit: "Power Limit",
  priority: "Priority",
  detection_mode: "Detection Mode",
  powerup_mode: "Power-up Mode",
  high_power_mode: "High Power",
  four_pair_mode: "Four Pair",
  use_spare_pair: "Spare Pair Power",
  power_pairs: "Power Pairs",
  disconnect_type: "Disconnect Type",
  power_classification_mode: "Power Classification",
};

function renderVal(field: string, v: string): string {
  if (field === "admin_mode") return "Disable";
  if (field === "high_power_mode" || field === "four_pair_mode" || field === "use_spare_pair") return "Enable";
  return v;
}

function renderPortConfig(device: Device, filter: string): OutputLine[] {
  const all = cpList(device, "poe", "ports") as unknown as PortEntry[];
  const sel = filter ? all.filter((e) => e.iface.toLowerCase() === filter.toLowerCase()) : all;
  if (!sel.length) return [muted("No PoE port configuration")];

  const ifaces: string[] = [];
  for (const e of sel) if (!ifaces.includes(e.iface)) ifaces.push(e.iface);

  const out: OutputLine[] = [];
  for (const ifc of ifaces) {
    out.push(line(`Interface ${ifc}`));
    for (const e of sel.filter((x) => x.iface === ifc)) {
      out.push(line(`  ${(FIELD_LABEL[e.field] ?? e.field).padEnd(22)}: ${renderVal(e.field, e.value)}`));
    }
  }
  return out;
}
