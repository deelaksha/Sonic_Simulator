/**
 * SNMP SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and `show snmp ...` renders SOLELY from that
 * stored state. Nothing touches a real host SNMP agent — this is educational.
 *
 * Commands are the SONiC click `config snmp` family (path ["snmp", ...]); the
 * fields, enum values and validation ranges are taken from snmp.txt, which drives
 * the equivalent management-framework `snmp-server ...` forms:
 *
 *   config snmp community add <name> [ro|rw]  <- snmp-server community <name> [ro|rw]
 *   config snmp community del <name>          <- no snmp-server community <name>
 *   config snmp location add <text ...>       <- snmp-server location "<text>"
 *   config snmp location del                  <- no snmp-server location
 *   config snmp contact add <text ...>        <- snmp-server contact "<text>"
 *   config snmp contact del                   <- no snmp-server contact
 *   config snmp user add <name> [ro|rw]       <- snmp-server user <name> ...
 *   config snmp user del <name>               <- no snmp-server user <name>
 *   show snmp                                 <- show snmp-server
 *   show snmp community                       <- show snmp-server community
 *   show snmp user                            <- show snmp-server user
 *
 * From snmp.txt: community/type shown as RO/RW (TC-7), community name length
 * 4-32 (SNMP_COMMUNITY_STRING, TC-60), same-name re-add overwrites and is not an
 * error (TC-57), deleting a non-existent community is a silent no-op (TC-61),
 * empty views print "No SNMP communities configured" / "No SNMP users
 * configured" (TC-2, TC-59).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";

type Access = "RO" | "RW";

interface SnmpCommunity {
  name: string;
  access: Access;
}

interface SnmpUser {
  name: string;
  permission: Access;
}

interface SnmpState {
  communities: SnmpCommunity[];
  location: string | undefined;
  contact: string | undefined;
  users: SnmpUser[];
}

/** SNMP_COMMUNITY_STRING is 4-32 characters (snmp.txt TC-60). */
const NAME_LEN = { min: 4, max: 32 };

function state(ctx: CommandContext): SnmpState {
  return featureState<SnmpState>(ctx.device, "snmp", () => ({
    communities: [],
    location: undefined,
    contact: undefined,
    users: [],
  }));
}

/** "ro"/"rw" (case-insensitive) -> "RO"/"RW"; omitted defaults to RO; else null. */
function parseAccess(tok: string | undefined): Access | null {
  if (tok === undefined) return "RO";
  const t = tok.toLowerCase();
  if (t === "ro") return "RO";
  if (t === "rw") return "RW";
  return null;
}

const config: SonicCmd[] = [
  {
    path: ["snmp", "community", "add"],
    summary: "Add/update an SNMP community (ro|rw, default ro)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      if (!name) return { output: [err("Usage: config snmp community add <name> [ro|rw]")] };
      if (name.length < NAME_LEN.min || name.length > NAME_LEN.max) {
        return { output: [err(`config snmp community add: name must be ${NAME_LEN.min}-${NAME_LEN.max} characters (got '${name}')`)] };
      }
      const access = parseAccess(pos[1]);
      if (access === null) return { output: [err(`config snmp community add: access must be ro or rw (got '${pos[1]}')`)] };
      const st = state(ctx);
      const existing = st.communities.find((c) => c.name === name);
      if (existing) existing.access = access; // same-name overwrite is not an error (TC-57)
      else st.communities.push({ name, access });
      return { output: [muted(`SNMP community ${name} (${access}) configured`)] };
    },
  },
  {
    path: ["snmp", "community", "del"],
    summary: "Delete an SNMP community",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config snmp community del <name>")] };
      const st = state(ctx);
      const before = st.communities.length;
      st.communities = st.communities.filter((c) => c.name !== name);
      // Deleting a non-existent community is a silent no-op (TC-61).
      return { output: [muted(st.communities.length < before ? `SNMP community ${name} deleted` : `SNMP community ${name} not configured (no-op)`)] };
    },
  },
  {
    path: ["snmp", "location", "add"],
    summary: "Set the SNMP location string",
    run(args, ctx): CommandResult {
      const text = positional(args).join(" ").trim();
      if (!text) return { output: [err("Usage: config snmp location add <text>")] };
      state(ctx).location = text;
      return { output: [muted(`SNMP location set to "${text}"`)] };
    },
  },
  {
    path: ["snmp", "location", "del"],
    summary: "Clear the SNMP location string",
    run(_args, ctx): CommandResult {
      state(ctx).location = undefined;
      return { output: [muted("SNMP location cleared")] };
    },
  },
  {
    path: ["snmp", "contact", "add"],
    summary: "Set the SNMP contact string",
    run(args, ctx): CommandResult {
      const text = positional(args).join(" ").trim();
      if (!text) return { output: [err("Usage: config snmp contact add <text>")] };
      state(ctx).contact = text;
      return { output: [muted(`SNMP contact set to "${text}"`)] };
    },
  },
  {
    path: ["snmp", "contact", "del"],
    summary: "Clear the SNMP contact string",
    run(_args, ctx): CommandResult {
      state(ctx).contact = undefined;
      return { output: [muted("SNMP contact cleared")] };
    },
  },
  {
    path: ["snmp", "user", "add"],
    summary: "Add/update an SNMPv3 user (ro|rw, default ro)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const name = pos[0];
      if (!name) return { output: [err("Usage: config snmp user add <name> [ro|rw]")] };
      const permission = parseAccess(pos[1]);
      if (permission === null) return { output: [err(`config snmp user add: permission must be ro or rw (got '${pos[1]}')`)] };
      const st = state(ctx);
      const existing = st.users.find((u) => u.name === name);
      if (existing) existing.permission = permission;
      else st.users.push({ name, permission });
      return { output: [muted(`SNMP user ${name} (${permission}) configured`)] };
    },
  },
  {
    path: ["snmp", "user", "del"],
    summary: "Delete an SNMPv3 user",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config snmp user del <name>")] };
      const st = state(ctx);
      const before = st.users.length;
      st.users = st.users.filter((u) => u.name !== name);
      return { output: [muted(st.users.length < before ? `SNMP user ${name} deleted` : `SNMP user ${name} not configured (no-op)`)] };
    },
  },
];

function renderSummary(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<SnmpState>(ctx.device, "snmp");
  const out: OutputLine[] = [];
  if (st?.contact !== undefined) out.push(line(`${"Contact".padEnd(11)}: ${st.contact}`));
  if (st?.location !== undefined) out.push(line(`${"Location".padEnd(11)}: ${st.location}`));
  if (out.length === 0) out.push(muted("No SNMP contact or location configured"));
  return out;
}

function renderCommunities(ctx: CommandContext): OutputLine[] {
  const communities = [...(peekFeatureState<SnmpState>(ctx.device, "snmp")?.communities ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (communities.length === 0) return [muted("No SNMP communities configured")];
  const out: OutputLine[] = [line(`${"Community Name".padEnd(33)}Type`)];
  for (const c of communities) out.push(line(`${c.name.padEnd(33)}${c.access}`));
  return out;
}

function renderUsers(ctx: CommandContext): OutputLine[] {
  const users = [...(peekFeatureState<SnmpState>(ctx.device, "snmp")?.users ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  if (users.length === 0) return [muted("No SNMP users configured")];
  const out: OutputLine[] = [line(`${"User Name".padEnd(33)}Permission`)];
  for (const u of users) out.push(line(`${u.name.padEnd(33)}${u.permission}`));
  return out;
}

const show: SonicCmd[] = [
  { path: ["snmp", "community"], summary: "Show configured SNMP communities", run: (_a, ctx) => ({ output: renderCommunities(ctx) }) },
  { path: ["snmp", "user"], summary: "Show configured SNMPv3 users", run: (_a, ctx) => ({ output: renderUsers(ctx) }) },
  { path: ["snmp"], summary: "Show SNMP contact and location", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
];

export const snmpModule: SonicFeatureModule = { id: "snmp", config, show };
