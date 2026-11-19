/**
 * Host-interface trap model of a SONiC switch (the ASIC → CPU path).
 *
 * Defaults are the image's COPP_GROUP / COPP_TRAP tables from
 * sonic-buildimage files/image_config/copp/copp_cfg.j2 (groups :2-214, traps
 * :215-316); trap-id names are copporch's trap_id_map (sonic-swss
 * orchagent/copporch.cpp:60-100). The KLISH CoPP objects the user configures
 * (copp-action = COPP_GROUP, class-map match protocol = COPP_TRAP trap_ids,
 * policy-map binding = trap → group, lib/commands/sonic/copp.ts) override the
 * defaults for the trap ids they claim.
 *
 * Feature gating follows coppmgr as documented in copp_cfg.j2:221-227: a
 * COPP_TRAP that is not always_enabled is installed only while the FEATURE of
 * the same name is enabled. Deviation: stp has no FEATURE in this image (so it
 * would never be installed) but the simulator runs an STP daemon, so the stp
 * trap is treated as installed.
 */
import { Device, isSwitch } from "../models/device";
import { Frame } from "../models/packet";
import { ownsIp } from "../models/interface";
import { peekFeatureState } from "../models/feature-state";
import { isBroadcast, isMulticast } from "../models/mac";
import { featureEnabled } from "./cpu-features";

export type MeterType = "packets" | "bytes";

export interface CoppGroup {
  trapAction: string;
  trapPriority?: number;
  queue: number;
  meterType: MeterType;
  mode?: string;
  /** undefined = no policer (copporch.cpp:795 creates one only when policer fields are set). */
  cir?: number;
  cbs?: number;
  redAction?: string;
}

const g = (prio: number, cir: number, action = "trap"): CoppGroup => ({
  trapAction: action,
  trapPriority: prio,
  queue: prio, // copp_cfg.j2 uses queue == trap_priority for every group
  meterType: "packets",
  mode: "sr_tcm",
  cir,
  cbs: cir,
  redAction: "drop",
});

/** COPP_GROUP (copp_cfg.j2:8-213). dhcp_relay uses the non-Mgmt 100 pps branch (:128). */
export const DEFAULT_GROUPS: Record<string, CoppGroup> = {
  lacp: g(23, 500),
  udld: g(22, 500),
  stp: g(21, 16000),
  bfd: g(20, 2000),
  lldp: g(18, 500),
  vrrp: g(17, 500),
  ospf: g(15, 5000),
  bgp: g(14, 10000),
  pim: g(13, 5000),
  igmp: g(12, 2000),
  arp: g(10, 3000, "copy"),
  dhcp_relay: g(9, 100),
  ip2me: g(7, 6000),
  mtu: g(4, 500),
  sflow: g(3, 8000),
  ttl: g(0, 100),
  macsec: g(8, 6000),
  nat: g(6, 600),
  neighbor_miss: g(11, 200),
  default: { trapAction: "trap", queue: 0, meterType: "packets", mode: "sr_tcm", cir: 100, cbs: 100, redAction: "drop" },
};

export interface CoppTrapEntry {
  trapIds: string[];
  group: string;
  alwaysEnabled?: boolean;
}

/** COPP_TRAP (copp_cfg.j2:228-315), keyed by the COPP_TRAP entry name. */
export const DEFAULT_TRAPS: Record<string, CoppTrapEntry> = {
  lacp: { trapIds: ["lacp"], group: "lacp", alwaysEnabled: true },
  udld: { trapIds: ["udld"], group: "udld", alwaysEnabled: true },
  stp: { trapIds: ["stp", "pvrst"], group: "stp" },
  bfd: { trapIds: ["bfd", "bfdv6"], group: "bfd", alwaysEnabled: true },
  lldp: { trapIds: ["lldp"], group: "lldp" },
  vrrp: { trapIds: ["vrrp", "vrrpv6"], group: "vrrp", alwaysEnabled: true },
  ospf: { trapIds: ["ospf", "ospfv6"], group: "ospf", alwaysEnabled: true },
  bgp: { trapIds: ["bgp", "bgpv6"], group: "bgp" },
  pim: { trapIds: ["pim"], group: "pim" },
  igmp: { trapIds: ["igmp_query"], group: "igmp" },
  arp: { trapIds: ["arp_req", "arp_resp", "neigh_discovery"], group: "arp", alwaysEnabled: true },
  dhcp_relay: { trapIds: ["dhcp", "dhcpv6"], group: "dhcp_relay" },
  ip2me: { trapIds: ["ip2me"], group: "ip2me", alwaysEnabled: true },
  mtu: { trapIds: ["l3_mtu_error"], group: "mtu" },
  sflow: { trapIds: ["sample_packet"], group: "sflow" },
  ttl: { trapIds: ["ttl_error"], group: "ttl", alwaysEnabled: true },
  macsec: { trapIds: ["eapol"], group: "macsec" },
  nat: { trapIds: ["src_nat_miss", "dest_nat_miss"], group: "nat" },
  neighbor_miss: { trapIds: ["neighbor_miss"], group: "neighbor_miss", alwaysEnabled: true },
};

/** Trap ids the KLISH classifier accepts (`show copp protocols`): copporch trap_id_map names the simulator can classify. */
export const TRAP_PROTOCOLS = [
  "arp_req", "arp_resp", "bfd", "bgp", "dhcp", "dhcpv6", "eapol", "igmp_query", "ip2me", "isis", "lacp", "ldp",
  "lldp", "ospf", "pim", "pvrst", "snmp", "ssh", "stp", "ttl_error", "udld", "vrrp",
];

// ---- KLISH CoPP configuration (features["copp"], written by lib/commands/sonic/copp.ts) ----

export interface CoppActionGroup {
  name: string;
  trapAction?: string;
  trapQueue?: number;
  trapPriority?: number;
  cir?: number;
  cbs?: number;
  meterType?: MeterType;
}
export interface CoppClassifier {
  name: string;
  protocols: string[];
}
export interface CoppBinding {
  classifier: string;
  action: string;
  priority: number;
}
export interface CoppState {
  actions: CoppActionGroup[];
  classifiers: CoppClassifier[];
  bindings: CoppBinding[];
}

/** COPP_TRAP keys that coppmgr feature-gates and that have a FEATURE (init_cfg.json FEATURE table). */
const GATED_BY_FEATURE = new Set(["lldp", "bgp", "dhcp_relay", "sflow", "macsec", "nat"]);
/** Not always_enabled and owned by no FEATURE → never installed (copp_cfg.j2:225-227), except stp (see header). */
const NEVER_INSTALLED = new Set(["pim", "igmp", "mtu"]);

export interface ResolvedTrap {
  trapId: string;
  /** Trap group (COPP_GROUP / KLISH action group name). */
  group: string;
  params: CoppGroup;
}

function configuredGroup(st: CoppState | undefined, trapId: string): { name: string; params: CoppGroup } | undefined {
  if (!st) return undefined;
  const bound = st.bindings
    .filter((b) => st.classifiers.find((c) => c.name === b.classifier)?.protocols.includes(trapId))
    .sort((a, b) => b.priority - a.priority)[0];
  const a = bound && st.actions.find((x) => x.name === bound.action);
  if (!a) return undefined;
  return {
    name: a.name,
    params: {
      trapAction: a.trapAction ?? "trap",
      trapPriority: a.trapPriority,
      queue: a.trapQueue ?? 0,
      meterType: a.meterType ?? "packets",
      mode: "sr_tcm",
      cir: a.cir,
      cbs: a.cir !== undefined ? (a.cbs ?? a.cir) : undefined,
      redAction: "drop",
    },
  };
}

/** The default COPP_TRAP entry that carries a trap id, and whether coppmgr has it installed. */
export function defaultTrapFor(device: Device, trapId: string): { key: string; entry: CoppTrapEntry; installed: boolean } | undefined {
  for (const [key, entry] of Object.entries(DEFAULT_TRAPS)) {
    if (!entry.trapIds.includes(trapId)) continue;
    let installed = true;
    if (!entry.alwaysEnabled) {
      if (GATED_BY_FEATURE.has(key)) installed = featureEnabled(device, key);
      else if (NEVER_INSTALLED.has(key)) installed = false;
    }
    return { key, entry, installed };
  }
  return undefined;
}

/** Resolve a trap id to its installed trap group (configured policy first, then copp_cfg defaults). */
export function resolveTrap(device: Device, trapId: string): ResolvedTrap | undefined {
  const cfg = configuredGroup(peekFeatureState<CoppState>(device, "copp"), trapId);
  if (cfg) return { trapId, group: cfg.name, params: cfg.params };
  const d = defaultTrapFor(device, trapId);
  if (!d || !d.installed) return undefined;
  return { trapId, group: d.entry.group, params: DEFAULT_GROUPS[d.entry.group] };
}

export interface Classification {
  /** Candidate trap ids, most specific first (BGP before IP2ME). */
  candidates: string[];
  /** FEATURE whose container hosts the receiving process (gated by `config feature state`). */
  owner?: string;
  /** A recognised link-local protocol whose trap is not installed is dropped (never bridged); anything else falls to the default group. */
  linkLocal: boolean;
}

const ETH_P_SLOW = 0x8809; // LACP (lacp-daemon.ts)
const ETH_P_LLDP = 0x88cc; // lldp-daemon.ts
const ETH_P_EAPOL = 0x888e;

function toMe(device: Device, ip: string): boolean {
  return device.interfaces.some((i) => ownsIp(i, ip));
}

/** Classify a frame the engine trapped to the CPU into SAI hostif trap ids. */
export function classifyTrap(device: Device, frame: Frame): Classification {
  const dst = frame.ethernet.dstMac.toUpperCase();
  const type = frame.ethernet.typeCode;
  if (frame.arp) return { candidates: [frame.arp.op === "request" ? "arp_req" : "arp_resp"], linkLocal: false };
  if (type === ETH_P_SLOW) return { candidates: ["lacp"], owner: "teamd", linkLocal: true };
  if (type === ETH_P_LLDP) return { candidates: ["lldp"], owner: "lldp", linkLocal: true };
  if (type === ETH_P_EAPOL) return { candidates: ["eapol"], owner: "macsec", linkLocal: true };
  if (frame.stp || dst === "01:80:C2:00:00:00") return { candidates: ["stp"], linkLocal: true };
  if (dst === "01:00:0C:CC:CC:CD") return { candidates: ["pvrst"], linkLocal: true };
  if (dst === "01:00:0C:CC:CC:CC") return { candidates: ["udld"], linkLocal: true };
  const ip = frame.ipv4;
  if (!ip) return { candidates: [], linkLocal: false }; // unrecognised protocol → default trap group
  const proto = ip.protocol === "OSPF" ? 89 : ip.protocol === "OTHER" ? ip.protocolNumber : undefined;
  if (frame.ospf || proto === 89) return { candidates: ["ospf"], owner: "bgp", linkLocal: false };
  if (proto === 112) return { candidates: ["vrrp"], linkLocal: false };
  if (proto === 103) return { candidates: ["pim"], linkLocal: false };
  if (proto === 2) return { candidates: ["igmp_query"], linkLocal: false };
  const mine = toMe(device, ip.dstIp);
  const l4 = frame.tcp ?? frame.udp;
  const port = (p: number) => !!l4 && (l4.srcPort === p || l4.dstPort === p);
  const ip2me = mine ? ["ip2me"] : [];
  if (frame.tcp && (frame.bgp || port(179))) return { candidates: ["bgp", ...ip2me], owner: "bgp", linkLocal: false };
  if (frame.udp && (port(3784) || port(4784))) return { candidates: ["bfd", ...ip2me], owner: "bgp", linkLocal: false };
  if (frame.udp && (frame.dhcp || port(67) || port(68))) return { candidates: ["dhcp", ...ip2me], owner: "dhcp_relay", linkLocal: false };
  if (frame.udp && (port(546) || port(547))) return { candidates: ["dhcpv6", ...ip2me], owner: "dhcp_relay", linkLocal: false };
  if (frame.udp && mine && (l4!.dstPort === 161 || l4!.dstPort === 162)) return { candidates: ["snmp", "ip2me"], owner: "snmp", linkLocal: false };
  if (frame.tcp && mine && port(22)) return { candidates: ["ssh", "ip2me"], linkLocal: false };
  if (mine) return { candidates: ["ip2me"], linkLocal: false };
  if (ip.ttl <= 1 && !isBroadcast(frame.ethernet.dstMac) && !isMulticast(frame.ethernet.dstMac)) {
    return { candidates: ["ttl_error"], linkLocal: false };
  }
  return { candidates: [], linkLocal: false };
}

/** First installed candidate, else the default group (IP) or nothing (link-local → dropped). */
export function trapFor(device: Device, c: Classification): ResolvedTrap | undefined {
  for (const id of c.candidates) {
    const r = resolveTrap(device, id);
    if (r) return r;
  }
  if (c.linkLocal) return undefined;
  return { trapId: "default", group: "default", params: DEFAULT_GROUPS.default };
}

export const isSonicSwitch = (d: Device) => isSwitch(d.type);
