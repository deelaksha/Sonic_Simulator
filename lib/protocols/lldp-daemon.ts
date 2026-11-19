/**
 * LLDP control-plane daemon — lldpd 1.0.16 as packaged in SONiC's docker-lldp.
 * Runs on SONiC switches and routers (never on hosts). Every LLDPDU is real
 * bytes (EtherType 0x88CC to 01:80:C2:00:00:0E) so tcpdump, sFlow and Scapy
 * decode exactly what was sent; neighbours exist only because a PDU arrived.
 *
 * Sources (sonic-buildimage tree):
 *   dockers/docker-lldp/supervisord.conf.j2:55  lldpd -I Ethernet[0-9]*,eth0 -C eth0
 *       → LLDP on front-panel EthernetN ports + eth0; chassis ID = eth0 MAC.
 *   dockers/docker-lldp/lldpmgrd:38-39          tx-interval 30 s, tx-hold 4 (defaults)
 *   src/lldpd/.../daemon/lldpd.c:1910-1911      TTL = ceil(tx_interval × tx_hold) = 120 s
 *   dockers/docker-lldp/lldpmgrd:459-472        Port ID = subtype local <alias|name>,
 *       port description only when configured (the simulator has none →
 *       lldpd keeps ifname, daemon/interfaces.c:596-607).
 *   dockers/docker-lldp/lldpd.conf.j2:16,19,21,24  eth0 Port ID "local eth0",
 *       management address = eth0 IPv4, hostname, "SONiC Software Version: ..."
 *   src/lldpd/.../daemon/lldpd.c:1947           capabilities available Bridge|Router|Station;
 *       enabled Bridge (kernel Bridge device, interfaces.c:336) + Router (ip_forward=1,
 *       lldpd.c:1233; files/image_config/sysctl/sysctl-net.conf:6).
 *   src/lldpd/.../daemon/protocols/lldp.c:129-205  TLV order: Chassis, Port, TTL,
 *       SysName, SysDescr, SysCap, MgmtAddr, PortDescr, End. Shutdown PDU = TTL 0.
 *       lldp.c:704-777 the first three TLVs must be Chassis/Port/TTL.
 *   src/lldpd/.../daemon/lldpd.c:666            TTL 0 → neighbour removed.
 *   src/lldpd/.../daemon/lldpd.c:468            link not RUNNING → neighbours on the port removed.
 *   src/lldpd/.../daemon/lldpd.c:1046           RX disabled → frame ignored.
 *   src/lldpd/.../daemon/lldpd.c:397-408        local port info changed → PDU sent at once.
 *   src/lldpd/.../daemon/event.c:784            neighbour expires at lastupdate + TTL.
 *   src/lldpd/.../daemon/lldpd.c:630, lldpd.h:71  at most 32 neighbours per port.
 *   Routers run stock lldpd: Port ID = MAC (subtype 3, interfaces.c else-branch),
 *   chassis = first physical interface MAC (interfaces.c:355-378).
 *
 * Simulator choices (documented, not from a source):
 *   - lldpd starts paused (lldpd.conf.j2:23) until lldpmgrd's `lldpcli resume`
 *     (lldpmgrd:671-680): the first PDUs leave BOOT_DELAY_MS (5 s) after the
 *     daemon first sees the device; a port that comes up later sends at once.
 *   - Management-address ifIndex: eth0 = 2 (lo = 1), other ports 3 + position.
 *
 * Organisational TLVs (lldp.c:208-388, sent after Port Description in this order):
 *   802.1 Port VLAN ID (subtype 1) + VLAN Name (subtype 3) per bridge VLAN of the
 *     port; lldpd names them "vlan<N>" (interfaces.c:221-238).
 *   802.3 Link Aggregation (subtype 3, always: status 3 + PortChannel ifindex when
 *     the port is a team member, else capability only, lldp.c:251-257,
 *     interfaces-linux.c:850) and MAC/PHY (subtype 1, always, lldp.c:260-267):
 *     autoneg not supported, MAU type from the ethtool speed with an unknown
 *     connector (interfaces-linux.c:587-675: 1G → 1000BaseTFD, 40G → 40GBaseCR4,
 *     100G → 100GBaseCR4, 10G/25G → 0).
 *   802.3 Max Frame Size is never sent: lldpd 1.0.16 only fills p_mfs from a
 *     received TLV (lldp.c:981), so it is decoded/displayed but not advertised.
 *   LLDP-MED Network Policy (lldp.c:356-382) for ports bound to a KLISH
 *     network-policy profile (`network-policy <n>` on the interface). SONiC starts
 *     lldpd without -M, so the simulator advertises as `lldpd -M 4` would
 *     (lldpd.c:1952-1958: MED Capabilities TLV, class Network Connectivity) —
 *     without it a receiving lldpctl hides the policy (display.c:70).
 *
 * Feature: `config feature state lldp disabled` stops docker-lldp; lldpd exits
 * sending a shutdown LLDPDU (TTL 0) on every port (lldpd.c:1316-1317) and all
 * runtime is gone; re-enabling starts a fresh (paused) lldpd.
 */
import { registerDaemon } from "../control/daemon";
import { transmitL2 } from "../control/packet";
import { Device, isRouter, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { featureEnabled } from "./cpu-features";
import { cpList } from "../commands/sonic-cli/config-plane";

export const LLDP_MULTICAST = "01:80:C2:00:00:0E";
export const ETH_P_LLDP = 0x88cc;
export const LLDP_DEFAULT_TX_INTERVAL = 30; // lldpmgrd:38
export const LLDP_DEFAULT_TX_HOLD = 4; // lldpmgrd:39
const BOOT_DELAY_MS = 5000;
const MAX_NEIGHBORS = 32; // lldpd.h:71

export const CAP = { OTHER: 0x01, REPEATER: 0x02, BRIDGE: 0x04, WLAN: 0x08, ROUTER: 0x10, TELEPHONE: 0x20, DOCSIS: 0x40, STATION: 0x80 } as const;
/** lldpctl display order + names (src/client/display.c:270-277). */
export const CAP_NAMES: [number, string][] = [
  [CAP.OTHER, "Other"], [CAP.REPEATER, "Repeater"], [CAP.BRIDGE, "Bridge"], [CAP.ROUTER, "Router"],
  [CAP.WLAN, "Wlan"], [CAP.TELEPHONE, "Tel"], [CAP.DOCSIS, "Docsis"], [CAP.STATION, "Station"],
];

const TLV = { END: 0, CHASSIS: 1, PORT: 2, TTL: 3, PORT_DESCR: 4, SYS_NAME: 5, SYS_DESCR: 6, SYS_CAP: 7, MGMT: 8, ORG: 127 } as const;

/** A remote system learned from a received LLDPDU. */
export interface LldpNeighbor {
  chassisSubtype: number;
  chassisId: string;
  portSubtype: number;
  portId: string;
  ttl: number;
  portDescr?: string;
  sysName?: string;
  sysDescr?: string;
  capAvailable: number;
  capEnabled: number;
  mgmtIp?: string;
  mgmtIfIndex?: number;
  /** 802.1 Port VLAN ID / VLAN names. */
  pvid?: number;
  vlans?: { vid: number; name: string }[];
  /** 802.3 link aggregation (status bits, aggregated port id), MAC/PHY, max frame size. */
  aggStatus?: number;
  aggId?: number;
  macphy?: { autonegSupport: boolean; autonegEnabled: boolean; advertised: number; mau: number };
  mfs?: number;
  /** LLDP-MED device type + capabilities, network policies. */
  medType?: number;
  medCap?: number;
  medPolicies?: MedPolicy[];
  rid: number;
  lastChange: number;
  lastUpdate: number;
}

export interface MedPolicy {
  type: number;
  unknown: boolean;
  tagged: boolean;
  vid: number;
  priority: number;
  dscp: number;
}

export interface LldpStats { tx: number; rx: number; discarded: number; unrecognized: number; ageout: number }
interface PortRt { up: boolean; sig?: string; next?: number }

export interface LldpRuntime {
  boot: number;
  lastRid: number;
  ports: Record<string, PortRt>;
  neighbors: Record<string, LldpNeighbor[]>;
  stats: Record<string, LldpStats>;
}

const RT = "lldpd";

/** Read-only view of the CONFIG_DB LLDP state kept by lib/commands/sonic/lldp.ts. */
interface LldpCfg {
  enabled?: boolean;
  transmit?: boolean;
  receive?: boolean;
  timer?: number;
  multiplier?: number;
  systemName?: string;
  systemDescription?: string;
  interfaces?: Record<string, { enabled?: boolean; transmit?: boolean; receive?: boolean; networkPolicy?: number }>;
}

const cfgOf = (d: Device) => peekFeatureState<LldpCfg>(d, "lldp");

export function lldpRuntime(d: Device): LldpRuntime | undefined {
  return peekFeatureState<LldpRuntime>(d, RT);
}

/** Effective tx/rx of a port: global status + per-port status (lldpmgrd:190-232, 369-426). */
export function lldpPortMode(d: Device, port: string): { tx: boolean; rx: boolean } {
  const c = cfgOf(d);
  if (c?.enabled === false) return { tx: false, rx: false };
  const p = c?.interfaces?.[port];
  if (p?.enabled === false) return { tx: false, rx: false };
  return { tx: c?.transmit !== false && p?.transmit !== false, rx: c?.receive !== false && p?.receive !== false };
}

export function runsLldp(d: Device): boolean {
  return isSwitch(d.type) || isRouter(d.type);
}

/** Interfaces lldpd manages: SONiC `-I Ethernet[0-9]*,eth0`; routers: every physical port. */
export function lldpPorts(d: Device): NetInterface[] {
  if (isSwitch(d.type)) return d.interfaces.filter((i) => !i.logical && (i.management || /^Ethernet\d+$/.test(i.name)));
  return d.interfaces.filter((i) => !i.logical && !i.management);
}

const linkUp = (i: NetInterface) => i.adminState === "up" && i.operState === "up";

// ---------- local system (what we advertise) ----------

export function lldpTimers(d: Device): { interval: number; hold: number; ttl: number } {
  const c = cfgOf(d);
  const interval = c?.timer ?? LLDP_DEFAULT_TX_INTERVAL;
  const hold = c?.multiplier ?? LLDP_DEFAULT_TX_HOLD;
  return { interval, hold, ttl: Math.min(65535, interval * hold) };
}

function chassisMac(d: Device): string {
  const eth0 = isSwitch(d.type) ? d.interfaces.find((i) => i.management) : undefined;
  return (eth0 ?? d.interfaces.find((i) => !i.logical) ?? d.interfaces[0]).mac;
}

function sysDescr(d: Device): string {
  const c = cfgOf(d);
  if (c?.systemDescription) return c.systemDescription; // lldpmgrd:276
  if (isSwitch(d.type)) {
    // lldpd.conf.j2:24 with this simulator's `show version` identity.
    return "SONiC Software Version: SONiC.Lab-Simulation - HwSku: switch - Distribution: Debian 12.8 - Kernel: 6.1.0-29-2-amd64";
  }
  // Stock lldpd: "<lsb_release> <uname -s -r -v -m>" (lldpd.c:1211-1215).
  return "Debian GNU/Linux 12 (bookworm) Linux 6.1.0-29-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.123-1 x86_64";
}

function ifIndex(d: Device, iface: NetInterface): number {
  if (iface.management) return 2;
  return 3 + d.interfaces.filter((i) => !i.management).indexOf(iface);
}

function mgmtAddress(d: Device): { ip: string; ifIndex: number } | undefined {
  // SONiC: `configure system ip management pattern <eth0 ipv4>` (lldpd.conf.j2:19).
  const owner = isSwitch(d.type) ? d.interfaces.filter((i) => i.management) : d.interfaces.filter((i) => !i.logical);
  const i = owner.find((x) => x.ipv4.length > 0);
  return i ? { ip: i.ipv4[0].address, ifIndex: ifIndex(d, i) } : undefined;
}

function capabilities(d: Device): { available: number; enabled: number } {
  const available = CAP.BRIDGE | CAP.ROUTER | CAP.STATION; // lldpd.c:1947
  const enabled = isSwitch(d.type) ? CAP.BRIDGE | CAP.ROUTER : CAP.ROUTER;
  return { available, enabled };
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const macBytes = (m: string) => m.split(":").map((x) => parseInt(x, 16));
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const tlv = (type: number, value: number[]) => [...u16((type << 9) | (value.length & 0x1ff)), ...value];

const OUI_DOT1 = [0x00, 0x80, 0xc2];
const OUI_DOT3 = [0x00, 0x12, 0x0f];
const OUI_MED = [0x00, 0x12, 0xbb];
const org = (oui: number[], subtype: number, value: number[]) => tlv(TLV.ORG, [...oui, subtype, ...value]);

/** MAU type lldpd derives from the ethtool speed, connector unknown (interfaces-linux.c:587-675). */
export function mauType(speedMbps: number): number {
  if (speedMbps === 10) return 11; // 10BaseTFD
  if (speedMbps === 100) return 16; // 100BaseTXFD
  if (speedMbps === 1000) return 30; // 1000BaseTFD
  if (speedMbps === 40000) return 71; // 40GBaseCR4
  if (speedMbps === 50000) return 117; // 50GBaseCR (lldp-const.h:168)
  if (speedMbps === 100000) return 98; // 100GBaseCR4
  return 0;
}

/** Bridge VLANs of a switch port as lldpd reads them from the kernel bridge (pvid + members). */
export function portVlans(d: Device, port: NetInterface): { pvid: number; vids: number[] } {
  if (!isSwitch(d.type) || port.management || port.logical || port.ipv4.length) return { pvid: 0, vids: [] };
  const known = new Set((d.config.vlans ?? []).map((v) => v.id));
  if (port.vlan.mode === "access") return known.has(port.vlan.accessVlan) ? { pvid: port.vlan.accessVlan, vids: [port.vlan.accessVlan] } : { pvid: 0, vids: [] };
  const vids = [...new Set(port.vlan.allowedVlans)].filter((v) => known.has(v)).sort((a, b) => a - b);
  return { pvid: known.has(port.vlan.nativeVlan) ? port.vlan.nativeVlan : 0, vids };
}

/** Kernel ifindex of the PortChannel a port is a team member of (0 = not aggregated). */
function aggregId(d: Device, port: NetInterface): number {
  const lags = peekFeatureState<{ portchannels: { name: string; members: string[] }[] }>(d, "lacp")?.portchannels ?? [];
  const lag = lags.find((l) => l.members.includes(port.name));
  const pc = lag && d.interfaces.find((i) => i.logical && i.name === lag.name);
  return pc ? ifIndex(d, pc) : 0;
}

/** LLDP-MED network policies of the KLISH network-policy profile bound to the port. */
function medPolicies(d: Device, port: NetInterface): MedPolicy[] {
  const n = cfgOf(d)?.interfaces?.[port.name]?.networkPolicy;
  if (n === undefined) return [];
  const prof = cpList(d, "network-policy", "profiles").find((p) => String(p.number) === String(n)) as
    | { apps?: { type: string; vlan: string; untagged?: boolean; cos?: string; dscp?: string }[] }
    | undefined;
  const out: MedPolicy[] = [];
  for (const a of prof?.apps ?? []) {
    const type = a.type === "voice" ? 1 : a.type === "voice-signaling" ? 2 : 0;
    if (!type) continue;
    const dot1p = a.vlan === "dot1p";
    out.push({ type, unknown: false, tagged: !a.untagged, vid: dot1p || a.untagged ? 0 : Number(a.vlan), priority: Number(a.cos ?? 0), dscp: Number(a.dscp ?? 0) });
  }
  return out.sort((x, y) => x.type - y.type);
}

function orgTlvs(d: Device, port: NetInterface): number[] {
  const out: number[] = [];
  const { pvid, vids } = portVlans(d, port);
  if (pvid) out.push(...org(OUI_DOT1, 1, u16(pvid)));
  for (const vid of vids) {
    const name = ascii(`vlan${vid}`);
    out.push(...org(OUI_DOT1, 3, [...u16(vid), name.length, ...name]));
  }
  const agg = aggregId(d, port);
  out.push(...org(OUI_DOT3, 3, [agg ? 3 : 1, ...u32(agg)]));
  out.push(...org(OUI_DOT3, 1, [0, ...u16(0), ...u16(mauType(port.speed))]));
  const pols = medPolicies(d, port);
  if (pols.length) {
    out.push(...org(OUI_MED, 1, [...u16(0x01 | 0x02), 4])); // capabilities: Capabilities|Policy, class Network Connectivity
    for (const p of pols) {
      const v = ((p.type & 0xff) << 24) | ((p.unknown ? 1 : 0) << 23) | ((p.tagged ? 1 : 0) << 22) | ((p.vid & 0xfff) << 9) | ((p.priority & 7) << 6) | (p.dscp & 0x3f);
      out.push(...org(OUI_MED, 2, u32(v >>> 0)));
    }
  }
  return out;
}

/** The LLDPDU (bytes after the EtherType) this device sends out of `port`. */
export function buildLldpdu(d: Device, port: NetInterface, shutdown = false): number[] {
  const { ttl } = lldpTimers(d);
  const portId = isSwitch(d.type) ? [7, ...ascii(port.name)] : [3, ...macBytes(port.mac)];
  const out = [...tlv(TLV.CHASSIS, [4, ...macBytes(chassisMac(d))]), ...tlv(TLV.PORT, portId), ...tlv(TLV.TTL, u16(shutdown ? 0 : ttl))];
  if (!shutdown) {
    const name = cfgOf(d)?.systemName ?? d.config.hostname ?? d.name;
    if (name) out.push(...tlv(TLV.SYS_NAME, ascii(name)));
    out.push(...tlv(TLV.SYS_DESCR, ascii(sysDescr(d))));
    const cap = capabilities(d);
    out.push(...tlv(TLV.SYS_CAP, [...u16(cap.available), ...u16(cap.enabled)]));
    const m = mgmtAddress(d);
    if (m) out.push(...tlv(TLV.MGMT, [5, 1, ...m.ip.split(".").map(Number), 2, ...u32(m.ifIndex), 0]));
    out.push(...tlv(TLV.PORT_DESCR, ascii(port.name)));
    out.push(...orgTlvs(d, port));
  }
  out.push(...tlv(TLV.END, []));
  return out;
}

// ---------- decoding ----------

const hexMac = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(":");
const text = (b: number[]) => String.fromCharCode(...b);

export interface ParsedLldpdu {
  nb: Omit<LldpNeighbor, "rid" | "lastChange" | "lastUpdate">;
  unrecognized: number;
}

/** Decode an LLDPDU; null when malformed (lldp.c:604-777 checks). */
export function parseLldpdu(bytes: ArrayLike<number>): ParsedLldpdu | null {
  const b = Array.from(bytes);
  let off = 0;
  let idx = 0;
  let unrecognized = 0;
  const nb: Partial<ParsedLldpdu["nb"]> = { capAvailable: 0, capEnabled: 0 };
  let gotEnd = false;
  while (off + 2 <= b.length) {
    const hdr = (b[off] << 8) | b[off + 1];
    const type = hdr >> 9;
    const len = hdr & 0x1ff;
    const v = b.slice(off + 2, off + 2 + len);
    if (v.length < len) return null;
    off += 2 + len;
    // The first three TLVs must be Chassis ID, Port ID, TTL (lldp.c:704-710).
    if (idx < 3 && type !== [TLV.CHASSIS, TLV.PORT, TLV.TTL][idx]) return null;
    idx++;
    switch (type) {
      case TLV.END:
        gotEnd = true;
        break;
      case TLV.CHASSIS:
        if (len < 2) return null;
        nb.chassisSubtype = v[0];
        nb.chassisId = v[0] === 4 && len === 7 ? hexMac(v.slice(1)) : text(v.slice(1));
        break;
      case TLV.PORT:
        if (len < 2) return null;
        nb.portSubtype = v[0];
        nb.portId = v[0] === 3 && len === 7 ? hexMac(v.slice(1)) : text(v.slice(1));
        break;
      case TLV.TTL:
        if (len < 2) return null;
        nb.ttl = (v[0] << 8) | v[1];
        break;
      case TLV.PORT_DESCR:
        nb.portDescr = text(v);
        break;
      case TLV.SYS_NAME:
        nb.sysName = text(v);
        break;
      case TLV.SYS_DESCR:
        nb.sysDescr = text(v);
        break;
      case TLV.SYS_CAP:
        if (len !== 4) return null;
        nb.capAvailable = (v[0] << 8) | v[1];
        nb.capEnabled = (v[2] << 8) | v[3];
        break;
      case TLV.MGMT: {
        const alen = v[0];
        if (v[1] === 1 && alen === 5 && nb.mgmtIp === undefined) {
          nb.mgmtIp = v.slice(2, 6).join(".");
          const ifSub = v[1 + alen];
          const ifNum = ((v[2 + alen] << 24) | (v[3 + alen] << 16) | (v[4 + alen] << 8) | v[5 + alen]) >>> 0;
          if (ifSub === 2 && ifNum) nb.mgmtIfIndex = ifNum;
        }
        break;
      }
      case TLV.ORG:
        if (!parseOrg(nb, v)) unrecognized++;
        break;
      default:
        unrecognized++;
    }
    if (gotEnd) break;
  }
  if (nb.chassisId === undefined || nb.portId === undefined || nb.ttl === undefined) return null; // lldp.c:1317
  return { nb: nb as ParsedLldpdu["nb"], unrecognized };
}

const sameOui = (v: number[], oui: number[]) => v[0] === oui[0] && v[1] === oui[1] && v[2] === oui[2];

/** 802.1 / 802.3 / LLDP-MED TLVs lldpd decodes (lldp.c:880-1270); false = unrecognized. */
function parseOrg(nb: Partial<ParsedLldpdu["nb"]>, v: number[]): boolean {
  if (v.length < 4) return false;
  const st = v[3];
  const b = v.slice(4);
  if (sameOui(v, OUI_DOT1)) {
    if (st === 1 && b.length >= 2) nb.pvid = (b[0] << 8) | b[1];
    else if (st === 3 && b.length >= 3) (nb.vlans ??= []).push({ vid: (b[0] << 8) | b[1], name: text(b.slice(3, 3 + b[2])) });
    else return false;
    return true;
  }
  if (sameOui(v, OUI_DOT3)) {
    if (st === 1 && b.length >= 5) nb.macphy = { autonegSupport: !!(b[0] & 1), autonegEnabled: !!(b[0] & 2), advertised: (b[1] << 8) | b[2], mau: (b[3] << 8) | b[4] };
    else if (st === 3 && b.length >= 5) {
      nb.aggStatus = b[0];
      nb.aggId = ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0;
    } else if (st === 4 && b.length >= 2) nb.mfs = (b[0] << 8) | b[1];
    else return false;
    return true;
  }
  if (sameOui(v, OUI_MED)) {
    if (st === 1 && b.length >= 3) {
      nb.medCap = (b[0] << 8) | b[1];
      nb.medType = b[2];
    } else if (st === 2 && b.length >= 4) {
      const x = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      (nb.medPolicies ??= []).push({ type: x >>> 24, unknown: !!((x >> 23) & 1), tagged: !!((x >> 22) & 1), vid: (x >> 9) & 0xfff, priority: (x >> 6) & 7, dscp: x & 0x3f });
    } else return false;
    return true;
  }
  return false;
}

// ---------- tcpdump -v (print-lldp.c) ----------

const TD_TLV: Record<number, string> = {
  0: "End", 1: "Chassis ID", 2: "Port ID", 3: "Time to Live", 4: "Port Description", 5: "System Name",
  6: "System Description", 7: "System Capabilities", 8: "Management Address", 127: "Organization specific",
};
const TD_CHASSIS: Record<number, string> = { 1: "Chassis component", 2: "Interface alias", 3: "Port component", 4: "MAC address", 5: "Network address", 6: "Interface name", 7: "Local" };
const TD_PORT: Record<number, string> = { 1: "Interface alias", 2: "Port component", 3: "MAC address", 4: "Network Address", 5: "Interface Name", 6: "Agent circuit ID", 7: "Local" };
const TD_CAP: [number, string][] = [
  [CAP.OTHER, "Other"], [CAP.REPEATER, "Repeater"], [CAP.BRIDGE, "Bridge"], [CAP.WLAN, "WLAN AP"],
  [CAP.ROUTER, "Router"], [CAP.TELEPHONE, "Telephone"], [CAP.DOCSIS, "Docsis"], [CAP.STATION, "Station Only"],
];
const capList = (v: number) => `[${TD_CAP.filter(([b]) => v & b).map(([, n]) => n).join(", ")}] (0x${v.toString(16).padStart(4, "0")})`;

const TD_OUI: Record<string, [string, Record<number, string>]> = {
  "0080c2": ["Ethernet bridged", { 1: "Port VLAN Id", 3: "VLAN name" }],
  "00120f": ["IEEE 802.3 Private", { 1: "MAC/PHY configuration/status", 3: "Link aggregation", 4: "Maximum frame size" }],
  "0012bb": ["TIA", { 1: "LLDP-MED Capabilities", 2: "Network policy" }],
};

/** print-lldp.c LLDP_PRIVATE_TLV: OUI, subtype, the main value. */
function tcpdumpOrg(head: string, v: number[]): string[] {
  const oui = v.slice(0, 3).map((x) => x.toString(16).padStart(2, "0")).join("");
  const [name, subs] = TD_OUI[oui] ?? ["Unknown", {}];
  const st = v[3];
  const b = v.slice(4);
  const out = [`${head}: OUI ${name} (0x${oui})`, `	  ${subs[st] ?? "unknown"} Subtype (${st})`];
  if (oui === "0080c2" && st === 1) out.push(`	    port vlan id (PVID): ${(b[0] << 8) | b[1]}`);
  if (oui === "0080c2" && st === 3) out.push(`	    vlan id (VID): ${(b[0] << 8) | b[1]}`, `	    vlan name: ${text(b.slice(3, 3 + b[2]))}`);
  if (oui === "00120f" && st === 1) out.push(`	    autonegotiation [${b[0] & 1 ? "supported" : "none"}] (0x${b[0].toString(16).padStart(2, "0")})`, `	    MAU type ${(b[3] << 8) | b[4]}`);
  if (oui === "00120f" && st === 3) out.push(`	    aggregation status [${b[0] & 2 ? "enabled" : "supported"}], aggregation port ID ${((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0}`);
  if (oui === "00120f" && st === 4) out.push(`	    MTU size (MFS): ${(b[0] << 8) | b[1]}`);
  return out;
}

function tcpdumpTlvLines(raw: number[]): string[] {
  const out: string[] = [];
  let off = 0;
  while (off + 2 <= raw.length) {
    const hdr = (raw[off] << 8) | raw[off + 1];
    const type = hdr >> 9;
    const len = hdr & 0x1ff;
    const v = raw.slice(off + 2, off + 2 + len);
    off += 2 + len;
    const head = `\t${TD_TLV[type] ?? "Unknown"} TLV (${type}), length ${len}`;
    switch (type) {
      case TLV.CHASSIS:
      case TLV.PORT: {
        const names = type === TLV.CHASSIS ? TD_CHASSIS : TD_PORT;
        const isMac = (type === TLV.CHASSIS ? v[0] === 4 : v[0] === 3) && len === 7;
        out.push(head, `\t  Subtype ${names[v[0]] ?? "Unknown"} (${v[0]}): ${isMac ? hexMac(v.slice(1)) : text(v.slice(1))}`);
        break;
      }
      case TLV.TTL:
        out.push(`${head}: TTL ${(v[0] << 8) | v[1]}s`);
        break;
      case TLV.SYS_NAME:
      case TLV.PORT_DESCR:
        out.push(`${head}: ${text(v)}`);
        break;
      case TLV.SYS_DESCR:
        out.push(head, `\t  ${text(v)}`);
        break;
      case TLV.SYS_CAP:
        out.push(head, `\t  System  Capabilities ${capList((v[0] << 8) | v[1])}`, `\t  Enabled Capabilities ${capList((v[2] << 8) | v[3])}`);
        break;
      case TLV.MGMT: {
        const alen = v[0];
        out.push(head, `\t  Management Address length ${alen}, AFI IPv4 (1): ${v.slice(2, 6).join(".")}`);
        const ifSub = v[1 + alen];
        const ifNum = ((v[2 + alen] << 24) | (v[3 + alen] << 16) | (v[4 + alen] << 8) | v[5 + alen]) >>> 0;
        out.push(`\t  Interface ${ifSub === 2 ? "Index" : "Unknown"} Interface Numbering (${ifSub}): ${ifNum}`);
        break;
      }
      case TLV.ORG:
        out.push(...tcpdumpOrg(head, v));
        break;
      default:
        out.push(head);
    }
    if (type === TLV.END) break;
  }
  return out;
}

// ---------- runtime ----------

function stats(rt: LldpRuntime, port: string): LldpStats {
  return (rt.stats[port] ??= { tx: 0, rx: 0, discarded: 0, unrecognized: 0, ageout: 0 });
}

const sigOf = (pdu: number[]) => pdu.join(",");

function nextExpiry(rt: LldpRuntime): number | undefined {
  let t: number | undefined;
  for (const list of Object.values(rt.neighbors)) {
    for (const n of list) {
      const e = n.lastUpdate + n.ttl * 1000;
      if (t === undefined || e < t) t = e;
    }
  }
  return t;
}

function upsertNeighbor(rt: LldpRuntime, port: string, p: ParsedLldpdu["nb"], now: number): void {
  const list = (rt.neighbors[port] ??= []);
  const i = list.findIndex((n) => n.chassisId === p.chassisId && n.portId === p.portId);
  if (p.ttl === 0) {
    // Shutdown LLDPDU (lldpd.c:666).
    if (i >= 0) list.splice(i, 1);
    return;
  }
  if (i >= 0) {
    const old = list[i];
    const { rid, lastChange } = old;
    const same = JSON.stringify({ ...old, rid: 0, lastChange: 0, lastUpdate: 0 }) === JSON.stringify({ ...p, rid: 0, lastChange: 0, lastUpdate: 0 });
    list[i] = { ...p, rid, lastChange: same ? lastChange : now, lastUpdate: now };
    return;
  }
  if (list.length >= MAX_NEIGHBORS) return;
  // One RID per remote chassis, reused across ports (lldpd.c:645-660).
  const known = Object.values(rt.neighbors).flat().find((n) => n.chassisId === p.chassisId);
  const rid = known?.rid ?? ++rt.lastRid;
  list.push({ ...p, rid, lastChange: now, lastUpdate: now });
}

registerDaemon({
  id: "lldp",

  nextDue(d, now) {
    if (!runsLldp(d) || d.state === "down") return undefined;
    const rt = lldpRuntime(d);
    if (!featureEnabled(d, "lldp")) return rt ? now : undefined; // container stopping
    if (!rt) return now;
    if (now < rt.boot) return rt.boot;
    let due = nextExpiry(rt);
    const at = (t: number) => {
      if (due === undefined || t < due) due = t;
    };
    for (const p of lldpPorts(d)) {
      const prt = rt.ports[p.name];
      const up = linkUp(p);
      if (!prt || prt.up !== up) return now;
      if (!up || !lldpPortMode(d, p.name).tx) {
        if (prt.sig) return now;
        continue;
      }
      if (prt.sig !== sigOf(buildLldpdu(d, p))) return now;
      if (prt.next !== undefined) at(prt.next);
    }
    return due;
  },

  tick(ctx, d, now) {
    const rt = lldpRuntime(d);
    if (!featureEnabled(d, "lldp")) {
      if (!rt) return false;
      // lldpd_exit (lldpd.c:1316-1317): a shutdown LLDPDU on every port it was sending on.
      for (const p of lldpPorts(d)) {
        if (!rt.ports[p.name]?.sig || !linkUp(p)) continue;
        const pdu = buildLldpdu(d, p, true);
        transmitL2(ctx, d, p, LLDP_MULTICAST, ETH_P_LLDP, pdu, `LLDP, length ${pdu.length} (shutdown)`);
      }
      delete d.config.features![RT];
      return true;
    }
    if (!rt) {
      featureState<LldpRuntime>(d, RT, () => ({ boot: now + BOOT_DELAY_MS, lastRid: 0, ports: {}, neighbors: {}, stats: {} }));
      return true;
    }
    if (now < rt.boot) return false;
    const { interval } = lldpTimers(d);
    for (const p of lldpPorts(d)) {
      const prt = (rt.ports[p.name] ??= { up: false });
      const up = linkUp(p);
      if (!up && prt.up) delete rt.neighbors[p.name]; // lldpd.c:468
      if (up && lldpPortMode(d, p.name).tx) {
        const pdu = buildLldpdu(d, p);
        const sig = sigOf(pdu);
        if (!prt.up || prt.sig !== sig || prt.next === undefined || now >= prt.next) {
          const name = cfgOf(d)?.systemName ?? d.config.hostname ?? d.name;
          transmitL2(ctx, d, p, LLDP_MULTICAST, ETH_P_LLDP, pdu, `LLDP, length ${pdu.length}: ${name}`);
          stats(rt, p.name).tx++;
          prt.sig = sig;
          prt.next = now + interval * 1000;
        }
      } else {
        delete prt.sig;
        delete prt.next;
      }
      prt.up = up;
    }
    // Age out neighbours whose TTL elapsed (event.c:784).
    for (const [port, list] of Object.entries(rt.neighbors)) {
      const keep = list.filter((n) => now < n.lastUpdate + n.ttl * 1000);
      if (keep.length !== list.length) stats(rt, port).ageout += list.length - keep.length;
      if (keep.length) rt.neighbors[port] = keep;
      else delete rt.neighbors[port];
    }
    return true;
  },

  receiveL2(ctx, d, ingress, frame) {
    if (frame.ethernet.typeCode !== ETH_P_LLDP || !runsLldp(d)) return false;
    if (!featureEnabled(d, "lldp")) return false; // docker-lldp stopped: nobody listens
    const rt = lldpRuntime(d);
    const now = ctx.wallNow();
    if (!rt || now < rt.boot) return true; // paused until lldpmgrd resumes (lldpd.c:1052)
    if (!lldpPorts(d).includes(ingress)) return true;
    if (!lldpPortMode(d, ingress.name).rx) return true; // lldpd.c:1046
    const parsed = frame.rawL3 ? parseLldpdu(frame.rawL3) : null;
    const st = stats(rt, ingress.name);
    if (!parsed) {
      st.discarded++;
      return true;
    }
    st.rx++;
    st.unrecognized += parsed.unrecognized;
    upsertNeighbor(rt, ingress.name, parsed.nb, now);
    if (!rt.neighbors[ingress.name]?.length) delete rt.neighbors[ingress.name];
    return true;
  },

  describe(frame: Frame, verbose: boolean) {
    // tcpdump print-lldp.c: "LLDP, length <len>" + ": <system name>" without -v,
    // one line per TLV with -v (checked against tcpdump 4.99 reading a pcap).
    if (frame.ethernet.typeCode !== ETH_P_LLDP || !frame.rawL3) return undefined;
    const len = frame.meta.sizeBytes - 18 - (frame.vlan ? 4 : 0);
    if (verbose) return [`LLDP, length ${len}`, ...tcpdumpTlvLines(frame.rawL3)].join("\n");
    const p = parseLldpdu(frame.rawL3);
    return `LLDP, length ${len}${p?.nb.sysName ? `: ${p.nb.sysName}` : ""}`;
  },
});
