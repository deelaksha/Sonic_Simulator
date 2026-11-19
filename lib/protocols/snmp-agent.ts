/**
 * snmpd (net-snmp 5.9.3, docker-snmp) + snmp_linktrapd behaviour on a SONiC device.
 *
 * Request path (agent/snmp_agent.c):
 *   - unknown community: no com2sec security name -> snmpInBadCommunityNames++, an
 *     authenticationFailure trap if `authtrapenable 1`, and the request is DROPPED
 *     (snmp_agent.c:2239-2290, vacm_conf.c "No security name found"); the manager times out.
 *   - SONiC binds every community with `group <c>_grp v2c <c>_sec` (snmpd.conf.j2:141-145),
 *     so an SNMPv1 request finds no VACM group and is dropped as well.
 *   - RO communities have write view `none`: a SET fails per varbind with noAccess
 *     (snmp_agent.c:2780-2787). sysContact/sysLocation are always set in snmpd.conf
 *     (snmpd.conf.j2:182-191), which makes them read-only: SET -> notWritable
 *     (mibII/updates.c:15, system_mib.c:197-205). sysName is not configured, so an RW
 *     community may SET it (kept in memory/persistent store, not the Linux hostname).
 *
 * Notifications:
 *   - coldStart on every snmpd start (snmpd.c:1176) and nsNotifyShutdown on stop
 *     (snmpd.c:472-475, 1211) to each trap2sink; generic v2 traps carry
 *     snmpTrapEnterprise.0 = NET-SNMP-MIB::netSnmpAgentOIDs.10 (agent_trap.c:840-858, 1258-1266).
 *   - linkUp/linkDown come from snmp_linktrapd, not snmpd: on an oper_status transition
 *     of an Ethernet* port, gated by SNMP|TRAPS.traps_enabled == "true", it runs
 *     `snmptrap -v 2c -c <community|public> <ip>:<port> "" <linkUp|linkDown> ifIndex i <n>
 *     ifAdminStatus i <a> ifOperStatus i <o>` for each SNMP_TRAP row with version v2c
 *     (snmp_linktrapd:240-260, 519-560, 626-662, 913-960). ifIndex there is the 1-based
 *     get_index_from_str value; snmptrap's "" uptime is the system uptime. SNMP_TRAP v3
 *     rows get `snmptrap -v 3 -e <engine> -u <user> -l <level> [-a -A] [-x -X]`
 *     (_build_v3_argv, snmp_linktrapd:664-753).
 *   - trapsink (v1TrapDest / v3TrapDest) receives SNMPv1 Trap-PDUs converted from the
 *     notification as agent_trap.c does (RFC 3584 §3.2: snmpTraps.N → generic N-1 with
 *     enterprise = snmpTrapEnterprise.0; others → enterprise-specific, specific = last
 *     sub-id); trapsess -v 3 (SNMP_TRAP v3 rows) receives SNMPv3 TRAP2s secured with the
 *     user's keys localized to snmpd's own engine ID (the sender is authoritative).
 *
 * SNMPv3 requests (snmpusm.c usm_process_in_msg, RFC 3414 §3.2): unknown engine ID →
 *   Report usmStatsUnknownEngineIDs (discovery, carries engineID/boots/time); unknown
 *   user → usmStatsUnknownUserNames; level above the user's credentials →
 *   usmStatsUnsupportedSecLevels; bad digest → usmStatsWrongDigests; outside the 150 s
 *   window → usmStatsNotInTimeWindows (authenticated); undecryptable → usmStatsDecryptionErrors.
 *   VACM: SONiC renders `rouser|rwuser <user> <SNMP_USER_TYPE>` (snmpd.conf.j2:161-168), so
 *   a request below the user's level is answered with authorizationError (snmp_agent.c
 *   check_access failure for v2c/v3).
 *
 * Feature: `config feature state snmp disabled` stops docker-snmp: snmpd sends
 * nsNotifyShutdown and exits; nothing answers UDP 161 and no traps are sent until it is
 * re-enabled (then coldStart, snmpEngineBoots + 1).
 */
import { Device, findInterface, isRouter, isSwitch } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { longestPrefixMatch } from "../models/route";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { sendIpv4, l4Payload } from "../control/packet";
import { ERR, PDU, SnmpMessage, SnmpPdu, VarBind, decodeMessage, encodeMessage, messageVersion, oidCompare } from "./snmp-ber";
import { AgentRuntime, LinkSeen, ensureAgent, peekAgent, peekSnmpConfig, renderApplied } from "./snmp-config";
import { MibRow, OIDS, buildMib, isKnownObject, sonicIfRow } from "./snmp-mib";
import { FLAG, LEVEL_RANK, SecLevel, USM_STATS, UsmUser, V3Message, decodeV3, flagsLevel, levelFlags, secureV3, unsecureV3, userMaxLevel } from "./snmp-usm";
import { featureEnabled } from "./cpu-features";

export const SNMP_PORT = 161;
export const SNMPTRAP_PORT = 162;

/** Runs snmpd: a switch/router that is up with the snmp container running. */
export const isAgentDevice = (d: Device): boolean => (isSwitch(d.type) || isRouter(d.type)) && d.state !== "down" && featureEnabled(d, "snmp");

const bump = (rt: AgentRuntime, k: string, n = 1) => (rt.stats[k] = (rt.stats[k] ?? 0) + n);

/** Ephemeral UDP source port + request-id for a datagram this device originates. */
export function nextIds(rt: { seq: number }): { port: number; reqId: number } {
  rt.seq += 1;
  return { port: 32768 + ((rt.seq * 7919) % 28000), reqId: ((rt.seq * 1103515245 + 12345) >>> 1) & 0x7fffffff };
}

// ------------------------------------------------------------------ requests

/** True when snmpd listens on dstIp:dstPort (agentAddress lines, default udp:161). */
export function agentListens(rt: AgentRuntime, dstIp: string, dstPort: number): boolean {
  const l = rt.applied.listen;
  if (l.length === 0) return dstPort === SNMP_PORT;
  return l.some((a) => a.port === dstPort && (a.ip === dstIp || a.ip === "0.0.0.0" || a.ip === ""));
}

function next(view: MibRow[], oid: number[]): MibRow | undefined {
  return view.find((r) => oidCompare(r.oid, oid) > 0);
}

function getOne(view: MibRow[], oid: number[]): VarBind {
  const hit = view.find((r) => oidCompare(r.oid, oid) === 0);
  if (hit) return { oid, value: hit.value };
  return { oid, value: { type: isKnownObject(oid) ? "noSuchInstance" : "noSuchObject" } };
}

function getNext(view: MibRow[], oid: number[]): VarBind {
  const r = next(view, oid);
  return r ? { oid: r.oid, value: r.value } : { oid, value: { type: "endOfMibView" } };
}

/**
 * Process one request. Returns the Response to send, or null when snmpd drops it.
 * `onAuthFail` is invoked for a bad community (authenticationFailure trap).
 */
export function processRequest(device: Device, rt: AgentRuntime, msg: SnmpMessage, nowMs: number, onAuthFail: () => void): SnmpMessage | null {
  bump(rt, "snmpInPkts");
  if (msg.version !== 0 && msg.version !== 1) {
    bump(rt, "snmpInBadVersions");
    return null;
  }
  const comm = rt.applied.communities.find((c) => c.name === msg.community);
  if (!comm) {
    bump(rt, "snmpInBadCommunityNames");
    if (rt.applied.authTraps) onAuthFail();
    return null;
  }
  if (msg.version === 0) return null; // no v1 VACM group for SONiC communities
  const r = servePdu(device, rt, msg.pdu, comm.access === "RW", nowMs);
  if (!r) return null;
  return { version: msg.version, community: msg.community, pdu: r };
}

/** Run one request PDU through the MIB (access already granted); the Response PDU, or null to drop. */
function servePdu(device: Device, rt: AgentRuntime, req: SnmpPdu, rw: boolean, nowMs: number): SnmpPdu | null {
  const view = buildMib(device, rt, nowMs);
  let varbinds: VarBind[] = [];
  let errStatus = 0;
  let errIndex = 0;
  switch (req.type) {
    case PDU.GET:
      bump(rt, "snmpInGetRequests");
      varbinds = req.varbinds.map((vb) => getOne(view, vb.oid));
      bump(rt, "snmpInTotalReqVars", varbinds.length);
      break;
    case PDU.GETNEXT:
      bump(rt, "snmpInGetNexts");
      varbinds = req.varbinds.map((vb) => getNext(view, vb.oid));
      bump(rt, "snmpInTotalReqVars", varbinds.length);
      break;
    case PDU.GETBULK: {
      const n = Math.max(0, Math.min(req.errStatus, req.varbinds.length));
      const m = Math.max(0, req.errIndex);
      varbinds = req.varbinds.slice(0, n).map((vb) => getNext(view, vb.oid));
      let cur = req.varbinds.slice(n).map((vb) => vb.oid);
      for (let r = 0; r < m && cur.length; r++) {
        const row = cur.map((oid) => getNext(view, oid));
        varbinds.push(...row);
        if (row.every((vb) => vb.value.type === "endOfMibView")) break;
        cur = row.map((vb) => vb.oid);
      }
      bump(rt, "snmpInTotalReqVars", varbinds.length);
      break;
    }
    case PDU.SET: {
      bump(rt, "snmpInSetRequests");
      varbinds = req.varbinds;
      const fail = (status: number, i: number) => {
        errStatus = status;
        errIndex = i + 1;
      };
      for (let i = 0; i < req.varbinds.length && !errStatus; i++) {
        if (!rw) fail(ERR.noAccess, i);
      }
      for (let i = 0; i < req.varbinds.length && !errStatus; i++) {
        const vb = req.varbinds[i];
        const exists = view.some((r) => oidCompare(r.oid, vb.oid) === 0);
        const key = vb.oid.join(".");
        if (!exists) fail(isKnownObject(vb.oid) ? ERR.noCreation : ERR.notWritable, i);
        else if (key === "1.3.6.1.2.1.1.5.0") {
          if (vb.value.type !== "string") fail(ERR.wrongType, i);
          else if (vb.value.value.length > 255) fail(ERR.wrongLength, i);
        } else fail(ERR.notWritable, i);
      }
      if (!errStatus) {
        for (const vb of req.varbinds) if (vb.value.type === "string") rt.sysNameSet = String.fromCharCode(...vb.value.value);
        bump(rt, "snmpInTotalSetVars", req.varbinds.length);
      }
      break;
    }
    default:
      return null;
  }
  bump(rt, "snmpOutPkts");
  bump(rt, "snmpOutGetResponses");
  return { type: PDU.RESPONSE, reqId: req.reqId, errStatus, errIndex, varbinds };
}

// ------------------------------------------------------------------ SNMPv3 / USM

const engineTime = (rt: AgentRuntime, nowMs: number) => Math.max(0, Math.floor((nowMs - rt.startedAt) / 1000));
export const engineBoots = (rt: AgentRuntime) => rt.engineBoots ?? 1;
const sameBytes = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Process an SNMPv3 request (RFC 3412 §7.2 + RFC 3414 §3.2 as snmpusm.c does).
 * Returns the reply (Response or Report) bytes, or null when snmpd drops the message.
 */
export function processV3(device: Device, rt: AgentRuntime, bytes: number[], nowMs: number): number[] | null {
  bump(rt, "snmpInPkts");
  let d: ReturnType<typeof decodeV3>;
  try {
    d = decodeV3(bytes);
  } catch {
    bump(rt, "snmpInASNParseErrs");
    return null;
  }
  const m = d.msg;
  if (d.secModel !== 3) return null; // snmpUnknownSecurityModels
  if (m.flags & FLAG.PRIV && !(m.flags & FLAG.AUTH)) return null; // snmpInvalidMsgs
  const own = rt.applied.engineId;
  const boots = engineBoots(rt);
  const time = engineTime(rt, nowMs);
  const reportable = !!(m.flags & FLAG.REPORTABLE);
  const report = (stat: readonly number[], key: string, user?: UsmUser, level: SecLevel = "noAuthNoPriv"): number[] | null => {
    bump(rt, key);
    if (!reportable) return null;
    const reqId = m.scoped?.pdu.reqId ?? 0;
    const msg: V3Message = {
      msgId: m.msgId, maxSize: 65507, flags: levelFlags(level), engineId: own, boots, time, user: m.user, authParams: [], privParams: [],
      scoped: { contextEngineId: own, contextName: m.scoped?.contextName ?? "", pdu: { type: PDU.REPORT, reqId, errStatus: 0, errIndex: 0, varbinds: [{ oid: [...stat], value: { type: "counter32", value: rt.stats[key] } }] } },
    };
    return secureV3(msg, user, nextIds(rt).reqId);
  };
  if (!sameBytes(m.engineId, own)) return report(USM_STATS.unknownEngineIDs, "usmStatsUnknownEngineIDs");
  const u = rt.applied.users.find((x) => x.name === m.user);
  if (!u) return report(USM_STATS.unknownUserNames, "usmStatsUnknownUserNames");
  const level = flagsLevel(m.flags);
  if (LEVEL_RANK[level] > LEVEL_RANK[userMaxLevel(u.usm)]) return report(USM_STATS.unsupportedSecLevels, "usmStatsUnsupportedSecLevels");
  if (m.flags & FLAG.AUTH) {
    if (unsecureV3(bytes, { authOffset: d.authOffset, msg: { ...m, flags: m.flags & ~FLAG.PRIV } }, u.usm)) {
      return report(USM_STATS.wrongDigests, "usmStatsWrongDigests");
    }
    // RFC 3414 §3.2 step 7: boots must match and time be within 150 s.
    if (m.boots !== boots || Math.abs(m.time - time) > 150) return report(USM_STATS.notInTimeWindows, "usmStatsNotInTimeWindows", u.usm, "authNoPriv");
  }
  const plain = { ...m, flags: m.flags & FLAG.PRIV };
  if (m.flags & FLAG.PRIV && unsecureV3(bytes, { authOffset: d.authOffset, msg: plain }, u.usm)) {
    return report(USM_STATS.decryptionErrors, "usmStatsDecryptionErrors");
  }
  if (plain.scoped) m.scoped = plain.scoped;
  const req = m.scoped?.pdu;
  if (!req) return null;
  let resp: SnmpPdu | null;
  if (LEVEL_RANK[level] < LEVEL_RANK[u.minLevel]) {
    // VACM denies the request (rouser/rwuser level): authorizationError (snmp_agent.c check_access).
    resp = { type: PDU.RESPONSE, reqId: req.reqId, errStatus: ERR.authorizationError, errIndex: 0, varbinds: req.varbinds };
  } else resp = servePdu(device, rt, req, u.permission === "RW", nowMs);
  if (!resp) return null;
  const out: V3Message = {
    msgId: m.msgId, maxSize: 65507, flags: levelFlags(level), engineId: own, boots, time, user: m.user, authParams: [], privParams: [],
    scoped: { contextEngineId: own, contextName: m.scoped!.contextName, pdu: resp },
  };
  return secureV3(out, u.usm, nextIds(rt).reqId);
}

/** UDP datagram to the agent port: decode, process, reply. */
export function agentReceive(ctx: SimContext, device: Device, frame: Frame): void {
  const now = ctx.wallNow();
  const rt = ensureAgent(device, now, true);
  const payload = l4Payload(frame);
  if (!payload || !frame.ipv4 || !frame.udp) return;
  if (messageVersion(payload) === 3) {
    const reply = processV3(device, rt, Array.from(payload), now);
    if (reply) {
      sendIpv4(ctx, device, { src: frame.ipv4.dstIp, dst: frame.ipv4.srcIp, udp: { sport: frame.udp.dstPort, dport: frame.udp.srcPort }, payload: reply, summary: `SNMPv3 reply to ${frame.ipv4.srcIp}` });
    }
    return;
  }
  let msg: SnmpMessage;
  try {
    msg = decodeMessage(payload);
  } catch {
    bump(rt, "snmpInPkts");
    bump(rt, "snmpInASNParseErrs");
    return;
  }
  const resp = processRequest(device, rt, msg, now, () => sendGenericTrap(ctx, device, rt, now, OIDS.authenticationFailure));
  if (!resp) return;
  sendIpv4(ctx, device, {
    src: frame.ipv4.dstIp,
    dst: frame.ipv4.srcIp,
    udp: { sport: frame.udp.dstPort, dport: frame.udp.srcPort },
    payload: encodeMessage(resp),
    summary: `SNMP GetResponse to ${frame.ipv4.srcIp}`,
  });
}

// ------------------------------------------------------------------ notifications

function egress(device: Device, dst: string): NetInterface | undefined {
  const m = longestPrefixMatch(device.routingTable, dst);
  return m ? findInterface(device, m.route.interfaceId) : undefined;
}

/** Send an SNMPv2-Trap to ip:port from the route's egress address. */
export function sendTrap2(ctx: SimContext, device: Device, rt: AgentRuntime, dest: { ip: string; port: number; community: string }, varbinds: VarBind[], what: string): boolean {
  const src = egress(device, dest.ip);
  const srcIp = src && primaryIpv4(src)?.address;
  if (!srcIp) return false;
  const ids = nextIds(rt);
  const res = sendIpv4(ctx, device, {
    src: srcIp,
    dst: dest.ip,
    udp: { sport: ids.port, dport: dest.port },
    payload: encodeMessage({ version: 1, community: dest.community, pdu: { type: PDU.TRAP2, reqId: ids.reqId, errStatus: 0, errIndex: 0, varbinds } }),
    summary: `SNMP V2Trap ${what} to ${dest.ip}`,
  });
  return res.ok;
}

function srcFor(device: Device, dst: string): string | undefined {
  const src = egress(device, dst);
  return src && primaryIpv4(src)?.address;
}

/** RFC 3584 §3.2 notification → SNMPv1 Trap-PDU, as agent_trap.c converts it for trapsink. */
export function sendTrap1(ctx: SimContext, device: Device, rt: AgentRuntime, dest: { ip: string; port: number; community: string }, varbinds: VarBind[], what: string): boolean {
  const srcIp = srcFor(device, dest.ip);
  if (!srcIp) return false;
  const uptime = varbinds.find((v) => oidCompare(v.oid, OIDS.sysUpTime0) === 0)?.value;
  const trapOid = varbinds.find((v) => oidCompare(v.oid, OIDS.snmpTrapOID0) === 0)?.value;
  const ent = varbinds.find((v) => oidCompare(v.oid, OIDS.snmpTrapEnterprise0) === 0)?.value;
  const t = trapOid?.type === "oid" ? trapOid.value : [];
  const generic = t.length === 10 && t.slice(0, 9).join(".") === "1.3.6.1.6.3.1.1.5" ? t[9] - 1 : 6;
  let enterprise = ent?.type === "oid" ? ent.value : t.slice(0, -1);
  if (generic === 6 && enterprise[enterprise.length - 1] === 0) enterprise = enterprise.slice(0, -1);
  const rest = varbinds.filter((v) => ![OIDS.sysUpTime0, OIDS.snmpTrapOID0, OIDS.snmpTrapEnterprise0].some((o) => oidCompare(o, v.oid) === 0));
  const ids = nextIds(rt);
  const pdu: SnmpPdu = {
    type: PDU.TRAP, reqId: 0, errStatus: 0, errIndex: 0, varbinds: rest,
    trap: { enterprise, agentAddr: srcIp, generic, specific: generic === 6 ? t[t.length - 1] ?? 0 : 0, timestamp: uptime?.type === "timeticks" ? uptime.value : 0 },
  };
  return sendIpv4(ctx, device, { src: srcIp, dst: dest.ip, udp: { sport: ids.port, dport: dest.port }, payload: encodeMessage({ version: 0, community: dest.community, pdu }), summary: `SNMP Trap(v1) ${what} to ${dest.ip}` }).ok;
}

/** SNMPv3 TRAP2 to a trapsess target, secured with the user's keys for our engine. */
export function sendTrap3(ctx: SimContext, device: Device, rt: AgentRuntime, dest: { ip: string; port: number; level: SecLevel; usm: UsmUser }, varbinds: VarBind[], what: string, nowMs: number): boolean {
  const srcIp = srcFor(device, dest.ip);
  if (!srcIp) return false;
  const ids = nextIds(rt);
  const own = rt.applied.engineId;
  const msg: V3Message = {
    msgId: ids.reqId, maxSize: 65507, flags: levelFlags(dest.level), engineId: own, boots: engineBoots(rt), time: engineTime(rt, nowMs), user: dest.usm.name, authParams: [], privParams: [],
    scoped: { contextEngineId: own, contextName: "", pdu: { type: PDU.TRAP2, reqId: ids.reqId, errStatus: 0, errIndex: 0, varbinds } },
  };
  const payload = secureV3(msg, dest.usm, ids.reqId);
  return sendIpv4(ctx, device, { src: srcIp, dst: dest.ip, udp: { sport: ids.port, dport: dest.port }, payload, summary: `SNMPv3 TRAP2 ${what} to ${dest.ip}` }).ok;
}

/** snmpd send_easy_trap(): generic traps get snmpTrapEnterprise.0; nsNotify* do not. */
function sendGenericTrap(ctx: SimContext, device: Device, rt: AgentRuntime, nowMs: number, trapOid: number[]): void {
  const generic = trapOid.join(".").startsWith("1.3.6.1.6.3.1.1.5.");
  const vbs: VarBind[] = [
    { oid: OIDS.sysUpTime0, value: { type: "timeticks", value: Math.max(0, Math.floor((nowMs - rt.startedAt) / 10)) } },
    { oid: OIDS.snmpTrapOID0, value: { type: "oid", value: trapOid } },
  ];
  if (generic) vbs.push({ oid: OIDS.snmpTrapEnterprise0, value: { type: "oid", value: OIDS.netSnmpLinux } });
  const name = trapOid === OIDS.coldStart ? "coldStart" : trapOid === OIDS.nsNotifyShutdown ? "nsNotifyShutdown" : "authenticationFailure";
  for (const sink of rt.applied.sinks) if (sendTrap2(ctx, device, rt, sink, vbs, name)) bump(rt, "snmpOutTraps");
  for (const sink of rt.applied.v1Sinks ?? []) if (sendTrap1(ctx, device, rt, sink, vbs, name)) bump(rt, "snmpOutTraps");
  for (const sink of rt.applied.v3Sinks ?? []) if (sendTrap3(ctx, device, rt, sink, vbs, name, nowMs)) bump(rt, "snmpOutTraps");
}

/** Physical front-panel ports snmp_linktrapd tracks (TRACKED_PREFIX "Ethernet", :259). */
function trackedPorts(device: Device): NetInterface[] {
  return device.interfaces.filter((i) => !i.management && !i.logical && /^Ethernet\d+$/.test(i.name));
}

function linksChanged(device: Device, rt: AgentRuntime): boolean {
  return trackedPorts(device).some((p) => {
    const s = rt.links[p.name];
    return !s || s.admin !== p.adminState || s.oper !== p.operState;
  });
}

/** Earliest wall ms the SNMP processes need attention on this device. */
export function agentDue(device: Device, nowMs: number): number | undefined {
  if (!isAgentDevice(device)) return (isSwitch(device.type) || isRouter(device.type)) && device.state !== "down" && peekAgent(device) ? nowMs : undefined; // snmpd stopping
  const rt = peekAgent(device);
  if (!rt) return nowMs;
  if (rt.coldStartPending || linksChanged(device, rt)) return nowMs;
  return rt.restartAt;
}

export function agentTick(ctx: SimContext, device: Device, nowMs: number): boolean {
  const rt = ensureAgent(device, nowMs, true);
  if (rt.restartAt !== undefined && rt.restartAt <= nowMs) {
    // systemctl restart snmp: snmpd stops (nsNotifyShutdown to the OLD sinks), the
    // container re-renders snmpd.conf from CONFIG_DB, snmpd starts (coldStart).
    sendGenericTrap(ctx, device, rt, nowMs, OIDS.nsNotifyShutdown);
    rt.startedAt = nowMs;
    rt.engineBoots = engineBoots(rt) + 1;
    rt.applied = renderApplied(device);
    rt.stats = {};
    rt.coldStartPending = true;
    rt.restartAt = undefined;
    rt.burstDeadline = undefined;
  }
  if (rt.coldStartPending) {
    rt.coldStartPending = false;
    sendGenericTrap(ctx, device, rt, nowMs, OIDS.coldStart);
  }
  for (const p of trackedPorts(device)) {
    const cur: LinkSeen = { admin: p.adminState, oper: p.operState };
    const prev = rt.links[p.name];
    rt.links[p.name] = cur;
    if (!prev || prev.oper === cur.oper) continue; // first sighting / admin-only change: no trap
    sendLinkTrap(ctx, device, rt, nowMs, p.name, cur);
  }
  return true;
}

/** docker-snmp stopped: snmpd sends nsNotifyShutdown and exits (its state goes with it). */
export function stopAgent(ctx: SimContext, device: Device, nowMs: number): boolean {
  const rt = peekAgent(device);
  if (!rt) return false;
  sendGenericTrap(ctx, device, rt, nowMs, OIDS.nsNotifyShutdown);
  delete device.config.features!["snmp-agent"];
  return true;
}

function sendLinkTrap(ctx: SimContext, device: Device, rt: AgentRuntime, nowMs: number, port: string, st: LinkSeen): void {
  const cfg = peekSnmpConfig(device);
  if (cfg?.trapsEnabled !== true) return; // SNMP|TRAPS.traps_enabled missing/false -> suppressed
  const idx = sonicIfRow(port);
  if (idx === undefined) return;
  const n = (s: "up" | "down") => (s === "up" ? 1 : 2);
  const vbs: VarBind[] = [
    { oid: OIDS.sysUpTime0, value: { type: "timeticks", value: Math.max(0, Math.floor((nowMs - rt.bootAt) / 10)) } },
    { oid: OIDS.snmpTrapOID0, value: { type: "oid", value: st.oper === "up" ? OIDS.linkUp : OIDS.linkDown } },
    { oid: [...OIDS.ifIndex, idx], value: { type: "integer", value: idx } },
    { oid: [...OIDS.ifAdminStatus, idx], value: { type: "integer", value: n(st.admin) } },
    { oid: [...OIDS.ifOperStatus, idx], value: { type: "integer", value: n(st.oper) } },
  ];
  const what = st.oper === "up" ? "linkUp" : "linkDown";
  for (const h of cfg.trapHosts ?? []) {
    if (h.version === "v2c") sendTrap2(ctx, device, rt, { ip: h.ip, port: h.port, community: h.community || "public" }, vbs, what);
    else if (h.version === "v3") {
      // _build_v3_argv: live SNMP_USER credentials, snmpd's engine ID; fail closed when incomplete.
      const sink = renderApplied(device).v3Sinks.find((x) => x.ip === h.ip && x.port === h.port);
      if (sink) sendTrap3(ctx, device, rt, sink, vbs, what, nowMs);
    } // unversioned rows are skipped by _build_snmptrap_argv (:766-775)
  }
}

