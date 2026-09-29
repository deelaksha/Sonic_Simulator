/**
 * ACL SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and `show acl ...` renders SOLELY from that
 * stored state. There is NO packet-engine ACL hook yet, so this models ACL
 * CONFIGURATION only — no hit counters, no permit/deny packet enforcement (that
 * enforcement is simulated separately once such a hook exists).
 *
 * The cheatsheet (acl.txt) is klish (`ip access-list <name>` + `seq <n> ...`); we
 * expose the click-friendly `config acl ...` family rooted at ["acl", ...] that
 * maps onto those forms:
 *
 *   config acl table add <name> [ip|ipv6|mac] [ingress|egress]
 *                                          <- {ip|ipv6|mac} access-list <name>
 *   config acl table del <name>            <- no {ip|ipv6|mac} access-list <name>
 *   config acl rule add <table> <seq> <permit|deny> <match...>
 *                                          <- seq <n> {permit|deny} <match...>
 *   config acl rule del <table> <seq>      <- no seq <n>
 *   config acl bind <table> <port> [ingress|egress]
 *                                          <- interface X / {ip} access-group <name> {in|out}
 *   config acl unbind <table> <port>       <- no {ip} access-group <name> {in|out}
 *   show acl table [name]                  <- show {ip|ipv6|mac} access-lists
 *   show acl rule [table]                  <- show running-configuration ... access-list
 *
 * Behaviour grounded in acl.txt: seq range 1-65535 (TC-22/TC-23); re-using a name
 * with a DIFFERENT type is rejected (TC-30) while a same-type re-declare is a
 * clean no-op (SM_ISCLI_51); a same-seq DIFFERENT-content rule is rejected
 * (TC-27) while an identical re-add is a no-op; deleting a non-existent rule or
 * table is idempotent (TC-47/TC-48); binding a non-existent ACL is rejected
 * (TC-44); deleting a table cascades its rules and bindings away (TC-46).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { interfaceByName } from "../../models/device";

type AclType = "ip" | "ipv6" | "mac";
type AclStage = "ingress" | "egress";

interface AclRule {
  seq: number;
  action: string;
  match: string;
}

interface AclTable {
  name: string;
  type?: string;
  stage?: string;
  ports: string[];
}

interface AclState {
  tables: AclTable[];
  rules: Record<string, AclRule[]>;
}

/** ACL rule sequence numbers are RANGE_1_65535 (acl.txt TC-22/TC-23). */
const SEQ = { min: 1, max: 65535 };

function state(ctx: CommandContext): AclState {
  return featureState<AclState>(ctx.device, "acl", () => ({ tables: [], rules: {} }));
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
      const st = state(ctx);
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
      const st = state(ctx);
      const before = st.tables.length;
      st.tables = st.tables.filter((t) => t.name !== name); // bindings live on the table -> cascade removed
      delete st.rules[name];
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
      const st = state(ctx);
      if (!st.tables.some((t) => t.name === table)) return { output: [err(`ACL ${table} not found`)] };
      const seq = Number(pos[1]);
      if (!Number.isInteger(seq) || seq < SEQ.min || seq > SEQ.max) {
        return { output: [err(`config acl rule add: Invalid input detected (seq must be ${SEQ.min}-${SEQ.max})`)] };
      }
      const action = pos[2].toLowerCase();
      if (action !== "permit" && action !== "deny") {
        return { output: [err(`config acl rule add: action must be permit or deny (got '${pos[2]}')`)] };
      }
      const match = pos.slice(3).join(" ");
      const rules = st.rules[table] ?? (st.rules[table] = []);
      const existing = rules.find((r) => r.seq === seq);
      if (existing) {
        // Identical re-add is a no-op; same-seq DIFFERENT content is rejected (TC-27).
        if (existing.action === action && existing.match === match) {
          return { output: [muted(`seq ${seq} already exists in ${table} (no-op)`)] };
        }
        return { output: [err(`Rule with sequence number ${seq} already exists`)] };
      }
      rules.push({ seq, action, match });
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
      const st = state(ctx);
      if (!st.tables.some((t) => t.name === table)) return { output: [err(`ACL ${table} not found`)] };
      const seq = Number(seqTok);
      const rules = st.rules[table] ?? [];
      const before = rules.length;
      st.rules[table] = rules.filter((r) => r.seq !== seq);
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
      const st = state(ctx);
      const t = st.tables.find((x) => x.name === table);
      if (!t) return { output: [err(`ACL ${table} not found`)] }; // TC-44
      if (!interfaceByName(ctx.device, port)) {
        return { output: [err(`config acl bind: ${port} is not an interface on ${ctx.device.name}`)] };
      }
      if (pos[2] !== undefined) {
        const stage = parseStage(pos[2]);
        if (stage === null) return { output: [err(`config acl bind: stage must be ingress or egress (got '${pos[2]}')`)] };
        t.stage = stage;
      }
      if (!t.ports.includes(port)) t.ports.push(port);
      return { output: [muted(`ACL ${table} bound ${t.stage ?? "ingress"} on ${port}`)] };
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
      const st = state(ctx);
      const t = st.tables.find((x) => x.name === table);
      if (!t) return { output: [err(`ACL ${table} not found`)] };
      const before = t.ports.length;
      t.ports = t.ports.filter((p) => p !== port);
      return { output: [muted(t.ports.length < before ? `ACL ${table} unbound from ${port}` : `ACL ${table} not bound on ${port} (no-op)`)] };
    },
  },
];

function renderTables(ctx: CommandContext, filter?: string): OutputLine[] {
  const all = [...(peekFeatureState<AclState>(ctx.device, "acl")?.tables ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const tables = filter ? all.filter((t) => t.name === filter) : all;
  if (tables.length === 0) return [muted(filter ? `ACL table ${filter} not configured` : "No ACL tables configured")];
  const out: OutputLine[] = [
    line(`${"Name".padEnd(17)}${"Type".padEnd(8)}${"Stage".padEnd(10)}Binding`),
    line("---------------  ------  --------  ----------------"),
  ];
  for (const t of tables) {
    const binding = t.ports.length ? t.ports.join(", ") : "-";
    out.push(line(`${t.name.padEnd(17)}${(t.type ?? "ip").padEnd(8)}${(t.stage ?? "ingress").padEnd(10)}${binding}`));
  }
  return out;
}

function renderRules(ctx: CommandContext, filter?: string): OutputLine[] {
  const st = peekFeatureState<AclState>(ctx.device, "acl");
  const names = Object.keys(st?.rules ?? {})
    .filter((n) => !filter || n === filter)
    .sort((a, b) => a.localeCompare(b));
  const out: OutputLine[] = [];
  for (const name of names) {
    const rules = [...(st!.rules[name] ?? [])].sort((a, b) => a.seq - b.seq);
    if (rules.length === 0) continue;
    const type = st!.tables.find((t) => t.name === name)?.type;
    out.push(line(`ACL Table ${name}${type ? ` (${type})` : ""}`));
    for (const r of rules) out.push(line(`  seq ${r.seq} ${r.action} ${r.match}`));
  }
  if (out.length === 0) return [muted(filter ? `No rules configured for ACL ${filter}` : "No ACL rules configured")];
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["acl", "table"],
    summary: "Show ACL tables (optionally one table name)",
    run: (args, ctx) => ({ output: renderTables(ctx, positional(args)[0]) }),
  },
  {
    path: ["acl", "rule"],
    summary: "Show ACL rules (optionally for one table)",
    run: (args, ctx) => ({ output: renderRules(ctx, positional(args)[0]) }),
  },
];

export const aclModule: SonicFeatureModule = { id: "acl", config, show };
