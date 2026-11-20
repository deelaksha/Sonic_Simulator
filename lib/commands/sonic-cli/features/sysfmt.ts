/**
 * Shared helpers for the system / event / QoS-buffer `show` handlers (no
 * registration here): wall-clock formatting in the configured `clock timezone`
 * (the same zone `show clock` uses, features/clock.ts) and KLISH two-word
 * interface parsing ("Ethernet 0" → "Ethernet0"), plus the image name and the
 * sysreadyshow table shared by KLISH `show system status` and Click
 * `show system-health sysready-status`.
 */
import { Device } from "../../../models/device";
import { cpGet } from "../config-plane";
import { featureRows, containerTimes } from "../../../protocols/cpu-features";
import { bootMs } from "../../../protocols/system-resources";

/** build_version of the simulated image (SNMP sysDescr "SONiC.Lab-Simulation", snmp-mib.ts:303). */
export const IMAGE = "SONiC-OS-Lab-Simulation";

export interface WallParts {
  Y: string;
  M: string;
  D: string;
  h: string;
  m: string;
  s: string;
  wd: string;
  mon: string;
  /** "+0000" style offset of the zone at that instant */
  off: string;
  tz: string;
}

export function wallParts(device: Device, ms: number): WallParts {
  const tz = (cpGet(device, "clock")?.timezone as string | undefined) ?? "UTC";
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      second: "2-digit", weekday: "short", hourCycle: "h23",
    }).formatToParts(new Date(ms));
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt(tz);
  } catch {
    parts = fmt("UTC");
  }
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const Y = p("year"), M = p("month"), D = p("day"), h = p("hour") === "24" ? "00" : p("hour"), m = p("minute"), s = p("second");
  const asUtc = Date.UTC(Number(Y), Number(M) - 1, Number(D), Number(h), Number(m), Number(s));
  const offMin = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  const a = Math.abs(offMin);
  const off = `${offMin < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}${String(a % 60).padStart(2, "0")}`;
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(M) - 1];
  return { Y, M, D, h, m, s, wd: p("weekday"), mon, off, tz };
}

/** render_cli datetimeformat(): "%Y-%m-%d %H:%M:%S" + UTC offset. */
export function datetimeformat(device: Device, ms: number): string {
  const w = wallParts(device, ms);
  return `${w.Y}-${w.M}-${w.D} ${w.h}:${w.m}:${w.s}${w.off}`;
}

/** render_cli datetimeformat_rfc3339(): local time with a literal "Z" and milliseconds. */
export function rfc3339ms(device: Device, ms: number): string {
  const w = wallParts(device, ms);
  return `${w.Y}-${w.M}-${w.D}T${w.h}:${w.m}:${w.s}.${String(ms % 1000).padStart(3, "0")}Z`;
}

/** strftime("%a %d %b %Y %I:%M:%S %p") + " " + tz, like `show clock`. */
export function clockString(device: Device, ms: number): string {
  const w = wallParts(device, ms);
  const H = Number(w.h);
  const h12 = String(H % 12 === 0 ? 12 : H % 12).padStart(2, "0");
  return `${w.wd} ${w.D} ${w.mon} ${w.Y} ${h12}:${w.m}:${w.s} ${H < 12 ? "AM" : "PM"} ${w.tz}`;
}

/** render_cli seconds_to_wdhm_str(t, upTime=True): elapsed since t. */
export function wdhm(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  let days = Math.floor(total / 86400);
  const sec = total % 86400;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const weeks = Math.floor(days / 7);
  days %= 7;
  const p = (n: number) => String(n).padStart(2, "0");
  if (weeks) return `${weeks}w${days}d${p(h)}h`;
  if (days) return `${days}d${p(h)}h${p(m)}m`;
  return `${p(h)}:${p(m)}:${p(s)}`;
}

/** KLISH interface argument: "Ethernet 0" / "Ethernet0" / "Eth1/1" → "Ethernet0"; returns name + tokens used. */
export function ifArg(tokens: string[]): { name?: string; used: number } {
  const t0 = tokens[0];
  if (!t0) return { used: 0 };
  if (/^\d+$/.test(tokens[1] ?? "") && /^[A-Za-z-]+$/.test(t0)) return { name: canon(t0) + tokens[1], used: 2 };
  const m = /^([A-Za-z-]+)(\d+(?:\.\d+)?)$/.exec(t0);
  if (m) return { name: canon(m[1]) + m[2], used: 1 };
  return { name: t0, used: 1 };
}

function canon(type: string): string {
  const t = type.toLowerCase();
  if (t === "ethernet" || t === "eth") return "Ethernet";
  if (t === "portchannel" || t === "po") return "PortChannel";
  if (t === "vlan") return "Vlan";
  if (t === "loopback") return "Loopback";
  if (t === "management") return "Management";
  return type;
}

/** python "%-Ns" / str.ljust */
export const L = (v: unknown, w: number) => String(v).padEnd(w);
/** python "%Ns" / str.rjust */
export const R = (v: unknown, w: number) => String(v).padStart(w);

/** sysreadyshow: "System is ready" + tabulate(simple, left) of ALL_SERVICE_STATUS; mode default|brief|detail|core. */
export function showStatus(dev: Device, mode: string): string[] {
  const running = featureRows(dev).filter((f) => f.state === "enabled" || f.state === "always_enabled").map((f) => f.name);
  const CORE = ["database", "swss", "syncd", "bgp", "teamd", "pmon"];
  const host = ["caclmgrd", "featured", "hostcfgd", "procdockerstatsd", "rsyslog"];
  let names = [...running, ...host].sort();
  if (mode === "core") names = names.filter((n) => CORE.includes(n));
  const out = ["System is ready", ""];
  if (mode === "brief") return out;
  const times = containerTimes(dev);
  const boot = bootMs(dev);
  const detail = mode === "detail";
  const hdr = ["Service-Name", "Service-Status", "App-Ready-Status", "Down-Reason", ...(detail ? ["AppStatus-UpdateTime"] : [])];
  const rows = names.map((n) => {
    const w = wallParts(dev, Math.max(boot, times[n]?.startedMs ?? boot) + 60_000);
    return [n, "OK", "OK", "-", ...(detail ? [`${w.Y}-${w.M}-${w.D} ${w.h}:${w.m}:${w.s}`] : [])];
  });
  const wd = hdr.map((h, i) => Math.max(h.length + 2, ...rows.map((r) => r[i].length))); // tabulate MIN_PADDING
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(wd[i])).join("  ").trimEnd();
  return [...out, fmt(hdr), wd.map((n) => "-".repeat(n)).join("  "), ...rows.map(fmt)];
}
