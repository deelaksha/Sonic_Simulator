/**
 * ACL rule model shared by the config modules (lib/commands/sonic/acl.ts,
 * KLISH features/acl.ts) and the data-plane hook (acl-daemon.ts).
 *
 * State lives in device.config.features.acl (the simulated CONFIG_DB):
 *   tables   ACL_TABLE|<name>   type, stage (one per table), ports@ bindings
 *   rules    ACL_RULE|<name>|RULE_<seq>   stored as the typed match string
 *   counters COUNTERS_DB per rule (+ the aclorch-generated DEFAULT_DROP_ANY)
 *
 * Grounded in (sonic-buildimage/src):
 *   sonic-mgmt-common/translib/transformer/xfmr_acl.go:2228-2285
 *       PRIORITY = 65536 - seq  → lowest seq evaluated first, first match wins
 *   xfmr_acl.go:2322-2341   IP_TYPE IPV4ANY / IPV6ANY for ip/ipv6 ACLs (an
 *       IPv4 rule never matches ARP/IPv6), ANY for MAC ACLs
 *   sonic-swss/orchagent/aclorch.cpp:4742-4801 addDefaultDenyRule: implicit
 *       lowest-priority DROP "DEFAULT_DROP_ANY" scoped to IPV4ANY (L3) /
 *       IPV6ANY (L3V6); none for L2 (MAC) tables
 *   sonic-mgmt-framework/CLI/actioner/sonic_cli_acl.py:416-575 rule_data
 *       rendering (host/any, eq/gt/lt/range, dscp names, flags, ethertype, pcp)
 */
import { Frame } from "../models/packet";
import { ipToInt, isValidIpv4, prefixToMaskInt } from "../models/ip";
import { parseIpv6, prefixMask6, formatIpv6 } from "../models/ipv6";

export type AclType = "ip" | "ipv6" | "mac";

export interface AclRule {
  seq: number;
  action: string;
  match: string;
  remark?: string;
}

export interface AclTable {
  name: string;
  type?: string;
  stage?: string;
  ports: string[];
  description?: string;
}

export interface AclCounter {
  packets: number;
  bytes: number;
}

export interface AclState {
  tables: AclTable[];
  rules: Record<string, AclRule[]>;
  /** "<table>|RULE_<seq>" / "<table>|DEFAULT_DROP_ANY" → hits. */
  counters?: Record<string, AclCounter>;
  /** `aclshow -c` snapshot (sonic-utilities scripts/aclshow clear_counters). */
  aclshowBaseline?: Record<string, AclCounter>;
}

/** aclorch.h:99 DEFAULT_DENY_RULE_ID. */
export const DEFAULT_DENY = "DEFAULT_DROP_ANY";
export const ruleName = (seq: number): string => `RULE_${seq}`;
export const counterKey = (table: string, rule: string): string => `${table}|${rule}`;
/** xfmr_acl.go:2285 */
export const priorityOf = (seq: number): number => 65536 - seq;

// ---------------------------------------------------------------------------
// Parsed rule
// ---------------------------------------------------------------------------

interface Range {
  lo: number;
  hi: number;
}
type Addr = { v4: true; net: number; prefix: number; text: string } | { v4: false; net: bigint; prefix: number; text: string };
interface MacMatch {
  mac: string; // lower-case aa:bb:cc:dd:ee:ff
  mask?: string;
}

export interface ParsedRule {
  family: AclType;
  proto?: number;
  src?: Addr;
  dst?: Addr;
  sport?: Range;
  dport?: Range;
  dscp?: number;
  flagsSet: string[];
  flagsClear: string[];
  established?: boolean;
  icmpType?: number;
  icmpCode?: number;
  vlan?: number;
  srcMac?: MacMatch;
  dstMac?: MacMatch;
  etherType?: number;
  pcp?: number;
  dei?: number;
}

/** sonic_cli_acl.py:120-126 */
export const DSCP: Record<string, number> = {
  default: 0, cs1: 8, cs2: 16, cs3: 24, cs4: 32, cs5: 40, cs6: 48, cs7: 56,
  af11: 10, af12: 12, af13: 14, af21: 18, af22: 20, af23: 22,
  af31: 26, af32: 28, af33: 30, af41: 34, af42: 36, af43: 38,
  ef: 46, "voice-admit": 44,
};
/** sonic_cli_acl.py:112-115 */
const PCP: Record<string, number> = { be: 0, bk: 1, ee: 2, ca: 3, vi: 4, vo: 5, ic: 6, nc: 7 };
const ETHERTYPE: Record<string, number> = { ip: 0x0800, ipv6: 0x86dd, arp: 0x0806 };
const TCP_FLAG_BITS: Record<string, number> = { FIN: 0x01, SYN: 0x02, RST: 0x04, PSH: 0x08, ACK: 0x10, URG: 0x20 };
const FLAG_ORDER = ["fin", "syn", "rst", "psh", "ack", "urg"];

const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;
const normMac = (m: string): string => m.toLowerCase().replace(/-/g, ":");

export class AclParseError extends Error {}

const num = (tok: string | undefined, lo: number, hi: number, what: string): number => {
  const n = Number(tok);
  if (tok === undefined || !/^\d+$/.test(tok) || n < lo || n > hi) throw new AclParseError(`Invalid ${what} '${tok ?? ""}' (${lo}-${hi})`);
  return n;
};

function parseAddr(toks: string[], v4: boolean): Addr | undefined {
  const t = toks.shift();
  if (t === undefined) throw new AclParseError("Incomplete command");
  if (t === "any") return undefined;
  let a = t;
  let prefix = v4 ? 32 : 128;
  if (t === "host") {
    a = toks.shift() ?? "";
  } else if (t.includes("/")) {
    const [x, p] = t.split("/");
    a = x;
    prefix = num(p, 0, v4 ? 32 : 128, "prefix length");
  }
  if (v4) {
    if (!isValidIpv4(a)) throw new AclParseError(`Invalid IPv4 address '${a}'`);
    const net = (ipToInt(a) & prefixToMaskInt(prefix)) >>> 0;
    return { v4: true, net, prefix, text: a };
  }
  const n = parseIpv6(a);
  if (n === null) throw new AclParseError(`Invalid IPv6 address '${a}'`);
  return { v4: false, net: n & prefixMask6(prefix), prefix, text: formatIpv6(n) };
}

function parsePortOp(toks: string[]): Range | undefined {
  const op = toks[0];
  if (op === "eq") {
    toks.shift();
    const p = num(toks.shift(), 0, 65535, "port");
    return { lo: p, hi: p };
  }
  if (op === "gt") {
    toks.shift();
    return { lo: num(toks.shift(), 0, 65534, "port") + 1, hi: 65535 }; // sonic_cli_acl.py:929-931
  }
  if (op === "lt") {
    toks.shift();
    return { lo: 0, hi: num(toks.shift(), 1, 65535, "port") - 1 };
  }
  if (op === "range") {
    toks.shift();
    const lo = num(toks.shift(), 0, 65534, "port");
    const hi = num(toks.shift(), 1, 65535, "port");
    if (lo >= hi) throw new AclParseError(`Invalid range. Begin(${lo}) is not lesser than End(${hi})`); // :938
    return { lo, hi };
  }
  return undefined;
}

function parseMacSpec(toks: string[], maskFollows: (rest: string[]) => boolean): MacMatch | undefined {
  const t = toks.shift();
  if (t === undefined) throw new AclParseError("Incomplete command");
  if (t === "any") return undefined;
  if (t === "host") {
    const m = toks.shift() ?? "";
    if (!MAC_RE.test(m)) throw new AclParseError(`Invalid MAC address '${m}'`);
    return { mac: normMac(m) };
  }
  if (!MAC_RE.test(t)) throw new AclParseError(`Invalid MAC address '${t}'`);
  if (toks[0] && MAC_RE.test(toks[0]) && maskFollows(toks.slice(1))) {
    const mask = normMac(toks.shift()!);
    return mask === "ff:ff:ff:ff:ff:ff" ? { mac: normMac(t) } : { mac: normMac(t), mask };
  }
  return { mac: normMac(t) };
}

const PARSE_CACHE = new Map<string, ParsedRule>();

/** Parse a rule's match tokens (everything after `seq N permit|deny`, remark stripped). */
export function parseRule(family: AclType, match: string): ParsedRule {
  const key = `${family}|${match}`;
  const hit = PARSE_CACHE.get(key);
  if (hit) return hit;
  const toks = match.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  const r: ParsedRule = { family, flagsSet: [], flagsClear: [] };
  if (family === "mac") {
    r.srcMac = parseMacSpec(toks, (rest) => rest.length > 0 && (rest[0] === "any" || rest[0] === "host" || MAC_RE.test(rest[0])));
    r.dstMac = parseMacSpec(toks, () => true);
    if (toks[0] && (ETHERTYPE[toks[0]] !== undefined || /^0x[0-9a-f]{1,4}$/.test(toks[0]))) {
      const t = toks.shift()!;
      r.etherType = ETHERTYPE[t] ?? parseInt(t, 16);
      if (r.etherType < 0x600) throw new AclParseError(`Invalid ethertype '${t}' (0x0600-0xffff)`);
    }
    while (toks.length) {
      const t = toks.shift()!;
      if (t === "vlan") r.vlan = num(toks.shift(), 1, 4095, "VLAN ID");
      else if (t === "pcp") {
        const p = toks.shift() ?? "";
        r.pcp = PCP[p] ?? num(p, 0, 7, "PCP");
      } else if (t === "dei") r.dei = num(toks.shift(), 0, 1, "DEI");
      else throw new AclParseError(`Invalid input '${t}'`);
    }
  } else {
    const v4 = family === "ip";
    const p = toks.shift();
    if (p === undefined) throw new AclParseError("Incomplete command");
    if (p === (v4 ? "ip" : "ipv6")) r.proto = undefined;
    else if (p === "tcp") r.proto = 6;
    else if (p === "udp") r.proto = 17;
    else if (v4 && p === "icmp") r.proto = 1;
    else if (!v4 && p === "icmpv6") r.proto = 58;
    else r.proto = num(p, 0, 255, "protocol");
    const l4 = r.proto === 6 || r.proto === 17;
    r.src = parseAddr(toks, v4);
    if (l4) r.sport = parsePortOp(toks);
    r.dst = parseAddr(toks, v4);
    if (l4) r.dport = parsePortOp(toks);
    while (toks.length) {
      const t = toks.shift()!;
      const flag = t.replace(/^not-/, "");
      if (t === "dscp") {
        const d = toks.shift() ?? "";
        r.dscp = DSCP[d] ?? num(d, 0, 63, "DSCP");
      } else if (r.proto === 6 && (t === "established" || t === "tcp-established")) r.established = true;
      else if (r.proto === 6 && FLAG_ORDER.includes(flag)) (t.startsWith("not-") ? r.flagsClear : r.flagsSet).push(flag.toUpperCase());
      else if ((r.proto === 1 || r.proto === 58) && t === "type") r.icmpType = num(toks.shift(), 0, 255, "ICMP type");
      else if ((r.proto === 1 || r.proto === 58) && t === "code") r.icmpCode = num(toks.shift(), 0, 255, "ICMP code");
      else if (t === "vlan") r.vlan = num(toks.shift(), 1, 4095, "VLAN ID");
      else throw new AclParseError(`Invalid input '${t}'`);
    }
  }
  PARSE_CACHE.set(key, r);
  return r;
}

/** Split a trailing per-rule `remark <text>` off the match tokens. */
export function splitRemark(match: string): { match: string; remark?: string } {
  const toks = match.trim().split(/\s+/);
  const i = toks.findIndex((t) => t.toLowerCase() === "remark");
  if (i < 0) return { match: toks.join(" ") };
  return { match: toks.slice(0, i).join(" "), remark: toks.slice(i + 1).join(" ") || undefined };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const ICMP_TYPE: Record<string, number> = { "echo-reply": 0, "dest-unreachable": 3, "echo-request": 8, "time-exceeded": 11 };
const ICMP6_TYPE: Record<string, number> = {
  "dest-unreachable": 1, "time-exceeded": 3, "echo-request": 128, "echo-reply": 129,
  "neighbor-solicitation": 135, "neighbor-advertisement": 136,
};
const IPPROTO: Record<string, number> = { ICMP: 1, TCP: 6, UDP: 17, OSPF: 89, ICMPv6: 58 };

function etherTypeOf(f: Frame): number {
  const e = f.ethernet.etherType;
  if (e === "IPv4") return 0x0800;
  if (e === "IPv6") return 0x86dd;
  if (e === "ARP") return 0x0806;
  return f.ethernet.typeCode ?? 0;
}

const inRange = (v: number | undefined, r: Range | undefined): boolean => !r || (v !== undefined && v >= r.lo && v <= r.hi);

function macHit(m: MacMatch | undefined, mac: string): boolean {
  if (!m) return true;
  const a = normMac(mac).split(":").map((x) => parseInt(x, 16));
  const b = m.mac.split(":").map((x) => parseInt(x, 16));
  const k = (m.mask ?? "ff:ff:ff:ff:ff:ff").split(":").map((x) => parseInt(x, 16));
  return a.every((v, i) => (v & k[i]) === (b[i] & k[i]));
}

function addrHit(a: Addr | undefined, ip: string): boolean {
  if (!a) return true;
  if (a.v4) return ((ipToInt(ip) & prefixToMaskInt(a.prefix)) >>> 0) === a.net;
  const n = parseIpv6(ip);
  return n !== null && (n & prefixMask6(a.prefix)) === a.net;
}

/**
 * Does the rule match this frame? `vid` is the VLAN the frame is classified
 * into on this port (null on routed ports). ip/ipv6 rules carry IP_TYPE
 * IPV4ANY/IPV6ANY so they never match other ethertypes (xfmr_acl.go:2334-2337).
 */
export function ruleMatches(r: ParsedRule, f: Frame, vid: number | null): boolean {
  if (r.vlan !== undefined && r.vlan !== (f.vlan?.vlanId ?? vid)) return false;
  if (r.family === "mac") {
    if (!macHit(r.srcMac, f.ethernet.srcMac) || !macHit(r.dstMac, f.ethernet.dstMac)) return false;
    if (r.etherType !== undefined && r.etherType !== etherTypeOf(f)) return false;
    if (r.pcp !== undefined && r.pcp !== (f.vlan?.priority ?? 0)) return false;
    if (r.dei !== undefined && r.dei !== 0) return false; // DEI is not modelled on frames (always 0)
    return true;
  }
  let src: string;
  let dst: string;
  let proto: number;
  let icmpType: number | undefined;
  let icmpCode: number | undefined;
  if (r.family === "ip") {
    if (!f.ipv4) return false;
    src = f.ipv4.srcIp;
    dst = f.ipv4.dstIp;
    proto = f.ipv4.protocol === "OTHER" ? f.ipv4.protocolNumber ?? -1 : IPPROTO[f.ipv4.protocol];
    if (f.icmp) [icmpType, icmpCode] = [ICMP_TYPE[f.icmp.type], f.icmp.code];
  } else {
    if (!f.ipv6) return false;
    src = f.ipv6.srcIp;
    dst = f.ipv6.dstIp;
    proto = IPPROTO[f.ipv6.nextHeader] ?? -1;
    if (f.icmp6) [icmpType, icmpCode] = [ICMP6_TYPE[f.icmp6.type], f.icmp6.code];
  }
  if (r.proto !== undefined && r.proto !== proto) return false;
  if (!addrHit(r.src, src) || !addrHit(r.dst, dst)) return false;
  const l4 = f.tcp ?? f.udp;
  if (!inRange(l4?.srcPort, r.sport) || !inRange(l4?.dstPort, r.dport)) return false;
  if (r.dscp !== undefined && r.dscp !== (f.ipv4?.dscp ?? 0)) return false;
  if (r.icmpType !== undefined && r.icmpType !== icmpType) return false;
  if (r.icmpCode !== undefined && r.icmpCode !== icmpCode) return false;
  if (r.flagsSet.length || r.flagsClear.length || r.established) {
    const flags = f.tcp?.flags ?? [];
    if (!f.tcp) return false;
    if (!r.flagsSet.every((x) => flags.includes(x)) || r.flagsClear.some((x) => flags.includes(x))) return false;
    if (r.established && !flags.includes("ACK") && !flags.includes("RST")) return false;
  }
  return true;
}

/** Does this table's implicit deny (aclorch DEFAULT_DROP_ANY) apply to the frame? */
export function implicitDenyApplies(type: AclType, f: Frame): boolean {
  if (type === "ip") return !!f.ipv4; // IPV4ANY
  if (type === "ipv6") return !!f.ipv6; // IPV6ANY
  return false; // L2: no implicit deny (aclorch.cpp:4747-4759)
}

/** Does a table of this type look at the frame at all? */
export function tableSees(type: AclType, f: Frame): boolean {
  return type === "mac" || implicitDenyApplies(type, f);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const DSCP_NAME: Record<number, string> = Object.fromEntries(Object.entries(DSCP).map(([k, v]) => [v, k]));
const PCP_NAME: Record<number, string> = Object.fromEntries(Object.entries(PCP).map(([k, v]) => [v, k]));

function addrText(a: Addr | undefined): string {
  if (!a) return "any";
  if (a.prefix === (a.v4 ? 32 : 128)) return `host ${a.text}`;
  return `${a.text}/${a.prefix}`;
}

/** sonic_cli_acl.py:389-414 _convert_oc_l4_port_to_user_fmt */
function portText(r: Range | undefined): string[] {
  if (!r) return [];
  if (r.lo === r.hi) return ["eq", String(r.lo)];
  if (r.lo === 0 && r.hi < 65535) return ["lt", String(r.hi + 1)];
  if (r.lo > 0 && r.hi === 65535) return ["gt", String(r.lo - 1)];
  return ["range", String(r.lo), String(r.hi)];
}

function protoText(r: ParsedRule): string {
  if (r.proto === undefined) return r.family === "ip" ? "ip" : "ipv6";
  return { 1: "icmp", 6: "tcp", 17: "udp", 58: "icmpv6" }[r.proto] ?? String(r.proto);
}

const macText = (m: MacMatch | undefined): string[] => (!m ? ["any"] : m.mask ? [m.mac, m.mask] : ["host", m.mac]);

/** rule_data tokens as `show ip|ipv6|mac access-lists` prints them (sonic_cli_acl.py:416-603). */
export function ruleData(type: AclType, rule: AclRule): string {
  const out: string[] = [rule.action];
  let r: ParsedRule;
  try {
    r = parseRule(type, rule.match);
  } catch {
    return `${rule.action} ${rule.match}`;
  }
  if (type === "mac") {
    out.push(...macText(r.srcMac), ...macText(r.dstMac));
    if (r.etherType !== undefined) {
      const name = Object.entries(ETHERTYPE).find(([, v]) => v === r.etherType)?.[0];
      out.push(name ?? `0x${r.etherType.toString(16).padStart(4, "0")}`);
    }
    if (r.vlan !== undefined) out.push("vlan", String(r.vlan));
    if (r.pcp !== undefined) out.push("pcp", PCP_NAME[r.pcp] ?? String(r.pcp));
    if (r.dei !== undefined) out.push("dei", String(r.dei));
    return out.join(" ");
  }
  out.push(protoText(r), addrText(r.src), ...portText(r.sport), addrText(r.dst), ...portText(r.dport));
  if (r.dscp !== undefined) out.push("dscp", DSCP_NAME[r.dscp] ?? String(r.dscp));
  for (const f of FLAG_ORDER) {
    if (r.flagsSet.includes(f.toUpperCase())) out.push(f);
    if (r.flagsClear.includes(f.toUpperCase())) out.push(`not-${f}`);
  }
  if (r.established) out.push("established");
  if (r.icmpType !== undefined) out.push("type", String(r.icmpType));
  if (r.icmpCode !== undefined) out.push("code", String(r.icmpCode));
  if (r.vlan !== undefined) out.push("vlan", String(r.vlan));
  return out.join(" ");
}

/** The ACL_RULE row (CONFIG_DB) the transformer writes for a rule (xfmr_acl.go:2285-2500). */
export function ruleFields(type: AclType, rule: AclRule): Record<string, string> {
  const f: Record<string, string> = {
    PRIORITY: String(priorityOf(rule.seq)),
    PACKET_ACTION: rule.action === "deny" ? "DROP" : "FORWARD",
    IP_TYPE: type === "ip" ? "IPV4ANY" : type === "ipv6" ? "IPV6ANY" : "ANY",
  };
  let r: ParsedRule;
  try {
    r = parseRule(type, rule.match);
  } catch {
    return f;
  }
  const port = (k: string, p: Range | undefined) => {
    if (!p) return;
    if (p.lo === p.hi) f[k] = String(p.lo);
    else f[`${k}_RANGE`] = `${p.lo}-${p.hi}`;
  };
  if (type === "mac") {
    if (r.srcMac) f.SRC_MAC = r.srcMac.mask ? `${r.srcMac.mac}/${r.srcMac.mask}` : r.srcMac.mac;
    if (r.dstMac) f.DST_MAC = r.dstMac.mask ? `${r.dstMac.mac}/${r.dstMac.mask}` : r.dstMac.mac;
    if (r.etherType !== undefined) f.ETHER_TYPE = `0x${r.etherType.toString(16).toUpperCase().padStart(4, "0")}`;
    if (r.pcp !== undefined) f.PCP = String(r.pcp);
    if (r.dei !== undefined) f.DEI = String(r.dei);
  } else {
    const any = type === "ip" ? "0.0.0.0/0" : "::/0";
    const [s, d] = type === "ip" ? ["SRC_IP", "DST_IP"] : ["SRC_IPV6", "DST_IPV6"];
    f[s] = r.src ? `${r.src.text}/${r.src.prefix}` : any;
    f[d] = r.dst ? `${r.dst.text}/${r.dst.prefix}` : any;
    if (r.proto !== undefined) f.IP_PROTOCOL = String(r.proto);
    port("L4_SRC_PORT", r.sport);
    port("L4_DST_PORT", r.dport);
    if (r.dscp !== undefined) f.DSCP = String(r.dscp);
    if (r.flagsSet.length || r.flagsClear.length) {
      const v = r.flagsSet.reduce((a, x) => a | TCP_FLAG_BITS[x], 0);
      const m = [...r.flagsSet, ...r.flagsClear].reduce((a, x) => a | TCP_FLAG_BITS[x], 0);
      f.TCP_FLAGS = `0x${v.toString(16).padStart(2, "0")}/0x${m.toString(16).padStart(2, "0")}`;
    }
    const icmp = type === "ip" ? "ICMP" : "ICMPV6";
    if (r.icmpType !== undefined) f[`${icmp}_TYPE`] = String(r.icmpType);
    if (r.icmpCode !== undefined) f[`${icmp}_CODE`] = String(r.icmpCode);
  }
  if (r.vlan !== undefined) f.VLAN_ID = String(r.vlan);
  return f;
}

/** CONFIG_DB ACL_TABLE type for a KLISH ACL type (L3 / L3V6 / L2). */
export function sonicTableType(type: string | undefined): string {
  return type === "ipv6" ? "L3V6" : type === "mac" ? "L2" : "L3";
}

/** Minimal `tabulate(..., tablefmt="simple")`: numeric columns right-aligned. */
export function tabulate(headers: string[], rows: string[][]): string[] {
  const numeric = headers.map((_, c) => rows.length > 0 && rows.every((r) => r[c] === "" || /^-?\d+$/.test(r[c] ?? "")));
  const w = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? "").length)));
  const fmt = (cells: string[]) =>
    cells
      .map((v, c) => (numeric[c] ? (v ?? "").padStart(w[c]) : (v ?? "").padEnd(w[c])))
      .join("  ")
      .replace(/\s+$/, "");
  return [fmt(headers), w.map((n) => "-".repeat(n)).join("  "), ...rows.map(fmt)];
}
