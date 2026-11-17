/**
 * The MIB objects the simulated SONiC agent serves, their names (as net-snmp's
 * client tools print them with the standard MIBs loaded), and net-snmp value
 * formatting (snmplib/mib.c sprint_realloc_*).
 *
 * Served on a SONiC switch (snmpd master + sonic-snmpagent AgentX subagent):
 *   SNMPv2-MIB system group   net-snmp agent/mibgroup/mibII/system_mib.c
 *   IF-MIB ifNumber/ifTable   sonic-snmpagent mibs/ietf/rfc1213.py:590-720
 *   SNMPv2-MIB snmp group     net-snmp agent/mibgroup/mibII/snmp_mib.c
 *   IF-MIB ifXTable           sonic-snmpagent mibs/ietf/rfc2863.py:330-485
 */
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Oid, SnmpValue, VarBind, bytesToString, oidCompare, str } from "./snmp-ber";
import { AgentRuntime } from "./snmp-config";

// ------------------------------------------------------------------ names

type Syntax = "DisplayString" | "PhysAddress";

interface Node {
  module: string;
  name: string;
  oid: Oid;
  syntax?: Syntax;
  enums?: Record<number, string>;
}

const o = (s: string): Oid => s.split(".").filter(Boolean).map(Number);
const IFSTATUS = { 1: "up", 2: "down", 3: "testing", 4: "unknown", 5: "dormant", 6: "notPresent", 7: "lowerLayerDown" };
const TRUTH = { 1: "true", 2: "false" };
const ENABLED = { 1: "enabled", 2: "disabled" };
const IFTYPE = { 1: "other", 6: "ethernetCsmacd", 24: "softwareLoopback", 136: "l3ipvlan", 161: "ieee8023adLag" };

const SYS = "1.3.6.1.2.1.1";
const IFE = "1.3.6.1.2.1.2.2.1";
const IFX = "1.3.6.1.2.1.31.1.1.1";
const SNMPG = "1.3.6.1.2.1.11";

export const IF_COLUMNS = [
  "ifIndex", "ifDescr", "ifType", "ifMtu", "ifSpeed", "ifPhysAddress", "ifAdminStatus", "ifOperStatus", "ifLastChange",
  "ifInOctets", "ifInUcastPkts", "ifInNUcastPkts", "ifInDiscards", "ifInErrors", "ifInUnknownProtos", "ifOutOctets",
  "ifOutUcastPkts", "ifOutNUcastPkts", "ifOutDiscards", "ifOutErrors", "ifOutQLen", "ifSpecific",
];
export const IFX_COLUMNS = [
  "ifName", "ifInMulticastPkts", "ifInBroadcastPkts", "ifOutMulticastPkts", "ifOutBroadcastPkts", "ifHCInOctets",
  "ifHCInUcastPkts", "ifHCInMulticastPkts", "ifHCInBroadcastPkts", "ifHCOutOctets", "ifHCOutUcastPkts",
  "ifHCOutMulticastPkts", "ifHCOutBroadcastPkts", "ifLinkUpDownTrapEnable", "ifHighSpeed", "ifPromiscuousMode",
  "ifConnectorPresent", "ifAlias", "ifCounterDiscontinuityTime",
];
export const SNMP_COUNTERS: [number, string][] = [
  [1, "snmpInPkts"], [2, "snmpOutPkts"], [3, "snmpInBadVersions"], [4, "snmpInBadCommunityNames"],
  [5, "snmpInBadCommunityUses"], [6, "snmpInASNParseErrs"], [8, "snmpInTooBigs"], [9, "snmpInNoSuchNames"],
  [10, "snmpInBadValues"], [11, "snmpInReadOnlys"], [12, "snmpInGenErrs"], [13, "snmpInTotalReqVars"],
  [14, "snmpInTotalSetVars"], [15, "snmpInGetRequests"], [16, "snmpInGetNexts"], [17, "snmpInSetRequests"],
  [18, "snmpInGetResponses"], [19, "snmpInTraps"], [20, "snmpOutTooBigs"], [21, "snmpOutNoSuchNames"],
  [22, "snmpOutBadValues"], [24, "snmpOutGenErrs"], [25, "snmpOutGetRequests"], [26, "snmpOutGetNexts"],
  [27, "snmpOutSetRequests"], [28, "snmpOutGetResponses"], [29, "snmpOutTraps"],
];

const NODES: Node[] = [
  { module: "SNMPv2-SMI", name: "zeroDotZero", oid: [0, 0] },
  { module: "SNMPv2-SMI", name: "iso", oid: [1] },
  { module: "SNMPv2-SMI", name: "org", oid: o("1.3") },
  { module: "SNMPv2-SMI", name: "dod", oid: o("1.3.6") },
  { module: "SNMPv2-SMI", name: "internet", oid: o("1.3.6.1") },
  { module: "SNMPv2-SMI", name: "mgmt", oid: o("1.3.6.1.2") },
  { module: "SNMPv2-SMI", name: "mib-2", oid: o("1.3.6.1.2.1") },
  { module: "SNMPv2-SMI", name: "private", oid: o("1.3.6.1.4") },
  { module: "SNMPv2-SMI", name: "enterprises", oid: o("1.3.6.1.4.1") },
  { module: "SNMPv2-SMI", name: "snmpV2", oid: o("1.3.6.1.6") },
  { module: "SNMPv2-SMI", name: "snmpModules", oid: o("1.3.6.1.6.3") },
  { module: "NET-SNMP-MIB", name: "netSnmp", oid: o("1.3.6.1.4.1.8072") },
  { module: "NET-SNMP-MIB", name: "netSnmpAgentOIDs", oid: o("1.3.6.1.4.1.8072.3.2") },
  { module: "NET-SNMP-MIB", name: "netSnmpNotificationPrefix", oid: o("1.3.6.1.4.1.8072.4") },
  { module: "NET-SNMP-AGENT-MIB", name: "nsNotifyStart", oid: o("1.3.6.1.4.1.8072.4.0.1") },
  { module: "NET-SNMP-AGENT-MIB", name: "nsNotifyShutdown", oid: o("1.3.6.1.4.1.8072.4.0.2") },
  { module: "NET-SNMP-AGENT-MIB", name: "nsNotifyRestart", oid: o("1.3.6.1.4.1.8072.4.0.3") },
  { module: "SNMPv2-MIB", name: "system", oid: o(SYS) },
  { module: "SNMPv2-MIB", name: "sysDescr", oid: o(`${SYS}.1`), syntax: "DisplayString" },
  { module: "SNMPv2-MIB", name: "sysObjectID", oid: o(`${SYS}.2`) },
  { module: "SNMPv2-MIB", name: "sysUpTime", oid: o(`${SYS}.3`) },
  { module: "DISMAN-EVENT-MIB", name: "sysUpTimeInstance", oid: o(`${SYS}.3.0`) },
  { module: "SNMPv2-MIB", name: "sysContact", oid: o(`${SYS}.4`), syntax: "DisplayString" },
  { module: "SNMPv2-MIB", name: "sysName", oid: o(`${SYS}.5`), syntax: "DisplayString" },
  { module: "SNMPv2-MIB", name: "sysLocation", oid: o(`${SYS}.6`), syntax: "DisplayString" },
  { module: "SNMPv2-MIB", name: "sysServices", oid: o(`${SYS}.7`) },
  { module: "SNMPv2-MIB", name: "sysORLastChange", oid: o(`${SYS}.8`) },
  { module: "SNMPv2-MIB", name: "snmp", oid: o(SNMPG) },
  ...SNMP_COUNTERS.map(([n, name]) => ({ module: "SNMPv2-MIB", name, oid: o(`${SNMPG}.${n}`) })),
  { module: "SNMPv2-MIB", name: "snmpEnableAuthenTraps", oid: o(`${SNMPG}.30`), enums: ENABLED },
  { module: "SNMPv2-MIB", name: "snmpSilentDrops", oid: o(`${SNMPG}.31`) },
  { module: "SNMPv2-MIB", name: "snmpProxyDrops", oid: o(`${SNMPG}.32`) },
  { module: "SNMPv2-MIB", name: "snmpTrap", oid: o("1.3.6.1.6.3.1.1.4") },
  { module: "SNMPv2-MIB", name: "snmpTrapOID", oid: o("1.3.6.1.6.3.1.1.4.1") },
  { module: "SNMPv2-MIB", name: "snmpTrapEnterprise", oid: o("1.3.6.1.6.3.1.1.4.3") },
  { module: "SNMPv2-MIB", name: "snmpTraps", oid: o("1.3.6.1.6.3.1.1.5") },
  { module: "SNMPv2-MIB", name: "coldStart", oid: o("1.3.6.1.6.3.1.1.5.1") },
  { module: "SNMPv2-MIB", name: "warmStart", oid: o("1.3.6.1.6.3.1.1.5.2") },
  { module: "IF-MIB", name: "linkDown", oid: o("1.3.6.1.6.3.1.1.5.3") },
  { module: "IF-MIB", name: "linkUp", oid: o("1.3.6.1.6.3.1.1.5.4") },
  { module: "SNMPv2-MIB", name: "authenticationFailure", oid: o("1.3.6.1.6.3.1.1.5.5") },
  { module: "IF-MIB", name: "interfaces", oid: o("1.3.6.1.2.1.2") },
  { module: "IF-MIB", name: "ifNumber", oid: o("1.3.6.1.2.1.2.1") },
  { module: "IF-MIB", name: "ifTable", oid: o("1.3.6.1.2.1.2.2") },
  { module: "IF-MIB", name: "ifEntry", oid: o(IFE) },
  ...IF_COLUMNS.map((name, i) => ({
    module: "IF-MIB",
    name,
    oid: o(`${IFE}.${i + 1}`),
    syntax: (name === "ifDescr" ? "DisplayString" : name === "ifPhysAddress" ? "PhysAddress" : undefined) as Syntax | undefined,
    enums: name === "ifType" ? IFTYPE : name === "ifAdminStatus" || name === "ifOperStatus" ? IFSTATUS : undefined,
  })),
  { module: "IF-MIB", name: "ifMIB", oid: o("1.3.6.1.2.1.31") },
  { module: "IF-MIB", name: "ifMIBObjects", oid: o("1.3.6.1.2.1.31.1") },
  { module: "IF-MIB", name: "ifXTable", oid: o("1.3.6.1.2.1.31.1.1") },
  { module: "IF-MIB", name: "ifXEntry", oid: o(IFX) },
  ...IFX_COLUMNS.map((name, i) => ({
    module: "IF-MIB",
    name,
    oid: o(`${IFX}.${i + 1}`),
    syntax: (name === "ifName" || name === "ifAlias" ? "DisplayString" : undefined) as Syntax | undefined,
    enums: name === "ifLinkUpDownTrapEnable" ? ENABLED : name === "ifPromiscuousMode" || name === "ifConnectorPresent" ? TRUTH : undefined,
  })),
];

const BY_NAME = new Map<string, Node>();
for (const n of NODES) {
  BY_NAME.set(n.name, n);
  BY_NAME.set(`${n.module}::${n.name}`, n);
}
const BY_DEPTH = [...NODES].sort((a, b) => b.oid.length - a.oid.length);

function deepest(oid: Oid): Node | undefined {
  return BY_DEPTH.find((n) => n.oid.length <= oid.length && n.oid.every((x, i) => oid[i] === x));
}

export const OIDS = {
  sysUpTime0: o(`${SYS}.3.0`),
  snmpTrapOID0: o("1.3.6.1.6.3.1.1.4.1.0"),
  snmpTrapEnterprise0: o("1.3.6.1.6.3.1.1.4.3.0"),
  coldStart: o("1.3.6.1.6.3.1.1.5.1"),
  linkDown: o("1.3.6.1.6.3.1.1.5.3"),
  linkUp: o("1.3.6.1.6.3.1.1.5.4"),
  authenticationFailure: o("1.3.6.1.6.3.1.1.5.5"),
  nsNotifyShutdown: o("1.3.6.1.4.1.8072.4.0.2"),
  /** NETSNMP_SYSTEM_MIB = 1.3.6.1.4.1.8072.3.2.<OSTYPE>, linux = 10 (net-snmp-config.h:2190). */
  netSnmpLinux: o("1.3.6.1.4.1.8072.3.2.10"),
  ifIndex: o(`${IFE}.1`),
  ifAdminStatus: o(`${IFE}.7`),
  ifOperStatus: o(`${IFE}.8`),
  mib2: o("1.3.6.1.2.1"),
};

/**
 * net-snmp snmp_parse_oid(): MODULE::name.suffix, name.suffix, or numeric
 * (with or without the leading dot). Returns null with net-snmp's error text.
 */
export function parseOid(input: string): Oid | { error: string } {
  const s = input.trim();
  if (/^\.?\d+(\.\d+)*\.?$/.test(s)) return o(s);
  const m = s.match(/^((?:[A-Za-z][\w-]*::)?[A-Za-z][\w-]*)((?:\.\d+)*)$/);
  const node = m ? BY_NAME.get(m[1]) : undefined;
  if (!m || !node) {
    const name = (m?.[1] ?? s).replace(/^.*::/, "");
    if (m && m[1].includes("::") && !BY_NAME.has(name)) {
      const mod = m[1].split("::")[0];
      if (!NODES.some((n) => n.module === mod)) return { error: `${s}: Unknown Object Identifier (Cannot find module (${mod}))` };
    }
    return { error: `${s}: Unknown Object Identifier (Sub-id not found: (top) -> ${name})` };
  }
  return [...node.oid, ...o(m[2])];
}

export interface FormatOpts {
  /** -On: numeric OIDs. */
  numeric?: boolean;
  /** -Os: drop the MODULE:: prefix. */
  short?: boolean;
  /** -Oq: quick print. */
  quick?: boolean;
  /** -Ov: value only. */
  valueOnly?: boolean;
}

export function formatOid(oid: Oid, opts: FormatOpts = {}): string {
  if (opts.numeric) return "." + oid.join(".");
  const n = deepest(oid);
  if (!n) return "." + oid.join(".");
  const suffix = oid.slice(n.oid.length);
  return `${opts.short ? "" : `${n.module}::`}${n.name}${suffix.length ? "." + suffix.join(".") : ""}`;
}

/** net-snmp uptime_string(): "%d:%02d:%02d.%02d", with "N day(s), " prefix. */
export function uptimeString(ticks: number, quick = false): string {
  const cs = ticks % 100;
  let t = Math.floor(ticks / 100);
  const days = Math.floor(t / 86400);
  t %= 86400;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (quick) return `${days}:${h}:${p(m)}:${p(sec)}.${p(cs)}`;
  const hms = `${h}:${p(m)}:${p(sec)}.${p(cs)}`;
  return days === 0 ? hms : `${days} day${days === 1 ? "" : "s"}, ${hms}`;
}

const isPrintable = (b: number) => (b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d;

/** The value part of print_variable() (after "name = "). */
export function formatValue(oid: Oid, v: SnmpValue, opts: FormatOpts = {}): string {
  const q = !!opts.quick;
  const node = deepest(oid);
  // Only the object's own column/scalar carries its syntax (not its subtree parents).
  const obj = node && node.oid.length >= oid.length - 1 ? node : undefined;
  switch (v.type) {
    case "noSuchObject":
      return "No Such Object available on this agent at this OID";
    case "noSuchInstance":
      return "No Such Instance currently exists at this OID";
    case "endOfMibView":
      return "No more variables left in this MIB View (It is past the end of the MIB tree)";
    case "integer": {
      const label = obj?.enums?.[v.value];
      if (label === undefined) return q ? String(v.value) : `INTEGER: ${v.value}`;
      return q ? label : `INTEGER: ${label}(${v.value})`;
    }
    case "string": {
      if (obj?.syntax === "DisplayString") return `${q ? "" : "STRING: "}${bytesToString(v.value)}`;
      if (obj?.syntax === "PhysAddress") return `${q ? "" : "STRING: "}${v.value.map((b) => b.toString(16)).join(":")}`;
      if (v.value.length === 0) return '""';
      if (v.value.every(isPrintable)) return `${q ? "" : "STRING: "}"${bytesToString(v.value)}"`;
      const hex = v.value.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ") + " ";
      return q ? `"${hex}"` : `Hex-STRING: ${hex}`;
    }
    case "null":
      return q ? "" : "NULL";
    case "oid":
      return `${q ? "" : "OID: "}${formatOid(v.value, opts)}`;
    case "ipaddress":
      return `${q ? "" : "IpAddress: "}${v.value}`;
    case "counter32":
      return `${q ? "" : "Counter32: "}${v.value}`;
    case "gauge32":
      return `${q ? "" : "Gauge32: "}${v.value}`;
    case "counter64":
      return `${q ? "" : "Counter64: "}${v.value.toString()}`;
    case "timeticks":
      return q ? uptimeString(v.value, true) : `Timeticks: (${v.value}) ${uptimeString(v.value)}`;
  }
}

/** print_variable(): "NAME = TYPE: value" (or the -Oq / -Ov forms). */
export function formatVarBind(vb: VarBind, opts: FormatOpts = {}): string {
  const val = formatValue(vb.oid, vb.value, opts);
  if (opts.valueOnly) return val;
  return `${formatOid(vb.oid, opts)}${opts.quick ? " " : " = "}${val}`;
}

// ------------------------------------------------------------------ the agent's MIB view

export interface MibRow {
  oid: Oid;
  value: SnmpValue;
}

/** sonic_py_common.port_util.get_index_from_str (port_util.py:43-67, BaseIdx :20-27). */
export function sonicIfRow(name: string): number | undefined {
  const pats: [RegExp, number][] = [
    [/^Ethernet(\d+)$/, 1],
    [/^Ethernet-BP(\d+)$/, 9000],
    [/^Vlan(\d+)$/, 2000],
    [/^PortChannel(\d+)$/, 1000],
    [/^eth(\d+)$/, 10000],
    [/^Ethernet-IB(\d+)$/, 11000],
    [/^Ethernet-Rec(\d+)$/, 12000],
  ];
  for (const [re, base] of pats) {
    const m = name.match(re);
    if (m) return Number(m[1]) + base;
  }
  return undefined;
}

/** Interfaces sonic-snmpagent exposes: ports, LAGs, mgmt, VLAN SVIs (rfc1213.py:262-266). */
export function ifRows(device: Device): { row: number; iface: NetInterface; mgmt: boolean }[] {
  const rows: { row: number; iface: NetInterface; mgmt: boolean }[] = [];
  for (const iface of device.interfaces) {
    if (/^Loopback/.test(iface.name)) continue;
    const row = sonicIfRow(iface.name);
    if (row === undefined) continue;
    rows.push({ row, iface, mgmt: isSwitch(device.type) && row >= 10000 && row < 11000 });
  }
  return rows.sort((a, b) => a.row - b.row);
}

export const SYS_SERVICES = 72;

export function sysDescr(device: Device): string {
  // docker-snmp sysDescription.j2 (served by sysDescr_pass.py, snmpd.conf.j2:352).
  const hwsku = device.type === "router" || device.type === "firewall" ? "router" : "switch";
  return `SONiC Software Version: SONiC.Lab-Simulation - HwSku: ${hwsku} - Distribution: Debian 12.13 - Kernel: 6.1.0-29-2-amd64`;
}

const BIG = (n: number) => BigInt(Math.max(0, Math.floor(n)));

/** Build the full, sorted MIB view the agent serves right now. */
export function buildMib(device: Device, rt: AgentRuntime, nowMs: number): MibRow[] {
  const rows: MibRow[] = [];
  const ticks = Math.max(0, Math.floor((nowMs - rt.startedAt) / 10));
  const sys = (n: number, value: SnmpValue) => rows.push({ oid: [...o(SYS), n, 0], value });
  sys(1, str(sysDescr(device)));
  sys(2, { type: "oid", value: OIDS.netSnmpLinux });
  sys(3, { type: "timeticks", value: ticks });
  sys(4, str(rt.applied.contact));
  sys(5, str(rt.sysNameSet ?? device.config.hostname));
  sys(6, str(rt.applied.location));
  sys(7, { type: "integer", value: SYS_SERVICES });
  sys(8, { type: "timeticks", value: 0 });

  const ifs = ifRows(device);
  rows.push({ oid: o("1.3.6.1.2.1.2.1.0"), value: { type: "integer", value: ifs.length } });
  const st = (i: NetInterface) => i.statistics;
  for (const { row, iface, mgmt } of ifs) {
    const s = st(iface);
    // Management-port counters are not in COUNTERS_DB: sonic-snmpagent returns 0 (rfc1213.py:394-397).
    const c = (n: number | undefined) => (mgmt ? 0 : n ?? 0);
    const inNU = c((s.rxBroadcast ?? 0) + (s.rxMulticast ?? 0));
    const outNU = c((s.txBroadcast ?? 0) + (s.txMulticast ?? 0));
    const inU = c(s.rxFrames - (s.rxBroadcast ?? 0) - (s.rxMulticast ?? 0));
    const outU = c(s.txFrames - (s.txBroadcast ?? 0) - (s.txMulticast ?? 0));
    const status = (x: "up" | "down") => ({ type: "integer" as const, value: x === "up" ? 1 : 2 });
    const ifType = /^PortChannel/.test(iface.name) ? 161 : /^Vlan/.test(iface.name) ? 136 : 6; // rfc1213.py:569-588
    const c32 = (n: number): SnmpValue => ({ type: "counter32", value: n % 4294967296 });
    const cols: SnmpValue[] = [
      { type: "integer", value: row - 1 }, // if_index(): the 0-based id (rfc1213.py:313-319)
      str(iface.name), // alias (no PORT alias in the simulator → the name)
      { type: "integer", value: ifType },
      { type: "integer", value: 1500 },
      { type: "gauge32", value: Math.min(4294967295, iface.speed * 1_000_000) },
      str(""), // ifPhysAddress: placeholder '' (rfc1213.py:621-622)
      status(iface.adminState),
      status(iface.operState),
      { type: "timeticks", value: 0 }, // ifLastChange: placeholder 0 (rfc1213.py:631-632)
      c32(c(s.rxBytes)),
      c32(inU),
      c32(inNU),
      c32(c(s.rxDropped)),
      c32(0),
      c32(0),
      c32(c(s.txBytes)),
      c32(outU),
      c32(outNU),
      c32(c(s.txDropped)),
      c32(0),
      { type: "gauge32", value: 0 },
      { type: "oid", value: [0, 0] },
    ];
    cols.forEach((value, i) => rows.push({ oid: [...o(IFE), i + 1, row], value }));
    const x: SnmpValue[] = [
      str(iface.name), // ifName: the alias as well (rfc2863.py:184-202)
      c32(c(s.rxMulticast)),
      c32(c(s.rxBroadcast)),
      c32(c(s.txMulticast)),
      c32(c(s.txBroadcast)),
      { type: "counter64", value: BIG(c(s.rxBytes)) },
      { type: "counter64", value: BIG(inU) },
      { type: "counter64", value: BIG(c(s.rxMulticast)) },
      { type: "counter64", value: BIG(c(s.rxBroadcast)) },
      { type: "counter64", value: BIG(c(s.txBytes)) },
      { type: "counter64", value: BIG(outU) },
      { type: "counter64", value: BIG(c(s.txMulticast)) },
      { type: "counter64", value: BIG(c(s.txBroadcast)) },
      { type: "integer", value: 2 }, // ifLinkUpDownTrapEnable: disabled(2) (rfc2863.py:432)
      { type: "gauge32", value: iface.speed },
      { type: "integer", value: 1 }, // ifPromiscuousMode true(1)
      { type: "integer", value: 1 }, // ifConnectorPresent true(1)
      str(""), // ifAlias = PORT description, empty if unset (rfc2863.py:204-221)
      { type: "timeticks", value: 0 },
    ];
    x.forEach((value, i) => rows.push({ oid: [...o(IFX), i + 1, row], value }));
  }

  for (const [n, name] of SNMP_COUNTERS) rows.push({ oid: [...o(SNMPG), n, 0], value: { type: "counter32", value: rt.stats[name] ?? 0 } });
  rows.push({ oid: [...o(SNMPG), 30, 0], value: { type: "integer", value: rt.applied.authTraps ? 1 : 2 } });
  rows.push({ oid: [...o(SNMPG), 31, 0], value: { type: "counter32", value: rt.stats.snmpSilentDrops ?? 0 } });
  rows.push({ oid: [...o(SNMPG), 32, 0], value: { type: "counter32", value: 0 } });
  return rows.sort((a, b) => oidCompare(a.oid, b.oid));
}

/** Registered objects (scalars/columns): a GET under one with no instance is noSuchInstance. */
export function isKnownObject(oid: Oid): boolean {
  const n = deepest(oid);
  if (!n) return false;
  const s = n.oid.join(".");
  return (
    (s.startsWith(`${SYS}.`) && n.oid.length === 8) ||
    (s.startsWith(`${IFE}.`) && n.oid.length === 10) ||
    (s.startsWith(`${IFX}.`) && n.oid.length === 11) ||
    (s.startsWith(`${SNMPG}.`) && n.oid.length === 8) ||
    s === "1.3.6.1.2.1.2.1" ||
    n.name === "sysUpTimeInstance"
  );
}
