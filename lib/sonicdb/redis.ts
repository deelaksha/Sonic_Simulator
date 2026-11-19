/**
 * A tiny read-only Redis command engine over a projected keyspace, plus the two
 * output styles learners meet on a SONiC box:
 *
 *   redis-cli (tty)  `1) "PORT|Ethernet0"`, `(integer) 1`, `(nil)`, `(empty array)`
 *   sonic-db-cli     sonic-swss-common/common/redisreply.cpp:262-450 — lists one per line,
 *                    HGETALL as a python dict {'f': 'v'}, SCAN as (0, ['k', ...]),
 *                    HEXISTS as True/False (g_intToBoolCommands), nil as an empty line.
 *
 * Writes are refused: the DBs are a projection of the device model, so the only
 * way to change them is through the CLI (config ... / sonic-cli), exactly the
 * CLI → CONFIG_DB path being taught.
 */
import { Keyspace } from "./schema";

export type Reply =
  | { kind: "int"; v: number }
  | { kind: "str"; v: string }
  | { kind: "status"; v: string }
  | { kind: "nil" }
  | { kind: "arr"; v: string[] }
  | { kind: "scan"; cursor: string; v: string[] }
  | { kind: "err"; v: string };

const WRITE_CMDS = new Set([
  "SET", "DEL", "UNLINK", "HSET", "HMSET", "HDEL", "HSETNX", "HINCRBY", "EXPIRE", "RENAME", "FLUSHDB",
  "FLUSHALL", "LPUSH", "RPUSH", "SADD", "SREM", "ZADD", "INCR", "DECR", "APPEND", "COPY", "MOVE", "EVAL", "PUBLISH",
]);

export const READONLY_ERR = "READONLY You can't write against a read only replica.";

/** Redis glob (KEYS/SCAN MATCH): * ? [set] [^set] and \ escapes. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) re += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        let set = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (set.startsWith("^")) set = "^" + set.slice(1);
        re += `[${set}]`;
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

const wrongArgs = (cmd: string): Reply => ({ kind: "err", v: `ERR wrong number of arguments for '${cmd.toLowerCase()}' command` });

export function execRedis(ks: Keyspace, args: string[]): Reply {
  const cmd = (args[0] ?? "").toUpperCase();
  const a = args.slice(1);
  const sortedKeys = () => [...ks.keys()].sort();
  const hash = (k: string) => ks.get(k);
  if (WRITE_CMDS.has(cmd)) return { kind: "err", v: READONLY_ERR };
  switch (cmd) {
    case "PING":
      return { kind: "status", v: "PONG" };
    case "KEYS": {
      if (a.length !== 1) return wrongArgs(cmd);
      const re = globToRegExp(a[0]);
      return { kind: "arr", v: sortedKeys().filter((k) => re.test(k)) };
    }
    case "SCAN": {
      if (a.length < 1) return wrongArgs(cmd);
      let match = "*";
      for (let i = 1; i < a.length; i++) if (a[i].toUpperCase() === "MATCH") match = a[++i] ?? "*";
      const re = globToRegExp(match);
      return { kind: "scan", cursor: "0", v: sortedKeys().filter((k) => re.test(k)) }; // one full pass
    }
    case "DBSIZE":
      return { kind: "int", v: ks.size };
    case "EXISTS":
      if (a.length < 1) return wrongArgs(cmd);
      return { kind: "int", v: a.filter((k) => ks.has(k)).length };
    case "TYPE":
      if (a.length !== 1) return wrongArgs(cmd);
      return { kind: "status", v: ks.has(a[0]) ? "hash" : "none" };
    case "HGETALL": {
      if (a.length !== 1) return wrongArgs(cmd);
      const h = hash(a[0]);
      return { kind: "arr", v: h ? Object.entries(h).flat() : [] };
    }
    case "HGET": {
      if (a.length !== 2) return wrongArgs(cmd);
      const v = hash(a[0])?.[a[1]];
      return v === undefined ? { kind: "nil" } : { kind: "str", v };
    }
    case "HMGET": {
      if (a.length < 2) return wrongArgs(cmd);
      const h = hash(a[0]);
      return { kind: "arr", v: a.slice(1).map((f) => h?.[f] ?? "") };
    }
    case "HKEYS":
      if (a.length !== 1) return wrongArgs(cmd);
      return { kind: "arr", v: Object.keys(hash(a[0]) ?? {}) };
    case "HVALS":
      if (a.length !== 1) return wrongArgs(cmd);
      return { kind: "arr", v: Object.values(hash(a[0]) ?? {}) };
    case "HLEN":
      if (a.length !== 1) return wrongArgs(cmd);
      return { kind: "int", v: Object.keys(hash(a[0]) ?? {}).length };
    case "HEXISTS":
      if (a.length !== 2) return wrongArgs(cmd);
      return { kind: "int", v: hash(a[0])?.[a[1]] !== undefined ? 1 : 0 };
    case "GET":
      if (a.length !== 1) return wrongArgs(cmd);
      return ks.has(a[0]) ? { kind: "err", v: "WRONGTYPE Operation against a key holding the wrong kind of value" } : { kind: "nil" };
    default:
      return { kind: "err", v: `ERR unknown command '${args[0] ?? ""}', with args beginning with: ${a.map((x) => `'${x}' `).join("")}`.trimEnd() };
  }
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function numbered(items: string[], indent = ""): string[] {
  if (!items.length) return [`${indent}(empty array)`];
  const w = String(items.length).length;
  return items.map((v, i) => `${indent}${String(i + 1).padStart(w)}) ${quote(v)}`);
}

/** redis-cli interactive (tty) rendering. */
export function formatRedisCli(r: Reply): string[] {
  switch (r.kind) {
    case "int":
      return [`(integer) ${r.v}`];
    case "str":
      return [quote(r.v)];
    case "status":
      return [r.v];
    case "nil":
      return ["(nil)"];
    case "err":
      return [`(error) ${r.v}`];
    case "arr":
      return numbered(r.v);
    case "scan": {
      const inner = numbered(r.v, "   ");
      return [`1) ${quote(r.cursor)}`, `2) ${inner[0].slice(3)}`, ...inner.slice(1)];
    }
  }
}

/** redis-cli --raw rendering (non-tty). */
export function formatRaw(r: Reply): string[] {
  switch (r.kind) {
    case "int":
      return [String(r.v)];
    case "str":
    case "status":
      return [r.v];
    case "nil":
      return [""];
    case "err":
      return [`(error) ${r.v}`];
    case "arr":
      return r.v;
    case "scan":
      return [r.cursor, ...r.v];
  }
}

const pyq = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** sonic-db-cli rendering (redisreply.cpp RedisReply::to_string). */
export function formatSonicDbCli(r: Reply, cmd: string): string[] {
  const c = cmd.toUpperCase();
  switch (r.kind) {
    case "int":
      return [c === "HEXISTS" ? (r.v ? "True" : "False") : String(r.v)];
    case "str":
      return [r.v];
    case "status":
      return [c === "PING" ? (r.v === "PONG" ? "True" : "False") : r.v];
    case "nil":
      return [""];
    case "err":
      return [r.v];
    case "arr": {
      if (c === "HGETALL") {
        const pairs: string[] = [];
        for (let i = 0; i < r.v.length; i += 2) pairs.push(`${pyq(r.v[i])}: ${pyq(r.v[i + 1])}`);
        return [`{${pairs.join(", ")}}`];
      }
      return r.v.length ? r.v : [""];
    }
    case "scan":
      return [`(${r.cursor}, [${r.v.map(pyq).join(", ")}])`];
  }
}
