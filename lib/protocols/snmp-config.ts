/**
 * SNMP configuration (the simulated CONFIG_DB SNMP_* tables, device.config.features.snmp)
 * and the snmpd runtime state (device.config.features["snmp-agent"]).
 *
 * snmpd reads its configuration only at process start: the docker-snmp container
 * renders /etc/snmp/snmpd.conf from CONFIG_DB (dockers/docker-snmp/snmpd.conf.j2)
 * and every config path restarts the service to apply a change:
 *   - Click `config snmp ...`, `config snmptrap ...`, `config snmpagentaddress ...`
 *     run `systemctl restart snmp` synchronously (sonic-utilities config/main.py:3924,
 *     3974, 4135).
 *   - KLISH/REST writes restart it through snmp_post_xfmr, debounced 2 s after the last
 *     write and at most 10 s after the first (sonic-mgmt-common xfmr_snmp.go:776-780).
 * So the agent serves an `applied` snapshot taken at its last (re)start, not the live
 * tables. snmp_linktrapd, by contrast, re-reads SNMP|TRAPS and SNMP_TRAP on every
 * transition (dockers/docker-snmp/snmp_linktrapd:520-590), so link traps use live config.
 */
import { Device } from "../models/device";
import { featureState, peekFeatureState } from "../models/feature-state";
import { SecLevel, UsmUser } from "./snmp-usm";
import { systemMac } from "./lacp-daemon";

export type Access = "RO" | "RW";

export interface SnmpCommunity {
  name: string;
  access: Access;
}

/** SNMP_USER row (Click `config snmp user add`, config/main.py:4457-4532). */
export interface SnmpUser {
  name: string;
  permission: Access;
  /** SNMP_USER_TYPE (absent on rows written by the simulator's older `user add <n> ro|rw`). */
  type?: "noAuthNoPriv" | "AuthNoPriv" | "Priv";
  authType?: "MD5" | "SHA" | "HMAC-SHA-2";
  authPassword?: string;
  encType?: "DES" | "AES";
  encPassword?: string;
}

/** SNMP_TRAP_CONFIG row (Click `config snmptrap modify <ver> <ip>`). */
export interface TrapConfigDest {
  ip: string;
  port: number;
  vrf: string;
  community: string;
}

/** SNMP_TRAP row (KLISH `snmp-server host`), key ip|port. */
export interface TrapHost {
  ip: string;
  port: number;
  version?: "v2c" | "v3";
  community?: string;
  user?: string;
  sourceInterface?: string;
}

/** SNMP_AGENT_ADDRESS_CONFIG row, key ip|port|vrf (port "" = default 161). */
export interface AgentAddress {
  ip: string;
  port: string;
  vrf: string;
}

export interface SnmpState {
  communities: SnmpCommunity[];
  location: string | undefined;
  contact: string | undefined;
  users: SnmpUser[];
  agentAddresses?: AgentAddress[];
  trapConfig?: { v1?: TrapConfigDest; v2?: TrapConfigDest; v3?: TrapConfigDest };
  trapHosts?: TrapHost[];
  /** SNMP|TRAPS.traps_enabled (undefined = row absent). */
  trapsEnabled?: boolean;
  /** SNMP|TRAPS.authen_traps. */
  authenTraps?: boolean;
}

export function snmpConfig(device: Device): SnmpState {
  return featureState<SnmpState>(device, "snmp", () => ({ communities: [], location: undefined, contact: undefined, users: [] }));
}

export const peekSnmpConfig = (device: Device): SnmpState | undefined => peekFeatureState<SnmpState>(device, "snmp");

/** What snmpd.conf.j2 rendered at the last start. */
export interface AppliedConfig {
  communities: SnmpCommunity[];
  /** sysLocation (snmpd.conf.j2:182-186: default "public"). */
  location: string;
  /** sysContact (snmpd.conf.j2:187-191). */
  contact: string;
  /** trap2sink lines (v2c). */
  sinks: { ip: string; port: number; community: string }[];
  /** agentAddress lines; empty = udp:161 on every address. */
  listen: { ip: string; port: number }[];
  /** authtrapenable 1 (snmpd.conf.j2:310). */
  authTraps: boolean;
  /** trapsink lines (SNMPv1 Trap-PDUs): v1TrapDest and — as the template renders it — v3TrapDest. */
  v1Sinks: { ip: string; port: number; community: string }[];
  /** trapsess -v 3 lines for SNMP_TRAP v3 rows (snmpd.conf.j2:272-300). */
  v3Sinks: { ip: string; port: number; user: string; level: SecLevel; usm: UsmUser }[];
  /** USM users: rouser/rwuser <user> <level> + CreateUser (snmpd.conf.j2:153-172). */
  users: AppliedUser[];
  /** exactEngineID (snmpd.conf.j2:68-72): 0x8000013703 + the system MAC. */
  engineId: number[];
}

export interface AppliedUser {
  name: string;
  permission: Access;
  /** Minimum security level of the rouser/rwuser line. */
  minLevel: SecLevel;
  usm: UsmUser;
}

const LEVEL: Record<string, SecLevel> = { noAuthNoPriv: "noAuthNoPriv", AuthNoPriv: "authNoPriv", Priv: "authPriv" }; // snmp_linktrapd SECURITY_LEVEL_MAP

/** CreateUser credentials net-snmp can use here (HMAC-SHA-2 → SHA-256 and DES are not modelled). */
function usmOf(u: SnmpUser): UsmUser {
  const auth = u.authType === "MD5" || u.authType === "SHA" ? u.authType : undefined;
  return { name: u.name, authProto: auth, authPassword: u.authPassword, privProto: auth && u.encType ? u.encType : undefined, privPassword: u.encPassword };
}

/** sonic-cfggen snmp_engine_id(mac, "default") = 0x8000013703 + MAC (sonic-cfggen:368-375). */
export function snmpEngineId(device: Device): number[] {
  return [0x80, 0x00, 0x01, 0x37, 0x03, ...systemMac(device).split(":").map((x) => parseInt(x, 16))];
}

export const DEFAULT_CONTACT = "Azure Cloud Switch vteam <linuxnetdev@microsoft.com>";

export function renderApplied(device: Device): AppliedConfig {
  const c = peekSnmpConfig(device);
  const sinks: AppliedConfig["sinks"] = [];
  // snmpd.conf.j2:248-256 — SNMP_TRAP_CONFIG v2TrapDest -> trap2sink (v1TrapDest and
  // v3TrapDest render `trapsink`, i.e. SNMPv1 traps: v1Sinks below).
  if (c?.trapConfig?.v2) sinks.push({ ip: c.trapConfig.v2.ip, port: c.trapConfig.v2.port, community: c.trapConfig.v2.community });
  // snmpd.conf.j2:272-306 — SNMP_TRAP: v3 -> trapsess (v3Sinks below), anything else -> trap2sink.
  for (const h of c?.trapHosts ?? []) if (h.version !== "v3") sinks.push({ ip: h.ip, port: h.port, community: h.community ?? "public" });
  // snmpd.conf.j2:41-66 — only local (or wildcard) agent addresses are emitted; none -> udp:161.
  const local = new Set(device.interfaces.flatMap((i) => i.ipv4.map((a) => a.address)));
  const listen = (c?.agentAddresses ?? [])
    .filter((a) => ["0.0.0.0", "::", "::0", ""].includes(a.ip) || local.has(a.ip))
    .map((a) => ({ ip: a.ip, port: a.port ? Number(a.port) : 161 }));
  const users: AppliedUser[] = (c?.users ?? []).map((u) => ({ name: u.name, permission: u.permission, minLevel: LEVEL[u.type ?? "noAuthNoPriv"] ?? "noAuthNoPriv", usm: usmOf(u) }));
  const v1Sinks: AppliedConfig["v1Sinks"] = [];
  for (const d of [c?.trapConfig?.v1, c?.trapConfig?.v3]) if (d) v1Sinks.push({ ip: d.ip, port: d.port, community: d.community });
  // trapsess only when the referenced user's credentials fit its level (snmpd.conf.j2:272-300).
  const v3Sinks: AppliedConfig["v3Sinks"] = [];
  for (const h of c?.trapHosts ?? []) {
    if (h.version !== "v3" || !h.user) continue;
    const u = users.find((x) => x.name === h.user);
    if (!u) continue;
    const ok = u.minLevel === "noAuthNoPriv" || (u.usm.authProto && u.usm.authPassword && (u.minLevel === "authNoPriv" || (u.usm.privProto && u.usm.privPassword)));
    if (ok) v3Sinks.push({ ip: h.ip, port: h.port, user: u.name, level: u.minLevel, usm: u.usm });
  }
  return {
    // snmpd.conf.j2:131-151 — only communities with TYPE RO/RW get com2sec/group/access.
    communities: (c?.communities ?? []).map((x) => ({ ...x })),
    v1Sinks,
    v3Sinks,
    users,
    engineId: snmpEngineId(device),
    location: c?.location ?? "public",
    contact: c?.contact ?? DEFAULT_CONTACT,
    sinks,
    listen,
    authTraps: c?.authenTraps === true,
  };
}

export interface LinkSeen {
  admin: "up" | "down";
  oper: "up" | "down";
}

/** snmpd + snmp_linktrapd process state. */
export interface AgentRuntime {
  /** Wall ms the box booted (system uptime base for snmptrap's sysUpTime). */
  bootAt: number;
  /** Wall ms snmpd last started (sysUpTime.0 base). */
  startedAt: number;
  applied: AppliedConfig;
  /** Pending service restart (wall ms) and the KLISH burst deadline. */
  restartAt?: number;
  burstDeadline?: number;
  /** Send coldStart on the next tick (process just started). */
  coldStartPending?: boolean;
  /** sysName.0 written by an SNMP SET (persisted by net-snmp in /var/lib/snmp). */
  sysNameSet?: string;
  /** snmp_linktrapd's last-seen PORT_TABLE state per Ethernet port. */
  links: Record<string, LinkSeen>;
  /** SNMPv2-MIB snmp group counters since snmpd started. */
  stats: Record<string, number>;
  /** Ephemeral source-port / request-id generators. */
  seq: number;
  /** snmpEngineBoots (persisted by net-snmp, +1 at every snmpd start). */
  engineBoots?: number;
}

export const peekAgent = (device: Device): AgentRuntime | undefined => peekFeatureState<AgentRuntime>(device, "snmp-agent");

/** Create the runtime on first use. `boot` = the process came up with the current config. */
export function ensureAgent(device: Device, nowMs: number, boot: boolean): AgentRuntime {
  return featureState<AgentRuntime>(device, "snmp-agent", () => ({
    bootAt: nowMs,
    startedAt: nowMs,
    // Created by a config write: the box booted earlier with no SNMP config, the
    // write's restart applies it. Created by the daemon: boot with what is configured.
    applied: boot ? renderApplied(device) : renderApplied({ ...device, config: { ...device.config, features: {} } }),
    coldStartPending: boot,
    links: {},
    stats: {},
    seq: 0,
  }));
}

/**
 * Restart snmp to apply a config change. `click` = synchronous systemctl restart;
 * `klish` = snmp_post_xfmr debounce (2 s quiet, 10 s max deferral).
 */
export function requestSnmpRestart(device: Device, kind: "click" | "klish", nowMs = Date.now()): void {
  const rt = ensureAgent(device, nowMs, false);
  if (kind === "click") {
    rt.restartAt = nowMs;
    rt.burstDeadline = undefined;
    return;
  }
  if (rt.burstDeadline === undefined || rt.restartAt === undefined) rt.burstDeadline = nowMs + 10_000;
  rt.restartAt = Math.min(nowMs + 2_000, rt.burstDeadline);
}
