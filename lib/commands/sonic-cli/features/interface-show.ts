/**
 * KLISH `show interface …` forms that had no handler (interface.xml:142-430 ACTION
 * dispatch). Rendered from the live device model:
 *
 *   show interface                         show_interface.j2 (Ethernet + PortChannel)
 *   show interface Ethernet [<id|range>]   show_interface_id.j2
 *   show interface PortChannel             every LAG (the per-LAG lacp-show handler)
 *   show interface Vlan [<id|range>]       show_interface_vlan.j2 (L3 SVIs only,
 *                                          sonic_cli_vlan.py:705-857)
 *   show interface Loopback [<id>]         show_interface_loopback.j2
 *   show interface Management [0]          show_interface_management.j2 (eth0)
 *   show interface description [<if>]      show_interface_description.j2
 *   show interface fec status [<range>]    show_intf_fec_status.j2
 *   show interface link-training [<range>] show_interface_link_training.j2
 *   show interface advertise [<range>]     autoneg advertisement (no template in tree)
 *   show interface unreliable-los status   unreliable-LOS mode (no template in tree)
 *   show interface phy status|counters     PHY diag: the simulated PHY has no data
 *   show interface counters PortChannel [<id>]   show_interface_counters.j2 layout
 *   show interface counters rif [<if>]     show_intf_counters_rif.j2
 *   show interface port-locator [<range>]  port locator LED state (none lit)
 *   show interface [<if>] vlan-mappings [dot1q-tunnel]   stored `switchport vlan-mapping`
 *   show interface [<if>] l2proto-tunnel [<proto>]       stored `switchport l2proto-tunnel`
 *
 * MTU / description / FEC / autoneg are not modelled on the interface, so they
 * render their SONiC defaults (9100, none, FEC none, autoneg off).
 */
import { OutputLine, line, err } from "../../types";
import { registerModal, runModalHandlers, ModalArgs } from "../registry";
import { cpRunningLines } from "../config-plane";
import { Device } from "../../../models/device";
import { NetInterface } from "../../../models/interface";
import { peekCounters } from "../../../protocols/counters-daemon";
import { portDiscards } from "../../../control/drops";
import { lagConfigs } from "../../../protocols/lacp-daemon";
import { parseIf, resolveIf, ifacesOfType, displayName, IfArg } from "./l2-ifargs";

const DEFAULT_MTU = 9100;

/** "SPEED_25GB" → "25G" as the templates print it. */
const speedStr = (mbps: number) => (mbps >= 1000 ? `${mbps / 1000}G` : `${mbps}M`);

function counters(d: Device, i: NetInterface) {
  const s = i.statistics;
  const disc = portDiscards(d, i.name);
  const inM = s.rxMulticast ?? 0;
  const inB = s.rxBroadcast ?? 0;
  const outM = s.txMulticast ?? 0;
  const outB = s.txBroadcast ?? 0;
  return {
    inPkts: s.rxFrames, inOct: s.rxBytes, inM, inB, inU: Math.max(0, s.rxFrames - inM - inB), inDisc: disc.rx || s.rxDropped,
    outPkts: s.txFrames, outOct: s.txBytes, outM, outB, outU: Math.max(0, s.txFrames - outM - outB), outDisc: disc.tx || s.txDropped,
  };
}

function ipLines(i: NetInterface, mode4Set: string, mode6Set: string): string[] {
  const out: string[] = [];
  const [prim, ...sec] = i.ipv4;
  if (prim) out.push(`IPV4 address is ${prim.address}/${prim.prefix}`);
  for (const a of sec) out.push(`IPV4 secondary address is ${a.address}/${a.prefix}`);
  out.push(`Mode of IPV4 address assignment: ${i.ipv4.length ? mode4Set : "not-set"}`);
  if (i.ipv6.length) out.push(`IPV6 address is ${i.ipv6.map((a) => `${a.address}/${a.prefix}`).join(",")}`);
  out.push(`Mode of IPV6 address assignment: ${i.ipv6.length ? mode6Set : "not-set"}`);
  out.push(`Interface IPv6 oper status: ${i.ipv6.length ? "Enabled" : "Disabled"}`);
  return out;
}

/** show_interface_id.j2:280-350 for one physical port. */
function renderEthId(d: Device, i: NetInterface): string[] {
  const reason = i.adminState === "down" ? "admin-down" : i.operState === "up" ? "oper-up" : "phy-link-down";
  const c = counters(d, i);
  const r = peekCounters(d)?.ports[i.name];
  const rate = (v: number | undefined) => Math.round(v ?? 0);
  return [
    " ",
    `${i.name} is ${i.adminState}, line protocol is ${i.operState}, reason ${reason}`,
    `Hardware is Eth, address is ${i.mac.toLowerCase()}`,
    ...ipLines(i, "STATIC", "STATIC"),
    `IP MTU ${DEFAULT_MTU} bytes`,
    `LineSpeed ${speedStr(i.speed)}, Auto-negotiation off`,
    "Link-training: off",
    "Unreliable-LOS: off",
    "FEC: none",
    "Events:",
    'Last clearing of "show interface" counters: never',
    `10 seconds input rate ${rate(r?.rxPps)} packets/sec, ${rate((r?.rxBps ?? 0) * 8)} bits/sec, ${rate(r?.rxBps)} Bytes/sec`,
    `10 seconds output rate ${rate(r?.txPps)} packets/sec, ${rate((r?.txBps ?? 0) * 8)} bits/sec, ${rate(r?.txBps)} Bytes/sec`,
    "",
    "Input statistics:",
    `        ${c.inPkts} packets, ${c.inOct} octets`,
    `        ${c.inM} Multicasts, ${c.inB} Broadcasts, ${c.inU} Unicasts`,
    `        0 error, ${c.inDisc} discarded, 0 Oversize`,
    "        0 Packets (128 to 255 Octects)",
    "Output statistics:",
    `        ${c.outPkts} packets, ${c.outOct} octets`,
    `        ${c.outM} Multicasts, ${c.outB} Broadcasts, ${c.outU} Unicasts`,
    `        0 error, ${c.outDisc} discarded, 0 Oversize`,
  ];
}

/** show_interface.j2:130-160 (bare `show interface`): Ethernet + PortChannel. */
function renderBrief(d: Device): string[] {
  const out: string[] = [];
  const ifs = [...ifacesOfType(d, "Ethernet"), ...ifacesOfType(d, "PortChannel")];
  for (const i of ifs) {
    const lag = i.name.startsWith("PortChannel");
    const members = lag ? (lagConfigs(d).find((l) => l.name === i.name)?.members ?? []) : [];
    const c = lag ? undefined : counters(d, i);
    const speed = lag ? members.reduce((s, m) => s + (d.interfaces.find((x) => x.name === m)?.speed ?? 0), 0) : i.speed;
    out.push(`${i.name} is ${i.adminState}, line protocol is ${i.operState}`, lag ? "Hardware is PortChannel" : "Hardware is Eth");
    out.push(`Interface index is ${d.interfaces.indexOf(i) + 1}`);
    if (i.ipv4.length) out.push(`IPV4 address is ${i.ipv4.map((a) => `${a.address}/${a.prefix}`).join(",")}`);
    out.push(`Mode of IPV4 address assignment: ${i.ipv4.length ? "MANUAL" : "not-set"}`);
    if (i.ipv6.length) out.push(`IPV6 address is ${i.ipv6.map((a) => `${a.address}/${a.prefix}`).join(",")}`);
    out.push(`Mode of IPV6 address assignment: ${i.ipv6.length ? "MANUAL" : "not-set"}`);
    out.push(`IP MTU ${DEFAULT_MTU} bytes`);
    if (speed) out.push(`LineSpeed ${speedStr(speed)}, Auto-negotiation off`);
    if (c) {
      out.push(
        "Input statistics:",
        `        ${c.inPkts} packets, ${c.inOct} octets`,
        `        ${c.inM} Multicasts, ${c.inB} Broadcasts, ${c.inU} Unicasts`,
        `        0 error, ${c.inDisc} discarded`,
        "Output statistics:",
        `        ${c.outPkts} packets, ${c.outOct} octets`,
        `        ${c.outM} Multicasts, ${c.outB} Broadcasts, ${c.outU} Unicasts`,
        `        0 error, ${c.outDisc} discarded`,
      );
    }
    out.push("");
  }
  return out;
}

/** show_interface_vlan.j2 — L3 SVI only (an L2-only VLAN prints nothing). */
function renderVlanIf(i: NetInterface): string[] {
  const out = [`${i.name} is ${i.adminState}, line protocol is ${i.operState}`, `Hardware is Vlan, address is ${i.mac.toLowerCase()}`, ""];
  for (const a of i.ipv4) out.push(`IPV4 address is ${a.address}/${a.prefix}`);
  out.push(`Mode of IPV4 address assignment: ${i.ipv4.length ? "MANUAL" : "not-set"}`);
  for (const a of i.ipv6) out.push(`IPV6 address is ${a.address}/${a.prefix}`);
  out.push(`Mode of IPV6 address assignment: ${i.ipv6.length ? "MANUAL" : "not-set"}`);
  out.push(`Interface IPv6 oper status: ${i.ipv6.length ? "Enabled" : "Disabled"}`);
  out.push(`IP MTU ${DEFAULT_MTU} bytes`, "");
  return out;
}

/** show_interface_loopback.j2:135-157. */
function renderLoopback(i: NetInterface): string[] {
  return [
    `${i.name} is ${i.adminState}, line protocol is ${i.operState}`,
    `Hardware is Loopback, address is ${i.mac.toLowerCase()}`,
    "",
    ...ipLines(i, "STATIC", "STATIC"),
  ];
}

/** show_interface_management.j2:156-186 (eth0 shown as Management0). */
function renderMgmt(d: Device, i: NetInterface): string[] {
  const c = counters(d, i);
  const out = [`Management0 is ${i.adminState}, line protocol is ${i.operState}`, `Hardware is MGMT, address is ${i.mac.toLowerCase()}`];
  if (i.ipv4[0]) out.push(`IPV4 address is ${i.ipv4[0].address}/${i.ipv4[0].prefix}`, "Mode of IPV4 address assignment: STATIC");
  if (i.ipv6.length) {
    for (const a of i.ipv6) out.push(`IPV6 address is ${a.address}/${a.prefix}`);
    out.push("Mode of IPV6 address assignment: STATIC");
  }
  out.push(
    `Interface IPv6 oper status: ${i.ipv6.length ? "Enabled" : "Disabled"}`,
    "IP MTU 1500 bytes",
    `LineSpeed ${speedStr(i.speed)}, Auto-negotiation True`,
    "Input statistics:",
    `        ${c.inPkts} packets, ${c.inOct} octets`,
    `        ${c.inM} Multicasts, 0 error, ${c.inDisc} discarded`,
    "Output statistics:",
    `        ${c.outPkts} packets, ${c.outOct} octets`,
    `        0 error, ${c.outDisc} discarded`,
    "",
  );
  return out;
}

/** show_interface_description.j2. */
function renderDescription(d: Device, a: IfArg | null): string[] {
  const types = ["Ethernet", "PortChannel", "Vlan", "Loopback", "Management"] as const;
  const ifs = a ? resolveIf(d, a) : types.flatMap((t) => ifacesOfType(d, t));
  const dash = "-".repeat(105);
  const out = [dash, "Name".padEnd(20) + "Admin".padEnd(15) + "Oper".padEnd(15) + "Description".padEnd(20), dash];
  for (const i of ifs) out.push(displayName(i).padEnd(20) + i.adminState.padEnd(15) + i.operState.padEnd(15) + "-".padEnd(30));
  return out;
}

const ethRange = (d: Device, toks: string[]): NetInterface[] | null => {
  if (!toks.length) return ifacesOfType(d, "Ethernet");
  const a = parseIf(toks);
  if (!a || a.type !== "Ethernet" || a.rest.length) return null;
  return resolveIf(d, a);
};

const ifState = (i: NetInterface) => (i.adminState === "down" ? "admin-down" : i.operState === "up" ? "oper-up" : "phy-link-down");

/** show_intf_fec_status.j2 (Type = transceiver display name, blank here). */
function renderFec(ifs: NetInterface[]): string[] {
  const out = ["Interface".padEnd(16) + "Type".padEnd(42) + "Oper".padEnd(7) + "Admin".padEnd(7) + "If-State", `${"-".repeat(14)}  ${"-".repeat(40)}  ${"-".repeat(5)}  ${"-".repeat(5)}  ${"-".repeat(11)}`];
  for (const i of ifs) out.push(i.name.padEnd(16) + "".padEnd(42) + "none".padEnd(7) + "none".padEnd(7) + ifState(i));
  return out;
}

/** show_interface_link_training.j2. */
function renderLinkTraining(ifs: NetInterface[]): string[] {
  const out = [
    "",
    "                                                             Auto          Link-Training",
    "Interface       Type                                      Negotiation  Standalone  Operational",
    "--------------  ----------------------------------------  -----------  ----------  -----------",
    "",
  ];
  for (const i of ifs) out.push(i.name.padEnd(16) + "".padEnd(42) + "off".padEnd(13) + "off".padEnd(12) + "--", "");
  return out;
}

function renderAdvertise(ifs: NetInterface[]): string[] {
  const out = ["Interface".padEnd(16) + "Auto-Neg".padEnd(10) + "Advertised Speeds".padEnd(20) + "Advertised Types", `${"-".repeat(14)}  ${"-".repeat(8)}  ${"-".repeat(18)}  ${"-".repeat(16)}`];
  for (const i of ifs) out.push(i.name.padEnd(16) + "off".padEnd(10) + "all".padEnd(20) + "all");
  return out;
}

function renderUnlos(ifs: NetInterface[]): string[] {
  const out = ["Interface".padEnd(16) + "Oper".padEnd(7) + "Admin".padEnd(7) + "If-State", `${"-".repeat(14)}  ${"-".repeat(5)}  ${"-".repeat(5)}  ${"-".repeat(11)}`];
  for (const i of ifs) out.push(i.name.padEnd(16) + "off".padEnd(7) + "auto".padEnd(7) + ifState(i));
  return out;
}

function renderPortLocator(ifs: NetInterface[]): string[] {
  const out = ["Interface".padEnd(16) + "Locator LED".padEnd(14) + "Time Remaining(min)", `${"-".repeat(14)}  ${"-".repeat(12)}  ${"-".repeat(19)}`];
  for (const i of ifs) out.push(i.name.padEnd(16) + "off".padEnd(14) + "-");
  return out;
}

/** show_interface_counters.j2 columns for PortChannels (member sums). */
function renderPoCounters(d: Device, ifs: NetInterface[]): string[] {
  const dash = "-".repeat(96);
  const cols = ["Interface", "State", "RX_OK", "RX_ERR", "RX_DRP", "TX_OK", "TX_ERR", "TX_DRP"];
  const out = [dash, cols.map((c, k) => c.padEnd(k ? 10 : 15)).join(""), dash];
  for (const po of ifs) {
    const ms = (lagConfigs(d).find((l) => l.name === po.name)?.members ?? []).map((m) => d.interfaces.find((x) => x.name === m)).filter((x): x is NetInterface => !!x);
    const sum = (f: (c: ReturnType<typeof counters>) => number) => ms.reduce((s, m) => s + f(counters(d, m)), 0);
    const row = [po.name, po.operState === "up" ? "U" : "D", sum((c) => c.inPkts), 0, sum((c) => c.inDisc), sum((c) => c.outPkts), 0, sum((c) => c.outDisc)];
    out.push(row.map((v, k) => String(v).padEnd(k ? 10 : 15)).join(""));
  }
  return out;
}

/** show_intf_counters_rif.j2 — routed interfaces (those with an IPv4 address). */
function renderRif(d: Device, only: NetInterface[] | null): string[] {
  const f = "%-22s%-19s%-19s%-18s%-17s%-19s%-19s%-18s%-17s";
  const widths = f.match(/\d+/g)!.map(Number);
  const row = (v: (string | number)[]) => v.map((x, k) => String(x).padEnd(widths[k])).join("");
  const out = [`${"Polling Rate".padEnd(21)}: 10 seconds`, "-".repeat(157), row(["Interface", "RX_OK", "RX_BPS", "RX_PPS", "RX_ERR", "TX_OK", "TX_BPS", "TX_PPS", "TX_ERR"]), "-".repeat(157)];
  const rifs = (only ?? d.interfaces.filter((i) => !i.management && i.ipv4.length)).filter((i) => i.ipv4.length);
  const rates = peekCounters(d)?.ports ?? {};
  for (const i of rifs) {
    const phys = !i.logical;
    const r = rates[i.name];
    const s = i.statistics;
    out.push(row([i.name, phys ? s.rxFrames : 0, phys ? Math.round(r?.rxBps ?? 0) : 0, phys ? Math.round(r?.rxPps ?? 0) : 0, 0, phys ? s.txFrames : 0, phys ? Math.round(r?.txBps ?? 0) : 0, phys ? Math.round(r?.txPps ?? 0) : 0, 0]));
  }
  return out;
}

/** Stored per-interface config lines starting with `prefix` (config-plane fallback). */
const storedLines = (d: Device, prefix: string) => cpRunningLines(d).filter((l) => l.line.startsWith(prefix));

/** `switchport vlan-mapping <outer> [inner <v>] <mapped> [priority <p>]` / `… dot1q-tunnel <svid>`. */
function renderVlanMappings(d: Device, ifs: NetInterface[] | null, dot1q: boolean): string[] {
  const names = ifs?.map((i) => i.name);
  const rows = storedLines(d, "switchport vlan-mapping")
    .filter((l) => !names || names.includes(l.ctx))
    .map((l) => ({ ctx: l.ctx, t: l.line.split(/\s+/).slice(2) }))
    .filter((r) => (r.t.includes("dot1q-tunnel") || r.t.includes("dot1q_tunnel")) === dot1q);
  const dash = "-".repeat(60);
  if (dot1q) {
    const out = [dash, "Name".padEnd(15) + "Vlan".padEnd(20) + "dot1q-tunnel Vlan".padEnd(20) + "Priority", dash];
    for (const r of rows) {
      const pr = r.t.indexOf("priority");
      out.push(r.ctx.padEnd(15) + r.t[0].padEnd(20) + (r.t[r.t.indexOf("dot1q-tunnel") + 1] ?? "").padEnd(20) + (pr >= 0 ? r.t[pr + 1] : "-"));
    }
    return out;
  }
  const out = ["Flags: M - Multi-tag", dash, "Name".padEnd(15) + "Outer".padEnd(12) + "Inner".padEnd(12) + "Mapped Vlan".padEnd(14) + "Priority", dash];
  for (const r of rows) {
    const inner = r.t[1] === "inner" ? r.t[2] : "-";
    const mapped = r.t[1] === "inner" ? r.t[3] : r.t[1];
    const pr = r.t.indexOf("priority");
    out.push(r.ctx.padEnd(15) + (r.t[0] ?? "").padEnd(12) + inner.padEnd(12) + (mapped ?? "").padEnd(14) + (pr >= 0 ? r.t[pr + 1] : "-"));
  }
  return out;
}

/** `switchport l2proto-tunnel <proto> Vlan <list>` rows. */
function renderL2pt(d: Device, ifs: NetInterface[] | null, proto?: string): string[] {
  const names = ifs?.map((i) => i.name);
  const dash = "-".repeat(50);
  const out = [dash, "Interface".padEnd(15) + "Protocol".padEnd(12) + "Vlans", dash];
  for (const l of storedLines(d, "switchport l2proto-tunnel")) {
    if (names && !names.includes(l.ctx)) continue;
    const t = l.line.split(/\s+/);
    if (proto && t[2]?.toLowerCase() !== proto) continue;
    out.push(l.ctx.padEnd(15) + (t[2] ?? "").toUpperCase().padEnd(12) + t.slice(3).filter((x) => !/^vlan$/i.test(x)).join(" "));
  }
  return out;
}

/** Front-panel "1/N" ↔ the N-th Ethernet port (natural order). */
const frontPorts = (d: Device) => ifacesOfType(d, "Ethernet").filter((i) => !i.logical);
function frontPort(d: Device, slotport: string): NetInterface | undefined {
  const m = /^1\/(\d+)$/.exec(slotport);
  return m ? frontPorts(d)[Number(m[1]) - 1] : undefined;
}

/** Breakout modes a single-lane/quad-lane port supports at its native speed. */
function breakoutModes(mbps: number): string[] {
  const g = mbps / 1000;
  if (g >= 400) return ["1x400G", "2x200G", "4x100G", "8x50G"];
  if (g >= 100) return ["1x100G", "1x40G", "4x25G", "4x10G"];
  if (g >= 40) return ["1x40G", "4x10G"];
  if (g >= 25) return ["1x25G", "1x10G"];
  if (g >= 10) return ["1x10G", "1x1G"];
  return ["1x1G"];
}

/** show interface breakout modes (dynamic_port_breakout.xml EXAMPLE layout). */
function renderBreakoutModes(d: Device, only: string | undefined): string[] {
  const dash = "-".repeat(73);
  const out = [dash, "Port".padEnd(6) + "Interface".padEnd(12) + "Supported Modes".padEnd(42) + "Default Mode", dash];
  frontPorts(d).forEach((i, k) => {
    const sp = `1/${k + 1}`;
    if (only && only !== sp) return;
    const modes = breakoutModes(i.speed);
    out.push(sp.padEnd(6) + i.name.padEnd(12) + modes.join(", ").padEnd(42) + modes[0]);
  });
  return out;
}

/** show interface breakout dependencies port <p>: CONFIG_DB rows that reference the port. */
function renderBreakoutDeps(d: Device, p: NetInterface): string[] {
  const dash = "-".repeat(34);
  const rows: string[] = [];
  const vids = p.vlan.mode === "access" ? [p.vlan.accessVlan] : p.vlan.allowedVlans;
  for (const v of vids.filter((v) => (d.config.vlans ?? []).some((x) => x.id === v))) rows.push(`VLAN|Vlan${v}`, `VLAN_MEMBER|Vlan${v}|${p.name}`);
  for (const l of lagConfigs(d)) if (l.members.includes(p.name)) rows.push(`PORTCHANNEL_MEMBER|${l.name}|${p.name}`);
  for (const a of p.ipv4) rows.push(`INTERFACE|${p.name}|${a.address}/${a.prefix}`);
  return [dash, "Dependent Configurations", dash, ...rows];
}

let inPoDetail = false; // guards the per-LAG re-dispatch against recursion

const L = (ss: string[]): { output: OutputLine[] } => ({ output: ss.map((s) => line(s)) });

function showInterface(a: ModalArgs): { output: OutputLine[] } | null {
  const d = a.ctx.device;
  const t = a.args.slice(1);
  const k0 = t[0]?.toLowerCase();
  if (!t.length) return L(renderBrief(d));

  switch (k0) {
    case "description": {
      if (t.length === 1) return L(renderDescription(d, null));
      const ia = parseIf(t.slice(1));
      return ia && !ia.rest.length ? L(renderDescription(d, ia)) : null;
    }
    case "fec": {
      if (t[1]?.toLowerCase() !== "status") return null;
      const ifs = ethRange(d, t.slice(2));
      return ifs ? L(renderFec(ifs)) : null;
    }
    case "link-training": {
      const ifs = ethRange(d, t.slice(1));
      return ifs ? L(renderLinkTraining(ifs)) : null;
    }
    case "advertise": {
      const ifs = ethRange(d, t.slice(1));
      return ifs ? L(renderAdvertise(ifs)) : null;
    }
    case "unreliable-los": {
      if (t[1]?.toLowerCase() !== "status") return null;
      const ifs = ethRange(d, t.slice(2));
      return ifs ? L(renderUnlos(ifs)) : null;
    }
    case "port-locator": {
      const ifs = ethRange(d, t.slice(1));
      return ifs ? L(renderPortLocator(ifs)) : null;
    }
    case "phy": {
      // Phy monitoring data / non-zero PHY counters: the simulated PHY reports none.
      const sub = t[1]?.toLowerCase();
      if (sub !== "status" && sub !== "counters") return null;
      return ethRange(d, t.slice(2)) ? { output: [] } : null;
    }
    case "vlan-mappings": {
      if (t.length > 2 || (t[1] && t[1].toLowerCase() !== "dot1q-tunnel")) return null;
      return L(renderVlanMappings(d, null, !!t[1]));
    }
    case "l2proto-tunnel":
      return t.length === 1 ? L(renderL2pt(d, null)) : null;
    case "breakout": {
      const k1 = t[1]?.toLowerCase();
      if (k1 === "modes") {
        if (t.length === 2) return L(renderBreakoutModes(d, undefined));
        return t[2]?.toLowerCase() === "port" && t.length === 4 ? L(renderBreakoutModes(d, t[3])) : null;
      }
      if (k1 === "dependencies" && t[2]?.toLowerCase() === "port" && t.length === 4) {
        const p = frontPort(d, t[3]);
        return p ? L(renderBreakoutDeps(d, p)) : { output: [err(`% Error: Invalid port ${t[3]}`)] };
      }
      return null;
    }
    case "counters": {
      const k1 = t[1]?.toLowerCase();
      if (k1 === "rif") {
        if (t.length === 2) return L(renderRif(d, null));
        const ia = parseIf(t.slice(2));
        if (!ia || ia.rest.length) return null;
        return L(renderRif(d, resolveIf(d, ia)));
      }
      const ia = parseIf(t.slice(1));
      if (ia?.type === "PortChannel" && !ia.rest.length) return L(renderPoCounters(d, resolveIf(d, ia)));
      return null;
    }
  }

  const ia = parseIf(t);
  if (!ia) return null;
  const sub = ia.rest[0]?.toLowerCase();
  if (sub === "vlan-mappings") {
    if (ia.type !== "Ethernet" && ia.type !== "PortChannel") return null;
    if (ia.rest.length > 2 || (ia.rest[1] && ia.rest[1].toLowerCase() !== "dot1q-tunnel")) return null;
    return L(renderVlanMappings(d, resolveIf(d, ia), !!ia.rest[1]));
  }
  if (sub === "l2proto-tunnel") {
    if (ia.type !== "Ethernet" || ia.rest.length > 2) return null;
    return L(renderL2pt(d, resolveIf(d, ia), ia.rest[1]?.toLowerCase()));
  }
  if (ia.rest.length) return null;
  const ifs = resolveIf(d, ia);
  switch (ia.type) {
    case "Ethernet":
      if (ia.ids && !ifs.length) return { output: [err(`% Error: Interface Ethernet${ia.ids[0]} not found`)] };
      return L(ifs.flatMap((i) => renderEthId(d, i)));
    case "Vlan":
      return L(ifs.filter((i) => i.ipv4.length || i.ipv6.length).flatMap(renderVlanIf));
    case "Loopback":
      if (ia.ids && !ifs.length) return { output: [err(`% Error: Interface Loopback${ia.ids[0]} not found`)] };
      return L(ifs.flatMap(renderLoopback));
    case "Management":
      return L(ifs.flatMap((i) => renderMgmt(d, i)));
    case "PortChannel": {
      // Each LAG through the per-LAG detail handler (lacp-show: show_interface_portchannel.j2).
      if (inPoDetail) return null;
      const out: OutputLine[] = [];
      inPoDetail = true;
      try {
        for (const i of ifs) {
          const r = runModalHandlers({ ...a, args: ["interface", i.name] });
          if (r) out.push(...r.output);
        }
      } finally {
        inPoDetail = false;
      }
      if (!ifs.length && !ia.ids) return { output: [line("No PortChannels configured")] };
      return { output: out };
    }
  }
  return null;
}

registerModal({
  id: "interface-show",
  views: ["enable-view"],
  keywords: ["show"],
  run(a) {
    if (a.args[0]?.toLowerCase() !== "interface") return null;
    if (a.args[1]?.toLowerCase() === "transceiver") return null; // transceiver-show
    return showInterface(a);
  },
});
