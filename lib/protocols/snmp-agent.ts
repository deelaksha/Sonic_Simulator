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
 *     get_index_from_str value; snmptrap's "" uptime is the system uptime.
 */
import { Device, findInterface, isRouter, isSwitch } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { longestPrefixMatch } from "../models/route";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { sendIpv4, l4Payload } from "../control/packet";
import { ERR, PDU, SnmpMessage, VarBind, decodeMessage, encodeMessage, oidCompare } from "./snmp-ber";
import { AgentRuntime, LinkSeen, ensureAgent, peekAgent, peekSnmpConfig, renderApplied } from "./snmp-config";
import { MibRow, OIDS, buildMib, isKnownObject, sonicIfRow } from "./snmp-mib";

export const SNMP_PORT = 161;
export const SNMPTRAP_PORT = 162;

export const isAgentDevice = (d: Device): boolean => (isSwitch(d.type) || isRouter(d.type)) && d.state !== "down";

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
  const req = msg.pdu;
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
        if (comm.access !== "RW") fail(ERR.noAccess, i);
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
  return { version: msg.version, community: msg.community, pdu: { type: PDU.RESPONSE, reqId: req.reqId, errStatus, errIndex, varbinds } };
}

/** UDP datagram to the agent port: decode, process, reply. */
export function agentReceive(ctx: SimContext, device: Device, frame: Frame): void {
  const now = ctx.wallNow();
  const rt = ensureAgent(device, now, true);
  const payload = l4Payload(frame);
  if (!payload || !frame.ipv4 || !frame.udp) return;
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
  if (!isAgentDevice(device)) return undefined;
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
  for (const h of cfg.trapHosts ?? []) {
    if (h.version !== "v2c") continue; // unversioned rows are skipped by _build_snmptrap_argv (:766-775)
    sendTrap2(ctx, device, rt, { ip: h.ip, port: h.port, community: h.community || "public" }, vbs, st.oper === "up" ? "linkUp" : "linkDown");
  }
}

