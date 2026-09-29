/**
 * QoS SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and `show qos ...` renders SOLELY from that
 * stored state. This is an EDUCATIONAL logical model of the QoS classify ->
 * queue -> schedule/drop pipeline (task §32); it deliberately does NOT fabricate
 * per-queue byte/packet counters, watermarks or any ASIC/hardware state (those
 * appear in qos_click_cli.txt as `show queue counters` / `watermark` and are a
 * SEPARATE counter-poll concern, not modelled here).
 *
 * A FOCUSED subset of qos.txt is modelled — the four things it actually
 * configures — reduced to click-friendly `config qos ...` forms (path
 * ["qos", ...]) whose semantics trace back to the authoritative klish/OC-CLI
 * grammar in qos.txt:
 *
 *   config qos map dscp-tc add <name> <dscp> <tc>   <- qos map dscp-tc <name> ; dscp <d> traffic-class <t>
 *   config qos map dscp-tc del <name>               <- no qos map dscp-tc <name>
 *   config qos map tc-queue add <name> <tc> <queue> <- qos map tc-queue <name> ; traffic-class <t> queue <q>
 *   config qos map tc-queue del <name>              <- no qos map tc-queue <name>
 *   config qos scheduler-policy add <name> <queue> <dwrr|wrr|strict> [weight]
 *                                                   <- qos scheduler-policy <name> ; queue <q> ; type <t> ; weight <w>
 *   config qos scheduler-policy del <name>          <- no qos scheduler-policy <name>
 *   config qos wred-policy add <name> <color> <min> <max> <prob>
 *                                                   <- qos wred-policy <name> ; <color> minimum-threshold .. maximum-threshold .. drop-probability ..
 *   config qos wred-policy del <name>               <- no qos wred-policy <name>
 *   config qos interface bind <port> <kind> <name>  <- interface <port> ; qos-map <kind> <name> | scheduler-policy <name>
 *   config qos interface unbind <port> <kind>       <- interface <port> ; no qos-map <kind> | no scheduler-policy
 *   show qos map dscp-tc [name]                     <- show qos map dscp-tc [name]
 *   show qos map tc-queue [name]                    <- show qos map tc-queue [name]
 *   show qos scheduler-policy [name]                <- show qos scheduler-policy [name]
 *   show qos wred-policy [name]                     <- show qos wred-policy [name]
 *   show qos interface <port>                       <- show qos interface <port>
 *   show qos                                         summary of what is configured
 *
 * Validation ranges taken from qos.txt: dscp 0-63 (TC-30 `dscp 64` rejected),
 * traffic-class 0-7 (TC-31 `traffic-class 8` rejected), queue 0-7,
 * drop-probability 0-100, dwrr/wrr weight 1-100. Deleting a map/policy that is
 * still bound to an interface is rejected as "in use" (qos.txt TC-115/TC-129).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";

type SchedType = "dwrr" | "wrr" | "strict";
type WredColor = "green" | "yellow" | "red";

interface MapEntry {
  key: number;
  value: number;
}

interface QosMap {
  name: string;
  entries: MapEntry[];
}

interface SchedulerQueue {
  queue: number;
  type: SchedType;
  weight?: number;
}

interface SchedulerPolicy {
  name: string;
  queues: SchedulerQueue[];
}

interface WredColorThreshold {
  color: WredColor;
  min: number;
  max: number;
  prob: number;
}

interface WredPolicy {
  name: string;
  colors: WredColorThreshold[];
}

interface IfaceBinding {
  dscpTc?: string;
  tcQueue?: string;
  schedulerPolicy?: string;
}

interface QosState {
  dscpTcMaps: QosMap[];
  tcQueueMaps: QosMap[];
  schedulers: SchedulerPolicy[];
  wredPolicies: WredPolicy[];
  interfaces: Record<string, IfaceBinding>;
}

type BindKind = "dscp-tc" | "tc-queue" | "scheduler-policy";

function state(ctx: CommandContext): QosState {
  return featureState<QosState>(ctx.device, "qos", () => ({
    dscpTcMaps: [],
    tcQueueMaps: [],
    schedulers: [],
    wredPolicies: [],
    interfaces: {},
  }));
}

/** Parse a non-negative integer token within [min,max]; null if malformed/out of range. */
function parseIntInRange(tok: string | undefined, min: number, max: number): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  return n >= min && n <= max ? n : null;
}

function parseSchedType(tok: string | undefined): SchedType | null {
  if (tok === "dwrr" || tok === "wrr" || tok === "strict") return tok;
  return null;
}

function parseColor(tok: string | undefined): WredColor | null {
  if (tok === "green" || tok === "yellow" || tok === "red") return tok;
  return null;
}

function parseBindKind(tok: string | undefined): BindKind | null {
  if (tok === "dscp-tc" || tok === "tc-queue" || tok === "scheduler-policy") return tok;
  return null;
}

function upsertMap(maps: QosMap[], name: string): QosMap {
  let m = maps.find((x) => x.name === name);
  if (!m) {
    m = { name, entries: [] };
    maps.push(m);
  }
  return m;
}

function setEntry(map: QosMap, key: number, value: number): void {
  const e = map.entries.find((x) => x.key === key);
  if (e) e.value = value;
  else map.entries.push({ key, value });
}

/** Interfaces (if any) whose binding of `kind` references `name`. */
function boundBy(st: QosState, kind: BindKind, name: string): string[] {
  return Object.entries(st.interfaces)
    .filter(([, b]) =>
      kind === "dscp-tc" ? b.dscpTc === name : kind === "tc-queue" ? b.tcQueue === name : b.schedulerPolicy === name,
    )
    .map(([port]) => port);
}

function binding(st: QosState, port: string): IfaceBinding {
  if (!st.interfaces[port]) st.interfaces[port] = {};
  return st.interfaces[port];
}

const config: SonicCmd[] = [
  {
    path: ["qos", "map", "dscp-tc", "add"],
    summary: "Add/update a DSCP->TC map entry (dscp 0-63, tc 0-7)",
    run(args, ctx): CommandResult {
      const [name, dscpTok, tcTok] = positional(args);
      if (!name || dscpTok === undefined || tcTok === undefined) {
        return { output: [err("Usage: config qos map dscp-tc add <name> <dscp:0-63> <tc:0-7>")] };
      }
      const dscp = parseIntInRange(dscpTok, 0, 63);
      if (dscp === null) return { output: [err(`config qos map dscp-tc add: dscp must be 0-63 (got '${dscpTok}')`)] };
      const tc = parseIntInRange(tcTok, 0, 7);
      if (tc === null) return { output: [err(`config qos map dscp-tc add: traffic-class must be 0-7 (got '${tcTok}')`)] };
      setEntry(upsertMap(state(ctx).dscpTcMaps, name), dscp, tc);
      return { output: [muted(`DSCP-TC map ${name}: dscp ${dscp} -> tc ${tc}`)] };
    },
  },
  {
    path: ["qos", "map", "dscp-tc", "del"],
    summary: "Delete a DSCP-TC map",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config qos map dscp-tc del <name>")] };
      const st = state(ctx);
      const users = boundBy(st, "dscp-tc", name);
      if (users.length) return { output: [err(`config qos map dscp-tc del: ${name} is in use by ${users.join(", ")}`)] };
      const before = st.dscpTcMaps.length;
      st.dscpTcMaps = st.dscpTcMaps.filter((m) => m.name !== name);
      return { output: [muted(st.dscpTcMaps.length < before ? `DSCP-TC map ${name} deleted` : `DSCP-TC map ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["qos", "map", "tc-queue", "add"],
    summary: "Add/update a TC->Queue map entry (tc 0-7, queue 0-7)",
    run(args, ctx): CommandResult {
      const [name, tcTok, queueTok] = positional(args);
      if (!name || tcTok === undefined || queueTok === undefined) {
        return { output: [err("Usage: config qos map tc-queue add <name> <tc:0-7> <queue:0-7>")] };
      }
      const tc = parseIntInRange(tcTok, 0, 7);
      if (tc === null) return { output: [err(`config qos map tc-queue add: traffic-class must be 0-7 (got '${tcTok}')`)] };
      const queue = parseIntInRange(queueTok, 0, 7);
      if (queue === null) return { output: [err(`config qos map tc-queue add: queue must be 0-7 (got '${queueTok}')`)] };
      setEntry(upsertMap(state(ctx).tcQueueMaps, name), tc, queue);
      return { output: [muted(`TC-Queue map ${name}: tc ${tc} -> queue ${queue}`)] };
    },
  },
  {
    path: ["qos", "map", "tc-queue", "del"],
    summary: "Delete a TC-Queue map",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config qos map tc-queue del <name>")] };
      const st = state(ctx);
      const users = boundBy(st, "tc-queue", name);
      if (users.length) return { output: [err(`config qos map tc-queue del: ${name} is in use by ${users.join(", ")}`)] };
      const before = st.tcQueueMaps.length;
      st.tcQueueMaps = st.tcQueueMaps.filter((m) => m.name !== name);
      return { output: [muted(st.tcQueueMaps.length < before ? `TC-Queue map ${name} deleted` : `TC-Queue map ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["qos", "scheduler-policy", "add"],
    summary: "Add/update a scheduler-policy queue (type dwrr|wrr|strict, weight 1-100 for dwrr/wrr)",
    run(args, ctx): CommandResult {
      const [name, queueTok, typeTok, weightTok] = positional(args);
      if (!name || queueTok === undefined || typeTok === undefined) {
        return { output: [err("Usage: config qos scheduler-policy add <name> <queue:0-7> <dwrr|wrr|strict> [weight:1-100]")] };
      }
      const queue = parseIntInRange(queueTok, 0, 7);
      if (queue === null) return { output: [err(`config qos scheduler-policy add: queue must be 0-7 (got '${queueTok}')`)] };
      const type = parseSchedType(typeTok);
      if (type === null) return { output: [err(`config qos scheduler-policy add: type must be dwrr, wrr or strict (got '${typeTok}')`)] };
      let weight: number | undefined;
      if (type !== "strict") {
        const w = parseIntInRange(weightTok, 1, 100);
        if (w === null) return { output: [err(`config qos scheduler-policy add: ${type} requires weight 1-100 (got '${weightTok ?? ""}')`)] };
        weight = w;
      }
      const st = state(ctx);
      let policy = st.schedulers.find((p) => p.name === name);
      if (!policy) {
        policy = { name, queues: [] };
        st.schedulers.push(policy);
      }
      const existing = policy.queues.find((q) => q.queue === queue);
      if (existing) {
        existing.type = type;
        existing.weight = weight;
      } else {
        policy.queues.push({ queue, type, weight });
      }
      return { output: [muted(`Scheduler policy ${name}: queue ${queue} ${type}${weight !== undefined ? ` weight ${weight}` : ""}`)] };
    },
  },
  {
    path: ["qos", "scheduler-policy", "del"],
    summary: "Delete a scheduler policy",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config qos scheduler-policy del <name>")] };
      const st = state(ctx);
      const users = boundBy(st, "scheduler-policy", name);
      if (users.length) return { output: [err(`config qos scheduler-policy del: ${name} is in use by ${users.join(", ")}`)] };
      const before = st.schedulers.length;
      st.schedulers = st.schedulers.filter((p) => p.name !== name);
      return { output: [muted(st.schedulers.length < before ? `Scheduler policy ${name} deleted` : `Scheduler policy ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["qos", "wred-policy", "add"],
    summary: "Add/update WRED thresholds for a color (green|yellow|red)",
    run(args, ctx): CommandResult {
      const [name, colorTok, minTok, maxTok, probTok] = positional(args);
      if (!name || colorTok === undefined || minTok === undefined || maxTok === undefined || probTok === undefined) {
        return { output: [err("Usage: config qos wred-policy add <name> <green|yellow|red> <min-kbytes> <max-kbytes> <drop-prob:0-100>")] };
      }
      const color = parseColor(colorTok);
      if (color === null) return { output: [err(`config qos wred-policy add: color must be green, yellow or red (got '${colorTok}')`)] };
      const min = parseIntInRange(minTok, 0, 1_000_000_000);
      if (min === null) return { output: [err(`config qos wred-policy add: minimum-threshold must be a non-negative integer (got '${minTok}')`)] };
      const max = parseIntInRange(maxTok, 0, 1_000_000_000);
      if (max === null) return { output: [err(`config qos wred-policy add: maximum-threshold must be a non-negative integer (got '${maxTok}')`)] };
      if (min > max) return { output: [err(`config qos wred-policy add: minimum-threshold (${min}) must be <= maximum-threshold (${max})`)] };
      const prob = parseIntInRange(probTok, 0, 100);
      if (prob === null) return { output: [err(`config qos wred-policy add: drop-probability must be 0-100 (got '${probTok}')`)] };
      const st = state(ctx);
      let policy = st.wredPolicies.find((p) => p.name === name);
      if (!policy) {
        policy = { name, colors: [] };
        st.wredPolicies.push(policy);
      }
      const existing = policy.colors.find((c) => c.color === color);
      if (existing) {
        existing.min = min;
        existing.max = max;
        existing.prob = prob;
      } else {
        policy.colors.push({ color, min, max, prob });
      }
      return { output: [muted(`WRED policy ${name}: ${color} min ${min} max ${max} drop-probability ${prob}`)] };
    },
  },
  {
    path: ["qos", "wred-policy", "del"],
    summary: "Delete a WRED policy",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config qos wred-policy del <name>")] };
      const st = state(ctx);
      const before = st.wredPolicies.length;
      st.wredPolicies = st.wredPolicies.filter((p) => p.name !== name);
      return { output: [muted(st.wredPolicies.length < before ? `WRED policy ${name} deleted` : `WRED policy ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["qos", "interface", "bind"],
    summary: "Bind a qos map/policy to an interface (kind: dscp-tc|tc-queue|scheduler-policy)",
    run(args, ctx): CommandResult {
      const [port, kindTok, name] = positional(args);
      if (!port || kindTok === undefined || !name) {
        return { output: [err("Usage: config qos interface bind <port> <dscp-tc|tc-queue|scheduler-policy> <name>")] };
      }
      const kind = parseBindKind(kindTok);
      if (kind === null) return { output: [err(`config qos interface bind: kind must be dscp-tc, tc-queue or scheduler-policy (got '${kindTok}')`)] };
      const st = state(ctx);
      if (kind === "dscp-tc" && !st.dscpTcMaps.some((m) => m.name === name)) {
        return { output: [err(`config qos interface bind: dscp-tc map ${name} does not exist`)] };
      }
      if (kind === "tc-queue" && !st.tcQueueMaps.some((m) => m.name === name)) {
        return { output: [err(`config qos interface bind: tc-queue map ${name} does not exist`)] };
      }
      if (kind === "scheduler-policy" && !st.schedulers.some((p) => p.name === name)) {
        return { output: [err(`config qos interface bind: scheduler-policy ${name} does not exist`)] };
      }
      const b = binding(st, port);
      if (kind === "dscp-tc") b.dscpTc = name;
      else if (kind === "tc-queue") b.tcQueue = name;
      else b.schedulerPolicy = name;
      return { output: [muted(`${port}: bound ${kind} ${name}`)] };
    },
  },
  {
    path: ["qos", "interface", "unbind"],
    summary: "Remove a qos binding from an interface",
    run(args, ctx): CommandResult {
      const [port, kindTok] = positional(args);
      if (!port || kindTok === undefined) {
        return { output: [err("Usage: config qos interface unbind <port> <dscp-tc|tc-queue|scheduler-policy>")] };
      }
      const kind = parseBindKind(kindTok);
      if (kind === null) return { output: [err(`config qos interface unbind: kind must be dscp-tc, tc-queue or scheduler-policy (got '${kindTok}')`)] };
      const st = state(ctx);
      const b = st.interfaces[port];
      if (!b) return { output: [muted(`${port}: no qos bindings (no-op)`)] };
      if (kind === "dscp-tc") b.dscpTc = undefined;
      else if (kind === "tc-queue") b.tcQueue = undefined;
      else b.schedulerPolicy = undefined;
      if (b.dscpTc === undefined && b.tcQueue === undefined && b.schedulerPolicy === undefined) delete st.interfaces[port];
      return { output: [muted(`${port}: unbound ${kind}`)] };
    },
  },
];

function renderMap(maps: QosMap[], label: string, keyHdr: string, valHdr: string, name?: string): OutputLine[] {
  const list = (name ? maps.filter((m) => m.name === name) : [...maps]).sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0) return [muted(name ? `${label} ${name} not configured` : `No ${label}s configured`)];
  const out: OutputLine[] = [];
  for (const m of list) {
    out.push(line(`${label}: ${m.name}`));
    out.push(line(`${keyHdr.padEnd(5)}${valHdr}`));
    for (const e of [...m.entries].sort((a, b) => a.key - b.key)) {
      out.push(line(`${String(e.key).padEnd(5)}${e.value}`));
    }
  }
  return out;
}

function renderSchedulers(ctx: CommandContext, name?: string): OutputLine[] {
  const all = peekFeatureState<QosState>(ctx.device, "qos")?.schedulers ?? [];
  const list = (name ? all.filter((p) => p.name === name) : [...all]).sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0) return [muted(name ? `Scheduler policy ${name} not configured` : "No scheduler policies configured")];
  const out: OutputLine[] = [];
  for (const p of list) {
    out.push(line(`Scheduler Policy: ${p.name}`));
    for (const q of [...p.queues].sort((a, b) => a.queue - b.queue)) {
      out.push(line(`Queue: ${q.queue}`));
      out.push(line(`type: ${q.type}`));
      if (q.weight !== undefined) out.push(line(`weight: ${q.weight}`));
    }
  }
  return out;
}

function renderWred(ctx: CommandContext, name?: string): OutputLine[] {
  const all = peekFeatureState<QosState>(ctx.device, "qos")?.wredPolicies ?? [];
  const list = (name ? all.filter((p) => p.name === name) : [...all]).sort((a, b) => a.name.localeCompare(b.name));
  if (list.length === 0) return [muted(name ? `WRED policy ${name} not configured` : "No WRED policies configured")];
  const out: OutputLine[] = [];
  for (const p of list) {
    out.push(line(`${"Policy".padEnd(22)} : ${p.name}`));
    const colors = [...p.colors].sort((a, b) => a.color.localeCompare(b.color));
    if (colors.length) out.push(line(`${"ecn".padEnd(22)} : ${colors.map((c) => `ecn_${c.color}`).join(",")}`));
    for (const c of colors) {
      out.push(line(`${`${c.color}-min-threshold`.padEnd(22)} : ${c.min}         KBytes`));
      out.push(line(`${`${c.color}-max-threshold`.padEnd(22)} : ${c.max}         KBytes`));
      out.push(line(`${`${c.color}-drop-probability`.padEnd(22)} : ${c.prob}`));
    }
  }
  return out;
}

function renderInterface(ctx: CommandContext, port: string): OutputLine[] {
  const st = peekFeatureState<QosState>(ctx.device, "qos");
  const b = st?.interfaces[port];
  if (!b || (b.dscpTc === undefined && b.tcQueue === undefined && b.schedulerPolicy === undefined)) {
    return [muted(`No qos bindings on ${port}`)];
  }
  const out: OutputLine[] = [];
  if (b.schedulerPolicy !== undefined) {
    const policy = st?.schedulers.find((p) => p.name === b.schedulerPolicy);
    const firstQueue = policy && policy.queues.length ? Math.min(...policy.queues.map((q) => q.queue)) : undefined;
    out.push(line(`scheduler policy: ${b.schedulerPolicy}${firstQueue !== undefined ? `@${firstQueue}` : ""}`));
  }
  if (b.dscpTc !== undefined) out.push(line(`dscp-tc-map: ${b.dscpTc}`));
  if (b.tcQueue !== undefined) out.push(line(`tc-queue-map: ${b.tcQueue}`));
  return out;
}

function renderSummary(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<QosState>(ctx.device, "qos");
  const bound = st ? Object.keys(st.interfaces).length : 0;
  return [
    muted("QoS configuration (simulated config-plane; no ASIC/queue counters)"),
    line(`  DSCP-TC maps       : ${st?.dscpTcMaps.length ?? 0}`),
    line(`  TC-Queue maps      : ${st?.tcQueueMaps.length ?? 0}`),
    line(`  Scheduler policies : ${st?.schedulers.length ?? 0}`),
    line(`  WRED policies      : ${st?.wredPolicies.length ?? 0}`),
    line(`  Bound interfaces   : ${bound}`),
  ];
}

const show: SonicCmd[] = [
  {
    path: ["qos", "map", "dscp-tc"],
    summary: "Show DSCP-TC map(s)",
    run(args, ctx): CommandResult {
      return { output: renderMap(state(ctx).dscpTcMaps, "DSCP-TC-MAP", "DSCP", "TC", positional(args)[0]) };
    },
  },
  {
    path: ["qos", "map", "tc-queue"],
    summary: "Show TC-Queue map(s)",
    run(args, ctx): CommandResult {
      return { output: renderMap(state(ctx).tcQueueMaps, "Traffic-Class-Queue-MAP", "TC", "Queue", positional(args)[0]) };
    },
  },
  {
    path: ["qos", "scheduler-policy"],
    summary: "Show scheduler policies",
    run: (args, ctx) => ({ output: renderSchedulers(ctx, positional(args)[0]) }),
  },
  {
    path: ["qos", "wred-policy"],
    summary: "Show WRED policies",
    run: (args, ctx) => ({ output: renderWred(ctx, positional(args)[0]) }),
  },
  {
    path: ["qos", "interface"],
    summary: "Show qos bindings on an interface",
    run(args, ctx): CommandResult {
      const port = positional(args)[0];
      if (!port) return { output: [err("Usage: show qos interface <port>")] };
      return { output: renderInterface(ctx, port) };
    },
  },
  {
    path: ["qos"],
    summary: "Show a summary of configured QoS maps/policies/bindings",
    run: (_a, ctx) => ({ output: renderSummary(ctx) }),
  },
];

export const qosModule: SonicFeatureModule = { id: "qos", config, show };
