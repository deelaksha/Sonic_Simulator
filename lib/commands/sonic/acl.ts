/**
 * ACL SONiC feature module (simulated CONFIG_DB + counters). Commands mutate
 * per-device ACL state (lib/protocols/acl-rules.ts); the data-plane hook
 * (lib/protocols/acl-daemon.ts) enforces it on every frame and updates the
 * per-rule counters that the show commands render.
 *
 * Click-friendly forms rooted at ["acl", ...] (mapping onto the KLISH forms):
 *
 *   config acl table add <name> [ip|ipv6|mac] [ingress|egress]
 *                                          <- {ip|ipv6|mac} access-list <name>
 *   config acl table del <name>            <- no {ip|ipv6|mac} access-list <name>
 *   config acl rule add <table> <seq> <permit|deny> <match...> [remark <text>]
 *                                          <- seq <n> {permit|deny} <match...>
 *   config acl rule del <table> <seq>      <- no seq <n>
 *   config acl bind <table> <port> [ingress|egress]
 *                                          <- interface X / {ip} access-group <name> {in|out}
 *   config acl unbind <table> <port>       <- no {ip} access-group <name> {in|out}
 *   show acl table [name]                  sonic-utilities acl_loader show_table (main.py:939-976)
 *   show acl rule [table] [rule]           acl_loader show_rule (main.py:1029-1101)
 *   aclshow [-a] [-c] [-t T,..] [-r R,..]  scripts/aclshow (exported; needs a registry entry)
 *
 * Behaviour grounded in acl.txt: seq range 1-65535 (TC-22/TC-23); re-using a name
 * with a DIFFERENT type is rejected (TC-30) while a same-type re-declare is a
 * clean no-op (SM_ISCLI_51); a same-seq DIFFERENT-content rule is rejected
 * (TC-27) while an identical re-add is a no-op; deleting a non-existent rule or
 * table is idempotent (TC-47/TC-48); binding a non-existent ACL is rejected
 * (TC-44); deleting a table cascades its rules and bindings away (TC-46).
 * One stage per ACL table: xfmr_acl.go:671-716 rejects binding an ACL in the
 * other direction while it is bound ("Acl X direction of EGRESS not allowed
 * when it is already configured as INGRESS").
 */
import { CommandContext, CommandHandler, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { Device, interfaceByName } from "../../models/device";
import {
  AclParseError,
  AclState,
  AclTable,
  AclType,
  counterKey,
  parseRule,
  priorityOf,
  ruleData,
  ruleFields,
  ruleName,
  sonicTableType,
  splitRemark,
  tabulate,
} from "../../protocols/acl-rules";
import { natCompare } from "./arpnd";

type AclStage = "ingress" | "egress";

/** ACL rule sequence numbers are RANGE_1_65535 (acl.txt TC-22/TC-23). */
const SEQ = { min: 1, max: 65535 };

function state(device: Device): AclState {
  return featureState<AclState>(device, "acl", () => ({ tables: [], rules: {} }));
}

/** "ip"/"ipv6"/"mac" (case-insensitive); omitted defaults to "ip"; else null. */
function parseType(tok: string | undefined): AclType | null {
  if (tok === undefined) return "ip";
  const t = tok.toLowerCase();
  return t === "ip" || t === "ipv6" || t === "mac" ? t : null;
}

/** "ingress"/"egress" (case-insensitive); omitted defaults to "ingress"; else null. */
function parseStage(tok: string | undefined): AclStage | null {
  if (tok === undefined) return "ingress";
  const s = tok.toLowerCase();
  return s === "ingress" || s === "egress" ? s : null;
}

const stageOf = (t: AclTable): AclStage => ((t.stage ?? "ingress").toLowerCase() as AclStage);

/** Drop every counter of a table (or one rule) — counters live with the rule. */
function dropCounters(st: AclState, table: string, rule?: string): void {
  for (const k of Object.keys(st.counters ?? {})) {
    if (rule ? k === counterKey(table, rule) : k.startsWith(`${table}|`)) delete st.counters![k];
  }
}

/**
 * Bind/unbind used by Click `config acl bind` and the KLISH access-group
 * commands. Returns an error string, or null on success.
 */
export function aclBind(device: Device, name: string, port: string, stage: AclStage, type?: AclType): string | null {
  const st = state(device);
  const t = st.tables.find((x) => x.name === name);
  // xfmr_acl.go:778 / 1069 validateAclBindType
  if (!t || (type && (t.type ?? "ip") !== type)) return type ? `ACL ${name} of the specified type not found` : `ACL ${name} not found`;
  const others = t.ports.filter((p) => p !== port);
  if (others.length > 0 && stageOf(t) !== stage) {
    return `Acl ${name} direction of ${stage.toUpperCase()} not allowed when it is already configured as ${stageOf(t).toUpperCase()}`;
  }
  if (port === "Switch") {
    // xfmr_acl.go:860-891: one global bind per ACL type per direction.
    const clash = st.tables.some((o) => o.name !== name && (o.type ?? "ip") === (t.type ?? "ip") && o.ports.includes("Switch") && stageOf(o) === stage);
    if (clash) return "ACL binding on Switch at  already exists.";
  }
  t.stage = stage;
  if (!t.ports.includes(port)) t.ports.push(port);
  return null;
}

export function aclUnbind(device: Device, name: string, port: string, stage?: AclStage): boolean {
  const t = peekFeatureState<AclState>(device, "acl")?.tables.find((x) => x.name === name);
  if (!t || !t.ports.includes(port) || (stage && stageOf(t) !== stage)) return false;
  t.ports = t.ports.filter((p) => p !== port);
  return true;
}

/** Set (or clear) the ACL description — KLISH `remark <text>` in the ACL sub-view. */
export function aclRemark(device: Device, name: string, remark: string | undefined): void {
  const t = peekFeatureState<AclState>(device, "acl")?.tables.find((x) => x.name === name);
  if (!t) return;
  if (remark) t.description = remark;
  else delete t.description;
}

/** `clear {ip|ipv6|mac} access-list counters [name]`: zero matching counters. */
export function aclClearCounters(device: Device, type: AclType, name?: string): void {
  const st = peekFeatureState<AclState>(device, "acl");
  if (!st?.counters) return;
  for (const t of st.tables) {
    if ((t.type ?? "ip") !== type || (name && t.name !== name)) continue;
    dropCounters(st, t.name);
  }
}

const config: SonicCmd[] = [
  {
    path: ["acl", "table", "add"],
    summary: "Create an ACL table (type ip|ipv6|mac, stage ingress|egress)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      if (!name) return { output: [err("Usage: config acl table add <name> [ip|ipv6|mac] [ingress|egress]")] };
      const type = parseType(pos[1]);
      if (type === null) return { output: [err(`config acl table add: type must be ip, ipv6 or mac (got '${pos[1]}')`)] };
      const stage = parseStage(pos[2]);
      if (stage === null) return { output: [err(`config acl table add: stage must be ingress or egress (got '${pos[2]}')`)] };
      const st = state(ctx.device);
      const existing = st.tables.find((t) => t.name === name);
      if (existing) {
        // Same-name DIFFERENT-type is rejected (TC-30); a same-type re-declare is a clean no-op.
        if (pos[1] !== undefined && existing.type !== type) {
          return { output: [err("Creating ACLs with same name and different type not allowed")] };
        }
        return { output: [muted(`ACL table ${name} already exists (no-op)`)] };
      }
      st.tables.push({ name, type, stage, ports: [] });
      if (!st.rules[name]) st.rules[name] = [];
      return { output: [muted(`ACL table ${name} (${type}, ${stage}) created`)] };
    },
  },
  {
    path: ["acl", "table", "del"],
    summary: "Delete an ACL table (removes its rules and bindings)",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config acl table del <name>")] };
      const st = state(ctx.device);
      const before = st.tables.length;
      st.tables = st.tables.filter((t) => t.name !== name); // bindings live on the table -> cascade removed
      delete st.rules[name];
      dropCounters(st, name);
      // Deleting a non-existent table is idempotent (TC-48).
      return { output: [muted(st.tables.length < before ? `ACL table ${name} deleted` : `ACL table ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["acl", "rule", "add"],
    summary: "Add a rule: config acl rule add <table> <seq> <permit|deny> <match...>",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      if (pos.length < 4) {
        return { output: [err("Usage: config acl rule add <table> <seq> <permit|deny> <match...>")] };
      }
      const table = pos[0];
      const st = state(ctx.device);
      const t = st.tables.find((x) => x.name === table);
      if (!t) return { output: [err(`ACL ${table} not found`)] };
      const seq = Number(pos[1]);
      if (!Number.isInteger(seq) || seq < SEQ.min || seq > SEQ.max) {
        return { output: [err(`config acl rule add: Invalid input detected (seq must be ${SEQ.min}-${SEQ.max})`)] };
      }
      const action = pos[2].toLowerCase();
      if (action !== "permit" && action !== "deny") {
        return { output: [err(`config acl rule add: action must be permit or deny (got '${pos[2]}')`)] };
      }
      const { match, remark } = splitRemark(pos.slice(3).join(" "));
      try {
        parseRule((t.type ?? "ip") as AclType, match);
      } catch (e) {
        if (e instanceof AclParseError) return { output: [err(`config acl rule add: ${e.message}`)] };
        throw e;
      }
      const rules = st.rules[table] ?? (st.rules[table] = []);
      const existing = rules.find((r) => r.seq === seq);
      if (existing) {
        // Identical re-add is a no-op; same-seq DIFFERENT content is rejected (TC-27).
        if (existing.action === action && existing.match === match) {
          return { output: [muted(`seq ${seq} already exists in ${table} (no-op)`)] };
        }
        return { output: [err(`Rule with sequence number ${seq} already exists`)] };
      }
      rules.push(remark ? { seq, action, match, remark } : { seq, action, match });
      return { output: [muted(`seq ${seq} ${action} ${match} added to ${table}`)] };
    },
  },
  {
    path: ["acl", "rule", "del"],
    summary: "Delete a rule: config acl rule del <table> <seq>",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const table = pos[0];
      const seqTok = pos[1];
      if (!table || seqTok === undefined) return { output: [err("Usage: config acl rule del <table> <seq>")] };
      const st = state(ctx.device);
      if (!st.tables.some((t) => t.name === table)) return { output: [err(`ACL ${table} not found`)] };
      const seq = Number(seqTok);
      const rules = st.rules[table] ?? [];
      const before = rules.length;
      st.rules[table] = rules.filter((r) => r.seq !== seq);
      dropCounters(st, table, ruleName(seq));
      // Deleting a non-existent rule is idempotent (TC-47).
      return { output: [muted(st.rules[table].length < before ? `seq ${seq} removed from ${table}` : `seq ${seq} not present in ${table} (no-op)`)] };
    },
  },
  {
    path: ["acl", "bind"],
    summary: "Bind an ACL table to a port: config acl bind <table> <port> [ingress|egress]",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const table = pos[0];
      const port = pos[1];
      if (!table || !port) return { output: [err("Usage: config acl bind <table> <port> [ingress|egress]")] };
      const t = state(ctx.device).tables.find((x) => x.name === table);
      if (!t) return { output: [err(`ACL ${table} not found`)] }; // TC-44
      if (!interfaceByName(ctx.device, port)) {
        return { output: [err(`config acl bind: ${port} is not an interface on ${ctx.device.name}`)] };
      }
      const stage = pos[2] === undefined ? stageOf(t) : parseStage(pos[2]);
      if (stage === null) return { output: [err(`config acl bind: stage must be ingress or egress (got '${pos[2]}')`)] };
      const e = aclBind(ctx.device, table, port, stage);
      if (e) return { output: [err(e)] };
      return { output: [muted(`ACL ${table} bound ${stage} on ${port}`)] };
    },
  },
  {
    path: ["acl", "unbind"],
    summary: "Unbind an ACL table from a port: config acl unbind <table> <port>",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const table = pos[0];
      const port = pos[1];
      if (!table || !port) return { output: [err("Usage: config acl unbind <table> <port>")] };
      if (!state(ctx.device).tables.some((x) => x.name === table)) return { output: [err(`ACL ${table} not found`)] };
      const ok = aclUnbind(ctx.device, table, port);
      return { output: [muted(ok ? `ACL ${table} unbound from ${port}` : `ACL ${table} not bound on ${port} (no-op)`)] };
    },
  },
];

/** acl_loader show_table: Name / Type / Binding / Description / Stage / Status. */
function renderTables(ctx: CommandContext, filter?: string): OutputLine[] {
  const all = [...(peekFeatureState<AclState>(ctx.device, "acl")?.tables ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const rows: string[][] = [];
  for (const t of all) {
    if (filter && t.name !== filter) continue;
    const ports = [...t.ports].sort(natCompare);
    rows.push([t.name, sonicTableType(t.type), ports[0] ?? "", t.description ?? "", stageOf(t), "Active"]);
    for (const p of ports.slice(1)) rows.push(["", "", p, "", "", ""]);
  }
  return tabulate(["Name", "Type", "Binding", "Description", "Stage", "Status"], rows).map((l) => line(l));
}

/** acl_loader show_rule: Table / Rule / Priority / Action / Match / Status, by priority desc. */
function renderRules(ctx: CommandContext, filter?: string, rid?: string): OutputLine[] {
  const st = peekFeatureState<AclState>(ctx.device, "acl");
  const raw: { prio: number; rows: string[][] }[] = [];
  for (const t of st?.tables ?? []) {
    if (filter && t.name !== filter) continue;
    for (const r of st!.rules[t.name] ?? []) {
      const name = ruleName(r.seq);
      if (rid && rid !== name) continue;
      const f = ruleFields((t.type ?? "ip") as AclType, r);
      const { PRIORITY: prio, PACKET_ACTION: action, ...rest } = f;
      const matches = Object.entries(rest)
        .map(([k, v]) => `${k}: ${v}`)
        .sort();
      const rows = [[t.name, name, prio, action, matches[0] ?? "N/A", "Active"]];
      for (const m of matches.slice(1)) rows.push(["", "", "", "", m, ""]);
      raw.push({ prio: Number(prio), rows });
    }
  }
  raw.sort((a, b) => b.prio - a.prio);
  return tabulate(["Table", "Rule", "Priority", "Action", "Match", "Status"], raw.flatMap((r) => r.rows)).map((l) => line(l));
}

const show: SonicCmd[] = [
  {
    path: ["acl", "table"],
    summary: "Show ACL tables (optionally one table name)",
    run: (args, ctx) => ({ output: renderTables(ctx, positional(args)[0]) }),
  },
  {
    path: ["acl", "rule"],
    summary: "Show ACL rules (optionally for one table / rule)",
    run: (args, ctx) => ({ output: renderRules(ctx, positional(args)[0], positional(args)[1]) }),
  },
];

export const aclModule: SonicFeatureModule = { id: "acl", config, show };

// ---------------------------------------------------------------------------
// KLISH renderers (sonic-mgmt-framework templates)
// ---------------------------------------------------------------------------

/**
 * `show {ip|ipv6|mac} access-lists [name]` — show_access_list.j2. Per-rule
 * "(N packets) [N bytes]" only for a BOUND ACL (xfmr_acl.go:2008-2032).
 */
export function renderAccessLists(device: Device, type: AclType, name?: string): OutputLine[] {
  const st = peekFeatureState<AclState>(device, "acl");
  const out: OutputLine[] = [];
  const tables = (st?.tables ?? []).filter((t) => (t.type ?? "ip") === type && (!name || t.name === name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const t of tables) {
    out.push(line(`${type} access-list ${t.name}`));
    if (t.description) out.push(line(`  remark ${t.description}`));
    const bound = t.ports.length > 0;
    for (const r of [...(st!.rules[t.name] ?? [])].sort((a, b) => a.seq - b.seq)) {
      const c = st!.counters?.[counterKey(t.name, ruleName(r.seq))] ?? { packets: 0, bytes: 0 };
      out.push(line(`    seq ${r.seq} ${ruleData(type, r)}${bound ? ` (${c.packets} packets) [${c.bytes} bytes]` : ""}`));
      if (r.remark) out.push(line(`      remark ${r.remark}`));
    }
  }
  return out;
}

const TYPE_LABEL: Record<AclType, string> = { ip: "IP", ipv6: "IPV6", mac: "MAC" };

/** `show [ip|ipv6|mac] access-group` — show_access_group.j2, Switch entry last. */
export function renderAccessGroups(device: Device, type?: AclType): OutputLine[] {
  const st = peekFeatureState<AclState>(device, "acl");
  const byPort = new Map<string, { stage: AclStage; t: AclTable }[]>();
  for (const t of st?.tables ?? []) {
    for (const p of t.ports) (byPort.get(p) ?? byPort.set(p, []).get(p)!).push({ stage: stageOf(t), t });
  }
  const ports = [...byPort.keys()].filter((p) => p !== "Switch").sort(natCompare);
  if (byPort.has("Switch")) ports.push("Switch");
  const out: OutputLine[] = [];
  for (const p of ports) {
    for (const stage of ["ingress", "egress"] as const) {
      for (const { t } of byPort.get(p)!.filter((x) => x.stage === stage).sort((a, b) => a.t.name.localeCompare(b.t.name))) {
        const ty = (t.type ?? "ip") as AclType;
        if (type && ty !== type) continue;
        out.push(line(`${stage === "ingress" ? "Ingress" : "Egress"} ${TYPE_LABEL[ty]} access-list ${t.name} on ${p}`));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// aclshow (sonic-utilities scripts/aclshow)
// ---------------------------------------------------------------------------

function aclshow(device: Device, args: string[]): OutputLine[] {
  const all = args.includes("-a") || args.includes("--all");
  const opt = (s: string, l: string) => {
    const i = args.findIndex((a) => a === s || a === l);
    return i >= 0 ? args[i + 1]?.split(",") : undefined;
  };
  const tables = opt("-t", "--tables");
  const rulesF = opt("-r", "--rules");
  const st = state(device);
  if (args.includes("-c") || args.includes("--clear")) {
    st.aclshowBaseline = JSON.parse(JSON.stringify(st.counters ?? {}));
    return [];
  }
  const rows: { t: string; prio: number; row: string[] }[] = [];
  for (const t of st.tables) {
    if (tables && !tables.includes(t.name)) continue;
    for (const r of st.rules[t.name] ?? []) {
      const name = ruleName(r.seq);
      if (rulesF && !rulesF.includes(name)) continue;
      const k = counterKey(t.name, name);
      const cur = st.counters?.[k] ?? { packets: 0, bytes: 0 };
      const base = st.aclshowBaseline?.[k];
      const pk = base && cur.packets - base.packets >= 0 ? cur.packets - base.packets : cur.packets;
      const by = base && cur.bytes - base.bytes >= 0 ? cur.bytes - base.bytes : cur.bytes;
      if (!all && pk === 0) continue; // aclshow:186 hides zero counters without -a
      rows.push({ t: t.name, prio: priorityOf(r.seq), row: [name, t.name, String(priorityOf(r.seq)), String(pk), String(by)] });
    }
  }
  rows.sort((a, b) => a.t.localeCompare(b.t) || b.prio - a.prio); // aclshow:201
  return tabulate(["RULE NAME", "TABLE NAME", "PRIO", "PACKETS COUNT", "BYTES COUNT"], rows.map((r) => r.row)).map((l) => line(l));
}

/** `aclshow` — exported for lib/commands/registry.ts (frozen; not yet registered). */
export const aclshowCommand: CommandHandler = {
  name: "aclshow",
  cli: "sonic",
  summary: "Display SONiC switch ACL rules and counters",
  usage: "aclshow [-a] [-c] [-t TABLES] [-r RULES]",
  help: [
    "ACLSHOW",
    "",
    "Usage:",
    "  aclshow [-a] [-c] [-t Table1,Table2] [-r Rule1,Rule2]",
    "",
    "  -a, --all     Show all ACL counters (including zero)",
    "  -c, --clear   Clear ACL counters statistics",
  ],
  run: (args, ctx) => ({ output: aclshow(ctx.device, args) }),
};
