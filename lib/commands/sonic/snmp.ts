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
 * Real sonic-utilities commands (config/main.py:3863-3995, show/main.py:560-600, 1864-2024):
 *   config snmptrap modify <1|2|3> <ip> [-p port] [-v vrf] [-c community] / del <ver>
 *   config snmpagentaddress add|del <ip> [-p port] [-v vrf]
 *   show snmptrap | show snmpagentaddress | show runningconfiguration snmp [community|contact|location|user]
 * Every Click SNMP write restarts the snmp service, which is when snmpd picks it up
 * (see lib/protocols/snmp-config.ts).
 *
 * From snmp.txt: community/type shown as RO/RW (TC-7), community name length
 * 4-32 (SNMP_COMMUNITY_STRING, TC-60), same-name re-add overwrites and is not an
 * error (TC-57), deleting a non-existent community is a silent no-op (TC-61),
 * empty views print "No SNMP communities configured" / "No SNMP users
 * configured" (TC-2, TC-59).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { peekFeatureState } from "../../models/feature-state";
import { Access, AgentAddress, SnmpState, requestSnmpRestart, snmpConfig } from "../../protocols/snmp-config";

/** SNMP_COMMUNITY_STRING is 4-32 characters (snmp.txt TC-60). */
const NAME_LEN = { min: 4, max: 32 };

function state(ctx: CommandContext): SnmpState {
  return snmpConfig(ctx.device);
}

/** Click runs `systemctl restart snmp` after the CONFIG_DB write (config/main.py). */
function restart(ctx: CommandContext): OutputLine {
  requestSnmpRestart(ctx.device, "click");
  return muted("Restarting SNMP service...");
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
      return { output: [muted(`SNMP community ${name} (${access}) configured`), restart(ctx)] };
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
      return { output: [muted(st.communities.length < before ? `SNMP community ${name} deleted` : `SNMP community ${name} not configured (no-op)`), restart(ctx)] };
    },
  },
  {
    path: ["snmp", "location", "add"],
    summary: "Set the SNMP location string",
    run(args, ctx): CommandResult {
      const text = positional(args).join(" ").trim();
      if (!text) return { output: [err("Usage: config snmp location add <text>")] };
      state(ctx).location = text;
      return { output: [muted(`SNMP location set to "${text}"`), restart(ctx)] };
    },
  },
  {
    path: ["snmp", "location", "del"],
    summary: "Clear the SNMP location string",
    run(_args, ctx): CommandResult {
      state(ctx).location = undefined;
      return { output: [muted("SNMP location cleared"), restart(ctx)] };
    },
  },
  {
    path: ["snmp", "contact", "add"],
    summary: "Set the SNMP contact string",
    run(args, ctx): CommandResult {
      const text = positional(args).join(" ").trim();
      if (!text) return { output: [err("Usage: config snmp contact add <text>")] };
      state(ctx).contact = text;
      return { output: [muted(`SNMP contact set to "${text}"`), restart(ctx)] };
    },
  },
  {
    path: ["snmp", "contact", "del"],
    summary: "Clear the SNMP contact string",
    run(_args, ctx): CommandResult {
      state(ctx).contact = undefined;
      return { output: [muted("SNMP contact cleared"), restart(ctx)] };
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
      return { output: [muted(`SNMP user ${name} (${permission}) configured`), restart(ctx)] };
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
      return { output: [muted(st.users.length < before ? `SNMP user ${name} deleted` : `SNMP user ${name} not configured (no-op)`), restart(ctx)] };
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

// ---------------------------------------------------------------------------
// Trap receivers / agent addresses (sonic-utilities config/main.py:3863-3995) and
// the real Click show commands (show/main.py:560-600, 1864-2024).

/** `-p 1161` / `--port 1161` style options + positionals. */
function opts(args: string[], names: Record<string, string>): { pos: string[]; o: Record<string, string> } {
  const pos: string[] = [];
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = names[args[i]];
    if (key !== undefined && i + 1 < args.length) o[key] = args[++i];
    else pos.push(args[i]);
  }
  return { pos, o };
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

const trapAndAgent: SonicCmd[] = [
  {
    path: ["snmptrap", "modify"],
    summary: "Set the SNMP trap receiver for version 1|2|3 (SNMP_TRAP_CONFIG)",
    run(args, ctx): CommandResult {
      const { pos, o } = opts(args, { "-p": "port", "--port": "port", "-v": "vrf", "--vrf": "vrf", "-c": "comm", "--comm": "comm" });
      const [ver, ip] = pos;
      if (!["1", "2", "3"].includes(ver ?? "") || !ip) {
        return { output: [err("Usage: config snmptrap modify [OPTIONS] <SNMP Version> <SNMP TRAP SERVER IP Address>"), err("Error: Invalid value for '<SNMP Version>': invalid choice. (choose from 1, 2, 3)")] };
      }
      const st = state(ctx);
      const key = ver === "1" ? "v1" : ver === "2" ? "v2" : "v3";
      st.trapConfig = { ...(st.trapConfig ?? {}), [key]: { ip, port: Number(o.port ?? "162"), vrf: o.vrf ?? "None", community: o.comm ?? "public" } };
      requestSnmpRestart(ctx.device, "click");
      return { output: [] };
    },
  },
  {
    path: ["snmptrap", "del"],
    summary: "Delete the SNMP trap receiver for version 1|2|3",
    run(args, ctx): CommandResult {
      const ver = positional(args)[0];
      if (!["1", "2", "3"].includes(ver ?? "")) return { output: [err("Error: Invalid value for '<SNMP Version>': invalid choice. (choose from 1, 2, 3)")] };
      const st = state(ctx);
      if (st.trapConfig) delete st.trapConfig[ver === "1" ? "v1" : ver === "2" ? "v2" : "v3"];
      requestSnmpRestart(ctx.device, "click");
      return { output: [] };
    },
  },
  {
    path: ["snmpagentaddress", "add"],
    summary: "Add an SNMP agent listening IP[:port] (SNMP_AGENT_ADDRESS_CONFIG)",
    run(args, ctx): CommandResult {
      const { pos, o } = opts(args, { "-p": "port", "--port": "port", "-v": "vrf", "--vrf": "vrf" });
      const ip = pos[0];
      if (!ip) return { output: [err("Usage: config snmpagentaddress add [OPTIONS] <SNMP AGENT LISTENING IP Address>")] };
      if (!IPV4.test(ip.split("%")[0])) return { output: [line("Invalid IP address")] };
      if (!ctx.device.interfaces.some((i) => i.ipv4.some((a) => a.address === ip))) return { output: [line("IP address is not available")] };
      const st = state(ctx);
      const port = o.port ?? "";
      if ((st.agentAddresses ?? []).some((a) => a.ip === ip && a.port === port)) return { output: [line(`entry with ${ip}:${port} already exists `)] };
      st.agentAddresses = [...(st.agentAddresses ?? []), { ip, port, vrf: o.vrf ?? "" } as AgentAddress];
      requestSnmpRestart(ctx.device, "click");
      return { output: [] };
    },
  },
  {
    path: ["snmpagentaddress", "del"],
    summary: "Delete an SNMP agent listening IP[:port]",
    run(args, ctx): CommandResult {
      const { pos, o } = opts(args, { "-p": "port", "--port": "port", "-v": "vrf", "--vrf": "vrf" });
      const st = state(ctx);
      st.agentAddresses = (st.agentAddresses ?? []).filter((a) => !(a.ip === pos[0] && a.port === (o.port ?? "") && a.vrf === (o.vrf ?? "")));
      requestSnmpRestart(ctx.device, "click");
      return { output: [] };
    },
  },
];

/** python-tabulate "simple" format as click.echo(tabulate(body, header)) prints it. */
export function tabulate(rows: (string | number)[][], headers: string[]): OutputLine[] {
  const cells = rows.map((r) => r.map((c) => String(c)));
  const isNum = (v: string) => /^-?\d+(\.\d+)?$/.test(v);
  const numeric = headers.map((_, i) => cells.some((r) => isNum(r[i])) && cells.every((r) => r[i] === "" || isNum(r[i])));
  const width = headers.map((h, i) => Math.max(h.length + 2, ...cells.map((r) => (r[i] ?? "").length)));
  const fmt = (v: string, i: number) => (numeric[i] ? v.padStart(width[i]) : v.padEnd(width[i]));
  const trim = (s: string) => s.replace(/\s+$/, "");
  return [
    line(trim(headers.map(fmt).join("  "))),
    line(width.map((w) => "-".repeat(w)).join("  ")),
    ...cells.map((r) => line(trim(r.map(fmt).join("  ")))),
  ];
}

const blank = (): OutputLine[] => [line(""), line("")]; // click.echo("\n")

function runSnmp(ctx: CommandContext, which?: string): OutputLine[] {
  const st = peekFeatureState<SnmpState>(ctx.device, "snmp");
  const location = tabulate(st?.location !== undefined ? [[st.location]] : [], ["Location"]);
  // SNMP|CONTACT is {<contact>: <email>}; the simulator stores "<contact> <email>".
  const [cName, ...cMail] = (st?.contact ?? "").split(" ");
  const contactRows = st?.contact !== undefined ? [[cName, cMail.join(" ")]] : [];
  const communities = [...(st?.communities ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map((c) => [c.name, c.access]);
  const users = (st?.users ?? []).map((u) => [u.name, u.permission, "Null", "Null", "Null", "Null", "Null"]);
  const userHdr = ["User", "Permission Type", "Type", "Auth Type", "Auth Password", "Encryption Type", "Encryption Password"];
  if (which === "location") return location;
  if (which === "contact") return tabulate(contactRows, ["Contact", "Contact Email"]);
  if (which === "community") return tabulate(communities, ["Community String", "Community Type"]);
  if (which === "user") return tabulate(users, userHdr);
  return [
    ...location,
    ...blank(),
    ...tabulate(contactRows, ["SNMP_CONTACT", "SNMP_CONTACT_EMAIL"]),
    ...blank(),
    ...tabulate(communities, ["Community String", "Community Type"]),
    ...blank(),
    ...tabulate(users, userHdr),
  ];
}

const clickShows: SonicCmd[] = [
  {
    path: ["snmptrap"],
    summary: "Show SNMP agent Trap server configuration",
    run(_a, ctx) {
      const t = peekFeatureState<SnmpState>(ctx.device, "snmp")?.trapConfig ?? {};
      const rows = (["v1", "v2", "v3"] as const).filter((k) => t[k]).map((k) => [k.slice(1), t[k]!.ip, t[k]!.port, t[k]!.vrf, t[k]!.community]);
      return { output: tabulate(rows, ["Version", "TrapReceiverIP", "Port", "VRF", "Community"]) };
    },
  },
  {
    path: ["snmpagentaddress"],
    summary: "Show SNMP agent listening IP address configuration",
    run(_a, ctx) {
      const rows = (peekFeatureState<SnmpState>(ctx.device, "snmp")?.agentAddresses ?? []).map((a) => [a.ip, a.port, a.vrf]);
      return { output: tabulate(rows, ["ListenIP", "ListenPort", "ListenVrf"]) };
    },
  },
  {
    path: ["runningconfiguration", "snmp"],
    summary: "Show SNMP running configuration",
    run: (args, ctx) => ({ output: runSnmp(ctx, positional(args)[0]) }),
  },
];

export const snmpModule: SonicFeatureModule = { id: "snmp", config: [...config, ...trapAndAgent], show: [...show, ...clickShows] };
