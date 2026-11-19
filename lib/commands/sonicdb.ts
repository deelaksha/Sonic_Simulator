/**
 * `sonic-db-cli` and `redis-cli` over the simulated SONiC Redis databases
 * (lib/sonicdb: read-only projections of the device model).
 *
 *   sonic-db-cli [-s] [-n NS] <DB_NAME> <cmd> [args...]     (sonic-swss-common/sonic-db-cli/sonic-db-cli.cpp)
 *   sonic-db-cli PING
 *   redis-cli [-n <db id>] [--raw] [-h host] [-p port] [-s sock] <cmd> [args...]
 *
 * Supported commands: KEYS, SCAN, HGETALL, HGET, HMGET, HKEYS, HVALS, HLEN,
 * HEXISTS, EXISTS, TYPE, DBSIZE, PING. Writes return a READONLY error.
 */
import { CommandHandler, CommandResult, OutputLine, line, err, muted } from "./types";
import { DBS, dbById, dbByName } from "../sonicdb/schema";
import { keyspace } from "../sonicdb/project";
import { execRedis, formatRedisCli, formatRaw, formatSonicDbCli, READONLY_ERR, Reply } from "../sonicdb/redis";
import { isSonicDevice } from "../sonicdb/config-db";

const READONLY_HINT = muted("(simulator) The Redis DBs are a live read-only projection of the device model — change config with `config ...` or sonic-cli, then re-read CONFIG_DB/APPL_DB/ASIC_DB.");

function render(lines: string[], r: Reply): OutputLine[] {
  const out = lines.map((t) => (r.kind === "err" ? err(t) : line(t)));
  if (r.kind === "err" && r.v === READONLY_ERR) out.push(READONLY_HINT);
  return out;
}

const SONIC_DB_CLI_USAGE = [
  "usage: sonic-db-cli [-h] [-s] [-n NAMESPACE] db_or_op [cmd [cmd ...]]",
  "",
  "SONiC DB CLI:",
  "",
  "positional arguments:",
  "  db_or_op              Database name Or Unary operation(only PING/SAVE/FLUSHALL supported)",
  "  cmd                   Command to execute in database",
  "",
  "optional arguments:",
  "  -h, --help            show this help message and exit",
  "  -s, --unixsocket      Override use of tcp_port and use unixsocket",
  "  -n NAMESPACE, --namespace NAMESPACE",
  "                        Namespace string to use asic0/asic1.../asicn",
  "",
  "Example 1: sonic-db-cli CONFIG_DB keys \\*",
  "Example 2: sonic-db-cli APPL_DB HGETALL VLAN_TABLE:Vlan10",
  "Example 3: sonic-db-cli APPL_DB HGET VLAN_TABLE:Vlan10 mtu",
  "",
  `Databases: ${DBS.map((d) => d.name).join(", ")}`,
];

/** The shell strips quotes around glob patterns ('*' / "PORT|*"). */
const unquote = (s: string) => (/^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s);

export const sonicDbCliCommand: CommandHandler = {
  name: "sonic-db-cli",
  cli: "sonic",
  summary: "Query the SONiC Redis databases (CONFIG_DB, APPL_DB, ASIC_DB, STATE_DB, COUNTERS_DB)",
  usage: "sonic-db-cli <DB_NAME> keys <pattern> | hgetall <key> | hget <key> <field> | exists <key>",
  help: SONIC_DB_CLI_USAGE,
  run(args, ctx): CommandResult {
    if (!isSonicDevice(ctx.device)) return { output: [err("sonic-db-cli: command not found")] };
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-h" || a === "--help") return { output: SONIC_DB_CLI_USAGE.map((t) => line(t)) };
      if (a === "-s" || a === "--unixsocket") continue;
      if ((a === "-n" || a === "--namespace") && rest.length === 0) {
        const ns = args[++i];
        if (ns && ns !== "" && ns !== "localhost") return { output: [err(`Invalid namespace '${ns}': single-ASIC device has no namespaces`)] };
        continue;
      }
      rest.push(unquote(a));
    }
    if (!rest.length) return { output: SONIC_DB_CLI_USAGE.map((t) => line(t)) };
    const op = rest[0];
    if (rest.length === 1 && op.toUpperCase() === "PING") return { output: [line("PONG")] };
    if (rest.length === 1 && ["SAVE", "FLUSHALL"].includes(op.toUpperCase())) return { output: [err(READONLY_ERR), READONLY_HINT] };
    const db = dbByName(op);
    if (!db) return { output: [err(`Invalid database name input : '${op}'`), err(`${op} is not a valid database name (${DBS.map((d) => d.name).join(", ")})`)] };
    if (rest.length < 2) return { output: SONIC_DB_CLI_USAGE.map((t) => line(t)) };
    const r = execRedis(keyspace(ctx.device, db.name), rest.slice(1));
    return { output: render(formatSonicDbCli(r, rest[1]), r) };
  },
};

const REDIS_CLI_HELP = [
  "Usage: redis-cli [OPTIONS] [cmd [arg [arg ...]]]",
  "  -h <hostname>      Server hostname (default: 127.0.0.1).",
  "  -p <port>          Server port (default: 6379).",
  "  -s <socket>        Server socket (overrides hostname and port).",
  "  -n <db>            Database number.",
  "  --raw              Use raw formatting for replies.",
  "",
  `SONiC databases: ${DBS.map((d) => `${d.id}=${d.name}`).join("  ")}`,
  "Examples:",
  "  redis-cli -n 4 keys 'VLAN*'",
  "  redis-cli -n 0 hgetall 'ROUTE_TABLE:10.0.0.0/24'",
  "  redis-cli -n 1 keys 'ASIC_STATE:SAI_OBJECT_TYPE_ROUTE_ENTRY*'",
];

export const redisCliCommand: CommandHandler = {
  name: "redis-cli",
  cli: "sonic",
  summary: "Redis command-line client (read-only, SONiC databases 0-6)",
  usage: "redis-cli [-n <db>] [--raw] <cmd> [args...]",
  help: REDIS_CLI_HELP,
  run(args, ctx): CommandResult {
    if (!isSonicDevice(ctx.device)) return { output: [err("redis-cli: command not found")] };
    let dbId = 0;
    let raw = false;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (rest.length === 0) {
        if (a === "--help") return { output: REDIS_CLI_HELP.map((t) => line(t)) };
        if (a === "-n") {
          const n = Number(args[++i]);
          if (!Number.isInteger(n) || n < 0) return { output: [err("Invalid argument for -n")] };
          dbId = n;
          continue;
        }
        if (a === "-h" || a === "-p" || a === "-s" || a === "-a") {
          i++;
          continue;
        }
        if (a === "--raw") {
          raw = true;
          continue;
        }
      }
      rest.push(unquote(a));
    }
    if (!rest.length) return { output: [err("redis-cli: interactive mode is not supported in the simulator; pass a command, e.g. redis-cli -n 4 keys '*'")] };
    if (dbId > 15) return { output: [err("(error) ERR DB index is out of range")] };
    const db = dbById(dbId);
    // Unused SONiC DB numbers (3 LOGLEVEL_DB, 7+ ...) exist in Redis but are empty here.
    const ks = db ? keyspace(ctx.device, db.name) : new Map<string, Record<string, string>>();
    const r = execRedis(ks, rest);
    return { output: render(raw ? formatRaw(r) : formatRedisCli(r), r) };
  },
};
