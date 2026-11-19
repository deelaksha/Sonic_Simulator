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
import {
  RemoteServer, SyslogState, forwardTargets, formatForward, logEvent, logReceived, parsePri, peekSyslog, rfc3164,
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
  return undefined;
}

function tick(ctx: SimContext, d: Device, now: number): boolean {
  const st = featureState<SyslogState>(d, "syslog", () => ({ lines: [] }));
  if (isSwitch(d.type)) {
    const ports = portSig(d);
    const teamd = teamdSig(d);
    if (st.seen) {
      logPorts(d, now, st.seen.ports, ports);
      logTeamd(d, now, st.seen.teamd, teamd);
    } else {
      logTeamd(d, now, {}, teamd); // teamd started with the lab: log its ports' first transitions
    }
    st.seen = { ports, teamd };
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
