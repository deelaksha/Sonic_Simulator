/**
 * FBS (Flow-Based Services) SONiC feature module. Config-plane only (simulated
 * CONFIG_DB): commands mutate per-device feature state and `show fbs ...` renders
 * SOLELY from that stored state. Nothing classifies, polices or forwards real
 * traffic — that needs a packet-engine hook not present yet — so NO match/flow
 * counters or forwarding results are fabricated here; this is educational.
 *
 * FBS has three objects (class-maps / policy-maps / service-policy bindings),
 * mirrored from fbs.txt and wrapped as click-style `config fbs ...` / `show
 * fbs ...` sub-commands (path ["fbs", ...]). The KLISH forms in fbs.txt they map
 * to:
 *
 *   config fbs classifier add <name>                <- class-map <name> match-type fields match-all
 *   config fbs classifier del <name>                <- no class-map <name>
 *   config fbs classifier match <name> <field> <v>  <- match <field> <v>
 *   config fbs classifier no-match <name> <field>   <- no match <field>
 *   config fbs policy add <name> <type>             <- policy-map <name> type <qos|forwarding|monitoring>
 *   config fbs policy del <name>                    <- no policy-map <name>
 *   config fbs policy flow add <policy> <cls> <pri> <- class <cls> priority <pri>
 *   config fbs policy flow del <policy> <cls>       <- no class <cls>
 *   config fbs policy flow action <policy> <cls> <a> ... <- set dscp|set pcp|police cir <n> cbs <n>
 *   config fbs bind <policy> <iface> <in|out>       <- interface <i>; service-policy type <t> <in|out> <p>
 *   config fbs unbind <policy> <iface> <in|out>     <- no service-policy type <t> <in|out> <p>
 *   show fbs classifier [name]                      <- show class-map [name]
 *   show fbs policy [name]                          <- show policy-map [name]
 *   show fbs bindings                               <- show service-policy summary
 *   show fbs                                         <- FBS configuration summary
 *
 * Match fields / ranges taken from fbs.txt: dscp 0-63, pcp 0-7, vlan 1-4094,
 * ip-protocol 0-255 (`match ip protocol <n>`), src-ip/dst-ip CIDR
 * (`match source-address ip <cidr>` / `match destination-address ip <cidr>`).
 * Flow actions: set-dscp 0-63, set-pcp 0-7, police cir <n> cbs <n> (uint32).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { interfaceByName } from "../../models/device";

/** policy-map types (fbs.txt: policy-map <name> type <...>). */
const POLICY_TYPES = ["qos", "forwarding", "monitoring"] as const;
type PolicyType = (typeof POLICY_TYPES)[number];

const DSCP = { min: 0, max: 63 };
const PCP = { min: 0, max: 7 };
const VLAN = { min: 1, max: 4094 };
const IP_PROTO = { min: 0, max: 255 };
const PRIORITY = { min: 0, max: 65535 };
const RATE = { min: 1, max: 4294967295 }; // uint32 (police cir/cbs)

const CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

/** Match fields the classifier accepts, with their `show class-map` rendering. */
const MATCH_FIELDS = ["dscp", "pcp", "vlan", "ip-protocol", "src-ip", "dst-ip"] as const;
type MatchField = (typeof MATCH_FIELDS)[number];

interface FbsMatch {
  field: MatchField;
  value: string;
}

interface FbsClassifier {
  name: string;
  matches: FbsMatch[];
}

interface FbsFlowAction {
  name: "set-dscp" | "set-pcp" | "police";
  detail: string; // rendered value, e.g. "46" or "cir 1000 cbs 10000"
}

interface FbsFlow {
  classifier: string;
  priority: number;
  actions: FbsFlowAction[];
}

interface FbsPolicy {
  name: string;
  type: PolicyType;
  flows: FbsFlow[];
}

interface FbsBinding {
  policy: string;
  iface: string;
  direction: "in" | "out";
}

interface FbsState {
  classifiers: FbsClassifier[];
  policies: FbsPolicy[];
  bindings: FbsBinding[];
}

function state(ctx: CommandContext): FbsState {
  return featureState<FbsState>(ctx.device, "fbs", () => ({ classifiers: [], policies: [], bindings: [] }));
}

/** Parse a non-negative integer token; null if not all digits (rejects unit suffixes). */
function parseUint(tok: string | undefined): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  return Number(tok);
}

/** Validate a match field value; return an error string, or the normalized value to store. */
function validateMatch(field: MatchField, value: string | undefined): { value: string } | { error: string } {
  if (value === undefined) return { error: `% Error: Invalid input — match ${field} requires a value` };
  const range = (r: { min: number; max: number }) => {
    const n = parseUint(value);
    if (n === null || n < r.min || n > r.max) return { error: `% Error: Invalid input — ${field} must be ${r.min}-${r.max}` };
    return { value: String(n) };
  };
  switch (field) {
    case "dscp":
      return range(DSCP);
    case "pcp":
      return range(PCP);
    case "vlan":
      return range(VLAN);
    case "ip-protocol":
      return range(IP_PROTO);
    case "src-ip":
    case "dst-ip":
      if (!CIDR.test(value)) return { error: `% Error: Invalid input — ${field} must be an IPv4 CIDR (e.g. 10.0.0.0/24)` };
      return { value };
  }
}

/** fbs.txt `match ...` rendering for a stored criterion. */
function matchText(m: FbsMatch): string {
  switch (m.field) {
    case "dscp":
      return `dscp ${m.value}`;
    case "pcp":
      return `pcp ${m.value}`;
    case "vlan":
      return `vlan ${m.value}`;
    case "ip-protocol":
      return `ip protocol ${m.value}`;
    case "src-ip":
      return `source-address ip ${m.value}`;
    case "dst-ip":
      return `destination-address ip ${m.value}`;
  }
}

const config: SonicCmd[] = [
  {
    path: ["fbs", "classifier", "add"],
    summary: "Create an FBS classifier (class-map <name> match-type fields match-all)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config fbs classifier add <name>")] };
      const st = state(ctx);
      if (!st.classifiers.some((c) => c.name === name)) st.classifiers.push({ name, matches: [] }); // re-add is idempotent
      return { output: [muted(`FBS classifier ${name} created`)] };
    },
  },
  {
    path: ["fbs", "classifier", "del"],
    summary: "Delete an FBS classifier (no class-map <name>)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config fbs classifier del <name>")] };
      const st = state(ctx);
      const before = st.classifiers.length;
      st.classifiers = st.classifiers.filter((c) => c.name !== name);
      for (const p of st.policies) p.flows = p.flows.filter((f) => f.classifier !== name); // drop dangling flows
      return { output: [muted(st.classifiers.length < before ? `FBS classifier ${name} deleted` : `FBS classifier ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["fbs", "classifier", "match"],
    summary: "Add a match criterion to a classifier (match <field> <value>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const field = pos[1];
      if (!name || !field) return { output: [err(`Usage: config fbs classifier match <name> <${MATCH_FIELDS.join("|")}> <value>`)] };
      if (!(MATCH_FIELDS as readonly string[]).includes(field)) {
        return { output: [err(`% Error: Invalid input — unknown match field '${field}' (expected ${MATCH_FIELDS.join("|")})`)] };
      }
      const c = state(ctx).classifiers.find((x) => x.name === name);
      if (!c) return { output: [err(`config fbs classifier match: classifier '${name}' not found (add it first)`)] };
      const res = validateMatch(field as MatchField, pos[2]);
      if ("error" in res) return { output: [err(res.error)] };
      const existing = c.matches.find((m) => m.field === field);
      if (existing) existing.value = res.value; // re-match overrides that field
      else c.matches.push({ field: field as MatchField, value: res.value });
      return { output: [muted(`FBS classifier ${name}: match ${matchText({ field: field as MatchField, value: res.value })}`)] };
    },
  },
  {
    path: ["fbs", "classifier", "no-match"],
    summary: "Remove a match criterion from a classifier (no match <field>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const field = pos[1];
      if (!name || !field) return { output: [err("Usage: config fbs classifier no-match <name> <field>")] };
      const c = state(ctx).classifiers.find((x) => x.name === name);
      if (!c) return { output: [err(`config fbs classifier no-match: classifier '${name}' not found`)] };
      const before = c.matches.length;
      c.matches = c.matches.filter((m) => m.field !== field);
      return { output: [muted(c.matches.length < before ? `FBS classifier ${name}: removed match ${field}` : `FBS classifier ${name}: ${field} not matched (no-op)`)] };
    },
  },
  {
    path: ["fbs", "policy", "add"],
    summary: "Create an FBS policy (policy-map <name> type <qos|forwarding|monitoring>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const type = pos[1];
      if (!name || !type) return { output: [err(`Usage: config fbs policy add <name> <${POLICY_TYPES.join("|")}>`)] };
      if (!(POLICY_TYPES as readonly string[]).includes(type)) {
        return { output: [err(`% Error: Invalid input — policy type must be one of ${POLICY_TYPES.join("|")}`)] };
      }
      const st = state(ctx);
      const existing = st.policies.find((p) => p.name === name);
      if (existing) {
        if (existing.type !== type) return { output: [err(`% Error: policy '${name}' already exists with type ${existing.type}`)] };
      } else {
        st.policies.push({ name, type: type as PolicyType, flows: [] });
      }
      return { output: [muted(`FBS policy ${name} type ${type} created`)] };
    },
  },
  {
    path: ["fbs", "policy", "del"],
    summary: "Delete an FBS policy (no policy-map <name>)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config fbs policy del <name>")] };
      const st = state(ctx);
      const before = st.policies.length;
      st.policies = st.policies.filter((p) => p.name !== name);
      st.bindings = st.bindings.filter((b) => b.policy !== name); // drop dangling interface bindings
      return { output: [muted(st.policies.length < before ? `FBS policy ${name} deleted` : `FBS policy ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["fbs", "policy", "flow", "add"],
    summary: "Add a classifier flow to a policy (class <classifier> priority <pri>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const policyName = pos[0];
      const classifier = pos[1];
      if (!policyName || !classifier) return { output: [err("Usage: config fbs policy flow add <policy> <classifier> <priority>")] };
      const st = state(ctx);
      const p = st.policies.find((x) => x.name === policyName);
      if (!p) return { output: [err(`config fbs policy flow add: policy '${policyName}' not found`)] };
      if (!st.classifiers.some((c) => c.name === classifier)) return { output: [err(`config fbs policy flow add: classifier '${classifier}' not found`)] };
      const priority = parseUint(pos[2]);
      if (priority === null || priority < PRIORITY.min || priority > PRIORITY.max) {
        return { output: [err(`% Error: Invalid input — priority must be ${PRIORITY.min}-${PRIORITY.max}`)] };
      }
      const existing = p.flows.find((f) => f.classifier === classifier);
      if (existing) existing.priority = priority; // re-add updates priority, keeps actions
      else p.flows.push({ classifier, priority, actions: [] });
      return { output: [muted(`FBS policy ${policyName}: flow ${classifier} at priority ${priority}`)] };
    },
  },
  {
    path: ["fbs", "policy", "flow", "del"],
    summary: "Remove a classifier flow from a policy (no class <classifier>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const policyName = pos[0];
      const classifier = pos[1];
      if (!policyName || !classifier) return { output: [err("Usage: config fbs policy flow del <policy> <classifier>")] };
      const p = state(ctx).policies.find((x) => x.name === policyName);
      if (!p) return { output: [err(`config fbs policy flow del: policy '${policyName}' not found`)] };
      const before = p.flows.length;
      p.flows = p.flows.filter((f) => f.classifier !== classifier);
      return { output: [muted(p.flows.length < before ? `FBS policy ${policyName}: removed flow ${classifier}` : `FBS policy ${policyName}: flow ${classifier} not present (no-op)`)] };
    },
  },
  {
    path: ["fbs", "policy", "flow", "action"],
    summary: "Set a flow action (set-dscp <n> | set-pcp <n> | police cir <n> cbs <n>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const policyName = pos[0];
      const classifier = pos[1];
      const action = pos[2];
      if (!policyName || !classifier || !action) {
        return { output: [err("Usage: config fbs policy flow action <policy> <classifier> <set-dscp|set-pcp|police> ...")] };
      }
      const p = state(ctx).policies.find((x) => x.name === policyName);
      if (!p) return { output: [err(`config fbs policy flow action: policy '${policyName}' not found`)] };
      const f = p.flows.find((x) => x.classifier === classifier);
      if (!f) return { output: [err(`config fbs policy flow action: flow '${classifier}' not in policy '${policyName}' (add it first)`)] };
      let entry: FbsFlowAction;
      switch (action) {
        case "set-dscp": {
          const n = parseUint(pos[3]);
          if (n === null || n < DSCP.min || n > DSCP.max) return { output: [err(`% Error: Invalid input — set-dscp must be ${DSCP.min}-${DSCP.max}`)] };
          entry = { name: "set-dscp", detail: String(n) };
          break;
        }
        case "set-pcp": {
          const n = parseUint(pos[3]);
          if (n === null || n < PCP.min || n > PCP.max) return { output: [err(`% Error: Invalid input — set-pcp must be ${PCP.min}-${PCP.max}`)] };
          entry = { name: "set-pcp", detail: String(n) };
          break;
        }
        case "police": {
          const rest = pos.slice(3);
          const upd: { cir?: number; cbs?: number } = {};
          for (let i = 0; i < rest.length; i += 2) {
            const key = rest[i];
            if (key !== "cir" && key !== "cbs") return { output: [err(`% Error: Invalid input — unknown police parameter '${key}' (expected cir|cbs)`)] };
            const val = parseUint(rest[i + 1]);
            if (val === null || val < RATE.min || val > RATE.max) return { output: [err(`% Error: Invalid input — police ${key} must be ${RATE.min}-${RATE.max}`)] };
            upd[key] = val;
          }
          if (upd.cir === undefined) return { output: [err("Usage: config fbs policy flow action <policy> <classifier> police cir <n> [cbs <n>]")] };
          entry = { name: "police", detail: [`cir ${upd.cir}`, upd.cbs !== undefined ? `cbs ${upd.cbs}` : ""].filter(Boolean).join(" ") };
          break;
        }
        default:
          return { output: [err(`% Error: Invalid input — unknown action '${action}' (expected set-dscp|set-pcp|police)`)] };
      }
      const idx = f.actions.findIndex((a) => a.name === entry.name);
      if (idx >= 0) f.actions[idx] = entry; // re-set overrides same action
      else f.actions.push(entry);
      return { output: [muted(`FBS policy ${policyName} flow ${classifier}: ${entry.name} ${entry.detail}`)] };
    },
  },
  {
    path: ["fbs", "bind"],
    summary: "Bind a policy to an interface (interface <i>; service-policy type <t> <in|out> <policy>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const policyName = pos[0];
      const iface = pos[1];
      const direction = pos[2];
      if (!policyName || !iface || !direction) return { output: [err("Usage: config fbs bind <policy> <iface> <in|out>")] };
      if (direction !== "in" && direction !== "out") return { output: [err("% Error: Invalid input — direction must be in|out")] };
      const st = state(ctx);
      if (!st.policies.some((p) => p.name === policyName)) return { output: [err(`config fbs bind: policy '${policyName}' not found`)] };
      if (!interfaceByName(ctx.device, iface)) return { output: [err(`config fbs bind: interface '${iface}' not found on ${ctx.device.name}`)] };
      const p = st.policies.find((x) => x.name === policyName)!;
      // One policy of a given type per (interface, direction): replace any same-type binding there.
      const conflict = st.bindings.find((b) => b.iface === iface && b.direction === direction && policyTypeOf(st, b.policy) === p.type);
      if (conflict) conflict.policy = policyName;
      else if (!st.bindings.some((b) => b.policy === policyName && b.iface === iface && b.direction === direction)) {
        st.bindings.push({ policy: policyName, iface, direction });
      }
      return { output: [muted(`${iface}: service-policy type ${p.type} ${direction} ${policyName}`)] };
    },
  },
  {
    path: ["fbs", "unbind"],
    summary: "Remove a policy binding from an interface (no service-policy ...)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const policyName = pos[0];
      const iface = pos[1];
      const direction = pos[2];
      if (!policyName || !iface || !direction) return { output: [err("Usage: config fbs unbind <policy> <iface> <in|out>")] };
      const st = state(ctx);
      const before = st.bindings.length;
      st.bindings = st.bindings.filter((b) => !(b.policy === policyName && b.iface === iface && b.direction === direction));
      return { output: [muted(st.bindings.length < before ? `${iface}: unbound ${policyName} (${direction})` : `${iface}: ${policyName} (${direction}) not bound (no-op)`)] };
    },
  },
];

function policyTypeOf(st: FbsState, name: string): PolicyType | undefined {
  return st.policies.find((p) => p.name === name)?.type;
}

/** `show class-map <name>` rendering for one classifier. */
function classifierLines(st: FbsState, c: FbsClassifier): OutputLine[] {
  const out: OutputLine[] = [line(`Class-map ${c.name} match-type fields`)];
  if (c.matches.length === 0) {
    out.push(muted("  no match criteria"));
  } else {
    out.push(line("Match:"));
    for (const m of c.matches) out.push(line(`  ${matchText(m)}`));
  }
  const refs = st.policies
    .filter((p) => p.flows.some((f) => f.classifier === c.name))
    .map((p) => ({ policy: p.name, priority: p.flows.find((f) => f.classifier === c.name)!.priority }));
  if (refs.length > 0) {
    out.push(line("Referenced in flows:"));
    for (const r of refs) out.push(line(`  policy ${r.policy} at priority ${r.priority}`));
  }
  return out;
}

function renderClassifiers(ctx: CommandContext, only?: string): OutputLine[] {
  const st = peekFeatureState<FbsState>(ctx.device, "fbs");
  const classifiers = [...(st?.classifiers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (only) {
    const c = classifiers.find((x) => x.name === only);
    if (!c) return [muted(`Classifier '${only}' not found`)];
    return classifierLines(st!, c);
  }
  if (classifiers.length === 0) return [muted("No FBS classifiers configured")];
  const out: OutputLine[] = [];
  for (const c of classifiers) out.push(...classifierLines(st!, c));
  return out;
}

/** flows sorted highest-priority-first (fbs.txt evaluation order). */
function sortedFlows(p: FbsPolicy): FbsFlow[] {
  return [...p.flows].sort((a, b) => b.priority - a.priority || a.classifier.localeCompare(b.classifier));
}

/** `show policy-map <name>` rendering for one policy. */
function policyLines(p: FbsPolicy): OutputLine[] {
  const out: OutputLine[] = [line(`Policy ${p.name} Type ${p.type.toUpperCase()}`)];
  for (const f of sortedFlows(p)) {
    out.push(line(`Flow ${f.classifier} at priority ${f.priority}`));
    for (const a of f.actions) out.push(line(`  ${a.name} ${a.detail}`));
  }
  return out;
}

function renderPolicies(ctx: CommandContext, only?: string): OutputLine[] {
  const st = peekFeatureState<FbsState>(ctx.device, "fbs");
  const policies = [...(st?.policies ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (only) {
    const p = policies.find((x) => x.name === only);
    if (!p) return [muted(`Policy '${only}' not found`)];
    return policyLines(p);
  }
  if (policies.length === 0) return [muted("No FBS policies configured")];
  const out: OutputLine[] = [];
  for (const p of policies) out.push(...policyLines(p));
  return out;
}

/** `show service-policy summary` rendering, grouped per interface. */
function renderBindings(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<FbsState>(ctx.device, "fbs");
  const bindings = st?.bindings ?? [];
  if (bindings.length === 0) return [muted("No FBS service-policy bindings configured")];
  const ifaces = [...new Set(bindings.map((b) => b.iface))].sort();
  const out: OutputLine[] = [];
  for (const iface of ifaces) {
    out.push(line(iface));
    const rows = bindings
      .filter((b) => b.iface === iface)
      .sort((a, b) => a.policy.localeCompare(b.policy));
    for (const b of rows) {
      const type = policyTypeOf(st!, b.policy) ?? "qos";
      out.push(line(`  ${type} policy ${b.policy} at ${b.direction === "in" ? "ingress" : "egress"}`));
    }
  }
  return out;
}

function renderSummary(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<FbsState>(ctx.device, "fbs");
  if (!st || (st.classifiers.length === 0 && st.policies.length === 0 && st.bindings.length === 0)) {
    return [muted("No FBS configuration")];
  }
  return [
    line(`FBS classifiers : ${st.classifiers.length}`),
    line(`FBS policies    : ${st.policies.length}`),
    line(`FBS bindings    : ${st.bindings.length}`),
  ];
}

const show: SonicCmd[] = [
  {
    path: ["fbs", "classifier"],
    summary: "Show FBS classifiers (optionally one name)",
    run: (args, ctx) => ({ output: renderClassifiers(ctx, positional(args)[0]) }),
  },
  {
    path: ["fbs", "policy"],
    summary: "Show FBS policies (optionally one name)",
    run: (args, ctx) => ({ output: renderPolicies(ctx, positional(args)[0]) }),
  },
  { path: ["fbs", "bindings"], summary: "Show FBS service-policy bindings", run: (_a, ctx) => ({ output: renderBindings(ctx) }) },
  { path: ["fbs"], summary: "Show an FBS configuration summary", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
];

export const fbsModule: SonicFeatureModule = { id: "fbs", config, show };
