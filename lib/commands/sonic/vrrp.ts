/**
 * VRRP SONiC feature module (Click). Commands write the per-device CONFIG_DB
 * model (features.vrrp.instances); the running protocol (FRR vrrpd model,
 * lib/protocols/vrrp-daemon.ts) picks changes up on its next tick, and `show`
 * renders the daemon's LIVE state.
 *
 * Click config — sonic-utilities config/main.py:6510-6790 ('config interface vrrp ...'):
 *   config interface vrrp add <if> <vrid>
 *   config interface vrrp remove <if> <vrid>
 *   config interface vrrp ip add <if> <vrid> <ip>       (creates the instance if needed)
 *   config interface vrrp ip remove <if> <vrid> <ip>
 *   config interface vrrp priority <if> <vrid> <1-254>
 *   config interface vrrp adv_interval <if> <vrid> <1-255>   (seconds)
 *   config interface vrrp pre_empt <if> <vrid> <enabled|disabled>
 *   config interface vrrp version <if> <vrid> <2|3>
 * Legacy simulator forms kept: config vrrp add|vip|priority|version|preempt|del.
 *
 * Click show — sonic-utilities show/main.py:1207-1252, each a `vtysh -c "show vrrp ..."`
 * rendered by FRR vrrpd (vrrp_vty.c:487-720):
 *   show vrrp                       FRR detail block per instance
 *   show vrrp interface <if> [vrid] (filtered)
 *   show vrrp vrid <vrid>
 *   show vrrp summary               FRR summary table
 *
 * KLISH `show vrrp` (sonic-mgmt-framework CLI/renderer/templates/show_vrrp_brief.j2 etc.)
 * is rendered by renderKlishShow() and registered from
 * lib/commands/sonic-cli/features/vrrp-show.ts.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { Device, interfaceByName } from "../../models/device";
import { isValidIpv4 } from "../../models/ip";
import { primaryIpv4 } from "../../models/interface";
import {
  VrrpInstance, VrrpConfig, VRRP_DEFAULTS, runtimeOf, fsmState, effectivePriority, vrrpTimers, vrrpMac,
  versionOf, preemptOf, priorityOf,
} from "../../protocols/vrrp";

const VRID = { min: 1, max: 255 };
const PRIORITY = { min: 1, max: 254 };
const VERSION = { min: 2, max: 3 };
const ADV_S = { min: 1, max: 255 }; // config/main.py adv_interval IntRange(1, 255)

function state(device: Device): VrrpConfig {
  return featureState<VrrpConfig>(device, "vrrp", () => ({ instances: [] as VrrpInstance[] }));
}

function parseInt10(tok: string | undefined): number | null {
  if (tok === undefined || tok.trim() === "") return null;
  const n = Number(tok);
  return Number.isInteger(n) ? n : null;
}

function parseVrid(tok: string | undefined): { vrid: number } | { error: OutputLine } {
  const n = parseInt10(tok);
  if (n === null || n < VRID.min || n > VRID.max) return { error: err(`VRID must be ${VRID.min}-${VRID.max} (got '${tok}')`) };
  return { vrid: n };
}

function findInstance(st: VrrpConfig, iface: string, vrid: number): VrrpInstance | undefined {
  return st.instances.find((i) => i.iface === iface && i.vrid === vrid);
}

function parsePreempt(tok: string | undefined): boolean | null {
  const t = (tok ?? "").toLowerCase();
  if (t === "enable" || t === "enabled" || t === "on") return true;
  if (t === "disable" || t === "disabled" || t === "off") return false;
  return null;
}

/** KLISH `[no] shutdown` in the VRRP sub-mode (FRR `vrrp <vrid> shutdown`; no Click equivalent). */
export function setVrrpShutdown(device: Device, iface: string, vrid: number, on: boolean): OutputLine[] {
  const inst = findInstance(state(device), iface, vrid);
  if (!inst) return [err(`% VRRP ${vrid} not configured on ${iface}`)];
  inst.shutdown = on || undefined;
  return [];
}

type Setter = (inst: VrrpInstance, value: string | undefined) => OutputLine | string;

/** A `<cmd> <if> <vrid> <value>` sub-command operating on an existing instance. */
function instanceCmd(path: string[], usage: string, set: Setter): SonicCmd {
  const name = `config ${path.join(" ")}`;
  return {
    path,
    summary: `${usage}`,
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      if (!iface) return { output: [err(`Usage: ${name} ${usage}`)] };
      const v = parseVrid(pos[1]);
      if ("error" in v) return { output: [v.error] };
      const inst = findInstance(state(ctx.device), iface, v.vrid);
      if (!inst) return { output: [err(`${name}: VRRP ${v.vrid} not configured on ${iface}`)] };
      const r = set(inst, pos[2]);
      return { output: [typeof r === "string" ? muted(`VRRP ${v.vrid} on ${iface} ${r}`) : r] };
    },
  };
}

function addCmd(path: string[]): SonicCmd {
  return {
    path,
    summary: "Create a VRRP instance on an interface (<if> <vrid>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      if (!iface) return { output: [err(`Usage: config ${path.join(" ")} <iface> <vrid>`)] };
      if (!interfaceByName(ctx.device, iface)) return { output: [err(`config vrrp add: interface ${iface} not found`)] };
      const v = parseVrid(pos[1]);
      if ("error" in v) return { output: [v.error] };
      const st = state(ctx.device);
      if (findInstance(st, iface, v.vrid)) return { output: [muted(`VRRP ${v.vrid} already configured on ${iface} (no-op)`)] };
      st.instances.push({ iface, vrid: v.vrid });
      return { output: [muted(`VRRP ${v.vrid} created on ${iface}`)] };
    },
  };
}

function delCmd(path: string[]): SonicCmd {
  return {
    path,
    summary: "Delete a VRRP instance (<if> <vrid>)",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const iface = pos[0];
      if (!iface) return { output: [err(`Usage: config ${path.join(" ")} <iface> <vrid>`)] };
      const v = parseVrid(pos[1]);
      if ("error" in v) return { output: [v.error] };
      const st = state(ctx.device);
      const before = st.instances.length;
      st.instances = st.instances.filter((i) => !(i.iface === iface && i.vrid === v.vrid));
      // Deleting a non-existent instance is a silent no-op (vrrp.txt Section 7).
      return { output: [muted(st.instances.length < before ? `VRRP ${v.vrid} deleted from ${iface}` : `VRRP ${v.vrid} not configured on ${iface} (no-op)`)] };
    },
  };
}

const setVip: Setter = (inst, ip) => {
  if (!ip || !isValidIpv4(ip)) return err(`config vrrp vip: invalid IPv4 address '${ip ?? ""}'`);
  inst.vip = ip;
  return `virtual IP set to ${ip}`;
};
const setPriority: Setter = (inst, tok) => {
  const n = parseInt10(tok);
  if (n === null || n < PRIORITY.min || n > PRIORITY.max) return err(`config vrrp priority: priority must be ${PRIORITY.min}-${PRIORITY.max} (got '${tok ?? ""}')`);
  inst.priority = n;
  return `priority set to ${n}`;
};
const setVersion: Setter = (inst, tok) => {
  const n = parseInt10(tok);
  if (n === null || n < VERSION.min || n > VERSION.max) return err(`config vrrp version: version must be ${VERSION.min}-${VERSION.max} (got '${tok ?? ""}')`);
  inst.version = n;
  return `version set to ${n}`;
};
const setPreempt: Setter = (inst, tok) => {
  const on = parsePreempt(tok);
  if (on === null) return err(`config vrrp preempt: expected enable or disable (got '${tok ?? ""}')`);
  inst.preempt = on;
  return `preempt ${on ? "enabled" : "disabled"}`;
};
const setAdvInterval: Setter = (inst, tok) => {
  const n = parseInt10(tok);
  if (n === null || n < ADV_S.min || n > ADV_S.max) return err(`config vrrp adv_interval: interval must be ${ADV_S.min}-${ADV_S.max} seconds (got '${tok ?? ""}')`);
  inst.advInterval = n * 1000;
  return `advertisement interval set to ${n} s`;
};

const ipAdd: SonicCmd = {
  path: ["interface", "vrrp", "ip", "add"],
  summary: "Add a virtual IPv4 address to a VRRP instance (creates it if needed)",
  run(args, ctx): CommandResult {
    const [iface, vridTok, ip] = positional(args);
    if (!iface) return { output: [err("Usage: config interface vrrp ip add <interface_name> <vrrp_id> <ip_addr>")] };
    if (!interfaceByName(ctx.device, iface)) return { output: [err(`Error: Router Interface '${iface}' not found`)] };
    const v = parseVrid(vridTok);
    if ("error" in v) return { output: [v.error] };
    const addr = (ip ?? "").split("/")[0];
    if (!isValidIpv4(addr)) return { output: [err(`Error: IP address is not valid: ${ip ?? ""}`)] };
    const st = state(ctx.device);
    let inst = findInstance(st, iface, v.vrid);
    if (!inst) st.instances.push((inst = { iface, vrid: v.vrid }));
    inst.vip = addr;
    return { output: [] };
  },
};

const ipRemove: SonicCmd = {
  path: ["interface", "vrrp", "ip", "remove"],
  summary: "Remove a virtual IPv4 address from a VRRP instance",
  run(args, ctx): CommandResult {
    const [iface, vridTok, ip] = positional(args);
    const v = parseVrid(vridTok);
    if ("error" in v) return { output: [v.error] };
    const inst = iface ? findInstance(state(ctx.device), iface, v.vrid) : undefined;
    const addr = (ip ?? "").split("/")[0];
    if (!inst || inst.vip !== addr) return { output: [err(`Error: ${ip ?? ""} is not configured on the vrrp instance ${v.vrid}!`)] };
    delete inst.vip;
    return { output: [] };
  },
};

const config: SonicCmd[] = [
  // Legacy simulator forms.
  addCmd(["vrrp", "add"]),
  instanceCmd(["vrrp", "vip"], "<iface> <vrid> <ip>", setVip),
  instanceCmd(["vrrp", "priority"], "<iface> <vrid> <1-254>", setPriority),
  instanceCmd(["vrrp", "version"], "<iface> <vrid> <2|3>", setVersion),
  instanceCmd(["vrrp", "preempt"], "<iface> <vrid> <enable|disable>", setPreempt),
  instanceCmd(["vrrp", "adv_interval"], "<iface> <vrid> <1-255>", setAdvInterval),
  delCmd(["vrrp", "del"]),
  // sonic-utilities `config interface vrrp ...`.
  addCmd(["interface", "vrrp", "add"]),
  delCmd(["interface", "vrrp", "remove"]),
  ipAdd,
  ipRemove,
  instanceCmd(["interface", "vrrp", "priority"], "<interface_name> <vrrp_id> <priority>", setPriority),
  instanceCmd(["interface", "vrrp", "adv_interval"], "<interface_name> <vrrp_id> <interval>", setAdvInterval),
  instanceCmd(["interface", "vrrp", "pre_empt"], "<interface_name> <vrrp_id> <enabled|disabled>", setPreempt),
  instanceCmd(["interface", "vrrp", "version"], "<interface_name> <vrrp_id> <2|3>", setVersion),
];

// ---------------------------------------------------------------------------
// show

function sortedInstances(device: Device): VrrpInstance[] {
  return [...(peekFeatureState<VrrpConfig>(device, "vrrp")?.instances ?? [])].sort((a, b) => (a.iface < b.iface ? -1 : a.iface > b.iface ? 1 : a.vrid - b.vrid));
}

/** CRC-32 low 16 bits of the parent name (sonic-swss cfgmgr/vrrpmgr.cpp:72-86). */
function ifnameDigest(name: string): number {
  let crc = 0xffffffff;
  for (const ch of name) {
    crc ^= ch.charCodeAt(0) & 0xff;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc & 0xffff;
}
/** macvlan name vrrpmgr gives the group: vrrp4-<vrid>-<digest> (vrrpmgr.cpp:98-106). */
export function vrrpDeviceName(iface: string, vrid: number): string {
  return `vrrp4-${vrid}-${ifnameDigest(iface).toString(16).padStart(4, "0")}`;
}

/** FRR ttable TTSTYLE_BLANK (lib/termtable.c:48-77): indent 1, left-aligned, 3 spaces right pad. */
function blankTable(rows: string[][], sepAfterHeader = false): string[] {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  const fmt = (r: string[]) => (" " + r.map((v, c) => v.padEnd(w[c] + 3)).join("")).trimEnd();
  const out = rows.map(fmt);
  if (sepAfterHeader) out.splice(1, 0, " " + "-".repeat(w.reduce((s, x) => s + x + 3, 0) - 3));
  return out;
}

export interface VrrpView {
  inst: VrrpInstance;
  state: string;
  effPrio: number;
  primary: string;
  skewMs: number;
  mdiMs: number;
  masterAdvMs: number;
  tx: number;
  rx: number;
  garp: number;
  transitions: number;
}

export function vrrpView(device: Device, inst: VrrpInstance): VrrpView {
  const r = runtimeOf(device, inst.iface, inst.vrid);
  const iface = interfaceByName(device, inst.iface);
  const st = fsmState(device, inst);
  const t = vrrpTimers(inst, r?.masterAdverInterval ?? 0);
  return {
    inst,
    state: st,
    effPrio: iface && st !== "Initialize" ? effectivePriority(iface, inst) : priorityOf(inst),
    // vrrpd binds the source address while Master and clears it in Backup (vrrp.c:1424).
    primary: st === "Master" && iface ? primaryIpv4(iface)?.address ?? "" : "",
    skewMs: t.skew * 10,
    mdiMs: t.mdi * 10,
    masterAdvMs: (r?.masterAdverInterval ?? 0) * 10,
    tx: r?.adverTx ?? 0,
    rx: r?.adverRx ?? 0,
    garp: r?.garpTx ?? 0,
    transitions: r?.transitions ?? 0,
  };
}

/** FRR vrrp_show (vrrp_vty.c:487-598). */
export function renderDetail(device: Device, inst: VrrpInstance): string[] {
  const v = vrrpView(device, inst);
  const yn = (b: boolean) => (b ? "Yes" : "No");
  const vmac = vrrpMac(inst.vrid).toLowerCase();
  const vmac6 = vmac.replace(/^00:00:5e:00:01/, "00:00:5e:00:02");
  const rows: string[][] = [
    ["Virtual Router ID", String(inst.vrid)],
    ["Protocol Version", String(versionOf(inst))],
    ["Autoconfigured", "No"],
    ["Shutdown", yn(!!inst.shutdown)],
    ["Interface", inst.iface],
    ["VRRP interface (v4)", inst.vip ? vrrpDeviceName(inst.iface, inst.vrid) : "None"],
    ["VRRP interface (v6)", "None"],
    ["Primary IP (v4)", v.primary],
    ["Primary IP (v6)", "::"],
    ["Virtual MAC (v4)", vmac],
    ["Virtual MAC (v6)", vmac6],
    ["Status (v4)", v.state],
    ["Status (v6)", "Initialize"],
    ["Priority", String(priorityOf(inst))],
    ["Effective Priority (v4)", String(v.effPrio)],
    ["Effective Priority (v6)", String(priorityOf(inst))],
    ["Preempt Mode", yn(preemptOf(inst))],
    ["Accept Mode", yn(VRRP_DEFAULTS.accept)],
    ["Checksum with IPv4 Pseudoheader", "Yes"],
    ["Advertisement Interval", `${inst.advInterval ?? VRRP_DEFAULTS.advIntervalMs} ms`],
    ["Master Advertisement Interval (v4) Rx", `${v.masterAdvMs} ms (stale)`],
    ["Master Advertisement Interval (v6) Rx", "0 ms (stale)"],
    ["Advertisements Tx (v4)", String(v.tx)],
    ["Advertisements Tx (v6)", "0"],
    ["Advertisements Rx (v4)", String(v.rx)],
    ["Advertisements Rx (v6)", "0"],
    ["Gratuitous ARP Tx (v4)", String(v.garp)],
    ["Neigh. Adverts Tx (v6)", "0"],
    ["State transitions (v4)", String(v.transitions)],
    ["State transitions (v6)", "0"],
    ["Skew Time (v4)", `${v.skewMs} ms`],
    ["Skew Time (v6)", "0 ms"],
    ["Master Down Interval (v4)", `${v.mdiMs} ms`],
    ["Master Down Interval (v6)", "0 ms"],
    ["IPv4 Addresses", inst.vip ? "1" : "0"],
    ...(inst.vip ? [[".".repeat(34), inst.vip]] : []),
    ["IPv6 Addresses", "0"],
  ];
  return ["", ...blankTable(rows)];
}

/** FRR `show vrrp ... summary` (vrrp_vty.c:657-704). */
export function renderSummary(insts: VrrpInstance[], device: Device): string[] {
  const rows = [["Interface", "VRID", "Priority", "IPv4", "IPv6", "State (v4)", "State (v6)"]];
  for (const i of insts) rows.push([i.iface, String(i.vrid), String(priorityOf(i)), i.vip ? "1" : "0", "0", fsmState(device, i) === "Master" ? "Master" : "Backup", "Backup"]);
  return ["", ...blankTable(rows, true)];
}

/** Filter for `show vrrp [interface <if>] [<vrid>]`. */
export function selectInstances(device: Device, ifname?: string, vrid?: number): VrrpInstance[] {
  return sortedInstances(device).filter((i) => (!ifname || i.iface === ifname) && (vrid === undefined || i.vrid === vrid));
}

function clickShow(args: string[], ctx: CommandContext): CommandResult {
  const pos = positional(args);
  const lines = (l: string[]): CommandResult => ({ output: l.map((t) => line(t)) });
  if (pos[0] === "summary") return lines(renderSummary(selectInstances(ctx.device), ctx.device));
  if (pos[0] === "interface") {
    if (!pos[1]) return { output: [err("Error: Missing argument \"<interface_name>\".")] };
    const vrid = pos[2] !== undefined ? parseInt10(pos[2]) ?? -1 : undefined;
    return lines(selectInstances(ctx.device, pos[1], vrid).flatMap((i) => renderDetail(ctx.device, i)));
  }
  if (pos[0] === "vrid") {
    const vrid = parseInt10(pos[1]);
    if (vrid === null) return { output: [err("Error: Missing argument \"<vrid>\".")] };
    return lines(selectInstances(ctx.device, undefined, vrid).flatMap((i) => renderDetail(ctx.device, i)));
  }
  if (pos.length) return { output: [err(`Error: No such command "${pos[0]}".`)] };
  return lines(selectInstances(ctx.device).flatMap((i) => renderDetail(ctx.device, i)));
}

const show: SonicCmd[] = [{ path: ["vrrp"], summary: "Show VRRP instances (FRR vrrpd)", run: clickShow }];

export const vrrpModule: SonicFeatureModule = { id: "vrrp", config, show };

// ---------------------------------------------------------------------------
// KLISH show (sonic-mgmt-framework CLI/actioner/sonic_cli_vrrp.py show_vrrp)

/** show_vrrp_brief.j2: right-aligned columns ending at fixed widths. */
function klishBrief(device: Device, insts: VrrpInstance[]): string[] {
  if (!insts.length) return ["No VRRP instances configured"];
  const W = [19, 6, 8, 16, 10, 11, 10, 12];
  const row = (vals: (string | number)[]) => vals.map((x, i) => { const t = String(x); return t.length >= W[i] ? " " + t : t.padStart(W[i]); }).join("");
  const out = [row(["Interface", "VRID", "State", "Virtual Address", "Cfg_Prio", "Curr_Prio", "Version", "Address"])];
  for (const i of insts) {
    const v = vrrpView(device, i);
    const iface = interfaceByName(device, i.iface);
    const addr = v.primary || (iface && primaryIpv4(iface)?.address) || "";
    out.push(row([i.iface, i.vrid, v.state, i.vip ?? "", priorityOf(i), v.effPrio, versionOf(i), addr]));
  }
  return out;
}

/**
 * KLISH `show vrrp [<vrid> | interface <if> [vrid <id> | <id>] | summary]`. Bare
 * `show vrrp` is the brief table; the vrid/interface forms the FRR detail block
 * (show_vrrp.j2); `summary` the FRR summary (show_vrrp_summary.j2).
 */
export function renderKlishShow(device: Device, args: string[]): string[] {
  const a = args.map((x) => x.toLowerCase());
  if (a[0] === "summary") {
    const insts = selectInstances(device);
    return insts.length ? renderSummary(insts, device) : ["No VRRP instances configured"];
  }
  let insts: VrrpInstance[];
  if (a[0] === "interface") {
    // `interface Vlan 10` or `interface Vlan10`, then optional `[vrid] <id>`.
    let i = 1;
    let ifname = args[i++] ?? "";
    if (/^[A-Za-z]+$/.test(ifname) && /^\d+$/.test(args[i] ?? "")) ifname += args[i++];
    if (a[i] === "vrid") i++;
    const vrid = args[i] !== undefined ? parseInt10(args[i]) ?? -1 : undefined;
    insts = selectInstances(device, ifname, vrid);
  } else if (a[0] !== undefined) {
    insts = selectInstances(device, undefined, parseInt10(args[0]) ?? -1);
  } else {
    return klishBrief(device, selectInstances(device));
  }
  return insts.length ? insts.flatMap((i) => renderDetail(device, i)) : ["No VRRP instances configured"];
}
