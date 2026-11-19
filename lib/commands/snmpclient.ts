/**
 * net-snmp 5.9.3 manager tools: snmpget, snmpgetnext, snmpwalk, snmpbulkwalk,
 * snmpset, and the snmptrapd notification receiver. Every request is a real
 * SNMPv2c datagram sent through the simulated network (tcpdump/sFlow see it);
 * the agent answers inside the same synchronous simulation run.
 *
 * Output follows net-snmp's apps/*.c and snmplib/mib.c print_variable():
 *   snmpget      "Timeout: No Response from <host>."          (apps/snmpget.c)
 *   snmpwalk     "Timeout: No Response from <host>"           (apps/snmpwalk.c:393)
 *   snmpset      "Error in packet.\nReason: …\nFailed object: …" (apps/snmpset.c:257-271)
 *   errors       snmp_errstring()                              (snmplib/snmp_client.c:1206-1236)
 *   snmptrapd    "%.4y-%.2m-%.2l %.2h:%.2j:%.2k %B [%b]:\n%v"  (apps/snmptrapd_handlers.c:716)
 *
 * SNMPv3 (-v3 -u USER -l noAuthNoPriv|authNoPriv|authPriv -a MD5|SHA -A PASS -x AES -X PASS
 * [-e ENGINEID] [-n CONTEXT]): engine discovery first (a reportable noAuthNoPriv probe
 * with an empty engine ID, answered by a usmStatsUnknownEngineIDs Report carrying the
 * agent's engine ID/boots/time — snmp_api.c snmpv3_engineID_probe), then the request
 * secured with the user's localized keys (lib/protocols/snmp-usm.ts). Report errors
 * print snmp_api_errstring() text: "Unknown user name", "Authentication failure
 * (incorrect password, community or key)", "Unsupported security level", "Decryption
 * error". DES privacy and SHA-2 are not simulated.
 *
 * Simulator notes: `snmptrapd` runs as if configured with `disableAuthorization yes`
 * (any community); SNMPv3 notifications need a `snmptrapd createUser ...` (snmptrapd.conf
 * createUser, accepted for any sender engine ID). `snmptrapd -l` prints its log (the
 * simulator has no /var/log), `snmptrapd stop` stops it.
 */
import { CommandContext, CommandHandler, CommandResult, OutputLine, err, line, muted } from "./types";
import { isValidIpv4 } from "../models/ip";
import { findInterface } from "../models/device";
import { primaryIpv4 } from "../models/interface";
import { longestPrefixMatch } from "../models/route";
import { ownsAddress, sendIpv4 } from "../control/packet";
import { SimEvent } from "../engine";
import { Oid, PDU, SnmpMessage, SnmpValue, VarBind, decodeMessage, encodeMessage, messageVersion, oidCompare, str } from "../protocols/snmp-ber";
import { FormatOpts, formatOid, formatVarBind, parseOid } from "../protocols/snmp-mib";
import { decodeTrap, managerState, peekTrapd, trapdState } from "../protocols/snmp-daemon";
import { SNMPTRAP_PORT, SNMP_PORT, agentListens, isAgentDevice, nextIds, processRequest, processV3 } from "../protocols/snmp-agent";
import { FLAG, SecLevel, USM_STATS, UsmUser, V3Message, decodeV3, levelFlags, secureV3, unsecureV3 } from "../protocols/snmp-usm";
import { ensureAgent } from "../protocols/snmp-config";

const ERRSTR = [
  "(noError) No Error",
  "(tooBig) Response message would have been too large.",
  "(noSuchName) There is no such variable name in this MIB.",
  "(badValue) The value given has the wrong type or length.",
  "(readOnly) The two parties used do not have access to use the specified SNMP PDU.",
  "(genError) A general failure occured",
  "noAccess",
  "wrongType (The set datatype does not match the data type the agent expects)",
  "wrongLength (The set value has an illegal length from what the agent expects)",
  "wrongEncoding",
  "wrongValue (The set value is illegal or unsupported in some way)",
  "noCreation (That table does not support row creation or that object can not ever be created)",
  "inconsistentValue (The set value is illegal or unsupported in some way)",
  "resourceUnavailable (This is likely a out-of-memory failure within the agent)",
  "commitFailed",
  "undoFailed",
  "authorizationError (access denied to that object)",
  "notWritable (That object does not support modification)",
  "inconsistentName (That object can not currently be created)",
];
const errstring = (e: number) => ERRSTR[e] ?? "Unknown Error";

// ------------------------------------------------------------------ argument parsing

interface Session {
  version: number; // 0 = v1, 1 = v2c, 3 = v3
  community: string;
  /** SNMPv3 (-u -l -a -A -x -X -e -n). */
  user: string;
  level: SecLevel;
  usm: UsmUser;
  context: string;
  engine?: { id: number[]; boots: number; time: number };
  timeoutMs: number;
  retries: number;
  fmt: FormatOpts;
  appOpts: string[]; // -C values
  peername: string;
  host: string;
  port: number;
  args: string[]; // after the agent
}

const VALUE_FLAGS = new Set(["v", "c", "t", "r", "O", "C", "m", "M", "u", "l", "a", "A", "x", "X", "e", "E", "n", "I", "L", "D"]);

function parseArgs(tool: string, argv: string[]): Session | { error: OutputLine[] } {
  const s: Session = {
    version: 3, community: "", user: "", level: "noAuthNoPriv", usm: { name: "" }, context: "",
    timeoutMs: 1000, retries: 5, fmt: {}, appOpts: [], peername: "", host: "", port: SNMP_PORT, args: [],
  };
  let auth: string | undefined;
  let priv: string | undefined;
  let authProto = "MD5"; // snmp_parse_args defaults: MD5 / DES
  let privProto = "DES";
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (pos.length === 0 && a.startsWith("-") && a.length > 1) {
      const f = a[1];
      if (f === "h" || a === "--help") return { error: [line(`USAGE: ${tool} [OPTIONS] AGENT OID [OID]...`)] };
      if (!VALUE_FLAGS.has(f)) return { error: [err(`${tool}: invalid option -- '${f}'`)] };
      const val = a.length > 2 ? a.slice(2) : argv[++i];
      if (val === undefined) return { error: [err(`${tool}: option requires an argument -- '${f}'`)] };
      if (f === "v") {
        if (val === "1") s.version = 0;
        else if (val === "2c") s.version = 1;
        else if (val === "3") s.version = 3;
        else return { error: [err(`Invalid version specified after -v flag: ${val}`)] };
      } else if (f === "c") s.community = val;
      else if (f === "t") s.timeoutMs = Math.round(Number(val) * 1000);
      else if (f === "r") s.retries = Math.max(0, Number(val) | 0);
      else if (f === "O") {
        for (const ch of val) {
          if (ch === "n") s.fmt.numeric = true;
          else if (ch === "s") s.fmt.short = true;
          else if (ch === "q") s.fmt.quick = true;
          else if (ch === "v") s.fmt.valueOnly = true;
        }
      } else if (f === "C") s.appOpts.push(val);
      else if (f === "u") s.user = val;
      else if (f === "n") s.context = val;
      else if (f === "A") auth = val;
      else if (f === "X") priv = val;
      else if (f === "a") authProto = val.toUpperCase();
      else if (f === "x") privProto = val.toUpperCase();
      else if (f === "e") s.engine = { id: (val.replace(/^0x/i, "").match(/../g) ?? []).map((h) => parseInt(h, 16)), boots: 0, time: 0 };
      else if (f === "l") {
        const l = val.toLowerCase();
        if (l === "noauthnopriv" || l === "noauth" || l === "1") s.level = "noAuthNoPriv";
        else if (l === "authnopriv" || l === "auth" || l === "2") s.level = "authNoPriv";
        else if (l === "authpriv" || l === "priv" || l === "3") s.level = "authPriv";
        else return { error: [err(`Invalid security level specified after -l flag: ${val}`)] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length === 0) return { error: [err("No hostname specified.")] };
  s.peername = pos[0];
  const m = pos[0].replace(/^udp:/, "").match(/^([^:]+)(?::(\d+))?$/);
  s.host = m?.[1] ?? pos[0];
  if (m?.[2]) s.port = Number(m[2]);
  s.args = pos.slice(1);
  if (s.version === 3) {
    if (!s.user) return { error: [err(`${tool}: No securityName specified`)] };
    if (s.level !== "noAuthNoPriv") {
      if (authProto !== "MD5" && authProto !== "SHA") return { error: [err(`Invalid authentication protocol specified after -a flag: ${authProto}`)] };
      if (!auth) return { error: [err(`${tool}: No authentication passphrase specified`)] };
      if (auth.length < 8) return { error: [err("Error: passphrase chosen is below the length requirements of the USM (min=8).")] };
    }
    if (s.level === "authPriv") {
      if (privProto !== "AES" && privProto !== "AES128") return { error: [err(`${tool}: ${privProto} privacy is not simulated here; use -x AES`)] };
      if (!priv) return { error: [err(`${tool}: No privacy passphrase specified`)] };
      if (priv.length < 8) return { error: [err("Error: passphrase chosen is below the length requirements of the USM (min=8).")] };
    }
    s.usm = {
      name: s.user,
      authProto: s.level !== "noAuthNoPriv" ? (authProto as "MD5" | "SHA") : undefined,
      authPassword: auth,
      privProto: s.level === "authPriv" ? "AES" : undefined,
      privPassword: priv,
    };
  } else if (!s.community) return { error: [err(`${tool}: No community name specified.`)] };
  if (!isValidIpv4(s.host)) return { error: [err(`${tool}: Unknown host (${s.host})`)] };
  return s;
}

// ------------------------------------------------------------------ one request/response

interface Exchange {
  resp?: SnmpMessage;
  error?: string; // STAT_ERROR text (after "<tool>: ")
  events: SimEvent[];
}

/** Send one datagram to the agent and wait for a reply that `match` accepts (with retries). */
function transport(ctx: CommandContext, s: Session, port: number, payload: number[], match: (raw: number[]) => boolean): { raw?: number[]; error?: string; events: SimEvent[] } {
  const dev = ctx.device;
  const mgr = managerState(dev);
  // Talking to ourselves (loopback / own address): no wire, straight to the local agent.
  if (s.host.startsWith("127.") || ownsAddress(dev, s.host)) {
    if (!isAgentDevice(dev)) return { events: [] };
    const now = Date.now();
    const rt = ensureAgent(dev, now, true);
    if (!agentListens(rt, s.host.startsWith("127.") ? "0.0.0.0" : s.host, s.port)) return { events: [] };
    let reply: number[] | null = null;
    if (messageVersion(payload) === 3) reply = processV3(dev, rt, payload, now);
    else {
      const r = processRequest(dev, rt, decodeMessage(payload), now, () => undefined);
      reply = r ? encodeMessage(r) : null;
    }
    return { raw: reply && match(reply) ? reply : undefined, events: [] };
  }

  const route = longestPrefixMatch(dev.routingTable, s.host);
  const egress = route ? findInterface(dev, route.route.interfaceId) : undefined;
  const src = egress ? primaryIpv4(egress)?.address : undefined;
  if (!src) return { error: "Failure in sendto (Network is unreachable)", events: [] };

  const events: SimEvent[] = [];
  mgr.pending = { port, agentIp: s.host, agentPort: s.port };
  try {
    for (let attempt = 0; attempt <= s.retries; attempt++) {
      mgr.rx = [];
      const run = ctx.runSim((sim) => {
        if (attempt > 0) sim.advance(attempt * s.timeoutMs); // retransmission after each timeout
        return sendIpv4(sim, dev, { src, dst: s.host, udp: { sport: port, dport: s.port }, payload, summary: `SNMP request to ${s.host}` });
      });
      events.push(...run.events);
      const raw = mgr.rx.find(match);
      if (raw) return { raw, events };
    }
    return { events };
  } finally {
    mgr.pending = undefined;
    mgr.rx = [];
  }
}

function exchange(ctx: CommandContext, s: Session, type: number, varbinds: VarBind[], extra: { nonRep?: number; maxRep?: number } = {}): Exchange {
  if (s.version === 3) return exchangeV3(ctx, s, type, varbinds, extra);
  const ids = nextIds(managerState(ctx.device));
  const msg: SnmpMessage = {
    version: s.version,
    community: s.community,
    pdu: { type, reqId: ids.reqId, errStatus: extra.nonRep ?? 0, errIndex: extra.maxRep ?? 0, varbinds },
  };
  const decode = (raw: number[]): SnmpMessage | undefined => {
    try {
      const r = decodeMessage(raw);
      return r.pdu.type === PDU.RESPONSE && r.pdu.reqId === ids.reqId ? r : undefined;
    } catch {
      return undefined;
    }
  };
  const x = transport(ctx, s, ids.port, encodeMessage(msg), (raw) => !!decode(raw));
  return { resp: x.raw ? decode(x.raw) : undefined, error: x.error, events: x.events };
}

/** snmp_api_errstring() for the USM Report counters (snmp_api.c api_errors[]). */
const REPORT_ERR: [readonly number[], string][] = [
  [USM_STATS.unknownUserNames, "Unknown user name"],
  [USM_STATS.wrongDigests, "Authentication failure (incorrect password, community or key)"],
  [USM_STATS.unsupportedSecLevels, "Unsupported security level"],
  [USM_STATS.decryptionErrors, "Decryption error"],
  [USM_STATS.notInTimeWindows, "Not in time window"],
  [USM_STATS.unknownEngineIDs, "Unknown engine ID"],
];

function exchangeV3(ctx: CommandContext, s: Session, type: number, varbinds: VarBind[], extra: { nonRep?: number; maxRep?: number }): Exchange {
  const mgr = managerState(ctx.device);
  const events: SimEvent[] = [];
  const send = (m: V3Message, user: UsmUser | undefined) => {
    const ids = nextIds(mgr);
    const bytes = secureV3(m, user, ids.reqId);
    const x = transport(ctx, s, ids.port, bytes, (raw) => {
      try {
        return decodeV3(raw).msg.msgId === m.msgId;
      } catch {
        return false;
      }
    });
    if (!events.length) events.push(...x.events);
    return x;
  };
  // Engine ID discovery probe (empty user, noAuthNoPriv, reportable).
  if (!s.engine) {
    const id = nextIds(mgr).reqId;
    const probe: V3Message = {
      msgId: id, maxSize: 65507, flags: FLAG.REPORTABLE, engineId: [], boots: 0, time: 0, user: "", authParams: [], privParams: [],
      scoped: { contextEngineId: [], contextName: "", pdu: { type: PDU.GET, reqId: id, errStatus: 0, errIndex: 0, varbinds: [] } },
    };
    const x = send(probe, undefined);
    if (x.error) return { error: x.error, events };
    if (!x.raw) return { events };
    const r = decodeV3(x.raw).msg;
    s.engine = { id: r.engineId, boots: r.boots, time: r.time };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = nextIds(mgr).reqId;
    const req: V3Message = {
      msgId: id, maxSize: 65507, flags: levelFlags(s.level) | FLAG.REPORTABLE, engineId: s.engine.id, boots: s.engine.boots, time: s.engine.time,
      user: s.user, authParams: [], privParams: [],
      scoped: { contextEngineId: s.engine.id, contextName: s.context, pdu: { type, reqId: id, errStatus: extra.nonRep ?? 0, errIndex: extra.maxRep ?? 0, varbinds } },
    };
    const x = send(req, s.usm);
    if (x.error) return { error: x.error, events };
    if (!x.raw) return { events };
    const d = decodeV3(x.raw);
    if (d.msg.flags & (FLAG.AUTH | FLAG.PRIV) && unsecureV3(x.raw, d, s.usm)) return { error: "Authentication failure (incorrect password, community or key)", events };
    const pdu = d.msg.scoped?.pdu;
    if (!pdu) return { events };
    if (pdu.type === PDU.REPORT) {
      const oid = pdu.varbinds[0]?.oid ?? [];
      if (oidCompare(oid, [...USM_STATS.notInTimeWindows]) === 0 && attempt === 0) {
        s.engine = { id: d.msg.engineId, boots: d.msg.boots, time: d.msg.time }; // resync and retry once
        continue;
      }
      const e = REPORT_ERR.find(([o]) => oidCompare(oid, [...o]) === 0);
      return { error: e?.[1] ?? "Unknown Report message", events };
    }
    return { resp: { version: 3, community: "", pdu }, events };
  }
  return { error: "Not in time window", events };
}

const nullVb = (oid: Oid): VarBind => ({ oid, value: { type: "null" } });
const isException = (v: SnmpValue) => v.type === "endOfMibView" || v.type === "noSuchObject" || v.type === "noSuchInstance";

function parseOids(oids: string[]): Oid[] | { error: OutputLine[] } {
  const out: Oid[] = [];
  for (const a of oids) {
    const r = parseOid(a);
    if ("error" in r) return { error: [err(r.error)] };
    out.push(r);
  }
  return out;
}

function failedObject(resp: SnmpMessage, fmt: FormatOpts): OutputLine[] {
  const out = [err(`Reason: ${errstring(resp.pdu.errStatus)}`)];
  const vb = resp.pdu.varbinds[resp.pdu.errIndex - 1];
  if (resp.pdu.errIndex !== 0 && vb) out.push(err(`Failed object: ${formatOid(vb.oid, fmt)}`));
  return out;
}

// ------------------------------------------------------------------ snmpget / snmpgetnext

function getLike(tool: string, type: number, args: string[], ctx: CommandContext): CommandResult {
  const s = parseArgs(tool, args);
  if ("error" in s) return { output: s.error };
  if (s.args.length === 0) return { output: [err("Missing object name"), line(`USAGE: ${tool} [OPTIONS] AGENT OID [OID]...`)] };
  const oids = parseOids(s.args);
  if ("error" in oids) return { output: oids.error };
  const out: OutputLine[] = [];
  let vbs = oids.map(nullVb);
  let events: SimEvent[] = [];
  for (;;) {
    const x = exchange(ctx, s, type, vbs);
    events = events.length ? events : x.events;
    if (x.error) return { output: [...out, err(`${tool}: ${x.error}`)], events };
    if (!x.resp) return { output: [...out, err(`Timeout: No Response from ${s.peername}.`)], events };
    const r = x.resp.pdu;
    if (r.errStatus === 0) {
      out.push(...r.varbinds.map((vb) => line(formatVarBind(vb, s.fmt))));
      return { output: out, events };
    }
    // snmpget.c: print the error, then retry without the failed varbind (snmp_fix_pdu).
    out.push(err("Error in packet"), ...failedObject(x.resp, s.fmt));
    vbs = vbs.filter((_, i) => i !== r.errIndex - 1);
    if (r.errIndex === 0 || vbs.length === 0) return { output: out, events };
  }
}

// ------------------------------------------------------------------ snmpwalk / snmpbulkwalk

function walk(tool: "snmpwalk" | "snmpbulkwalk", args: string[], ctx: CommandContext): CommandResult {
  const s = parseArgs(tool, args);
  if ("error" in s) return { output: s.error };
  let root: Oid = [1, 3, 6, 1, 2, 1]; // objid_mib
  if (s.args[0]) {
    const r = parseOid(s.args[0]);
    if ("error" in r) return { output: [err(r.error)] };
    root = r;
  }
  let nonRep = 0;
  let maxRep = 10;
  let printCount = false;
  for (const c of s.appOpts) {
    const m = c.match(/^([rn])(\d+)$/);
    if (m?.[1] === "r") maxRep = Number(m[2]);
    else if (m?.[1] === "n") nonRep = Number(m[2]);
    else if (c.includes("p")) printCount = true;
  }
  const end = [...root];
  end[end.length - 1] += 1;
  const out: OutputLine[] = [];
  let name = root;
  let numprinted = 0;
  let events: SimEvent[] | undefined;
  let ok = true;
  for (let running = true; running; ) {
    const x =
      tool === "snmpwalk"
        ? exchange(ctx, s, PDU.GETNEXT, [nullVb(name)])
        : exchange(ctx, s, PDU.GETBULK, [nullVb(name)], { nonRep, maxRep });
    events ??= x.events; // animate the first exchange
    if (x.error) {
      out.push(err(`${tool}: ${x.error}`));
      ok = false;
      break;
    }
    if (!x.resp) {
      out.push(err(`Timeout: No Response from ${s.peername}`));
      ok = false;
      break;
    }
    const r = x.resp.pdu;
    if (r.errStatus !== 0) {
      running = false;
      if (r.errStatus === 2) out.push(line("End of MIB"));
      else out.push(err("Error in packet."), ...failedObject(x.resp, s.fmt));
      break;
    }
    if (r.varbinds.length === 0) break;
    for (const vb of r.varbinds) {
      if (oidCompare(end, vb.oid) <= 0) {
        running = false; // not part of this subtree
        continue;
      }
      numprinted++;
      out.push(line(formatVarBind(vb, s.fmt)));
      if (isException(vb.value)) running = false;
      else if (oidCompare(name, vb.oid) >= 0) {
        out.push(err(`Error: OID not increasing: ${formatOid(name, s.fmt)}`), err(` >= ${formatOid(vb.oid, s.fmt)}`));
        running = false;
      } else name = vb.oid;
    }
  }
  if (numprinted === 0 && ok) {
    // walk.c: nothing in the subtree — maybe an exact instance; try a GET.
    const x = exchange(ctx, s, PDU.GET, [nullVb(root)]);
    if (x.resp && x.resp.pdu.errStatus === 0) out.push(...x.resp.pdu.varbinds.map((vb) => line(formatVarBind(vb, s.fmt))));
  }
  if (printCount) out.push(line(`Variables found: ${numprinted}`));
  return { output: out, events };
}

// ------------------------------------------------------------------ snmpset

function setValue(oidText: string, t: string, v: string): SnmpValue | { error: string } {
  switch (t) {
    case "i":
      return /^-?\d+$/.test(v) ? { type: "integer", value: Number(v) } : { error: `${oidText}: Bad value: ${v}` };
    case "u":
      return { type: "gauge32", value: Number(v) >>> 0 };
    case "t":
      return { type: "timeticks", value: Number(v) >>> 0 };
    case "a":
      return isValidIpv4(v) ? { type: "ipaddress", value: v } : { error: `${oidText}: Bad value: ${v}` };
    case "o": {
      const r = parseOid(v);
      return "error" in r ? { error: r.error } : { type: "oid", value: r };
    }
    case "s":
    case "=":
      return str(v);
    case "x": {
      const hex = v.replace(/[\s:]/g, "");
      if (!/^([0-9a-fA-F]{2})*$/.test(hex)) return { error: `${oidText}: Bad value: ${v}` };
      return { type: "string", value: (hex.match(/../g) ?? []).map((h) => parseInt(h, 16)) };
    }
    case "d":
      return { type: "string", value: v.split(/[.\s]+/).filter(Boolean).map((n) => Number(n) & 0xff) };
    default:
      return { error: `${oidText}: Bad object type: ${t}` };
  }
}

function snmpset(args: string[], ctx: CommandContext): CommandResult {
  const s = parseArgs("snmpset", args);
  if ("error" in s) return { output: s.error };
  if (s.args.length === 0) return { output: [err("Missing object name")] };
  const vbs: VarBind[] = [];
  for (let i = 0; i < s.args.length; i += 3) {
    const [o, t, v] = s.args.slice(i, i + 3);
    if (t === undefined) return { output: [err(`${o}: Needs type and value`)] };
    if (v === undefined) return { output: [err(`${o}: Needs value`)] };
    const oid = parseOid(o);
    if ("error" in oid) return { output: [err(oid.error)] };
    const val = setValue(o, t, v);
    if ("error" in val) return { output: [err(val.error)] };
    vbs.push({ oid, value: val });
  }
  const x = exchange(ctx, s, PDU.SET, vbs);
  if (x.error) return { output: [err(`snmpset: ${x.error}`)], events: x.events };
  if (!x.resp) return { output: [err(`Timeout: No Response from ${s.peername}`)], events: x.events };
  if (x.resp.pdu.errStatus !== 0) return { output: [err("Error in packet."), ...failedObject(x.resp, s.fmt)], events: x.events };
  const quiet = s.appOpts.some((c) => c.includes("q"));
  return { output: quiet ? [] : x.resp.pdu.varbinds.map((vb) => line(formatVarBind(vb, s.fmt))), events: x.events };
}

// ------------------------------------------------------------------ snmptrapd

const p2 = (n: number) => String(n).padStart(2, "0");

/** uptime_string (snmplib): "H:MM:SS.cc", "1 day, H:MM:SS.cc", "N days, H:MM:SS.cc". */
function uptime(ticks: number): string {
  const cs = ticks % 100;
  let t = Math.floor(ticks / 100);
  const days = Math.floor(t / 86400);
  t %= 86400;
  const hms = `${Math.floor(t / 3600)}:${p2(Math.floor(t / 60) % 60)}:${p2(t % 60)}.${p2(cs)}`;
  return days === 0 ? hms : `${days} day${days === 1 ? "" : "s"}, ${hms}`;
}

const TRAP_DESC = ["Cold Start", "Warm Start", "Link Down", "Link Up", "Authentication Failure", "EGP Neighbor Loss", "Enterprise Specific"]; // trap_description()

/**
 * One received notification as snmptrapd prints it: v2c/v3 PRINT_V23_NOTIFICATION_FORMAT
 * "%.4y-%.2m-%.2l %.2h:%.2j:%.2k %B [%b]:\n%v" (snmptrapd_handlers.c:716); SNMPv1 traps use
 * realloc_format_plain_trap (snmptrapd_log.c:1340-1545): "<time> <host> [<agent-addr>]
 * (via <transport>) TRAP, SNMP v1, community <c>\n\t<enterprise> <description> Trap
 * (<specific>) Uptime: <uptime>\n\t<varbinds>".
 */
export function formatTrap(t: { timeMs: number; srcIp: string; srcPort: number; dstIp: string; dstPort: number; bytes: number[] }, fmt: FormatOpts = {}, users: UsmUser[] = []): string[] {
  const d = new Date(t.timeMs);
  const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const via = `UDP: [${t.srcIp}]:${t.srcPort}->[${t.dstIp}]:${t.dstPort}`;
  const tr = decodeTrap(t.bytes, users);
  const p = tr.pdu;
  if (p?.type === PDU.TRAP && p.trap) {
    return [
      `${ts} <UNKNOWN> [${p.trap.agentAddr}] (via ${via}) TRAP, SNMP v1, community ${tr.community}`,
      `\t${formatOid(p.trap.enterprise, fmt)} ${TRAP_DESC[p.trap.generic] ?? "Unknown Type"} Trap (${p.trap.specific}) Uptime: ${uptime(p.trap.timestamp)}`,
      ...(p.varbinds.length ? [p.varbinds.map((vb) => "\t" + formatVarBind(vb, fmt)).join("")] : []),
    ];
  }
  const vbs = p ? p.varbinds.map((vb) => formatVarBind(vb, fmt)).join("\t") : `(${tr.error ?? "undecodable"})`;
  // %B: reverse-DNS name of the sender, "<UNKNOWN>" without DNS (snmptrapd_log.c:671-690).
  return [`${ts} <UNKNOWN> [${via}]:`, vbs];
}

export const snmptrapdCommand: CommandHandler = {
  name: "snmptrapd",
  summary: "SNMP notification receiver (UDP 162)",
  usage: "snmptrapd [-On] | snmptrapd -l | snmptrapd stop | snmptrapd clear",
  help: [
    "SNMPTRAPD (net-snmp 5.9.3)",
    "",
    "Usage:",
    "  snmptrapd [-p port]   start receiving notifications on UDP 162 (all communities accepted,",
    "                        as with `disableAuthorization yes`)",
    "  snmptrapd -l [-On]    print the received notifications (default snmptrapd log format)",
    "  snmptrapd stop        stop the receiver",
    "  snmptrapd clear       empty the log",
    "  snmptrapd createUser USER [MD5|SHA AUTHPASS [AES PRIVPASS]]   USM user for SNMPv3 notifications",
  ],
  run(args, ctx): CommandResult {
    const fmt: FormatOpts = {};
    for (const a of args) if (a.startsWith("-O")) for (const ch of a.slice(2)) if (ch === "n") fmt.numeric = true;
    const sub = args.find((a) => !a.startsWith("-O"));
    if (sub === "-l" || sub === "log") {
      const st = peekTrapd(ctx.device);
      if (!st || st.traps.length === 0) return { output: [muted(st?.running ? "(no notifications received yet)" : "snmptrapd is not running (start it with `snmptrapd`)")] };
      return { output: st.traps.flatMap((t) => formatTrap(t, fmt, st.users).map((l) => line(l))) };
    }
    if (sub === "stop") {
      const st = peekTrapd(ctx.device);
      if (!st?.running) return { output: [err("snmptrapd: not running")] };
      st.running = false;
      return { output: [muted("NET-SNMP version 5.9.3 Stopped.")] };
    }
    if (sub === "clear") {
      trapdState(ctx.device).traps = [];
      return { output: [] };
    }
    if (sub === "createUser") {
      // snmptrapd.conf: createUser [-e ENGINEID] USER (MD5|SHA) AUTHPASS [AES PRIVPASS]
      const a = args.slice(args.indexOf("createUser") + 1).filter((x, i, arr) => x !== "-e" && arr[i - 1] !== "-e");
      const [name, ap, apass, pp, ppass] = a;
      if (!name) return { output: [err("snmptrapd: createUser USER [MD5|SHA AUTHPASS [AES PRIVPASS]]")] };
      const up = ap?.toUpperCase();
      if (up && up !== "MD5" && up !== "SHA") return { output: [err(`snmptrapd: unknown authentication protocol ${ap}`)] };
      if (pp && pp.toUpperCase() !== "AES") return { output: [err(`snmptrapd: ${pp} privacy is not simulated here; use AES`)] };
      const st = trapdState(ctx.device);
      st.users = [...(st.users ?? []).filter((u) => u.name !== name), { name, authProto: up as "MD5" | "SHA" | undefined, authPassword: apass, privProto: pp ? "AES" : undefined, privPassword: ppass }];
      return { output: [] };
    }
    const st = trapdState(ctx.device);
    const pi = args.indexOf("-p");
    const port = pi >= 0 ? Number(args[pi + 1]) : SNMPTRAP_PORT;
    if (st.running) return { output: [err(`couldn't open udp:${st.port} -- errno 98 ("Address already in use")`)] };
    st.running = true;
    st.port = port || SNMPTRAP_PORT;
    return { output: [line("NET-SNMP version 5.9.3"), muted(`listening on udp:${st.port} — view received notifications with \`snmptrapd -l\``)] };
  },
};

// ------------------------------------------------------------------ registration

const COMMON_HELP = [
  "",
  "  -v 1|2c|3      SNMP version (SONiC answers v2c and v3)",
  "  -c COMMUNITY   community string (v1/v2c)",
  "  -u USER -l noAuthNoPriv|authNoPriv|authPriv -a MD5|SHA -A PASS -x AES -X PASS   SNMPv3 USM",
  "  -t TIMEOUT     seconds per attempt (default 1)",
  "  -r RETRIES     retransmissions (default 5)",
  "  -On / -Os / -Oq / -Ov   numeric OIDs / short names / quick print / value only",
  "",
  "OIDs: numeric (.1.3.6.1.2.1.1.5.0) or names (SNMPv2-MIB::sysName.0, sysName.0, system,",
  "ifTable, IF-MIB::ifOperStatus.1, ifXTable, ifHCInOctets.1 …).",
];

function tool(name: string, summary: string, usage: string, run: (a: string[], c: CommandContext) => CommandResult): CommandHandler {
  return { name, summary, usage, help: [name.toUpperCase() + " (net-snmp 5.9.3)", "", "Usage:", `  ${usage}`, ...COMMON_HELP], run };
}

export const snmpgetCommand = tool("snmpget", "SNMP GET request", "snmpget -v2c -c COMMUNITY [-On] AGENT OID [OID]...", (a, c) => getLike("snmpget", PDU.GET, a, c));
export const snmpgetnextCommand = tool("snmpgetnext", "SNMP GETNEXT request", "snmpgetnext -v2c -c COMMUNITY [-On] AGENT OID [OID]...", (a, c) => getLike("snmpgetnext", PDU.GETNEXT, a, c));
export const snmpwalkCommand = tool("snmpwalk", "Walk a MIB subtree with GETNEXT", "snmpwalk -v2c -c COMMUNITY [-On] [-Cp] AGENT [OID]", (a, c) => walk("snmpwalk", a, c));
export const snmpbulkwalkCommand = tool("snmpbulkwalk", "Walk a MIB subtree with GETBULK", "snmpbulkwalk -v2c -c COMMUNITY [-Cr10] [-Cn0] AGENT [OID]", (a, c) => walk("snmpbulkwalk", a, c));
export const snmpsetCommand = tool("snmpset", "SNMP SET request", "snmpset -v2c -c COMMUNITY AGENT OID TYPE VALUE [OID TYPE VALUE]...  (TYPE: i u t a o s x d)", snmpset);

export const SNMP_CLIENT_COMMANDS: CommandHandler[] = [snmpgetCommand, snmpgetnextCommand, snmpwalkCommand, snmpbulkwalkCommand, snmpsetCommand, snmptrapdCommand];
