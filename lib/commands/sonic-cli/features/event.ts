/**
 * Event / Alarm — eventd's EVENT and ALARM tables, derived from the box's syslog.
 *
 *   sonic# show event [from <id> [to <id>] | start <t> [end <t>]]   event.xml:26  summary_ev (show_event_summary.j2)
 *   sonic# show event details | id <id>                              event.xml:44,48 show_event_details.j2
 *   sonic# show event recent 5min|60min|24hr | severity <sev>        event.xml:53,58
 *   sonic# show event summary                                        event.xml:63  EVENT_STATS
 *   sonic# show alarm [all|acknowledged|detail|id <id>|recent <i>|severity <s>|summary]
 *                                                                    event.xml:67-112 summary_alarm / ALARM_STATS
 *   sonic# alarm acknowledge|unacknowledge <id>                      event.xml (enable-view exec)
 *
 * On the real box the daemons publish events to eventd, which keeps EVENT_DB
 * and raises/clears alarms. The simulator's daemons log those same state changes
 * to syslog (lib/control/syslog.ts), so each recognised syslog line becomes one
 * event (ids in chronological order); a "raise" event with no later matching
 * "clear" (same type + source) is an active alarm. Recognised lines: port oper
 * changes (orchagent), PortChannel carrier (teamd), BGP/OSPF/OSPFv3 adjacency,
 * VRRP transitions, err-disable/recovery, UDLD unidirectional/bidirectional,
 * IP SLA up/down, link-state-tracking, MCLAG ICCP session, feature start/stop.
 * Severity / action / filter semantics follow sonic-cli-event.py (severity(),
 * recent_interval(), process_cmd_params()) and the templates' column layout.
 */
import { Device } from "../../../models/device";
import { featureState, peekFeatureState } from "../../../models/feature-state";
import { peekSyslog, SyslogLine } from "../../../control/syslog";
import { line, err, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { rfc3339ms, L } from "./sysfmt";

type Sev = "CRITICAL" | "MAJOR" | "MINOR" | "WARNING" | "INFORMATIONAL";

export interface EventRec {
  id: string;
  atMs: number;
  type: string;
  resource: string;
  text: string;
  severity: Sev;
  action: "RAISE" | "CLEAR" | "-";
}

export interface AlarmRec extends EventRec {
  acknowledged: boolean;
  ackMs?: number;
}

type Rule = (l: SyslogLine) => Omit<EventRec, "id" | "atMs"> | undefined | null;

const sevOf = (l: SyslogLine): Sev =>
  l.severity === "EMERG" || l.severity === "ALERT" || l.severity === "CRIT" ? "CRITICAL"
  : l.severity === "ERR" ? "MAJOR"
  : l.severity === "WARNING" ? "WARNING"
  : "INFORMATIONAL";

const RULES: Rule[] = [
  (l) => {
    const m = /updatePortOperStatus: Port (\S+) oper state set from \S+ to (\S+)/.exec(l.message);
    return m && { type: "INTERFACE_OPER_STATUS_CHANGE", resource: m[1], text: `Operational status of interface ${m[1]} changed to ${m[2]}`, severity: "INFORMATIONAL", action: "-" };
  },
  (l) => {
    const m = /^teamd#teamd_(\S+)$/.exec(l.program);
    const c = /carrier changed to (UP|DOWN)/.exec(l.message);
    return m && c ? { type: "PORTCHANNEL_OPER_STATUS_CHANGE", resource: m[1], text: `Operational status of ${m[1]} changed to ${c[1].toLowerCase()}`, severity: "INFORMATIONAL", action: "-" } : undefined;
  },
  (l) => {
    const m = /%ADJCHANGE: neighbor (\S+?)\(.*?\) in vrf (\S+) (Up|Down)/.exec(l.message);
    return m && { type: "BGP_NEIGHBOR_STATE_CHANGE", resource: m[1], text: `BGP neighbor ${m[1]} in vrf ${m[2]} is ${m[3]}`, severity: m[3] === "Down" ? "WARNING" : "INFORMATIONAL", action: "-" };
  },
  (l) => {
    const m = /AdjChg: Nbr (\S+?),? .*?: (\S+) -> (\S+)/.exec(l.message);
    if (!m) return undefined;
    const v3 = l.program.endsWith("ospf6d");
    return { type: v3 ? "OSPFV3_NEIGHBOR_STATE_CHANGE" : "OSPF_NEIGHBOR_STATE_CHANGE", resource: m[1].replace(/\(.*$/, ""), text: `OSPF${v3 ? "v3" : ""} neighbor ${m[1].replace(/\(.*$/, "")} state changed from ${m[2]} to ${m[3]}`, severity: "INFORMATIONAL", action: "-" };
  },
  (l) => {
    const m = /\[VRID (\d+)\] \[(\S+)\] (\S+) -> (\S+)/.exec(l.message);
    return m && { type: "VRRP_STATE_CHANGE", resource: `VRID ${m[1]}`, text: `VRRP ${m[2]} VRID ${m[1]} state changed from ${m[3]} to ${m[4]}`, severity: "INFORMATIONAL", action: "-" };
  },
  (l) => {
    const r = /error detected on (\S+), putting \S+ in err-disable state/.exec(l.message);
    if (r) return { type: "INTERFACE_ERR_DISABLED", resource: r[1], text: l.message, severity: "MAJOR", action: "RAISE" };
    const c = /Attempting to recover from .* err-disable state on (\S+)/.exec(l.message);
    return c ? { type: "INTERFACE_ERR_DISABLED", resource: c[1], text: l.message, severity: "MAJOR", action: "CLEAR" } : undefined;
  },
  (l) => {
    const r = /UDLD unidirectional link detected on (\S+)/.exec(l.message);
    if (r) return { type: "UDLD_UNIDIRECTIONAL", resource: r[1], text: l.message, severity: "MAJOR", action: "RAISE" };
    const c = /UDLD link on (\S+) is bidirectional/.exec(l.message);
    return c ? { type: "UDLD_UNIDIRECTIONAL", resource: c[1], text: l.message, severity: "MAJOR", action: "CLEAR" } : undefined;
  },
  (l) => {
    const m = /IP SLA (\S+) state changed to: (Up|Down)/.exec(l.message);
    return m && { type: "IPSLA_STATE_DOWN", resource: `IP SLA ${m[1]}`, text: l.message, severity: "WARNING", action: m[2] === "Down" ? "RAISE" : "CLEAR" };
  },
  (l) => {
    const m = /Link state tracking group (\S+): (all upstream interfaces down|upstream up)/.exec(l.message);
    return m && { type: "LINK_STATE_TRACKING_DOWN", resource: m[1], text: l.message, severity: "MAJOR", action: m[2] === "upstream up" ? "CLEAR" : "RAISE" };
  },
  (l) => {
    if (!l.program.startsWith("iccpd")) return undefined;
    if (/connection timeout/.test(l.message)) return { type: "MCLAG_SESSION_DOWN", resource: "iccpd", text: "MCLAG ICCP session timed out", severity: "MAJOR", action: "RAISE" };
    return /to OPERATIONAL/.test(l.message) ? { type: "MCLAG_SESSION_DOWN", resource: "iccpd", text: "MCLAG ICCP session is operational", severity: "MAJOR", action: "CLEAR" } : undefined;
  },
  (l) => {
    const m = /^Feature (\S+) is (stopped and disabled|enabled and started)/.exec(l.message);
    return m && { type: "FEATURE_STATE_CHANGE", resource: m[1], text: l.message, severity: sevOf(l), action: "-" };
  },
];

/** EVENT table: one record per recognised syslog line, ids "1", "2", … in time order. */
export function events(device: Device): EventRec[] {
  const out: EventRec[] = [];
  for (const l of peekSyslog(device)?.lines ?? []) {
    if (l.raw !== undefined) continue;
    for (const r of RULES) {
      const e = r(l);
      if (e) {
        out.push({ ...e, id: String(out.length + 1), atMs: l.atMs });
        break;
      }
    }
  }
  return out;
}

type AckStore = Record<string, number>;

/** ALARM table: raised and not (yet) cleared. */
export function alarms(device: Device, evs = events(device)): AlarmRec[] {
  const active = new Map<string, EventRec>();
  for (const e of evs) {
    const key = `${e.type}|${e.resource}`;
    if (e.action === "RAISE") active.set(key, e);
    else if (e.action === "CLEAR") active.delete(key);
  }
  const acks = peekFeatureState<AckStore>(device, "alarm-ack") ?? {};
  return [...active.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((e) => ({ ...e, acknowledged: acks[e.id] !== undefined, ackMs: acks[e.id] }));
}

/** jinja2 truncate(length) with default leeway 5, killwords=False, end "...". */
function truncate(s: string, n: number): string {
  if (s.length <= n + 5) return s;
  const cut = s.slice(0, n - 3);
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut) + "...";
}

function eventSummary(dev: Device, evs: EventRec[]): string[] {
  if (!evs.length) return [];
  const d = "-".repeat(143);
  return [
    d,
    `${L("Id", 12)} ${L("Action", 8)} ${L("Severity", 15)} ${L("Name", 30)} ${L("Source", 15)} ${L("Timestamp", 27)} ${L("Description", 41)}`.trimEnd(),
    d,
    ...evs.map((e) => `${L(e.id, 12)} ${L(truncate(e.action, 7), 8)} ${L(e.severity, 15)} ${L(truncate(e.type, 29), 30)} ${L(truncate(e.resource, 14), 15)} ${L(rfc3339ms(dev, e.atMs), 27)} ${truncate(e.text, 40)}`),
  ];
}

function alarmSummary(dev: Device, als: AlarmRec[]): string[] {
  if (!als.length) return [];
  const d = "-".repeat(145);
  return [
    d,
    `${L("Id", 12)} ${L("Severity", 10)} ${L("Name", 30)} ${L("Source", 15)} ${L("Timestamp", 27)} ${L("Description", 41)}`.trimEnd(),
    d,
    ...als.map((a) => `${L(a.id, 12)} ${L(a.severity, 10)} ${L(truncate(a.type, 29), 30)} ${L(truncate(a.resource, 14), 15)} ${L(rfc3339ms(dev, a.atMs), 27)} ${truncate(a.text, 40)}`),
  ];
}

function eventDetails(dev: Device, evs: EventRec[]): string[] {
  const d = "-".repeat(46);
  return evs.flatMap((e) => [
    d, `Event Details - ${e.id}`, d,
    `${L("Id:", 20)} ${e.id}`, `${L("Action:", 20)} ${e.action}`, `${L("Severity:", 20)} ${e.severity}`, `${L("Type:", 20)} ${e.type}`,
    `${L("Timestamp:", 20)} ${rfc3339ms(dev, e.atMs)}`, `${L("Description:", 20)} ${e.text}`, `${L("Source:", 20)} ${e.resource}`, "",
  ]);
}

function alarmDetails(dev: Device, als: AlarmRec[]): string[] {
  const d = "-".repeat(46);
  return als.flatMap((a) => [
    d, `Alarm Details - ${a.id}`, d,
    `${L("Id:", 20)} ${a.id}`, `${L("Severity:", 20)} ${a.severity}`, `${L("Type:", 20)} ${a.type}`,
    `${L("Timestamp:", 20)} ${rfc3339ms(dev, a.atMs)}`, `${L("Description:", 20)} ${a.text}`, `${L("Source:", 20)} ${a.resource}`,
    `${L("Acknowledged:", 20)} ${a.acknowledged ? "True" : "False"}`,
    `${L("Acknowledged time:", 20)} ${a.ackMs !== undefined ? rfc3339ms(dev, a.ackMs) : "-"}`, "",
  ]);
}

const SEV: Record<string, Sev> = { critical: "CRITICAL", major: "MAJOR", minor: "MINOR", warning: "WARNING" };
const RECENT: Record<string, number> = { "5min": 5 * 60_000, "60min": 60 * 60_000, "24hr": 24 * 3_600_000 };

/** process_cmd_params(): from/to (ids), start/end (times), severity, recent. */
function filtered<T extends EventRec>(recs: T[], k: string[], raw: string[]): T[] {
  const i = (w: string) => k.indexOf(w);
  if (k[1] === "severity") {
    const want = SEV[k[2] ?? ""] ?? "INFORMATIONAL";
    return recs.filter((r) => r.severity === want);
  }
  if (k[1] === "recent") {
    const span = RECENT[k[2] ?? ""] ?? RECENT["5min"];
    return recs.filter((r) => r.atMs >= Date.now() - span);
  }
  if (i("from") >= 0) {
    const lo = Number(raw[i("from") + 1]);
    const hi = i("to") >= 0 ? Number(raw[i("to") + 1]) : Infinity;
    return recs.filter((r) => Number(r.id) >= lo && Number(r.id) <= hi);
  }
  if (i("start") >= 0) {
    const lo = Date.parse(raw[i("start") + 1] ?? "");
    const hi = i("end") >= 0 ? Date.parse(raw[i("end") + 1] ?? "") : Infinity;
    return recs.filter((r) => (Number.isNaN(lo) || r.atMs >= lo) && (Number.isNaN(hi) || r.atMs <= hi));
  }
  return recs;
}

const out = (t: string[]): { output: OutputLine[] } => ({ output: t.map((s) => line(s)) });

registerModal({
  id: "event-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const k = args.map((t) => t.toLowerCase());
    if (k[0] !== "event" && k[0] !== "alarm") return null;
    const dev = ctx.device;
    const evs = events(dev);
    if (k[0] === "event") {
      if (k[1] === "summary") {
        const raised = evs.filter((e) => e.action === "RAISE").length;
        const cleared = evs.filter((e) => e.action === "CLEAR").length;
        const acked = alarms(dev, evs).filter((a) => a.acknowledged).length;
        return out(["Event summary", "-".repeat(33), `${L("Total:", 30)} ${evs.length}`, `${L("Raised:", 30)} ${raised}`, `${L("Acknowledged:", 30)} ${acked}`, `${L("Cleared:", 30)} ${cleared}`, "-".repeat(34)]);
      }
      if (k[1] === "details") return out(eventDetails(dev, evs));
      if (k[1] === "id") return out(eventDetails(dev, evs.filter((e) => e.id === args[2])));
      return out(eventSummary(dev, filtered(evs, k, args)));
    }
    const als = alarms(dev, evs);
    if (k[1] === "summary") {
      const n = (s: Sev) => als.filter((a) => a.severity === s).length;
      return out(["Alarm summary", "-".repeat(33), `${L("Total:", 30)} ${als.length}`, `${L("Critical:", 30)} ${n("CRITICAL")}`, `${L("Major:", 30)} ${n("MAJOR")}`,
        `${L("Minor:", 30)} ${n("MINOR")}`, `${L("Warning:", 30)} ${n("WARNING")}`, `${L("Acknowledged:", 30)} ${als.filter((a) => a.acknowledged).length}`, "-".repeat(34)]);
    }
    if (k[1] === "detail") return out(alarmDetails(dev, als));
    if (k[1] === "id") return out(alarmDetails(dev, als.filter((a) => a.id === args[2])));
    if (k[1] === "all") return out(alarmSummary(dev, als));
    if (k[1] === "acknowledged") return out(alarmSummary(dev, als.filter((a) => a.acknowledged)));
    // get_alarm_filter: acknowledged alarms are skipped (show_event_summary.j2 summary_alarm)
    return out(alarmSummary(dev, filtered(als, k, args).filter((a) => !a.acknowledged)));
  },
});

// enable-view exec: `alarm acknowledge|unacknowledge <id>`
registerModal({
  id: "alarm-ack",
  views: ["enable-view"],
  keywords: ["alarm"],
  run({ args, ctx }) {
    const verb = args[0]?.toLowerCase();
    if ((verb !== "acknowledge" && verb !== "unacknowledge") || !args[1]) return null;
    const dev = ctx.device;
    if (!alarms(dev).some((a) => a.id === args[1])) return { output: [err(`%Error: Alarm id ${args[1]} not found`)] };
    const st = featureState<AckStore>(dev, "alarm-ack", () => ({}));
    if (verb === "acknowledge") st[args[1]] = Date.now();
    else delete st[args[1]];
    return { output: [] };
  },
});
