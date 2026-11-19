/**
 * NAT / NAPT engine: translates routed IPv4 traffic from the KLISH NAT config
 * (features.cp_nat, lib/commands/sonic-cli/features/nat.ts) and keeps the
 * translation table, counters and the `show nat ...` renderings.
 *
 * Grounded in (sonic-buildimage/src):
 *   sonic-swss/cfgmgr/natmgr.h:61-73     timeouts: nat 600 s, tcp 86400 s, udp 300 s (defaults)
 *   sonic-swss/cfgmgr/natmgr.cpp:887-913 a packet is marked with the zone of the interface it enters
 *       (PREROUTING) / leaves (POSTROUTING); NAT rules match on that mark
 *   natmgr.cpp:950-990   static NAT: DNAT -d global → local on ingress from the zone, SNAT -s local → global on
 *       egress to the zone; nat_type snat swaps the roles (no zone mark)
 *   natmgr.cpp:1000-1040 static NAPT: the same per protocol + L4 port
 *   natmgr.cpp:1140-1180 dynamic (pool binding): SNAT for -p tcp/udp/icmp to the pool IP[:port range]
 *       --fullcone, optionally limited by the binding's ACL (permit = translate, deny/no match = not)
 *   sonic-swss/natsyncd/natsync.cpp:215-217 ICMP translations are done by the kernel only ("Don't add ICMP
 *       NAT entries to hardware"), so they never appear in the ASIC NAT table / `show nat translations`
 *   natsync.cpp:560-575, 660-675 every TCP/UDP conntrack entry is written as a pair: SNAT keyed by the inside
 *       address and the reverse DNAT keyed by the translated address (APPL_DB NAPT_TABLE)
 *   sonic-utilities/scripts/natshow   `show nat translations [count]` / `show nat statistics` layout
 *
 * Simulator simplifications: NAT happens on routed packets that cross from one
 * zone into a non-zero (outside) zone; a global/pool address that is not on any
 * interface subnet is accepted for any outside zone (the real box needs it on an
 * interface or loopback of that zone, natmgr.cpp:890). Twice-NAT and hairpinning
 * are not modelled. ICMP translations are aged by the kernel conntrack ICMP
 * timeout (nf_conntrack_icmp_timeout, 30 s).
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame, cloneFrame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { cidrContains, intToIp, ipToInt } from "../models/ip";
import { inetChecksum } from "../sflow/wire";
import { cpGet, cpList } from "../commands/sonic-cli/config-plane";
import { AclState, parseRule, ruleMatches } from "./acl-rules";

export type NatProto = "tcp" | "udp" | "icmp";

/** One dynamic translation (conntrack entry): inside ip:port ↔ outside ip:port. */
export interface NatEntry {
  proto: NatProto;
  inIp: string;
  inPort: number;
  outIp: string;
  outPort: number;
  /** wall ms of the last translated packet (aging) */
  lastMs: number;
}

interface Counter {
  pkts: number;
  bytes: number;
}

export interface NatRuntime {
  entries: NatEntry[];
  /** "<snat|dnat>|<APPL_DB key>" → COUNTERS_NAT / COUNTERS_NAPT */
  counters: Record<string, Counter>;
}

const DEFAULT_TIMEOUT = { nat: 600, tcp: 86400, udp: 300 };
const ICMP_TIMEOUT_SEC = 30;

const runtime = (d: Device) => featureState<NatRuntime>(d, "_nat", () => ({ entries: [], counters: {} }));
export const peekNat = (d: Device) => peekFeatureState<NatRuntime>(d, "_nat");

export function natEnabled(device: Device): boolean {
  return cpGet(device, "nat")?.admin_mode === "enabled";
}

/** INTERFACE|<port> nat_zone (default 0). */
export function zoneOf(device: Device, iface: NetInterface): number {
  const z = cpList(device, "nat", "zones").find((r) => r.port === iface.name);
  return z ? Number(z.zone) : 0;
}

/** May NAT for `globalIp` happen toward / from `zone`? (natmgr marks rules with the global IP's interface zone.) */
function zoneAllows(device: Device, globalIp: string, zone: number): boolean {
  if (zone === 0) return false;
  const owner = device.interfaces.find((i) => i.ipv4.some((a) => cidrContains(a.address, a.prefix, globalIp)));
  return !owner || zoneOf(device, owner) === zone;
}

export function natTimeoutSec(device: Device, proto: NatProto): number {
  const st = cpGet(device, "nat") ?? {};
  if (proto === "tcp") return Number(st.nat_tcp_timeout ?? DEFAULT_TIMEOUT.tcp);
  if (proto === "udp") return Number(st.nat_udp_timeout ?? DEFAULT_TIMEOUT.udp);
  return ICMP_TIMEOUT_SEC;
}

interface Tuple {
  proto: NatProto | null;
  sport: number;
  dport: number;
}

/** Protocol + L4 ports (ICMP echo: the identifier is the "port", as in conntrack). */
function tupleOf(f: Frame): Tuple {
  if (f.tcp) return { proto: "tcp", sport: f.tcp.srcPort, dport: f.tcp.dstPort };
  if (f.udp) return { proto: "udp", sport: f.udp.srcPort, dport: f.udp.dstPort };
  if (f.icmp && (f.icmp.type === "echo-request" || f.icmp.type === "echo-reply")) return { proto: "icmp", sport: f.icmp.identifier, dport: f.icmp.identifier };
  return { proto: null, sport: 0, dport: 0 };
}

interface StaticNat {
  proto: "all" | "tcp" | "udp";
  globalIp: string;
  globalPort: number;
  localIp: string;
  localPort: number;
}

/** STATIC_NAT / STATIC_NAPT rows, NAPT first (more specific). nat_type snat swaps the roles. */
function staticEntries(device: Device): StaticNat[] {
  const out = cpList(device, "nat", "statics").map((r) => {
    const swap = r.nat_type === "snat";
    const g = { ip: String(r.global_ip), port: Number(r.global_port) || 0 };
    const l = { ip: String(r.local_ip), port: Number(r.local_port) || 0 };
    const [gl, lo] = swap ? [l, g] : [g, l];
    return { proto: r.ip_protocol as StaticNat["proto"], globalIp: gl.ip, globalPort: gl.port, localIp: lo.ip, localPort: lo.port };
  });
  return out.sort((a, b) => Number(a.proto === "all") - Number(b.proto === "all"));
}

interface Pool {
  ips: string[];
  lo: number;
  hi: number;
}

/** NAT_POOL nat_ip "a.b.c.d[-e.f.g.h]", nat_port "lo-hi" (absent: any port, source port kept when free). */
function poolOf(device: Device, name: string): Pool | undefined {
  const r = cpList(device, "nat", "pools").find((p) => p.pool_name === name);
  if (!r) return undefined;
  const [a, b] = String(r.nat_ip).split("-");
  const first = ipToInt(a);
  const last = b ? ipToInt(b) : first;
  const ips: string[] = [];
  for (let n = first; n <= last && ips.length < 256; n++) ips.push(intToIp(n));
  const m = /^(\d+)-(\d+)$/.exec(String(r.nat_port ?? ""));
  return { ips, lo: m ? Number(m[1]) : 1, hi: m ? Number(m[2]) : 65535 };
}

/** NAT binding ACL: first matching rule by seq; permit = translate (natmgr.cpp: deny/no match = no NAT). */
function aclPermits(device: Device, acl: string | undefined, frame: Frame): boolean {
  if (!acl || acl === "---") return true;
  const rules = peekFeatureState<AclState>(device, "acl")?.rules[acl];
  if (!rules) return false;
  for (const r of [...rules].sort((x, y) => x.seq - y.seq)) {
    let parsed;
    try {
      parsed = parseRule("ip", r.match);
    } catch {
      continue;
    }
    if (ruleMatches(parsed, frame, null)) return r.action === "permit";
  }
  return false;
}

function portInUse(device: Device, proto: NatProto, ip: string, port: number): boolean {
  if (runtime(device).entries.some((e) => e.proto === proto && e.outIp === ip && e.outPort === port)) return true;
  return staticEntries(device).some((s) => s.proto === proto && s.globalIp === ip && s.globalPort === port);
}

/** Linux nf_nat keeps the source port when it is in range and unused, else takes the first free one. */
function allocate(device: Device, pool: Pool, proto: NatProto, sport: number): { ip: string; port: number } | undefined {
  for (const ip of pool.ips) {
    if (sport >= pool.lo && sport <= pool.hi && !portInUse(device, proto, ip, sport)) return { ip, port: sport };
    for (let p = pool.lo; p <= pool.hi; p++) if (!portInUse(device, proto, ip, p)) return { ip, port: p };
  }
  return undefined;
}

const ipBytes = (ip: string) => ip.split(".").map((o) => Number(o) & 0xff);

/** Re-checksum engine-built bytes after rewriting addresses / ports / ICMP identifier. */
function patchRaw(raw: number[], f: Frame): number[] {
  const b = [...raw];
  if (b.length < 20 || !f.ipv4) return b;
  const ihl = (b[0] & 0x0f) * 4;
  const end = Math.min(((b[2] << 8) | b[3]) || b.length, b.length);
  b.splice(12, 4, ...ipBytes(f.ipv4.srcIp));
  b.splice(16, 4, ...ipBytes(f.ipv4.dstIp));
  b[10] = b[11] = 0;
  const ck = inetChecksum(b.slice(0, ihl));
  [b[10], b[11]] = [ck >> 8, ck & 0xff];
  const l4 = ihl;
  const pseudo = (proto: number) => [...ipBytes(f.ipv4!.srcIp), ...ipBytes(f.ipv4!.dstIp), 0, proto, (end - l4) >> 8, (end - l4) & 0xff];
  const port = (at: number, v: number) => ([b[at], b[at + 1]] = [(v >> 8) & 0xff, v & 0xff]);
  if (b[9] === 6 && f.tcp && end - l4 >= 20) {
    port(l4, f.tcp.srcPort);
    port(l4 + 2, f.tcp.dstPort);
    b[l4 + 16] = b[l4 + 17] = 0;
    port(l4 + 16, inetChecksum([...pseudo(6), ...b.slice(l4, end)]));
  } else if (b[9] === 17 && f.udp && end - l4 >= 8) {
    port(l4, f.udp.srcPort);
    port(l4 + 2, f.udp.dstPort);
    if (b[l4 + 6] || b[l4 + 7]) {
      b[l4 + 6] = b[l4 + 7] = 0;
      port(l4 + 6, inetChecksum([...pseudo(17), ...b.slice(l4, end)]) || 0xffff);
    }
  } else if (b[9] === 1 && (f.icmp?.type === "echo-request" || f.icmp?.type === "echo-reply") && end - l4 >= 8) {
    port(l4 + 4, f.icmp.identifier);
    b[l4 + 2] = b[l4 + 3] = 0;
    port(l4 + 2, inetChecksum(b.slice(l4, end)));
  }
  return b;
}

export interface NatResult {
  frame: Frame;
  /** "SNAT 192.168.1.10:40000 -> 100.64.0.1:20000 (tcp)" */
  text: string;
}

function rewrite(frame: Frame, rw: { srcIp?: string; srcPort?: number; dstIp?: string; dstPort?: number }): Frame {
  const f = cloneFrame(frame);
  const ip = f.ipv4!;
  if (rw.srcIp) ip.srcIp = rw.srcIp;
  if (rw.dstIp) ip.dstIp = rw.dstIp;
  const l4 = f.tcp ?? f.udp;
  if (l4) {
    if (rw.srcPort !== undefined) l4.srcPort = rw.srcPort;
    if (rw.dstPort !== undefined) l4.dstPort = rw.dstPort;
  } else if (f.icmp && (rw.srcPort !== undefined || rw.dstPort !== undefined)) {
    f.icmp.identifier = (rw.srcPort ?? rw.dstPort)!;
  }
  if (f.rawL3) f.rawL3 = patchRaw(f.rawL3, f);
  return f;
}

const PROTO_KEY: Record<string, string> = { tcp: "TCP", udp: "UDP" };
const hp = (ip: string, port: number | undefined) => (port ? `${ip}:${port}` : ip);

/** APPL_DB NAT_TABLE / NAPT_TABLE key (natsync.cpp), e.g. "TCP:100.64.0.1:20000" or "65.55.42.1". */
function applKey(proto: string, ip: string, port: number): string {
  return proto === "all" ? ip : `${PROTO_KEY[proto]}:${ip}:${port}`;
}

function count(device: Device, natType: "snat" | "dnat", proto: string, ip: string, port: number, frame: Frame): void {
  if (proto === "icmp") return; // kernel-only translation: no ASIC counters
  const c = (runtime(device).counters[`${natType}|${applKey(proto, ip, port)}`] ??= { pkts: 0, bytes: 0 });
  c.pkts += 1;
  c.bytes += frame.meta.sizeBytes;
}

/**
 * ICMP error (time-exceeded / unreachable) for a translated flow: the embedded
 * packet carries the translated source, so the error is addressed to the
 * outside address. Linux conntrack relates it to the flow and
 * nf_nat_icmp_reply_translation() rewrites the outer destination AND the
 * embedded source back to the inside host (RFC 5508 §4.2). Kernel slow path:
 * no ASIC counters.
 */
function icmpErrorInbound(device: Device, frame: Frame): NatResult | undefined {
  const o = frame.icmp?.original;
  if (!o || (frame.icmp!.type !== "time-exceeded" && frame.icmp!.type !== "dest-unreachable")) return undefined;
  const proto = o.protocol.toLowerCase() as NatProto;
  let inside: { ip: string; port: number } | undefined;
  const e = runtime(device).entries.find((x) => x.proto === proto && x.outIp === o.srcIp && x.outPort === o.srcPort);
  if (e) inside = { ip: e.inIp, port: e.inPort };
  else {
    const s = staticEntries(device).find((x) => x.globalIp === o.srcIp && (x.proto === "all" || (x.proto === proto && x.globalPort === o.srcPort)));
    if (s) inside = { ip: s.localIp, port: s.proto === "all" ? o.srcPort : s.localPort };
  }
  if (!inside) return undefined;
  const f = rewrite(frame, { dstIp: inside.ip });
  const ic = f.icmp!;
  ic.original = { ...o, srcIp: inside.ip, srcPort: inside.port };
  if (proto === "icmp") ic.identifier = inside.port; // the embedded echo's identifier
  if (ic.errorInfo) ic.errorInfo = ic.errorInfo.replace(o.srcIp, inside.ip);
  if (f.rawL3) f.rawL3 = patchIcmpErrorRaw(f.rawL3, ic.original);
  return {
    frame: f,
    text: `DNAT ${frame.ipv4!.dstIp} -> ${inside.ip} (icmp ${ic.type}, embedded ${proto} ${hp(o.srcIp, o.srcPort)} -> ${hp(inside.ip, inside.port)})`,
  };
}

/** Engine-built bytes of an ICMP error: rewrite the embedded source (address + port/identifier) and re-checksum. */
function patchIcmpErrorRaw(raw: number[], inner: NonNullable<Frame["icmp"]>["original"] & object): number[] {
  const b = [...raw];
  const l4 = (b[0] & 0x0f) * 4;
  const end = Math.min(((b[2] << 8) | b[3]) || b.length, b.length);
  const at = l4 + 8; // embedded IP header
  if (end - at < 20) return b;
  const ihl = (b[at] & 0x0f) * 4;
  b.splice(at + 12, 4, ...ipBytes(inner.srcIp));
  b[at + 10] = b[at + 11] = 0;
  const ck = inetChecksum(b.slice(at, at + ihl));
  [b[at + 10], b[at + 11]] = [ck >> 8, ck & 0xff];
  const p = at + ihl + (b[at + 9] === 1 ? 4 : 0); // TCP/UDP source port, or the ICMP echo identifier
  if (end - p >= 2) [b[p], b[p + 1]] = [(inner.srcPort >> 8) & 0xff, inner.srcPort & 0xff];
  b[l4 + 2] = b[l4 + 3] = 0;
  const ock = inetChecksum(b.slice(l4, end));
  [b[l4 + 2], b[l4 + 3]] = [ock >> 8, ock & 0xff];
  return b;
}

/**
 * Ingress (PREROUTING): reverse-translate traffic addressed to a translated
 * address — return traffic of a dynamic entry, or a static DNAT entry.
 */
export function natInbound(device: Device, frame: Frame, ingress: NetInterface, nowMs: number): NatResult | undefined {
  if (!natEnabled(device) || !frame.ipv4) return undefined;
  const icmpErr = icmpErrorInbound(device, frame);
  if (icmpErr) return icmpErr;
  const t = tupleOf(frame);
  const dst = frame.ipv4.dstIp;
  if (t.proto) {
    const e = runtime(device).entries.find((x) => x.proto === t.proto && x.outIp === dst && x.outPort === t.dport);
    if (e) {
      e.lastMs = nowMs;
      count(device, "dnat", e.proto, e.outIp, e.outPort, frame);
      return { frame: rewrite(frame, { dstIp: e.inIp, dstPort: e.inPort }), text: `DNAT ${hp(dst, t.dport)} -> ${hp(e.inIp, e.inPort)} (${e.proto})` };
    }
  }
  const zone = zoneOf(device, ingress);
  for (const s of staticEntries(device)) {
    if (s.globalIp !== dst || !zoneAllows(device, s.globalIp, zone)) continue;
    if (s.proto !== "all" && (s.proto !== t.proto || s.globalPort !== t.dport)) continue;
    count(device, "dnat", s.proto, s.globalIp, s.globalPort, frame);
    const napt = s.proto !== "all";
    return {
      frame: rewrite(frame, { dstIp: s.localIp, ...(napt ? { dstPort: s.localPort } : {}) }),
      text: `DNAT ${hp(dst, napt ? s.globalPort : 0)} -> ${hp(s.localIp, napt ? s.localPort : 0)} (static)`,
    };
  }
  return undefined;
}

/**
 * Egress (POSTROUTING): translate the source of traffic leaving through an
 * outside zone — existing entry, static NAT/NAPT, then the pool bindings.
 */
export function natOutbound(device: Device, frame: Frame, ingress: NetInterface, egress: NetInterface, nowMs: number): NatResult | undefined {
  if (!natEnabled(device) || !frame.ipv4) return undefined;
  const inZone = zoneOf(device, ingress);
  const outZone = zoneOf(device, egress);
  if (outZone === 0 || inZone === outZone) return undefined;
  const t = tupleOf(frame);
  const src = frame.ipv4.srcIp;
  const rt = runtime(device);
  if (t.proto) {
    const e = rt.entries.find((x) => x.proto === t.proto && x.inIp === src && x.inPort === t.sport);
    if (e) {
      e.lastMs = nowMs;
      count(device, "snat", e.proto, e.inIp, e.inPort, frame);
      return { frame: rewrite(frame, { srcIp: e.outIp, srcPort: e.outPort }), text: `SNAT ${hp(src, t.sport)} -> ${hp(e.outIp, e.outPort)} (${e.proto})` };
    }
  }
  for (const s of staticEntries(device)) {
    if (s.localIp !== src || !zoneAllows(device, s.globalIp, outZone)) continue;
    if (s.proto !== "all" && (s.proto !== t.proto || s.localPort !== t.sport)) continue;
    count(device, "snat", s.proto, s.localIp, s.localPort, frame);
    const napt = s.proto !== "all";
    return {
      frame: rewrite(frame, { srcIp: s.globalIp, ...(napt ? { srcPort: s.globalPort } : {}) }),
      text: `SNAT ${hp(src, napt ? s.localPort : 0)} -> ${hp(s.globalIp, napt ? s.globalPort : 0)} (static)`,
    };
  }
  if (!t.proto) return undefined; // dynamic rules exist for -p tcp / udp / icmp only (natmgr.cpp:1144-1146)
  for (const b of cpList(device, "nat", "bindings")) {
    const pool = poolOf(device, String(b.nat_pool));
    if (!pool || !pool.ips.length || !zoneAllows(device, pool.ips[0], outZone)) continue;
    if (!aclPermits(device, b.access_list as string | undefined, frame)) continue;
    const a = allocate(device, pool, t.proto, t.sport);
    if (!a) continue;
    rt.entries.push({ proto: t.proto, inIp: src, inPort: t.sport, outIp: a.ip, outPort: a.port, lastMs: nowMs });
    count(device, "snat", t.proto, src, t.sport, frame);
    return { frame: rewrite(frame, { srcIp: a.ip, srcPort: a.port }), text: `SNAT ${hp(src, t.sport)} -> ${hp(a.ip, a.port)} (${t.proto}, binding ${String(b.name)})` };
  }
  return undefined;
}

/** Drop dynamic entries idle past their timeout. Returns true if any expired. */
export function natExpire(device: Device, nowMs: number): boolean {
  const rt = peekNat(device);
  if (!rt?.entries.length) return false;
  const before = rt.entries.length;
  rt.entries = rt.entries.filter((e) => nowMs - e.lastMs < natTimeoutSec(device, e.proto) * 1000);
  return rt.entries.length !== before;
}

export function natNextExpiry(device: Device): number | undefined {
  const rt = peekNat(device);
  if (!rt?.entries.length) return undefined;
  return Math.min(...rt.entries.map((e) => e.lastMs + natTimeoutSec(device, e.proto) * 1000));
}

/** `clear nat translations`: flush the dynamic entries (static ones are re-programmed from config). */
export function natClearTranslations(device: Device): void {
  const rt = peekNat(device);
  if (rt) rt.entries = [];
}

/** `clear nat statistics`. */
export function natClearStatistics(device: Device): void {
  const rt = peekNat(device);
  if (rt) rt.counters = {};
}

interface ApplRow {
  proto: string; // all | tcp | udp
  natType: "snat" | "dnat";
  kind: "static" | "dynamic";
  ip: string;
  port: number;
  /** translated ip / port */
  tIp: string;
  tPort: number;
}

/** The ASIC NAT table: every static entry + every dynamic TCP/UDP entry, each as an SNAT/DNAT pair. */
function applRows(device: Device): ApplRow[] {
  if (!natEnabled(device)) return [];
  const rows: ApplRow[] = [];
  for (const s of staticEntries(device)) {
    rows.push({ proto: s.proto, natType: "snat", kind: "static", ip: s.localIp, port: s.localPort, tIp: s.globalIp, tPort: s.globalPort });
    rows.push({ proto: s.proto, natType: "dnat", kind: "static", ip: s.globalIp, port: s.globalPort, tIp: s.localIp, tPort: s.localPort });
  }
  for (const e of peekNat(device)?.entries ?? []) {
    if (e.proto === "icmp") continue; // natsync.cpp:215-217
    rows.push({ proto: e.proto, natType: "snat", kind: "dynamic", ip: e.inIp, port: e.inPort, tIp: e.outIp, tPort: e.outPort });
    rows.push({ proto: e.proto, natType: "dnat", kind: "dynamic", ip: e.outIp, port: e.outPort, tIp: e.inIp, tPort: e.inPort });
  }
  return rows;
}

/** natshow display_count(). */
export function renderNatCount(device: Device): string[] {
  const rows = applRows(device);
  const n = (kind: string, napt: boolean) => rows.filter((r) => r.kind === kind && (r.proto !== "all") === napt).length;
  const lines = [
    ["Static NAT Entries         ", n("static", false)],
    ["Static NAPT Entries        ", n("static", true)],
    ["Dynamic NAT Entries        ", n("dynamic", false)],
    ["Dynamic NAPT Entries       ", n("dynamic", true)],
    ["Static Twice NAT Entries   ", 0],
    ["Static Twice NAPT Entries  ", 0],
    ["Dynamic Twice NAT Entries  ", 0],
    ["Dynamic Twice NAPT Entries ", 0],
    ["Total SNAT/SNAPT Entries   ", rows.filter((r) => r.natType === "snat").length],
    ["Total DNAT/DNAPT Entries   ", rows.filter((r) => r.natType === "dnat").length],
    ["Total Entries              ", rows.length],
  ];
  return ["", ...lines.map(([l, v]) => `${l}..................... ${v}`), ""];
}

/** natshow -t: counts + "Protocol Source Destination Translated Source Translated Destination". */
export function renderNatTranslations(device: Device, tabulate: (h: string[], r: string[][]) => string[]): string[] {
  const rows = applRows(device)
    .map((r) => {
      const a = hp(r.ip, r.proto === "all" ? 0 : r.port);
      const b = hp(r.tIp, r.proto === "all" ? 0 : r.tPort);
      return r.natType === "snat" ? [r.proto, a, "---", b, "---"] : [r.proto, "---", a, "---", b];
    })
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return [...renderNatCount(device), ...tabulate(["Protocol", "Source", "Destination", "Translated Source", "Translated Destination"], rows), ""];
}

/** natshow -s: per APPL_DB entry packets / bytes. */
export function renderNatStatistics(device: Device, tabulate: (h: string[], r: string[][]) => string[]): string[] {
  const counters = peekNat(device)?.counters ?? {};
  const rows = applRows(device)
    .map((r) => {
      const c = counters[`${r.natType}|${applKey(r.proto, r.ip, r.port)}`] ?? { pkts: 0, bytes: 0 };
      const a = hp(r.ip, r.proto === "all" ? 0 : r.port);
      return [r.proto, r.natType === "snat" ? a : "---", r.natType === "dnat" ? a : "---", String(c.pkts), String(c.bytes)];
    })
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return ["", ...tabulate(["Protocol", "Source", "Destination", "Packets", "Bytes"], rows), ""];
}
