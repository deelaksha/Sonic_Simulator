/**
 * Interface counters, drop counters and FDB aging — Click commands.
 *
 * Sources (sonic-buildimage/src/sonic-utilities unless noted):
 *   show interfaces counters [-a] [-i <if>] [-p <s>] [-c]   show/interfaces/__init__.py:763-794 → scripts/portstat
 *   show interfaces counters errors|rates|detailed <if>     show/interfaces/__init__.py:797-990 (portstat -e|-R|-l)
 *     headers                                            utilities_common/portstat.py:35-44
 *     STATE U/D/X                                        portstat.py:384-411
 *     BPS/PPS/UTIL formatting                            utilities_common/netstat.py:84-164
 *     cache: "Cleared counters" / "Last cached time was" scripts/portstat:133-157
 *     detailed block                                     portstat.py:538-668
 *   sonic-clear counters                                 clear/main.py:167-171 (portstat -c)
 *   show dropcounters counts [-g] [-t]                   show/dropcounters.py:62-81 → scripts/dropstat
 *   show dropcounters capabilities|configuration [-g]    show/dropcounters.py:16-59 → scripts/dropconfig
 *   config dropcounters install|delete|add-reasons|remove-reasons  config/main.py:7796-7905
 *   sonic-clear dropcounters                             clear/main.py:209-213 (dropstat -c clear)
 *   show mac aging-time                                  show/main.py:1171-1187
 *   show mac count                                       device show tree (click-show-tree.txt:1240); rendered as fdbshow -c
 *   config mac aging_time <s>                            device `config mac` group (not in this sonic-utilities tree)
 *   sonic-clear fdb all                                  clear/main.py:561-571 → scripts/fdbclear:55-56
 *
 * Numbers are printed WITHOUT thousands separators: the target switch's
 * portstat prints raw integers (data/device-capture/show-outputs/
 * show_interfaces_counters.txt), unlike the newer format_number_with_comma.
 *
 * Counter mapping: OK = frames, DRP = port discards from lib/control/drops.ts
 * (every engine drop on that port except CPU-path CoPP/no-listener drops),
 * ERR/OVR = 0 (no PHY errors are modelled). Rates come from the polling daemon
 * (lib/protocols/counters-daemon.ts); N/A until two polls have happened.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule } from "./types";
import { Device } from "../../models/device";
import { NetInterface } from "../../models/interface";
import { peekFeatureState } from "../../models/feature-state";
import { counterPorts, peekCounters, sampleAgo } from "../../protocols/counters-daemon";
import { FDB_AGING_MAX, fdbAgingTime, flushDynamicFdb, setFdbAgingTime } from "../../protocols/macaging-daemon";
import {
  CAPABILITIES,
  COUNTER_TYPES,
  CounterType,
  DebugCounter,
  addCounterReasons,
  debugCounterValue,
  debugCounters,
  deleteDebugCounter,
  dropCheckpoint,
  getDebugCounter,
  portDiscards,
  removeCounterReasons,
  setDropCheckpoint,
  upsertDebugCounter,
} from "../../control/drops";

const NA = "N/A";

/** natsort (natsorted): digit runs compare numerically. */
export function natCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/**
 * python-tabulate tablefmt='simple' (MIN_PADDING 2, two-space column gap, lines
 * right-stripped). Columns whose cells are all numbers (numeric strings too)
 * are right-aligned like numalign='decimal' for integers; text follows `align`.
 */
export function tabulate(headers: string[], rows: (string | number)[][], align: "right" | "left" = "right"): string[] {
  const w = headers.map((h, c) => Math.max(h.length + 2, ...rows.map((r) => String(r[c] ?? "").length)));
  const num = headers.map((_, c) => rows.length > 0 && rows.every((r) => /^-?\d+$/.test(String(r[c] ?? ""))));
  const cell = (v: string | number, c: number) => (align === "right" || num[c] ? String(v).padStart(w[c]) : String(v).padEnd(w[c]));
  return [
    headers.map(cell).join("  ").trimEnd(),
    w.map((n) => "-".repeat(n)).join("  "),
    ...rows.map((r) => r.map((v, c) => cell(v ?? "", c)).join("  ").trimEnd()),
  ];
}

// ---------------------------------------------------------------------------
// portstat
// ---------------------------------------------------------------------------

const H_STD = ["IFACE", "STATE", "RX_OK", "RX_BPS", "RX_UTIL", "RX_ERR", "RX_DRP", "RX_OVR", "TX_OK", "TX_BPS", "TX_UTIL", "TX_ERR", "TX_DRP", "TX_OVR"];
const H_ALL = ["IFACE", "STATE", "RX_OK", "RX_BPS", "RX_PPS", "RX_UTIL", "RX_ERR", "RX_DRP", "RX_OVR", "TX_OK", "TX_BPS", "TX_PPS", "TX_UTIL", "TX_ERR", "TX_DRP", "TX_OVR", "TRIM"];
const H_ERR = ["IFACE", "STATE", "RX_ERR", "RX_DRP", "RX_OVR", "TX_ERR", "TX_DRP", "TX_OVR"];
const H_RATE = ["IFACE", "STATE", "RX_OK", "RX_BPS", "RX_PPS", "RX_UTIL", "TX_OK", "TX_BPS", "TX_PPS", "TX_UTIL"];

const FIELDS = ["rx_ok", "rx_err", "rx_drop", "rx_ovr", "tx_ok", "tx_err", "tx_drop", "tx_ovr", "rx_uca", "rx_mca", "rx_bca", "tx_uca", "tx_mca", "tx_bca"] as const;
type Field = (typeof FIELDS)[number];
type Cnstat = Record<Field, number>;

interface PortstatCache {
  time: string;
  ports: Record<string, Cnstat>;
}

function cnstat(device: Device, i: NetInterface): Cnstat {
  const s = i.statistics;
  const d = portDiscards(device, i.name);
  const rxb = s.rxBroadcast ?? 0;
  const rxm = s.rxMulticast ?? 0;
  const txb = s.txBroadcast ?? 0;
  const txm = s.txMulticast ?? 0;
  return {
    rx_ok: s.rxFrames, rx_err: 0, rx_drop: d.rx, rx_ovr: 0,
    tx_ok: s.txFrames, tx_err: 0, tx_drop: d.tx, tx_ovr: 0,
    rx_uca: Math.max(0, s.rxFrames - rxb - rxm), rx_mca: rxm, rx_bca: rxb,
    tx_uca: Math.max(0, s.txFrames - txb - txm), tx_mca: txm, tx_bca: txb,
  };
}

/** portstat get_port_state: X admin down, U up/up, D up/down. */
export function portState(i: NetInterface): string {
  if (i.adminState === "down") return "X";
  return i.operState === "up" ? "U" : "D";
}

/** netstat.format_brate. */
export function formatBrate(rate: number | undefined): string {
  if (rate === undefined) return NA;
  if (rate > 1000 * 1000 * 10) return `${(rate / 1000 / 1000).toFixed(2)} MB/s`;
  if (rate > 1000 * 10) return `${(rate / 1000).toFixed(2)} KB/s`;
  return `${rate.toFixed(2)} B/s`;
}
const formatPrate = (rate: number | undefined) => (rate === undefined ? NA : `${rate.toFixed(2)}/s`);
/** netstat.format_util: port speed in Mb/s. */
export function formatUtil(brate: number | undefined, speedMbps: number): string {
  if (brate === undefined) return NA;
  return `${((brate / ((speedMbps * 1000 * 1000) / 8)) * 100).toFixed(2)}%`;
}

/** Python datetime.isoformat() of a local wall-clock instant (what json_serial writes). */
function isoLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000`;
}

function portstatCache(device: Device): PortstatCache | undefined {
  return peekFeatureState<PortstatCache>(device, "portstat-cache");
}

/** `portstat -c` (sonic-clear counters): snapshot all ports (or one, KLISH per-interface clear). */
export function clearCounters(device: Device, only?: string): void {
  const prev = portstatCache(device);
  const ports: Record<string, Cnstat> = only && prev ? { ...prev.ports } : {};
  for (const i of counterPorts(device)) if (!only || i.name === only) ports[i.name] = cnstat(device, i);
  (device.config.features ??= {})["portstat-cache"] = { time: isoLocal(Date.now()), ports } satisfies PortstatCache;
}

/** parse_interface_in_filter: "Ethernet4,Ethernet8,Ethernet12-20". */
function parseIntfFilter(spec: string | undefined): string[] | undefined {
  if (!spec) return undefined;
  const out: string[] = [];
  for (const part of spec.split(",")) {
    const m = part.match(/^(\D+)(\d+)-(\d+)$/);
    if (m) for (let n = Number(m[2]); n <= Number(m[3]); n++) out.push(`${m[1]}${n}`);
    else out.push(part);
  }
  return out;
}

export interface PortstatOpts {
  all?: boolean;
  errors?: boolean;
  rates?: boolean;
  intf?: string;
  period?: number;
  /** KLISH `show interface counters` renders the table without the cache banner. */
  noBanner?: boolean;
}

export function renderPortstat(device: Device, o: PortstatOpts = {}): OutputLine[] {
  const ports = counterPorts(device).slice().sort((a, b) => natCompare(a.name, b.name));
  if (!ports.length) return [];
  const filter = parseIntfFilter(o.intf);
  const rates = peekCounters(device)?.ports ?? {};
  const out: OutputLine[] = [];
  let old: Record<string, Partial<Cnstat>> | undefined;
  if (o.period !== undefined && o.period > 0) {
    const now = Date.now();
    const s = sampleAgo(device, now, o.period) ?? peekCounters(device)?.history[0];
    out.push(line(`The rates are calculated within ${o.period} seconds period`));
    old = {};
    for (const [n, [rxOk, rxDrp, txOk, txDrp]] of Object.entries(s?.p ?? {})) old[n] = { rx_ok: rxOk, rx_drop: rxDrp, tx_ok: txOk, tx_drop: txDrp };
    if (!s || s.t > now - o.period * 1000) {
      out.push(muted(`(simulator: counter history covers ${s ? Math.round((now - s.t) / 1000) : 0} s, shown instead of waiting ${o.period} s)`));
    }
  } else {
    const cache = portstatCache(device);
    if (cache) {
      if (!o.noBanner) out.push(line(`Last cached time was ${cache.time}`));
      old = cache.ports;
    }
  }
  const rows: string[][] = [];
  let header = H_STD;
  for (const i of ports) {
    if (filter && !filter.includes(i.name)) continue;
    const c = cnstat(device, i);
    const base = old?.[i.name];
    const v = (f: Field) => String(base ? Math.max(0, c[f] - (base[f] ?? 0)) : c[f]);
    const r = rates[i.name];
    const st = portState(i);
    const rxU = formatUtil(r?.rxBps, i.speed);
    const txU = formatUtil(r?.txBps, i.speed);
    if (o.all) {
      header = H_ALL;
      rows.push([i.name, st, v("rx_ok"), formatBrate(r?.rxBps), formatPrate(r?.rxPps), rxU, v("rx_err"), v("rx_drop"), v("rx_ovr"),
        v("tx_ok"), formatBrate(r?.txBps), formatPrate(r?.txPps), txU, v("tx_err"), v("tx_drop"), v("tx_ovr"), NA]);
    } else if (o.errors) {
      header = H_ERR;
      rows.push([i.name, st, v("rx_err"), v("rx_drop"), v("rx_ovr"), v("tx_err"), v("tx_drop"), v("tx_ovr")]);
    } else if (o.rates) {
      header = H_RATE;
      rows.push([i.name, st, v("rx_ok"), formatBrate(r?.rxBps), formatPrate(r?.rxPps), rxU, v("tx_ok"), formatBrate(r?.txBps), formatPrate(r?.txPps), txU]);
    } else {
      rows.push([i.name, st, v("rx_ok"), formatBrate(r?.rxBps), rxU, v("rx_err"), v("rx_drop"), v("rx_ovr"),
        v("tx_ok"), formatBrate(r?.txBps), txU, v("tx_err"), v("tx_drop"), v("tx_ovr")]);
    }
  }
  if (rows.length) out.push(...tabulate(header, rows).map((t) => line(t)));
  return out;
}

const DOTS = 47;
const lbl = (s: string) => s.padEnd(DOTS, ".") + " ";
const SIZES = ["64", "65-127", "128-255", "256-511", "512-1023", "1024-1518", "1519-2047", "2048-4095", "4096-9216", "9217-16383"];

/** `portstat -l -i <if>` (cnstat_intf_diff_print). Frame-size buckets are not modelled → N/A. */
export function renderDetailed(device: Device, ifName: string): OutputLine[] {
  const i = counterPorts(device).find((p) => p.name === ifName);
  if (!i) return [];
  const cache = portstatCache(device);
  const c = cnstat(device, i);
  const base = cache?.ports[i.name];
  const v = (f: Field) => String(base ? Math.max(0, c[f] - base[f]) : c[f]);
  const L: string[] = [];
  for (const s of SIZES) L.push(lbl(`Packets Received ${s} Octets`) + NA);
  L.push("", lbl("Total Packets Received Without Errors") + v("rx_ok"), lbl("Unicast Packets Received") + v("rx_uca"),
    lbl("Multicast Packets Received") + v("rx_mca"), lbl("Broadcast Packets Received") + v("rx_bca"), "",
    lbl("Jabbers Received") + "0", lbl("Fragments Received") + "0", lbl("Undersize Received") + "0", lbl("Overruns Received") + "0", "");
  for (const s of SIZES) L.push(lbl(`Packets Transmitted ${s} Octets`) + NA);
  L.push("", lbl("Total Packets Transmitted Successfully") + v("tx_ok"), lbl("Unicast Packets Transmitted") + v("tx_uca"),
    lbl("Multicast Packets Transmitted") + v("tx_mca"), lbl("Broadcast Packets Transmitted") + v("tx_bca"),
    lbl("Packets Trimmed") + NA, lbl("Time Since Counters Last Cleared") + (cache?.time ?? "None"));
  return L.map((t) => line(t));
}

function flag(args: string[], ...names: string[]): string | undefined {
  for (let k = 0; k < args.length - 1; k++) if (names.includes(args[k])) return args[k + 1];
  return undefined;
}

function periodArg(args: string[]): number | undefined | null {
  const p = flag(args, "-p", "--period");
  if (p === undefined) return undefined;
  return /^\d+$/.test(p) ? Number(p) : null;
}

function showCounters(args: string[], ctx: CommandContext): CommandResult {
  const sub = args[0];
  const period = periodArg(args);
  if (period === null) return { output: [err(`Error: Invalid value for '-p' / '--period': '${flag(args, "-p", "--period")}' is not a valid integer.`)] };
  if (sub === "errors") return { output: renderPortstat(ctx.device, { errors: true, period }) };
  if (sub === "rates" || sub === "rate") return { output: renderPortstat(ctx.device, { rates: true, period }) };
  if (sub === "detailed") {
    const ifn = args[1];
    if (!ifn || ifn.startsWith("-")) return { output: [line("Usage: show interfaces counters detailed [OPTIONS] <INTERFACE_NAME>"), line(""), err("Error: Missing argument '<INTERFACE_NAME>'.")] };
    return { output: renderDetailed(ctx.device, ifn) };
  }
  if (sub === "rif") return { output: [muted("Router-interface (RIF) counters are not modelled in this simulator.")] };
  if (args.includes("-c") || args.includes("--clear")) {
    clearCounters(ctx.device);
    return { output: [line("Cleared counters")] };
  }
  return {
    output: renderPortstat(ctx.device, {
      all: args.includes("-a") || args.includes("--printall"),
      intf: flag(args, "-i", "--interface"),
      period,
    }),
  };
}

// ---------------------------------------------------------------------------
// dropstat / dropconfig
// ---------------------------------------------------------------------------

const STD_RX = ["SAI_PORT_STAT_IF_IN_ERRORS", "SAI_PORT_STAT_IF_IN_DISCARDS"];
const STD_TX = ["SAI_PORT_STAT_IF_OUT_ERRORS", "SAI_PORT_STAT_IF_OUT_DISCARDS"];
const STD_HDR: Record<string, string> = {
  SAI_PORT_STAT_IF_IN_ERRORS: "RX_ERR",
  SAI_PORT_STAT_IF_IN_DISCARDS: "RX_DROPS",
  SAI_PORT_STAT_IF_OUT_ERRORS: "TX_ERR",
  SAI_PORT_STAT_IF_OUT_DISCARDS: "TX_DROPS",
};

const isPortType = (t?: string) => t === "PORT_INGRESS_DROPS" || t === "PORT_EGRESS_DROPS";
const isSwitchType = (t?: string) => t === "SWITCH_INGRESS_DROPS" || t === "SWITCH_EGRESS_DROPS";

/** dropstat gather_counters: std + configured, filtered by group / type. */
function gather(device: Device, std: string[], level: "port" | "switch", group?: string, type?: string): (string | DebugCounter)[] {
  const cfg = debugCounters(device).filter((c) => (level === "port" ? isPortType(c.type) : isSwitchType(c.type)));
  const all: (string | DebugCounter)[] = [...std, ...cfg];
  return all.filter((c) => {
    if (typeof c === "string") {
      if (group) return false;
      if (!type) return true;
      return (STD_RX.includes(c) && type === "PORT_INGRESS_DROPS") || (STD_TX.includes(c) && type === "PORT_EGRESS_DROPS");
    }
    return (!group || c.group === group) && (!type || c.type === type);
  });
}

const colId = (c: string | DebugCounter) => (typeof c === "string" ? c : `DEBUG:${c.name}`);
const colHdr = (c: string | DebugCounter) => (typeof c === "string" ? STD_HDR[c] : c.alias || c.name);

function portValue(device: Device, port: string, c: string | DebugCounter): number {
  if (typeof c !== "string") return debugCounterValue(device, c, port);
  if (c === "SAI_PORT_STAT_IF_IN_DISCARDS") return portDiscards(device, port).rx;
  if (c === "SAI_PORT_STAT_IF_OUT_DISCARDS") return portDiscards(device, port).tx;
  return 0;
}

const SWITCH_ROW = "__switch__";

export function renderDropstat(device: Device, group?: string, type?: string): OutputLine[] {
  const ckpt = dropCheckpoint(device);
  const out: OutputLine[] = [];
  const ports = counterPorts(device).slice().sort((a, b) => natCompare(a.name, b.name));
  const pc = gather(device, [...STD_RX, ...STD_TX], "port", group, type);
  if (pc.length && ports.length) {
    const rows = ports.map((i) => [i.name, portState(i), ...pc.map((c) => portValue(device, i.name, c) - (ckpt[i.name]?.[colId(c)] ?? 0))]);
    out.push(...tabulate(["IFACE", "STATE", ...pc.map(colHdr)], rows).map((t) => line(t)));
  }
  out.push(line(""));
  const sc = gather(device, [], "switch", group, type) as DebugCounter[];
  if (sc.length) {
    const row = [device.config.hostname || device.name, ...sc.map((c) => debugCounterValue(device, c) - (ckpt[SWITCH_ROW]?.[colId(c)] ?? 0))];
    out.push(...tabulate(["DEVICE", ...sc.map(colHdr)], [row]).map((t) => line(t)));
  }
  return out;
}

/** `dropstat -c clear`. */
export function clearDropcounters(device: Device): OutputLine[] {
  const ckpt: Record<string, Record<string, number>> = {};
  const pc = gather(device, [...STD_RX, ...STD_TX], "port");
  for (const i of counterPorts(device)) {
    ckpt[i.name] = {};
    for (const c of pc) ckpt[i.name][colId(c)] = portValue(device, i.name, c);
  }
  ckpt[SWITCH_ROW] = {};
  for (const c of gather(device, [], "switch") as DebugCounter[]) ckpt[SWITCH_ROW][colId(c)] = debugCounterValue(device, c);
  setDropCheckpoint(device, ckpt);
  return [line("Cleared drop counters")];
}

/** dropconfig print_device_capabilities. */
export function renderDropCapabilities(): OutputLine[] {
  const out = tabulate(["Counter Type", "Total"], COUNTER_TYPES.map((t) => [t, String(CAPABILITIES[t].count)]), "left").map((t) => line(t));
  for (const t of COUNTER_TYPES) {
    out.push(line(""), line(t));
    for (const r of CAPABILITIES[t].reasons) out.push(line(`        ${r}`));
  }
  return out;
}

/** dropconfig print_counter_config. */
export function renderDropConfig(device: Device, group?: string): OutputLine[] {
  const rows: string[][] = [];
  for (const c of [...debugCounters(device)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (group && (c.group ?? "") !== group) continue;
    const reasons = [...c.reasons].sort();
    rows.push([c.name, c.alias || c.name, c.group || "N/A", c.type || "N/A", reasons[0] ?? "None", c.desc === undefined ? "N/A" : c.desc]);
    for (const r of reasons.slice(1)) rows.push(["", "", "", "", r, ""]);
  }
  return tabulate(["Counter", "Alias", "Group", "Type", "Reasons", "Description"], rows, "left").map((t) => line(t));
}

/** dropconfig deserialize_reason_list. */
function reasonList(s: string): string[] {
  const t = s.replace(/ /g, "").replace(/^\[+/, "").replace(/\]+$/, "");
  return t ? t.split(",") : [];
}

/** Split Click args into positionals and `-x value` options. */
function clickArgs(args: string[], valued: string[]): { pos: string[]; opt: Record<string, string> } {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let k = 0; k < args.length; k++) {
    if (valued.includes(args[k]) && k + 1 < args.length) opt[args[k]] = args[++k];
    else if (!args[k].startsWith("-")) pos.push(args[k]);
  }
  return { pos, opt };
}

function installCounter(args: string[], ctx: CommandContext): CommandResult {
  const { pos, opt } = clickArgs(args, ["-a", "--alias", "-g", "--group", "-d", "--desc"]);
  const [name, type, reasonsTok] = pos;
  if (!name || !type || !reasonsTok) {
    const miss = !name ? "COUNTER_NAME" : !type ? "COUNTER_TYPE" : "REASONS";
    return { output: [line("Usage: config dropcounters install [OPTIONS] COUNTER_NAME COUNTER_TYPE REASONS"), line(""), err(`Error: Missing argument '${miss}'.`)] };
  }
  const fail = (m: string) => ({ output: [line(`Encountered error trying to install counter: ${m}`)] });
  const reasons = reasonList(reasonsTok);
  if (!reasons.length) return fail("No drop reasons provided");
  if (getDebugCounter(ctx.device, name)) return fail(`Counter name '${name}' already in use`);
  const cap = CAPABILITIES[type as CounterType];
  if (!cap) return fail("Counter type not supported on this device");
  if (cap.count <= debugCounters(ctx.device).length) return fail("All counters of this type are currently in use");
  if (!reasons.every((r) => (cap.reasons as string[]).includes(r))) return fail("One or more provided drop reason not supported on this device");
  const alias = opt["-a"] ?? opt["--alias"];
  const group = opt["-g"] ?? opt["--group"];
  const desc = opt["-d"] ?? opt["--desc"];
  upsertDebugCounter(ctx.device, name, { type, reasons, ...(alias ? { alias } : {}), ...(group ? { group } : {}), ...(desc !== undefined ? { desc } : {}) });
  return { output: [] };
}

function reasonsCmd(kind: "add" | "remove", args: string[], ctx: CommandContext): CommandResult {
  const [name, reasonsTok] = args.filter((a) => !a.startsWith("-"));
  const what = kind === "add" ? "add reasons" : "remove reasons";
  if (!name || !reasonsTok) {
    return { output: [line(`Usage: config dropcounters ${kind}-reasons [OPTIONS] COUNTER_NAME REASONS`), line(""), err(`Error: Missing argument '${!name ? "COUNTER_NAME" : "REASONS"}'.`)] };
  }
  const fail = (m: string) => ({ output: [line(`Encountered error trying to ${what}: ${m}`)] });
  const reasons = reasonList(reasonsTok);
  if (!reasons.length) return fail("No drop reasons provided");
  const c = getDebugCounter(ctx.device, name);
  if (!c) return fail(`Counter '${name}' not found`);
  if (kind === "add") {
    const cap = CAPABILITIES[c.type as CounterType];
    if (!cap) return fail("No drop reasons found for this device");
    if (!reasons.every((r) => (cap.reasons as string[]).includes(r))) return fail("One or more provided drop reason not supported on this device");
    addCounterReasons(ctx.device, name, reasons);
  } else removeCounterReasons(ctx.device, name, reasons);
  return { output: [] };
}

// ---------------------------------------------------------------------------
// FDB aging
// ---------------------------------------------------------------------------

/** show/main.py aging_time: APPL_DB SWITCH_TABLE:switch fdb_aging_time. */
export function renderMacAgingTime(device: Device): OutputLine[] {
  return [line(`Aging time for switch is ${fdbAgingTime(device)} seconds`)];
}

export function setAgingTimeChecked(device: Device, tok: string | undefined): OutputLine[] | null {
  if (tok === undefined || !/^\d+$/.test(tok) || Number(tok) > FDB_AGING_MAX) return null;
  setFdbAgingTime(device, Number(tok));
  return [];
}

export function sonicClearFdbAll(device: Device): OutputLine[] {
  flushDynamicFdb(device);
  return [line("FDB entries are cleared.")];
}

// ---------------------------------------------------------------------------

const show: SonicCmd[] = [
  { path: ["interfaces", "counters"], summary: "Show interface counters (portstat)", run: showCounters },
  {
    path: ["dropcounters", "counts"],
    summary: "Show drop counts (dropstat)",
    run: (a, ctx) => ({ output: renderDropstat(ctx.device, flag(a, "-g", "--group"), flag(a, "-t", "--counter_type")) }),
  },
  { path: ["dropcounters", "capabilities"], summary: "Show device drop counter capabilities", run: () => ({ output: renderDropCapabilities() }) },
  {
    path: ["dropcounters", "configuration"],
    summary: "Show current drop counter configuration",
    run: (a, ctx) => ({ output: renderDropConfig(ctx.device, flag(a, "-g", "--group")) }),
  },
  { path: ["mac", "aging-time"], summary: "Show MAC Aging-Time", run: (_a, ctx) => ({ output: renderMacAgingTime(ctx.device) }) },
  {
    path: ["mac", "count"],
    summary: "Show MAC count",
    run: (_a, ctx) => ({ output: [line(`Total number of entries ${ctx.device.macTable.length}`)] }),
  },
];

const config: SonicCmd[] = [
  { path: ["dropcounters", "install"], summary: "Install a new drop counter", run: installCounter },
  {
    path: ["dropcounters", "delete"],
    summary: "Delete an existing drop counter",
    run(args, ctx): CommandResult {
      const name = args.find((a) => !a.startsWith("-"));
      if (!name) return { output: [line("Usage: config dropcounters delete [OPTIONS] COUNTER_NAME"), line(""), err("Error: Missing argument 'COUNTER_NAME'.")] };
      if (!getDebugCounter(ctx.device, name)) return { output: [line(`Encountered error trying to uninstall counter: Counter '${name}' not found`)] };
      deleteDebugCounter(ctx.device, name);
      return { output: [] };
    },
  },
  { path: ["dropcounters", "add-reasons"], summary: "Add reasons to an existing drop counter", run: (a, ctx) => reasonsCmd("add", a, ctx) },
  { path: ["dropcounters", "remove-reasons"], summary: "Remove reasons from an existing drop counter", run: (a, ctx) => reasonsCmd("remove", a, ctx) },
  {
    path: ["mac", "aging_time"],
    summary: "Set MAC aging time in seconds (0 disables aging)",
    run(args, ctx): CommandResult {
      const r = setAgingTimeChecked(ctx.device, args[0]);
      if (r) return { output: r };
      if (args[0] === undefined) return { output: [line("Usage: config mac aging_time [OPTIONS] <interval>"), line(""), err("Error: Missing argument '<interval>'.")] };
      return { output: [err(`Error: Invalid value for '<interval>': '${args[0]}' is not in the range 0<=x<=${FDB_AGING_MAX}.`)] };
    },
  },
];

export const countersModule: SonicFeatureModule = { id: "counters", config, show };
