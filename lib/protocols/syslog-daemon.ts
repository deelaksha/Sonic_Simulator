/**
 * syslog daemon — the parts of SONiC's logging pipeline that are not a
 * protocol daemon's own log call:
 *
 *  1. Port transitions (switches). The store mutates interfaces directly
 *     (cable cut, `config interface shutdown`), so transitions are detected
 *     here by comparing with the last seen state and logged the way swss does:
 *       portmgrd  "Configure Ethernet0 admin status to down"         sonic-swss/cfgmgr/portmgr.cpp:238 (doTask)
 *       orchagent "Port Ethernet0 oper state set from up to down"    sonic-swss/orchagent/portsorch.cpp:8972
 *                 "Set operation status DOWN to host interface Ethernet0"            portsorch.cpp:3566
 *     (SWSS_LOG_NOTICE prefixes ":- <function>: ", sonic-swss-common/common/logger.h:19.)
 *  2. teamd port state / carrier (libteam teamd_runner_lacp.c:1483 `%s: Changed port state:
 *     "%s" -> "%s"` and :759 `carrier changed to UP|DOWN`, LOG_INFO), observed from the lacp
 *     daemon's runtime because its state machine has no device handle at the transition.
 *  2b. Config changes (switches), detected the same way from the CONFIG_DB/APPL_DB rows the
 *     applying daemon consumes, worded as that daemon logs them at its default level
 *     (swss NOTICE; INFO lines are not written):
 *       featured  "Running cmd: '['sudo', 'systemctl', 'stop', 'snmp.service']'" ... "Feature snmp is
 *                 stopped and disabled" / "... is enabled and started"   sonic-host-services
 *                 scripts/featured:268-274 (update_feature_state), :403-455 (enable/disable_feature;
 *                 run_cmd's "Output: …" lines are not reproduced)
 *       orchagent port speed  "Set port Ethernet0 speed to 100000"        portsorch.cpp:4647-4650 (doPortTask)
 *                 ACL  "Created ACL table T oid:7…" (aclorch.cpp:4945 addAclTable) + implicit deny-all
 *                      on L3/L3V6 (:4784-4801 addDefaultDenyRule, via AclTable::add :3103),
 *                      "Successfully updated existing ACL table T" (:5661 doAclTableTask),
 *                      "Successfully deleted ACL table T" (:5082 removeAclTable),
 *                      "Successfully created|deleted ACL rule R in table T" (:3095-3125 AclTable::add/remove;
 *                      a changed rule is deleted and re-created, :3085-3105)
 *                 CoPP (APPL_DB COPP_TABLE from coppmgrd) "Create host interface trap group G" (copporch.cpp:791),
 *                      "Set trap group G to host interface" (:772), "Create policer for trap group G" /
 *                      "Bind policer to trap group G:" (:615/:652 createPolicer), "Creating policer for
 *                      existing Trap group: <oid> (name:G)." (:1309 WARN), "Remove policer for trap group G" (:574)
 *                 QoS  "Created [DSCP_TO_TC_MAP:M]" / "Set [...]" (qosorch.cpp:156/169 processWorkItem; also
 *                      TC_TO_QUEUE_MAP, WRED_PROFILE), "Created [SCHEDULER:P@q]" (:1470 handleSchedulerTable),
 *                      "Applied QoS maps to ports" (:2221 handlePortQosMapTable)
 *     Lab presets are boot configuration: the first tick only records them.
 *  3. Remote forwarding: each new line whose severity passes a SYSLOG_SERVER row's filter is
 *     sent as one UDP datagram (rsyslog omfwd, rsyslog.conf.j2:83-122; SONiCForwardFormat :60)
 *     to <server>:<port|514> from the configured source, else the egress interface address.
 *  4. Receiving (hosts only): a datagram to UDP/514 on a PC/server is written to that host's
 *     log the way a Debian rsyslog (imudp + RSYSLOG_TraditionalFileFormat) stores it:
 *     "Nov 19 10:01:02 <sender-hostname> <rest of message>", visible with `show logging`.
 *  tcpdump: print-syslog.c style "SYSLOG local4.info, length: N" (-v adds Facility/Severity/Msg).
 *
 * Not modelled: TCP/TLS forwarding, VRF-bound (mgmt) servers, rate limiting, message-type filters.
 */
import { registerDaemon } from "../control/daemon";
import { l4Payload, sendIpv4 } from "../control/packet";
import { Device, interfaceByName, findInterface, isHost, isSwitch } from "../models/device";
import { primaryIpv4 } from "../models/interface";
import { longestPrefixMatch } from "../models/route";
import { featureState } from "../models/feature-state";
import { isValidIpv4 } from "../models/ip";
import { SimContext } from "../engine/context";
import { Frame } from "../models/packet";
import { lacpRuntime } from "./lacp-daemon";
import { featureRows } from "./cpu-features";
import { projectAcl } from "../sonicdb/config-db";
import { projectQosConfig, projectCoppAppl } from "../sonicdb/qos-copp-db";
import { Tables } from "../sonicdb/schema";
import {
  RemoteServer, Severity, SyslogState, forwardTargets, formatForward, logEvent, logReceived, parsePri, peekSyslog, rfc3164,
} from "../control/syslog";

export const SYSLOG_PORT = 514;

const frontPanel = (d: Device) => d.interfaces.filter((i) => !i.management && !i.logical && /^Ethernet\d+$/.test(i.name));

function portSig(d: Device): Record<string, string> {
  const r: Record<string, string> = {};
  for (const i of frontPanel(d)) r[i.name] = `${i.adminState}|${i.operState}`;
  return r;
}

function teamdSig(d: Device): Record<string, string> {
  const r: Record<string, string> = {};
  for (const [lag, lr] of Object.entries(lacpRuntime(d)?.lags ?? {})) {
    r[lag] = lr.carrier ? "UP" : "DOWN";
    for (const [m, p] of Object.entries(lr.ports)) r[`${lag}|${m}`] = p.state;
  }
  return r;
}

const same = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

function logPorts(d: Device, now: number, prev: Record<string, string>, cur: Record<string, string>): void {
  for (const [name, s] of Object.entries(cur)) {
    const was = prev[name];
    if (!was || was === s) continue;
    const [pa, po] = was.split("|");
    const [ca, co] = s.split("|");
    if (pa !== ca) logEvent(d, now, "NOTICE", "swss#portmgrd", `:- doTask: Configure ${name} admin status to ${ca}`);
    if (po !== co) {
      logEvent(d, now, "NOTICE", "swss#orchagent", `:- updatePortOperStatus: Port ${name} oper state set from ${po} to ${co}`);
      logEvent(d, now, "NOTICE", "swss#orchagent", `:- setHostIntfsOperStatus: Set operation status ${co.toUpperCase()} to host interface ${name}`);
    }
  }
}

function logTeamd(d: Device, now: number, prev: Record<string, string>, cur: Record<string, string>): void {
  // Member ports first (their state drives the carrier), then the carrier.
  for (const [k, s] of Object.entries(cur)) {
    if (!k.includes("|")) continue;
    const [lag, member] = k.split("|");
    const was = prev[k] ?? "disabled"; // a new member starts DISABLED (lacp_port_added)
    if (was === s) continue;
    // Several changes inside one tick: link up always enters EXPIRED (:1487-1514) and CURRENT
    // times out via EXPIRED (:1734-1754), so put back the step that was not observed.
    const via = (was === "disabled" && s !== "expired") || (was === "current" && s === "defaulted") ? ["expired"] : [];
    const path = [was, ...via, s];
    for (let i = 1; i < path.length; i++) logEvent(d, now, "INFO", `teamd#teamd_${lag}`, `${member}: Changed port state: "${path[i - 1]}" -> "${path[i]}"`);
  }
  for (const [k, s] of Object.entries(cur)) {
    if (k.includes("|")) continue;
    if ((prev[k] ?? "DOWN") !== s) logEvent(d, now, "INFO", `teamd#teamd_${k}`, `carrier changed to ${s}`);
  }
}

/** Config rows whose changes the applying daemons log: "<TABLE>|<key>" → serialized row. */
function cfgSig(d: Device): Record<string, string> {
  const t: Tables = {};
  projectAcl(d, t);
  projectQosConfig(d, t);
  projectCoppAppl(d, t);
  const r: Record<string, string> = {};
  for (const [tb, rows] of Object.entries(t)) for (const [k, row] of Object.entries(rows)) r[`${tb}|${k}`] = JSON.stringify(row);
  for (const p of frontPanel(d)) r[`SPEED|${p.name}`] = JSON.stringify(p.speed);
  for (const f of featureRows(d)) r[`FEATURE|${f.name}`] = JSON.stringify(f.state);
  return r;
}

const hexId = (type: number, name: string) => {
  let h = 7;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 0xffffff;
  return `${type.toString(16)}${h.toString(16).padStart(12, "0")}`; // PRIx64 of a virtual OID
};

function logConfig(d: Device, now: number, prev: Record<string, string>, cur: Record<string, string>): void {
  const O = (fn: string, msg: string, sev: Severity = "NOTICE") => logEvent(d, now, sev, "swss#orchagent", `:- ${fn}: ${msg}`);
  const of = (sig: Record<string, string>, table: string) =>
    new Map(Object.entries(sig).filter(([k]) => k.startsWith(`${table}|`)).map(([k, v]) => [k.slice(table.length + 1), v]));
  const diff = (table: string) => {
    const a = of(prev, table);
    const b = of(cur, table);
    return {
      added: [...b.keys()].filter((k) => !a.has(k)),
      removed: [...a.keys()].filter((k) => !b.has(k)),
      changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)),
      was: (k: string) => JSON.parse(a.get(k) ?? "{}"),
      now: (k: string) => JSON.parse(b.get(k) ?? "{}"),
    };
  };

  // featured (python syslog, no openlog: ident "featured", LOG_INFO)
  const feat = diff("FEATURE");
  for (const name of feat.changed) {
    const [was, is] = [String(feat.was(name)), String(feat.now(name))];
    if (!["enabled", "disabled"].includes(was) || !["enabled", "disabled"].includes(is)) continue;
    const unit = `${name}.service`;
    const cmds = is === "disabled" ? ["stop", "disable", "mask"] : ["unmask", "enable", "start"];
    for (const c of cmds) logEvent(d, now, "INFO", "featured", `Running cmd: '['sudo', 'systemctl', '${c}', '${unit}']'`);
    logEvent(d, now, "INFO", "featured", is === "disabled" ? `Feature ${name} is stopped and disabled` : `Feature ${name} is enabled and started`);
  }

  const speed = diff("SPEED");
  for (const p of speed.changed) O("doPortTask", `Set port ${p} speed to ${speed.now(p)}`);

  // ACL: rule deletes, table deletes, table creates/updates, rule creates
  const tables = diff("ACL_TABLE");
  const rules = diff("ACL_RULE");
  const split = (k: string) => [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
  for (const k of [...rules.removed, ...rules.changed]) {
    const [tb, r] = split(k);
    O("remove", `Successfully deleted ACL rule ${r} in table ${tb}`);
  }
  for (const tb of tables.removed) O("removeAclTable", `Successfully deleted ACL table ${tb}`);
  const created = (tb: string, type: string) => {
    O("addAclTable", `Created ACL table ${tb} oid:${hexId(0x7, tb)}`);
    const ip = type === "L3" ? "IPV4ANY" : type === "L3V6" ? "IPV6ANY" : undefined;
    if (!ip) return;
    O("add", `Successfully created ACL rule DEFAULT_DROP_ANY in table ${tb}`);
    O("addDefaultDenyRule", `Added implicit deny-all rule DEFAULT_DROP_ANY (${ip}) to ACL table ${tb}`);
  };
  for (const tb of tables.added) created(tb, tables.now(tb).type);
  for (const tb of tables.changed) {
    const [w, n] = [tables.was(tb), tables.now(tb)];
    if (w.type !== n.type || w.stage !== n.stage) {
      O("removeAclTable", `Successfully deleted ACL table ${tb}`);
      created(tb, n.type);
    } else O("doAclTableTask", `Successfully updated existing ACL table ${tb}`);
  }
  for (const k of [...rules.added, ...rules.changed]) {
    const [tb, r] = split(k);
    O("add", `Successfully created ACL rule ${r} in table ${tb}`);
  }

  // CoPP: APPL_DB COPP_TABLE as coppmgrd pushes it to copporch
  const copp = diff("COPP_TABLE");
  for (const g of copp.removed) if (copp.was(g).cir !== undefined) O("removePolicer", `Remove policer for trap group ${g}`);
  const policer = (g: string) => {
    O("createPolicer", `Create policer for trap group ${g}`);
    O("createPolicer", `Bind policer to trap group ${g}:`);
  };
  for (const g of copp.added) {
    O("processCoppRule", `Create host interface trap group ${g}`);
    if (copp.now(g).cir !== undefined) policer(g);
  }
  for (const g of copp.changed) {
    const [w, n] = [copp.was(g), copp.now(g)];
    const { trap_ids: _a, ...wf } = w;
    const { trap_ids: _b, ...nf } = n;
    if (JSON.stringify(wf) === JSON.stringify(nf)) continue; // only the trap id list moved
    if (n.queue !== undefined) O("processCoppRule", `Set trap group ${g} to host interface`);
    if (n.cir !== undefined && w.cir === undefined) {
      O("trapGroupUpdatePolicer", `Creating policer for existing Trap group: ${hexId(0x11, g)} (name:${g}).`, "WARNING");
      policer(g);
    }
  }

  // QoS (qosorch reads CONFIG_DB)
  for (const table of ["DSCP_TO_TC_MAP", "TC_TO_QUEUE_MAP", "WRED_PROFILE"]) {
    const m = diff(table);
    for (const k of m.added) O("processWorkItem", `Created [${table}:${k}]`);
    for (const k of m.changed) O("processWorkItem", `Set [${table}:${k}]`);
  }
  for (const k of diff("SCHEDULER").added) O("handleSchedulerTable", `Created [SCHEDULER:${k}]`);
  const pqm = diff("PORT_QOS_MAP");
  if (pqm.added.length || pqm.changed.length) O("handlePortQosMapTable", "Applied QoS maps to ports");
}

/** rsyslog binds one ephemeral UDP port for omfwd. */
function sourcePort(d: Device): number {
  let h = 17;
  for (const c of d.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 32768 + (h % 28232);
}

function sourceIp(d: Device, s: RemoteServer): string | undefined {
  if (s.source) return s.source;
  if (s.sourceInterface) {
    const i = interfaceByName(d, s.sourceInterface);
    return i ? primaryIpv4(i)?.address : undefined;
  }
  const m = longestPrefixMatch(d.routingTable, s.host);
  const egress = m ? findInterface(d, m.route.interfaceId) : undefined;
  return egress ? primaryIpv4(egress)?.address : undefined;
}

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));

function forward(ctx: SimContext, d: Device, st: SyslogState): void {
  const n = Math.min(st.pending ?? 0, st.lines.length);
  st.pending = 0;
  for (const l of st.lines.slice(st.lines.length - n)) {
    for (const s of forwardTargets(d, l.severity)) {
      if (!isValidIpv4(s.host)) continue; // IPv6 servers: not modelled
      const src = sourceIp(d, s);
      if (!src) continue; // no route: rsyslog's sendto fails (ENETUNREACH)
      const text = formatForward(d, l);
      const payload = utf8(text + "\n"); // the template ends with "\n"
      sendIpv4(ctx, d, { src, dst: s.host, udp: { sport: sourcePort(d), dport: s.port }, payload, summary: `Syslog ${text.slice(0, 60)}` });
    }
  }
}

function nextDue(d: Device, now: number): number | undefined {
  const st = peekSyslog(d);
  if (st?.pending) return now;
  if (!isSwitch(d.type)) return undefined;
  if (!st?.seen) return now;
  if (!same(st.seen.ports, portSig(d)) || !same(st.seen.teamd, teamdSig(d))) return now;
  if (!st.seen.cfg || !same(st.seen.cfg, cfgSig(d))) return now;
  return undefined;
}

function tick(ctx: SimContext, d: Device, now: number): boolean {
  const st = featureState<SyslogState>(d, "syslog", () => ({ lines: [] }));
  if (isSwitch(d.type)) {
    const ports = portSig(d);
    const teamd = teamdSig(d);
    const cfg = cfgSig(d);
    if (st.seen) {
      logPorts(d, now, st.seen.ports, ports);
      logTeamd(d, now, st.seen.teamd, teamd);
      if (st.seen.cfg) logConfig(d, now, st.seen.cfg, cfg);
    } else {
      logTeamd(d, now, {}, teamd); // teamd started with the lab: log its ports' first transitions
    }
    st.seen = { ports, teamd, cfg };
  }
  if (st.pending) forward(ctx, d, st);
  return true;
}

const SEV_NAMES = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"];
const FAC_NAMES = ["kernel", "user", "mail", "daemon", "auth", "syslog", "lpr", "news", "uucp", "cron", "authpriv", "ftp", "ntp", "security", "console", "cron", "local0", "local1", "local2", "local3", "local4", "local5", "local6", "local7"];

const isSyslog = (f: Frame) => !!f.ipv4 && !!f.udp && (f.udp.dstPort === SYSLOG_PORT || f.udp.srcPort === SYSLOG_PORT) && !!f.rawL3;

registerDaemon({
  id: "syslog",
  nextDue,
  tick,
  receiveL3(ctx, device, _ingress, frame) {
    if (!isHost(device.type) || !frame.udp || frame.udp.dstPort !== SYSLOG_PORT || !frame.rawL3) return false;
    if (!device.interfaces.some((i) => i.ipv4.some((a) => a.address === frame.ipv4!.dstIp))) return false;
    const text = new TextDecoder().decode(l4Payload(frame) ?? new Uint8Array()).replace(/\n$/, "");
    const p = parsePri(text);
    if (!p) return true;
    // RFC 3339 timestamp + HOSTNAME, then the rest (SONiC puts the severity text first).
    const m = /^(\S+) (\S+) (.*)$/s.exec(p.rest);
    const ts = m ? Date.parse(m[1]) : NaN;
    const at = Number.isNaN(ts) ? ctx.wallNow() : ts;
    const raw = m ? `${rfc3164(at)} ${m[2]} ${m[3]}` : `${rfc3164(at)} ${frame.ipv4!.srcIp} ${p.rest}`;
    logReceived(device, ctx.wallNow(), p.severity, raw);
    return true;
  },
  describe(frame, verbose) {
    if (!isSyslog(frame)) return undefined;
    const body = l4Payload(frame) ?? new Uint8Array();
    const text = new TextDecoder().decode(body);
    const p = parsePri(text);
    if (!p) return `SYSLOG, length: ${body.length}`;
    const fac = FAC_NAMES[p.facility] ?? `unknown (${p.facility})`;
    const sevNum = ["EMERG", "ALERT", "CRIT", "ERR", "WARNING", "NOTICE", "INFO", "DEBUG"].indexOf(p.severity);
    const sev = SEV_NAMES[sevNum];
    if (!verbose) return `SYSLOG ${fac}.${sev}, length: ${body.length}`;
    return `SYSLOG, length: ${body.length}\n\tFacility ${fac} (${p.facility}), Severity ${sev} (${sevNum})\n\tMsg: ${p.rest.replace(/\n$/, "")}`;
  },
});
