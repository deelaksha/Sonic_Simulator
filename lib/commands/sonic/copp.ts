/**
 * CoPP (control-plane policing) SONiC feature module. The commands mutate the
 * simulated CONFIG_DB (features["copp"]); the CPU path (lib/protocols/
 * cpu-daemon.ts) reads it on every trapped packet, so a bound action group's
 * trap-queue / police cir/cbs / meter-type / trap-action really steer and
 * police control traffic. Unconfigured trap ids use the image defaults
 * (copp_cfg.j2, lib/protocols/cpu-traps.ts).
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
 *   config copp action set <name> meter-type packets|bytes <- police ... meter-type (copp.xml)
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
 *   show copp counters                            <- show copp counters (copp.xml:91, show_copp_counters.j2)
 *   show copp configuration [detailed -t|-g]      <- sonic-utilities show/copp.py
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
import {
  CoppActionGroup, CoppState, DEFAULT_GROUPS, DEFAULT_TRAPS, TRAP_PROTOCOLS, resolveTrap,
} from "../../protocols/cpu-traps";
import { peekCoppRuntime } from "../../protocols/cpu-daemon";

/** COPP_TRAP_ACTION enum (copp.txt lines 320-327). */
const TRAP_ACTIONS = ["trap", "drop", "forward", "copy", "copy_cancel", "log", "deny", "transit"] as const;
type TrapAction = (typeof TRAP_ACTIONS)[number];

/** Protocols the CoPP classifier accepts (copp.txt: match protocol <p>; trap ids from copporch.cpp:60-100). */
const SUPPORTED_PROTOCOLS = TRAP_PROTOCOLS;

const QUEUE = { min: 0, max: 31 }; // COPP_RANGE_0_31 (TC-26)
const PRIORITY = { min: 0, max: 1023 }; // COPP_RANGE_0_1023 (TC-27)
const RATE = { min: 1, max: 4294967295 }; // uint32 (TC-28/TC-29)

const POLICY_NAME = "copp-system-policy"; // copp.txt line 49

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
        case "meter-type": {
          const v = pos[2];
          if (v !== "packets" && v !== "bytes") return { output: [err("% Error: Invalid input — meter-type must be packets|bytes")] };
          g.meterType = v;
          return { output: [muted(`CoPP action group ${name}: meter-type ${v}`)] };
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
    if (g.meterType !== undefined) out.push(line(`  meter-type ${g.meterType}`));
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

/** printf-style %-Ns / %Ns. */
const L = (v: string, w: number) => v.padEnd(w);
const R = (v: string, w: number) => v.padStart(w);

/** show copp counters — show_copp_counters.j2 over the per-trap flow counters (xfmr_copp.go:157-238, sorted by trap name). */
function renderCounters(ctx: CommandContext): OutputLine[] {
  const traps = peekCoppRuntime(ctx.device)?.traps ?? {};
  const names = Object.keys(traps).sort();
  if (names.length === 0) return [line("No trap flow counters available")];
  const fmt = (a: string, b: string, c: string, d: string) => `${L(a, 20)} ${R(b, 15)} ${R(c, 15)} ${R(d, 10)}`;
  return [
    line(fmt("Trap Name", "Packets", "Bytes", "PPS")),
    line(fmt("-".repeat(20), "-".repeat(15), "-".repeat(15), "-".repeat(10))),
    ...names.map((n) => line(fmt(n, String(traps[n].pkts), String(traps[n].bytes), traps[n].pps.toFixed(2)))),
  ];
}

interface MergedTrap { trapIds: string[]; group: string }
interface MergedGroup { trapAction: string; trapPriority?: number; queue?: number; cir?: number; cbs?: number; meterType?: string; mode?: string; redAction?: string }

/** COPP_GROUP / COPP_TRAP as show/copp.py merge_copp_config sees them: copp_cfg defaults + KLISH-written entries. */
function mergedConfig(ctx: CommandContext): { groups: Record<string, MergedGroup>; traps: Record<string, MergedTrap> } {
  const groups: Record<string, MergedGroup> = {};
  for (const [k, gr] of Object.entries(DEFAULT_GROUPS)) groups[k] = { ...gr };
  const traps: Record<string, MergedTrap> = {};
  for (const [k, t] of Object.entries(DEFAULT_TRAPS)) traps[k] = { trapIds: t.trapIds, group: t.group };
  const st = peekFeatureState<CoppState>(ctx.device, "copp");
  for (const a of st?.actions ?? []) {
    groups[a.name] = { trapAction: a.trapAction ?? "", trapPriority: a.trapPriority, queue: a.trapQueue, cir: a.cir, cbs: a.cir !== undefined ? (a.cbs ?? a.cir) : a.cbs, meterType: a.meterType ?? (a.cir !== undefined ? "packets" : undefined), mode: a.cir !== undefined ? "sr_tcm" : undefined, redAction: a.cir !== undefined ? "drop" : undefined };
  }
  for (const b of st?.bindings ?? []) {
    const c = st?.classifiers.find((x) => x.name === b.classifier);
    if (c && c.protocols.length) traps[c.name] = { trapIds: c.protocols, group: b.action };
  }
  return { groups, traps };
}

/** HW Status (STATE_DB COPP_TRAP_TABLE|<trap_id> hw_status): installed when this row's group is the one programmed. */
function hwStatus(ctx: CommandContext, trapId: string, group: string): string {
  return resolveTrap(ctx.device, trapId)?.group === group ? "installed" : "not-installed";
}

const opt = (v: number | string | undefined) => (v === undefined ? "" : String(v));

/** python tabulate "simple" with numeric columns right-aligned. */
function simpleTable(header: string[], rows: string[][]): OutputLine[] {
  const numeric = header.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === "" || /^\d+$/.test(r[i])) && rows.some((r) => r[i] !== ""));
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (numeric[i] ? R(c, w[i]) : L(c, w[i]))).join("  ").replace(/\s+$/, "");
  return [line(fmt(header)), line(w.map((n) => "-".repeat(n)).join("  ")), ...rows.map((r) => line(fmt(r)))];
}

function renderConfiguration(ctx: CommandContext): OutputLine[] {
  const { groups, traps } = mergedConfig(ctx);
  const rows: string[][] = [];
  for (const t of Object.values(traps)) {
    const gr = groups[t.group];
    if (!gr) continue;
    for (const id of t.trapIds) rows.push([id, t.group, gr.trapAction, opt(gr.cbs), opt(gr.cir), opt(gr.meterType), opt(gr.mode), hwStatus(ctx, id, t.group)]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }) || a[1].localeCompare(b[1]));
  return simpleTable(["TrapId", "Trap Group", "Action", "CBS", "CIR", "Meter Type", "Mode", "HW Status"], rows);
}

function flagVal(args: string[], short: string, long: string): string | undefined {
  const i = args.findIndex((a) => a === short || a === long);
  return i >= 0 ? args[i + 1] : undefined;
}

/** show copp configuration detailed --trapid <id> | --group <g> (show/copp.py:229-268, print_single_copp_entry). */
function renderDetailed(args: string[], ctx: CommandContext): OutputLine[] {
  const trapid = flagVal(args, "-t", "--trapid");
  const group = flagVal(args, "-g", "--group");
  if (!trapid && !group) return [line("Either trapid or group must be provided.")];
  if (trapid && group) return [line("Either trapid or group must be provided, but not both.")];
  const { groups, traps } = mergedConfig(ctx);
  let gname = group;
  if (trapid) {
    const owners = Object.values(traps).filter((t) => t.trapIds.includes(trapid));
    gname = (owners.find((t) => hwStatus(ctx, trapid, t.group) === "installed") ?? owners[0])?.group;
  }
  const gr = gname ? groups[gname] : undefined;
  if (!gname || !gr) return [];
  const out: OutputLine[] = [];
  const dots = (label: string, v: string) => line(`${label.padEnd(28, ".")} ${v}`);
  if (!trapid) {
    const ids = Object.values(traps).filter((t) => t.group === gname).flatMap((t) => t.trapIds);
    out.push(dots("Trap Id(s)", ids.join(",")));
  } else out.push(dots("Trap Group", gname));
  out.push(dots("Trap Action", gr.trapAction), dots("Trap Priority", opt(gr.trapPriority)), dots("Queue", opt(gr.queue)));
  out.push(dots("CBS", opt(gr.cbs)), dots("CIR", opt(gr.cir)), dots("Meter Type", opt(gr.meterType)), dots("Mode", opt(gr.mode)));
  if (gr.mode === "sr_tcm" || gr.mode === "tr_tcm") out.push(dots("Yellow Action", "forward"));
  out.push(dots("Green Action", "forward"), dots("Red Action", opt(gr.redAction)));
  if (trapid) out.push(dots("HW Status", hwStatus(ctx, trapid, gname)));
  return out;
}

const show: SonicCmd[] = [
  { path: ["copp", "actions"], summary: "Show configured CoPP action groups", run: (_a, ctx) => ({ output: renderActions(ctx) }) },
  { path: ["copp", "classifiers"], summary: "Show configured CoPP classifiers", run: (_a, ctx) => ({ output: renderClassifiers(ctx) }) },
  { path: ["copp", "policy"], summary: "Show the copp-system-policy bindings", run: (_a, ctx) => ({ output: renderPolicy(ctx) }) },
  { path: ["copp", "protocols"], summary: "Show supported CoPP classifier protocols", run: () => ({ output: renderProtocols() }) },
  { path: ["copp", "counters"], summary: "Show per-trap CoPP flow counters (packets, bytes, PPS)", run: (_a, ctx) => ({ output: renderCounters(ctx) }) },
  { path: ["copp", "configuration"], summary: "Show CoPP trap/group configuration with HW status", run: (_a, ctx) => ({ output: renderConfiguration(ctx) }) },
  { path: ["copp", "configuration", "detailed"], summary: "Show one trap id (-t) or trap group (-g) in detail", run: (a, ctx) => ({ output: renderDetailed(a, ctx) }) },
  { path: ["copp"], summary: "Show a CoPP configuration summary", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
];

export const coppModule: SonicFeatureModule = { id: "copp", config, show };
