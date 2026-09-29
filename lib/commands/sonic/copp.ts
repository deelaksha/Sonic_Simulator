/**
 * CoPP (control-plane policing) SONiC feature module. Config-plane only
 * (simulated CONFIG_DB): commands mutate per-device feature state and
 * `show copp ...` renders SOLELY from that stored state. Nothing rate-limits or
 * drops real control-plane traffic — that needs a packet-engine hook not present
 * yet, so NO counters/drops are fabricated here; this is educational.
 *
 * Commands mirror the SONiC management-framework CoPP forms in copp.txt, wrapped
 * as click-style `config copp ...` / `show copp ...` sub-commands (path
 * ["copp", ...]). The three CoPP objects copp.txt configures:
 *
 *   config copp action add <name>                 <- copp-action <name>
 *   config copp action del <name>                 <- no copp-action <name>
 *   config copp action set <name> trap-action <a> <- set trap-action <a>
 *   config copp action set <name> trap-queue <n>  <- set trap-queue <n>
 *   config copp action set <name> trap-priority <n> <- set trap-priority <n>
 *   config copp action set <name> police cir <n> cbs <n> <- police cir <n> cbs <n>
 *   config copp classifier add <name>             <- class-map <name> match-type copp
 *   config copp classifier del <name>             <- no class-map <name>
 *   config copp classifier match <name> <proto>   <- match protocol <proto>
 *   config copp classifier no-match <name> <proto> <- no match protocol <proto>
 *   config copp bind <classifier> <action> [prio] <- class <c> priority <prio>; set copp-action <action>
 *   config copp unbind <classifier>               <- no class <c>
 *   show copp actions                             <- show copp actions
 *   show copp classifiers                         <- show copp classifiers
 *   show copp policy                              <- show copp policy
 *   show copp protocols                           <- show copp protocols
 *
 * Enums/ranges are taken verbatim from copp.txt: COPP_TRAP_ACTION values
 * trap|drop|forward|copy|copy_cancel|log|deny|transit (lines 320-327); trap-queue
 * COPP_RANGE_0_31 (TC-26); trap-priority COPP_RANGE_0_1023 (TC-27); police cir/cbs
 * are uint32 1..4294967295 (TC-28 rejects 0, TC-29 rejects 4294967296, TC-24
 * rejects unit suffixes). match protocol rejects unsupported protocols (TC-35) and
 * a protocol already claimed by another classifier (TC-34); deleting a
 * non-existent action group is an idempotent no-op (TC-31). The fixed policy is
 * copp-system-policy (line 49).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";

/** COPP_TRAP_ACTION enum (copp.txt lines 320-327). */
const TRAP_ACTIONS = ["trap", "drop", "forward", "copy", "copy_cancel", "log", "deny", "transit"] as const;
type TrapAction = (typeof TRAP_ACTIONS)[number];

/** Protocols the CoPP classifier accepts (copp.txt: match protocol <p>). */
const SUPPORTED_PROTOCOLS = ["arp_req", "arp_resp", "bgp", "eapol", "isis", "lacp", "ldp", "lldp", "ssh", "stp"];

const QUEUE = { min: 0, max: 31 }; // COPP_RANGE_0_31 (TC-26)
const PRIORITY = { min: 0, max: 1023 }; // COPP_RANGE_0_1023 (TC-27)
const RATE = { min: 1, max: 4294967295 }; // uint32 (TC-28/TC-29)

const POLICY_NAME = "copp-system-policy"; // copp.txt line 49

interface CoppActionGroup {
  name: string;
  trapAction?: TrapAction;
  trapQueue?: number;
  trapPriority?: number;
  cir?: number;
  cbs?: number;
}

interface CoppClassifier {
  name: string;
  protocols: string[];
}

interface CoppBinding {
  classifier: string; // Flow
  action: string; // bound copp-action
  priority: number;
}

interface CoppState {
  actions: CoppActionGroup[];
  classifiers: CoppClassifier[];
  bindings: CoppBinding[];
}

function state(ctx: CommandContext): CoppState {
  return featureState<CoppState>(ctx.device, "copp", () => ({ actions: [], classifiers: [], bindings: [] }));
}

/** Parse a non-negative integer token; null if it is not all digits (rejects unit suffixes like "1kbps"). */
function parseUint(tok: string | undefined): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  return Number(tok);
}

const config: SonicCmd[] = [
  {
    path: ["copp", "action", "add"],
    summary: "Create a CoPP action group (copp-action <name>)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config copp action add <name>")] };
      const st = state(ctx);
      if (!st.actions.some((a) => a.name === name)) st.actions.push({ name }); // re-add is idempotent
      return { output: [muted(`CoPP action group ${name} created`)] };
    },
  },
  {
    path: ["copp", "action", "del"],
    summary: "Delete a CoPP action group (no copp-action <name>)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config copp action del <name>")] };
      const st = state(ctx);
      const before = st.actions.length;
      st.actions = st.actions.filter((a) => a.name !== name);
      st.bindings = st.bindings.filter((b) => b.action !== name); // drop dangling policy bindings
      // Deleting a non-existent action group is an idempotent no-op (TC-31).
      return { output: [muted(st.actions.length < before ? `CoPP action group ${name} deleted` : `CoPP action group ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["copp", "action", "set"],
    summary: "Set a CoPP action-group field (trap-action|trap-queue|trap-priority|police cir <n> cbs <n>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const field = pos[1];
      if (!name || !field) {
        return { output: [err("Usage: config copp action set <name> <trap-action|trap-queue|trap-priority|police> ...")] };
      }
      const g = state(ctx).actions.find((a) => a.name === name);
      if (!g) return { output: [err(`config copp action set: action group '${name}' not found (add it first)`)] };
      switch (field) {
        case "trap-action": {
          const v = pos[2];
          if (v === undefined || !(TRAP_ACTIONS as readonly string[]).includes(v)) {
            return { output: [err(`% Error: Invalid input — trap-action must be one of ${TRAP_ACTIONS.join("|")}`)] };
          }
          g.trapAction = v as TrapAction;
          return { output: [muted(`CoPP action group ${name}: trap-action ${v}`)] };
        }
        case "trap-queue": {
          const n = parseUint(pos[2]);
          if (n === null || n < QUEUE.min || n > QUEUE.max) {
            return { output: [err(`% Error: Invalid input — trap-queue must be ${QUEUE.min}-${QUEUE.max}`)] };
          }
          g.trapQueue = n;
          return { output: [muted(`CoPP action group ${name}: trap-queue ${n}`)] };
        }
        case "trap-priority": {
          const n = parseUint(pos[2]);
          if (n === null || n < PRIORITY.min || n > PRIORITY.max) {
            return { output: [err(`% Error: Invalid input — trap-priority must be ${PRIORITY.min}-${PRIORITY.max}`)] };
          }
          g.trapPriority = n;
          return { output: [muted(`CoPP action group ${name}: trap-priority ${n}`)] };
        }
        case "police": {
          const rest = pos.slice(2);
          if (rest.length === 0) return { output: [err("Usage: config copp action set <name> police cir <n> cbs <n>")] };
          const upd: { cir?: number; cbs?: number } = {};
          for (let i = 0; i < rest.length; i += 2) {
            const key = rest[i];
            if (key !== "cir" && key !== "cbs") return { output: [err(`% Error: Invalid input — unknown police parameter '${key}' (expected cir|cbs)`)] };
            const val = parseUint(rest[i + 1]);
            if (val === null || val < RATE.min || val > RATE.max) {
              return { output: [err(`% Error: Invalid input — police ${key} must be ${RATE.min}-${RATE.max}`)] };
            }
            upd[key] = val;
          }
          if (upd.cir !== undefined) g.cir = upd.cir;
          if (upd.cbs !== undefined) g.cbs = upd.cbs;
          const shown = [upd.cir !== undefined ? `cir ${upd.cir}` : "", upd.cbs !== undefined ? `cbs ${upd.cbs}` : ""].filter(Boolean).join(" ");
          return { output: [muted(`CoPP action group ${name}: police ${shown}`)] };
        }
        default:
          return { output: [err(`% Error: Invalid input — unknown field '${field}'`)] };
      }
    },
  },
  {
    path: ["copp", "classifier", "add"],
    summary: "Create a CoPP classifier (class-map <name> match-type copp)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config copp classifier add <name>")] };
      const st = state(ctx);
      if (!st.classifiers.some((c) => c.name === name)) st.classifiers.push({ name, protocols: [] });
      return { output: [muted(`CoPP classifier ${name} created`)] };
    },
  },
  {
    path: ["copp", "classifier", "del"],
    summary: "Delete a CoPP classifier (no class-map <name>)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config copp classifier del <name>")] };
      const st = state(ctx);
      const before = st.classifiers.length;
      st.classifiers = st.classifiers.filter((c) => c.name !== name);
      st.bindings = st.bindings.filter((b) => b.classifier !== name); // drop dangling policy bindings
      return { output: [muted(st.classifiers.length < before ? `CoPP classifier ${name} deleted` : `CoPP classifier ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["copp", "classifier", "match"],
    summary: "Add a protocol trap to a classifier (match protocol <proto>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const proto = pos[1];
      if (!name || !proto) return { output: [err("Usage: config copp classifier match <name> <protocol>")] };
      const st = state(ctx);
      const c = st.classifiers.find((x) => x.name === name);
      if (!c) return { output: [err(`config copp classifier match: classifier '${name}' not found (add it first)`)] };
      if (!SUPPORTED_PROTOCOLS.includes(proto)) {
        return { output: [err(`% Error: '${proto}' is not a supported COPP protocol`)] };
      }
      const owner = st.classifiers.find((x) => x.name !== name && x.protocols.includes(proto));
      if (owner) return { output: [err(`% Error: protocol '${proto}' already claimed by CoPP classifier '${owner.name}'`)] };
      if (!c.protocols.includes(proto)) c.protocols.push(proto); // re-add is idempotent
      return { output: [muted(`CoPP classifier ${name}: match protocol ${proto}`)] };
    },
  },
  {
    path: ["copp", "classifier", "no-match"],
    summary: "Remove a protocol trap from a classifier (no match protocol <proto>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      const proto = pos[1];
      if (!name || !proto) return { output: [err("Usage: config copp classifier no-match <name> <protocol>")] };
      const c = state(ctx).classifiers.find((x) => x.name === name);
      if (!c) return { output: [err(`config copp classifier no-match: classifier '${name}' not found`)] };
      const before = c.protocols.length;
      c.protocols = c.protocols.filter((p) => p !== proto);
      return { output: [muted(c.protocols.length < before ? `CoPP classifier ${name}: removed protocol ${proto}` : `CoPP classifier ${name}: protocol ${proto} not matched (no-op)`)] };
    },
  },
  {
    path: ["copp", "bind"],
    summary: "Bind a classifier to an action group in copp-system-policy (class <c> priority <p>; set copp-action <a>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const classifier = pos[0];
      const action = pos[1];
      if (!classifier || !action) return { output: [err("Usage: config copp bind <classifier> <action> [priority]")] };
      const st = state(ctx);
      if (!st.classifiers.some((c) => c.name === classifier)) return { output: [err(`config copp bind: classifier '${classifier}' not found`)] };
      if (!st.actions.some((a) => a.name === action)) return { output: [err(`config copp bind: action group '${action}' not found`)] };
      let priority = 0;
      if (pos[2] !== undefined) {
        const p = parseUint(pos[2]);
        if (p === null || p < PRIORITY.min || p > PRIORITY.max) {
          return { output: [err(`% Error: Invalid input — priority must be ${PRIORITY.min}-${PRIORITY.max}`)] };
        }
        priority = p;
      }
      const existing = st.bindings.find((b) => b.classifier === classifier);
      if (existing) {
        existing.action = action;
        existing.priority = priority;
      } else {
        st.bindings.push({ classifier, action, priority });
      }
      return { output: [muted(`${POLICY_NAME}: bound classifier ${classifier} -> action ${action} (priority ${priority})`)] };
    },
  },
  {
    path: ["copp", "unbind"],
    summary: "Remove a classifier flow from copp-system-policy (no class <c>)",
    run(args, ctx): CommandResult {
      const classifier = positional(args)[0];
      if (!classifier) return { output: [err("Usage: config copp unbind <classifier>")] };
      const st = state(ctx);
      const before = st.bindings.length;
      st.bindings = st.bindings.filter((b) => b.classifier !== classifier);
      return { output: [muted(st.bindings.length < before ? `${POLICY_NAME}: unbound classifier ${classifier}` : `${POLICY_NAME}: classifier ${classifier} not bound (no-op)`)] };
    },
  },
];

/** Field lines for an action group, in copp.txt's `show copp actions` order. */
function actionFieldLines(g: CoppActionGroup): OutputLine[] {
  const out: OutputLine[] = [];
  if (g.trapAction !== undefined) out.push(line(`trap-action ${g.trapAction}`));
  if (g.trapPriority !== undefined) out.push(line(`trap-priority ${g.trapPriority}`));
  if (g.trapQueue !== undefined) out.push(line(`trap-queue ${g.trapQueue}`));
  if (g.cir !== undefined || g.cbs !== undefined) {
    const parts = [g.cir !== undefined ? `cir ${g.cir}` : "", g.cbs !== undefined ? `cbs ${g.cbs}` : ""].filter(Boolean);
    out.push(line(`police ${parts.join(" ")}`));
  }
  return out;
}

function renderActions(ctx: CommandContext): OutputLine[] {
  const actions = [...(peekFeatureState<CoppState>(ctx.device, "copp")?.actions ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (actions.length === 0) return [muted("No CoPP action groups configured")];
  const out: OutputLine[] = [];
  for (const g of actions) {
    out.push(line(`CoPP action group ${g.name}`));
    out.push(...actionFieldLines(g));
  }
  return out;
}

function renderClassifiers(ctx: CommandContext): OutputLine[] {
  const classifiers = [...(peekFeatureState<CoppState>(ctx.device, "copp")?.classifiers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (classifiers.length === 0) return [muted("No CoPP classifiers configured")];
  const out: OutputLine[] = [];
  for (const c of classifiers) {
    out.push(line(`Classifier ${c.name} match-type copp`));
    for (const p of c.protocols) out.push(line(`protocol ${p}`));
  }
  return out;
}

function renderPolicy(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<CoppState>(ctx.device, "copp");
  const bindings = [...(st?.bindings ?? [])].sort((a, b) => a.classifier.localeCompare(b.classifier));
  if (bindings.length === 0) return [muted("No CoPP policy bindings configured")];
  const out: OutputLine[] = [line(`Policy ${POLICY_NAME} Type copp`)];
  for (const b of bindings) {
    out.push(line(`Flow ${b.classifier}`));
    out.push(line(`Action ${b.action}`));
    const g = st?.actions.find((a) => a.name === b.action);
    if (g) out.push(...actionFieldLines(g));
  }
  return out;
}

function renderProtocols(): OutputLine[] {
  const out: OutputLine[] = [line("Class-map match-type copp protocols")];
  for (const p of SUPPORTED_PROTOCOLS) out.push(line(`protocol ${p}`));
  return out;
}

function renderSummary(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<CoppState>(ctx.device, "copp");
  if (!st || (st.actions.length === 0 && st.classifiers.length === 0 && st.bindings.length === 0)) {
    return [muted("No CoPP configuration")];
  }
  return [
    line(`CoPP action groups : ${st.actions.length}`),
    line(`CoPP classifiers   : ${st.classifiers.length}`),
    line(`Policy ${POLICY_NAME} flows: ${st.bindings.length}`),
  ];
}

const show: SonicCmd[] = [
  { path: ["copp", "actions"], summary: "Show configured CoPP action groups", run: (_a, ctx) => ({ output: renderActions(ctx) }) },
  { path: ["copp", "classifiers"], summary: "Show configured CoPP classifiers", run: (_a, ctx) => ({ output: renderClassifiers(ctx) }) },
  { path: ["copp", "policy"], summary: "Show the copp-system-policy bindings", run: (_a, ctx) => ({ output: renderPolicy(ctx) }) },
  { path: ["copp", "protocols"], summary: "Show supported CoPP classifier protocols", run: () => ({ output: renderProtocols() }) },
  { path: ["copp"], summary: "Show a CoPP configuration summary", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
];

export const coppModule: SonicFeatureModule = { id: "copp", config, show };
