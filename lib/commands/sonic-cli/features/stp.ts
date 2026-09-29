/**
 * Spanning-tree (STP) — CONFIG-PLANE feature (no engine/packet backend).
 *
 * SONiC's `spanning-tree ...` commands are pure CONFIG_DB: you set global,
 * per-VLAN and per-interface parameters and read them back. We model that
 * honestly — store exactly what is configured under cp_stp and render it via
 * `show running-configuration spanning-tree` (the config dump). Nothing is
 * fabricated. The STP control-plane itself (BPDU exchange, port-role/state
 * machine, root election, counters) is NOT simulated, so `show spanning-tree`
 * reflects only the configured mode and says operational state is not modelled.
 *
 *   sonic(config)# spanning-tree mode {pvst|rapid-pvst|mst}
 *   sonic(config)# spanning-tree forward-time <4-30>
 *   sonic(config)# spanning-tree hello-time <1-10>
 *   sonic(config)# spanning-tree max-age <6-40>
 *   sonic(config)# spanning-tree priority <0-61440>
 *   sonic(config)# spanning-tree guard root timeout <5-600>
 *   sonic(config)# spanning-tree loopguard default
 *   sonic(config)# spanning-tree portfast default
 *   sonic(config)# spanning-tree edge-port bpdufilter default
 *   sonic(config)# spanning-tree vlan <id> [forward-time|hello-time|max-age|priority <v>]
 *   sonic(config)# no spanning-tree vlan <id>
 *   sonic(conf-if-*)# spanning-tree {enable|portfast|uplinkfast}
 *   sonic(conf-if-*)# spanning-tree cost <1-200000000>
 *   sonic(conf-if-*)# spanning-tree port-priority <0-240>
 *   sonic(conf-if-*)# spanning-tree bpdufilter {enable|disable}
 *   sonic(conf-if-*)# spanning-tree bpduguard [port-shutdown]
 *   sonic(conf-if-*)# spanning-tree guard {root|loop|none}
 *   sonic(conf-if-*)# spanning-tree link-type {point-to-point|shared}
 *   sonic# show running-configuration spanning-tree
 *   sonic# show spanning-tree
 */
import { line, err, muted, OutputLine } from "../../types";
import { Device } from "../../../models/device";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpList } from "../config-plane";

const intIn = (s: string | undefined, lo: number, hi: number): number | null => {
  const n = Number(s);
  return s !== undefined && s !== "" && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

const MODE_MAP: Record<string, string> = { pvst: "pvst", "rapid-pvst": "rpvst", mst: "mst" };
const VLAN_PARAM: Record<string, string> = {
  "forward-time": "forward_delay",
  "hello-time": "hello_time",
  "max-age": "max_age",
  priority: "priority",
};
const PARAM_RANGE: Record<string, [number, number]> = {
  forward_delay: [4, 30],
  hello_time: [1, 10],
  max_age: [6, 40],
  priority: [0, 61440],
};

// --- per-VLAN / per-interface list helpers (mutate the stored record in place). --
function setVlan(dev: Device, id: number, field: string, value: unknown): void {
  cpUpsert(dev, "stp", "vlans", { vlan: id, [field]: value }, "vlan");
}
function clearVlanField(dev: Device, id: number, field: string): void {
  const rec = cpList(dev, "stp", "vlans").find((r) => r.vlan === id);
  if (rec) delete rec[field];
}
function clearIntfField(dev: Device, name: string, field: string): void {
  const rec = cpList(dev, "stp", "interfaces").find((r) => r.ifname === name);
  if (rec) delete rec[field];
}

// --- configure-view: global + per-VLAN spanning-tree config. ------------------
registerModal({
  id: "stp",
  views: ["configure-view"],
  keywords: ["spanning-tree"],
  run({ isNo, args, ctx }) {
    const dev = ctx.device;
    const sub = (args[0] ?? "").toLowerCase();

    // Global scalar with a validated integer value (forward-time/hello-time/...).
    const scalar = (key: string, lo: number, hi: number) => {
      if (isNo) {
        cpUnset(dev, "stp", key);
        return { output: [] };
      }
      const n = intIn(args[1], lo, hi);
      if (n === null) return { output: [err(`% value must be an integer ${lo}-${hi}`)] };
      cpSet(dev, "stp", key, n);
      return { output: [] };
    };

    switch (sub) {
      case "mode": {
        if (isNo) {
          cpUnset(dev, "stp", "mode");
          return { output: [] };
        }
        const m = MODE_MAP[(args[1] ?? "").toLowerCase()];
        if (!m) return { output: [err("% mode must be one of pvst|rapid-pvst|mst")] };
        cpSet(dev, "stp", "mode", m);
        return { output: [] };
      }
      case "forward-time":
        return scalar("forward_delay", 4, 30);
      case "hello-time":
        return scalar("hello_time", 1, 10);
      case "max-age":
        return scalar("max_age", 6, 40);
      case "priority":
        return scalar("priority", 0, 61440);
      case "guard": {
        if ((args[1] ?? "").toLowerCase() !== "root") return null;
        if (isNo) {
          cpUnset(dev, "stp", "rootguard_timeout");
          return { output: [] };
        }
        if ((args[2] ?? "").toLowerCase() !== "timeout") return null;
        const n = intIn(args[3], 5, 600);
        if (n === null) return { output: [err("% timeout must be an integer 5-600")] };
        cpSet(dev, "stp", "rootguard_timeout", n);
        return { output: [] };
      }
      case "loopguard": {
        if ((args[1] ?? "").toLowerCase() !== "default") return null;
        if (isNo) cpUnset(dev, "stp", "loopguard");
        else cpSet(dev, "stp", "loopguard", true);
        return { output: [] };
      }
      case "portfast": {
        if ((args[1] ?? "").toLowerCase() !== "default") return null;
        if (isNo) cpUnset(dev, "stp", "portfast");
        else cpSet(dev, "stp", "portfast", true);
        return { output: [] };
      }
      case "edge-port": {
        if ((args[1] ?? "").toLowerCase() !== "bpdufilter" || (args[2] ?? "").toLowerCase() !== "default") return null;
        if (isNo) cpUnset(dev, "stp", "bpdu_filter");
        else cpSet(dev, "stp", "bpdu_filter", true);
        return { output: [] };
      }
      case "vlan": {
        const id = intIn(args[1], 1, 4094);
        if (id === null) return { output: [err("% VLAN id must be an integer 1-4094")] };
        const p = (args[2] ?? "").toLowerCase();
        if (!p) {
          // Enable / disable spanning-tree on the whole VLAN.
          if (isNo) setVlan(dev, id, "disabled", true);
          else {
            cpUpsert(dev, "stp", "vlans", { vlan: id }, "vlan");
            clearVlanField(dev, id, "disabled");
          }
          return { output: [] };
        }
        const field = VLAN_PARAM[p];
        if (!field) return null;
        if (isNo) {
          clearVlanField(dev, id, field);
          return { output: [] };
        }
        const [lo, hi] = PARAM_RANGE[field];
        const n = intIn(args[3], lo, hi);
        if (n === null) return { output: [err(`% value must be an integer ${lo}-${hi}`)] };
        setVlan(dev, id, field, n);
        return { output: [] };
      }
      default:
        return null; // not cloned (mst configuration sub-mode, default-block, ...)
    }
  },
});

// --- configure-if-view / -lag-view: per-interface spanning-tree config. -------
registerModal({
  id: "stp-if",
  views: ["configure-if-view", "configure-lag-view"],
  keywords: ["spanning-tree"],
  run({ isNo, args, ifname, ctx }) {
    const dev = ctx.device;
    const name = ifname ?? "";
    const sub = (args[0] ?? "").toLowerCase();
    const set = (f: string, v: unknown) => {
      cpUpsert(dev, "stp", "interfaces", { ifname: name, [f]: v }, "ifname");
      return { output: [] };
    };
    const clr = (f: string) => {
      clearIntfField(dev, name, f);
      return { output: [] };
    };

    switch (sub) {
      case "enable":
        return isNo ? set("enable", false) : clr("enable"); // enabled is the default
      case "cost": {
        if (isNo) return clr("cost");
        const n = intIn(args[1], 1, 200000000);
        if (n === null) return { output: [err("% cost must be an integer 1-200000000")] };
        return set("cost", n);
      }
      case "port-priority": {
        if (isNo) return clr("port_priority");
        const n = intIn(args[1], 0, 240);
        if (n === null) return { output: [err("% port-priority must be an integer 0-240")] };
        return set("port_priority", n);
      }
      case "portfast":
        return set("portfast", !isNo);
      case "uplinkfast":
        return isNo ? clr("uplinkfast") : set("uplinkfast", true);
      case "bpdufilter": {
        if (isNo) return clr("bpdu_filter");
        const v = (args[1] ?? "").toLowerCase();
        if (v !== "enable" && v !== "disable") return { output: [err("% bpdufilter requires enable|disable")] };
        return set("bpdu_filter", v);
      }
      case "bpduguard": {
        if (isNo) {
          clr("bpduguard");
          return clr("bpduguard_shutdown");
        }
        cpUpsert(
          dev,
          "stp",
          "interfaces",
          { ifname: name, bpduguard: true, bpduguard_shutdown: (args[1] ?? "").toLowerCase() === "port-shutdown" },
          "ifname",
        );
        return { output: [] };
      }
      case "guard": {
        if (isNo) return clr("guard");
        const v = (args[1] ?? "").toLowerCase();
        if (!["root", "loop", "none"].includes(v)) return { output: [err("% guard must be root|loop|none")] };
        return set("guard", v);
      }
      case "link-type": {
        if (isNo) return clr("link_type");
        const v = (args[1] ?? "").toLowerCase();
        if (v !== "point-to-point" && v !== "shared") return { output: [err("% link-type must be point-to-point|shared")] };
        return set("link_type", v);
      }
      default:
        return null; // not cloned (mst / vlan per-port cost, port type edge, ...)
    }
  },
});

// --- render helpers (reflect ONLY stored config; never invent runtime data). --
const MODE_RUNCFG: Record<string, string> = { pvst: "pvst", rpvst: "rapid-pvst", mst: "mst" };
const MODE_HDR: Record<string, string> = { pvst: "PVST", rpvst: "Rapid-PVST", mst: "MST" };

function renderIntf(it: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (it.enable === false) out.push("no spanning-tree enable");
  if (it.portfast === true) out.push("spanning-tree portfast");
  if (it.portfast === false) out.push("no spanning-tree portfast");
  if (it.cost !== undefined) out.push(`spanning-tree cost ${it.cost}`);
  if (it.port_priority !== undefined) out.push(`spanning-tree port-priority ${it.port_priority}`);
  if (it.bpdu_filter !== undefined) out.push(`spanning-tree bpdufilter ${it.bpdu_filter}`);
  if (it.bpduguard === true) out.push(`spanning-tree bpduguard${it.bpduguard_shutdown === true ? " port-shutdown" : ""}`);
  if (it.guard !== undefined) out.push(`spanning-tree guard ${it.guard}`);
  if (it.link_type !== undefined) out.push(`spanning-tree link-type ${it.link_type}`);
  if (it.uplinkfast === true) out.push("spanning-tree uplinkfast");
  return out;
}

function renderRunning(dev: Device): OutputLine[] {
  const st = cpGet(dev, "stp");
  if (!st || Object.keys(st).length === 0) return [muted("% No spanning-tree configuration.")];
  const out: OutputLine[] = [];
  const mode = st.mode as string | undefined;
  if (mode) out.push(line(`spanning-tree mode ${MODE_RUNCFG[mode] ?? mode}`));
  if (st.bpdu_filter) out.push(line("spanning-tree edge-port bpdufilter default"));
  if (st.forward_delay !== undefined) out.push(line(`spanning-tree forward-time ${st.forward_delay}`));
  if (st.rootguard_timeout !== undefined) out.push(line(`spanning-tree guard root timeout ${st.rootguard_timeout}`));
  if (st.hello_time !== undefined) out.push(line(`spanning-tree hello-time ${st.hello_time}`));
  if (st.loopguard) out.push(line("spanning-tree loopguard default"));
  if (st.max_age !== undefined) out.push(line(`spanning-tree max-age ${st.max_age}`));
  if (st.portfast) out.push(line("spanning-tree portfast default"));
  if (st.priority !== undefined) out.push(line(`spanning-tree priority ${st.priority}`));

  const vlans = ((st.vlans as Record<string, unknown>[] | undefined) ?? [])
    .slice()
    .sort((a, b) => (a.vlan as number) - (b.vlan as number));
  for (const v of vlans) {
    out.push(line("!"));
    if (v.disabled === true) {
      out.push(line(`no spanning-tree vlan ${v.vlan}`));
      continue;
    }
    const params: OutputLine[] = [];
    if (v.forward_delay !== undefined) params.push(line(`spanning-tree vlan ${v.vlan} forward-time ${v.forward_delay}`));
    if (v.hello_time !== undefined) params.push(line(`spanning-tree vlan ${v.vlan} hello-time ${v.hello_time}`));
    if (v.max_age !== undefined) params.push(line(`spanning-tree vlan ${v.vlan} max-age ${v.max_age}`));
    if (v.priority !== undefined) params.push(line(`spanning-tree vlan ${v.vlan} priority ${v.priority}`));
    if (params.length === 0) params.push(line(`spanning-tree vlan ${v.vlan}`));
    out.push(...params);
  }

  const intfs = ((st.interfaces as Record<string, unknown>[] | undefined) ?? [])
    .slice()
    .sort((a, b) => String(a.ifname).localeCompare(String(b.ifname)));
  for (const it of intfs) {
    const body = renderIntf(it);
    if (body.length === 0) continue;
    out.push(line("!"));
    out.push(line(`interface ${it.ifname}`));
    out.push(...body.map((t) => line(` ${t}`)));
  }
  return out;
}

function renderOper(dev: Device): OutputLine[] {
  const st = cpGet(dev, "stp");
  const mode = st?.mode as string | undefined;
  if (!mode) return [muted("% Spanning-tree mode is not configured.")];
  return [
    line(`Spanning-tree Mode: ${MODE_HDR[mode] ?? mode}`),
    muted("% Operational spanning-tree state (bridge/port roles, timers, counters) is not simulated."),
  ];
}

// --- enable-view: show handlers (render ONLY from stored config). -------------
registerModal({
  id: "stp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a0 = (args[0] ?? "").toLowerCase();
    const a1 = (args[1] ?? "").toLowerCase();
    if (a0 === "running-configuration" && a1 === "spanning-tree") return { output: renderRunning(ctx.device) };
    // Only claim the bare `show spanning-tree`; counters/mst/inconsistentports are
    // operational-only and are not modelled (fall through to the grammar).
    if (a0 === "spanning-tree" && !args[1]) return { output: renderOper(ctx.device) };
    return null;
  },
});
