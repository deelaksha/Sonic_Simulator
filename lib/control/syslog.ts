/**
 * Syslog. Daemons report state changes here (BGP neighbour Up/Down, OSPF
 * adjacency changes, teamd port states, VRRP transitions, port oper up/down…);
 * lines are kept per device like /var/log/syslog on SONiC and forwarded to the
 * remote servers of SYSLOG_SERVER / `logging server` by the syslog daemon
 * (lib/protocols/syslog-daemon.ts).
 *
 * Formats (sonic-buildimage files/image_config/rsyslog/rsyslog.conf.j2):
 *   :58 file   SONiCFileFormat "%timegenerated:::date-year% %timegenerated%.%timegenerated:::date-subseconds%
 *              %HOSTNAME% %syslogseverity-text:::uppercase% %syslogtag%%msg:::sp-if-no-1st-sp%%msg:::drop-last-lf%"
 *              → "2026 Nov 19 10:01:02.123456 sonic NOTICE swss#orchagent: :- updatePortOperStatus: …"
 *   :60 remote SONiCForwardFormat "<%PRI%>%TIMESTAMP:::date-rfc3339% %HOSTNAME% %syslogseverity-text:::uppercase%
 *              %syslogtag%%msg…%" → "<166>2026-11-19T10:01:02.123456+00:00 sonic INFO bgp#bgpd[123]: …"
 *   :83-122    one omfwd action per SYSLOG_SERVER row: port default 514, protocol udp, `*.<severity>` filter.
 *
 * Tags: the container's rsyslog prefixes "<container>#" (rsyslog-container.conf.j2). Whether "[pid]" follows
 * depends on the process's openlog(): FRR LOG_PID (lib/zlog_targets.c:374), libdaemon/teamd and net-snmp
 * LOG_PID; swss-common and sonic-py-common Logger (logger.py:28 LOG_NDELAY only) and iccpd (plain syslog())
 * print no pid. Facility: FRR `log facility local4` (docker-fpm-frr/frr/common/daemons.common.conf.j2:11),
 * daemons LOG_DAEMON, everything else LOG_USER.
 */
import { Device } from "../models/device";
import { featureState, peekFeatureState } from "../models/feature-state";
import { cpList } from "../commands/sonic-cli/config-plane";

export type Severity = "EMERG" | "ALERT" | "CRIT" | "ERR" | "WARNING" | "NOTICE" | "INFO" | "DEBUG";
export const SEVERITIES: Severity[] = ["EMERG", "ALERT", "CRIT", "ERR", "WARNING", "NOTICE", "INFO", "DEBUG"];

export const FACILITY = { kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5, lpr: 6, news: 7, uucp: 8, cron: 9, authpriv: 10, ftp: 11, local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23 } as const;

export interface SyslogLine {
  atMs: number;
  severity: Severity;
  /** syslog tag without pid, e.g. "bgp#bgpd", "swss#orchagent", "teamd#teamd_PortChannel1", "admin" */
  program: string;
  message: string;
  facility: number;
  /** printed as "tag[pid]:"; null = the process logs without LOG_PID */
  pid: number | null;
  /** a line received from a remote sender (rsyslog imudp on a host), stored verbatim */
  raw?: string;
}

export interface SyslogState {
  lines: SyslogLine[];
  /** lines at the tail still to be forwarded to remote servers */
  pending?: number;
  /** last seen port / teamd state (the syslog daemon logs their transitions) */
  seen?: { ports: Record<string, string>; teamd: Record<string, string> };
}

const CAP = 2000;

/** Stable fake PID per program (SONiC prints the real one). */
export function fakePid(program: string): number {
  let h = 7;
  for (const c of program) h = (h * 31 + c.charCodeAt(0)) % 9000;
  return 100 + h;
}

function defaults(program: string): { facility: number; pid: number | null } {
  const container = program.includes("#") ? program.split("#")[0] : "";
  if (container === "bgp") return { facility: FACILITY.local4, pid: fakePid(program) };
  if (container === "teamd" || container === "snmp" || container === "lldp") return { facility: FACILITY.daemon, pid: fakePid(program) };
  return { facility: FACILITY.user, pid: null };
}

export interface RemoteServer {
  host: string;
  port: number;
  protocol: string;
  source?: string;
  sourceInterface?: string;
  vrf?: string;
  /** most verbose severity forwarded (rsyslog `*.<severity>`), undefined = `*.*` */
  severity?: Severity;
}

const SEV_ALIASES: Record<string, Severity> = {
  emerg: "EMERG", emergency: "EMERG", panic: "EMERG", alert: "ALERT", crit: "CRIT", critical: "CRIT",
  err: "ERR", error: "ERR", warning: "WARNING", warn: "WARNING", notice: "NOTICE", info: "INFO", informational: "INFO", debug: "DEBUG",
};

export function parseSeverity(s: string | undefined): Severity | undefined {
  return s ? SEV_ALIASES[s.toLowerCase()] : undefined;
}

/**
 * SYSLOG_SERVER rows. `config syslog add` (Click) and KLISH `logging server` write
 * the same list (features.cp_logging.servers).
 */
export function syslogServers(device: Device): RemoteServer[] {
  return cpList(device, "logging", "servers").map((s) => ({
    host: String(s.host),
    port: Number(s.port ?? 514),
    protocol: String(s.protocol ?? "udp").toLowerCase(),
    source: s.source !== undefined ? String(s.source) : undefined,
    sourceInterface: s["source-interface"] !== undefined ? String(s["source-interface"]) : undefined,
    vrf: s.vrf !== undefined ? String(s.vrf) : undefined,
    severity: parseSeverity(s.severity as string | undefined),
  }));
}

/** rsyslog `*.<severity>` selector: this severity and everything more severe. */
export function serverWants(s: RemoteServer, sev: Severity): boolean {
  return !s.severity || SEVERITIES.indexOf(sev) <= SEVERITIES.indexOf(s.severity);
}

/** UDP servers that would receive a line of this severity (TCP/TLS omfwd is not modelled). */
export function forwardTargets(device: Device, sev: Severity): RemoteServer[] {
  return syslogServers(device).filter((s) => s.protocol === "udp" && serverWants(s, sev));
}

function store(device: Device, l: SyslogLine, forward: boolean): void {
  const st = featureState<SyslogState>(device, "syslog", () => ({ lines: [] }));
  // The file is written in arrival order with %timegenerated% (rsyslog.conf.j2:58), so time never goes
  // backwards; daemons ticking later in the same pass report the pass start time.
  const last = st.lines[st.lines.length - 1];
  if (last && l.atMs < last.atMs) l.atMs = last.atMs;
  st.lines.push(l);
  if (forward) st.pending = (st.pending ?? 0) + 1;
  if (st.lines.length > CAP) st.lines.splice(0, st.lines.length - CAP);
  if (st.pending && st.pending > st.lines.length) st.pending = st.lines.length;
}

export function logEvent(
  device: Device,
  atMs: number,
  severity: Severity,
  program: string,
  message: string,
  opts: { facility?: number; pid?: number | null } = {},
): void {
  const d = defaults(program);
  const l: SyslogLine = { atMs, severity, program, message, facility: opts.facility ?? d.facility, pid: opts.pid !== undefined ? opts.pid : d.pid };
  store(device, l, forwardTargets(device, severity).length > 0);
}

/** A line received over UDP/514 (stored as rsyslog writes it; not forwarded again). */
export function logReceived(device: Device, atMs: number, severity: Severity, raw: string): void {
  store(device, { atMs, severity, program: "", message: raw, facility: FACILITY.user, pid: null, raw }, false);
}

export function peekSyslog(device: Device): SyslogState | undefined {
  return peekFeatureState<SyslogState>(device, "syslog");
}

export function clearSyslog(device: Device): void {
  const st = peekSyslog(device);
  if (st) {
    st.lines = [];
    st.pending = 0;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");
const micros = (d: Date) => String(d.getMilliseconds()).padStart(3, "0") + "000";

export const syslogHostname = (device: Device) => device.config.hostname.toLowerCase();

/** RFC 3164 timestamp "Nov  9 10:01:02" (%timegenerated%, day padded with a space). */
export function rfc3164(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** %TIMESTAMP:::date-rfc3339% with microseconds and the local UTC offset. */
export function rfc3339(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const tz = `${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${micros(d)}${tz}`;
}

const tag = (l: SyslogLine) => (l.pid === null ? `${l.program}:` : `${l.program}[${l.pid}]:`);
const msg = (m: string) => (m.startsWith(" ") ? m : ` ${m}`);

/** One /var/log/syslog line (SONiCFileFormat, rsyslog.conf.j2:58). */
export function formatSyslog(device: Device, l: SyslogLine): string {
  if (l.raw !== undefined) return l.raw;
  const d = new Date(l.atMs);
  return `${d.getFullYear()} ${rfc3164(l.atMs)}.${micros(d)} ${syslogHostname(device)} ${l.severity} ${tag(l)}${msg(l.message)}`;
}

/** The datagram payload sent to a remote server (SONiCForwardFormat, rsyslog.conf.j2:60). */
export function formatForward(device: Device, l: SyslogLine): string {
  const pri = l.facility * 8 + SEVERITIES.indexOf(l.severity);
  return `<${pri}>${rfc3339(l.atMs)} ${syslogHostname(device)} ${l.severity} ${tag(l)}${msg(l.message)}`;
}

/** Parsed "<PRI>…" header of a received datagram. */
export function parsePri(text: string): { facility: number; severity: Severity; rest: string } | undefined {
  const m = /^<(\d{1,3})>(.*)$/s.exec(text);
  if (!m) return undefined;
  const pri = Number(m[1]);
  if (pri > 191) return undefined;
  return { facility: pri >> 3, severity: SEVERITIES[pri & 7], rest: m[2] };
}
