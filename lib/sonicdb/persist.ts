/**
 * Config persistence: `config save` / `config reload` / `config load`.
 *
 * sonic-utilities config/main.py:
 *   save   (1699-1755) `sonic-cfggen -d --print-data > /etc/sonic/config_db.json` (sorted)
 *   load   (1757-...)  `sonic-cfggen -j <file> --write-to-db` — merged on top of the running DB
 *   reload (2026-...)  stop services, flush CONFIG_DB, load the file, restart services
 *
 * The simulator's CONFIG_DB is the device model, so a "file" is a snapshot of
 * the configuration part of the model (interfaces' addressing/admin/VLAN mode,
 * VLANs, static routes and every feature's config store), kept per device in
 * device.config.features[FILES_KEY] keyed by path, together with the rendered
 * config_db.json text. Restoring re-applies that snapshot; reload additionally
 * drops all daemon runtime state and learned tables so protocols re-converge.
 */
import { Device } from "../models/device";
import { NetworkState, refreshLink } from "../models/topology";
import { NetInterface, createInterface, emptyStats } from "../models/interface";
import { Route } from "../models/route";
import { Vlan } from "../models/vlan";
import { MacEntry } from "../models/device";
import { rebuildConnectedRoutes, rebuildConnectedRoutes6 } from "../models/factory";
import { configDbJson } from "./project";

export const DEFAULT_CONFIG_FILE = "/etc/sonic/config_db.json";
export const FILES_KEY = "sonicdb_files";

/**
 * Daemon runtime stores (not configuration): dropped by `config reload` so the
 * daemons start from scratch, and never written into a saved file.
 * ospfd/bgpd/bfdd/teamd/iccpd/lldpd/vrrpd/vxlan-rt/sflow-agent/snmp-agent are the
 * RT keys of lib/protocols/*-daemon.ts and lib/sflow/agent.ts; "_"-prefixed keys
 * are private daemon scratch (stp-daemon `_stpLastHello`, nat.ts `_nat` translations,
 * ipsla-daemon `_ipsla` probes, pbr.ts `_fbs` counters, igmp-snooping `_l2mc`,
 * pim-daemon `_pimd`, mcast-host `_mcast-host`).
 * Round-12 daemons: ospf6d (ospf6-daemon RT6_KEY), radvd/slaac (radv-daemon), the
 * per-VRF instances "ospfd:<vrf>" (ospf-daemon rtKey) and "bgpd:<vrf>" (bgp-daemon
 * rtKey) via RUNTIME_PREFIXES, and the operational stores that share a feature
 * name with nothing configured in them: "udld" (per-port status/neighbours; config
 * is cp_udld), "errdisable" (err-disabled ports; config is cp_errdisable),
 * "storm-control" (policer buckets/drops; config is cp_storm_control),
 * "dhcp-snooping" (learned bindings; config is cp_dhcp_snooping), "link-track"
 * (group oper state; config is cp_link_track), "mirror" (ERSPAN GRE sequence;
 * config is cp_mirror), "evpn-mh-rt" (remote ES peers).
 * Config stores of the same features (ospf6, ipv6-nd, ospf:<vrf>, bgpvrf,
 * ipsla_routes, fbs, routemap, prefixlist, bgpclist, cp_*) are saved.
 */
export const RUNTIME_KEYS = new Set([
  "ospfd", "bgpd", "bfdd", "teamd", "iccpd", "lldpd", "vrrpd", "vxlan-rt", "sflow-agent", "snmp-agent", "counters", "copp-runtime", "cpu-queues", "qos-flows", "qos-queues", "qos-pfc",
  "ospf6d", "radvd", "slaac", "udld", "errdisable", "storm-control", "dhcp-snooping", "link-track", "mirror", "evpn-mh-rt",
]);
const RUNTIME_PREFIXES = ["ospfd:", "bgpd:"];

/**
 * State that is neither CONFIG_DB nor restarted daemons: logs, drop/traffic
 * counters, host-side tools (collector, trap receiver, SNMP manager) and the
 * saved files themselves. Kept as-is across reload and never saved.
 */
export const PRESERVED_KEYS = new Set([FILES_KEY, "syslog", "drops", "traffic-sink", "sflow-collector", "snmp-mgr", "snmptrapd"]);

const isRuntime = (k: string) => RUNTIME_KEYS.has(k) || k.startsWith("_") || RUNTIME_PREFIXES.some((p) => k.startsWith(p));

interface SavedIface {
  id: string;
  name: string;
  mac: string;
  management?: boolean;
  logical?: boolean;
  ipv4: NetInterface["ipv4"];
  ipv6: NetInterface["ipv6"];
  adminState: NetInterface["adminState"];
  speed: number;
  duplex: NetInterface["duplex"];
  vlan: NetInterface["vlan"];
}

export interface SavedConfig {
  savedAtMs: number;
  hostname: string;
  interfaces: SavedIface[];
  vlans?: Vlan[];
  staticRoutes: Route[];
  staticRoutes6: Route[];
  staticMacs: MacEntry[];
  features: Record<string, unknown>;
  /** The config_db.json text as written at save time (`cat` / show). */
  json: string;
}

const clone = <T>(v: T): T => structuredClone(v);

function files(d: Device): Record<string, SavedConfig> {
  const f = (d.config.features ??= {});
  return (f[FILES_KEY] ??= {}) as Record<string, SavedConfig>;
}

export function savedFile(d: Device, path = DEFAULT_CONFIG_FILE): SavedConfig | undefined {
  return (d.config.features?.[FILES_KEY] as Record<string, SavedConfig> | undefined)?.[path];
}

export function savedFileNames(d: Device): string[] {
  return Object.keys((d.config.features?.[FILES_KEY] as Record<string, SavedConfig> | undefined) ?? {});
}

/** `config save [file]`: snapshot the running configuration. */
export function saveConfig(d: Device, path = DEFAULT_CONFIG_FILE, nowMs = Date.now()): SavedConfig {
  const features: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d.config.features ?? {})) {
    if (isRuntime(k) || PRESERVED_KEYS.has(k)) continue;
    features[k] = clone(v);
  }
  const snap: SavedConfig = {
    savedAtMs: nowMs,
    hostname: d.config.hostname,
    interfaces: d.interfaces.map((i) => ({
      id: i.id,
      name: i.name,
      mac: i.mac,
      ...(i.management ? { management: true } : {}),
      ...(i.logical ? { logical: true } : {}),
      ipv4: clone(i.ipv4),
      ipv6: clone(i.ipv6),
      adminState: i.adminState,
      speed: i.speed,
      duplex: i.duplex,
      vlan: clone(i.vlan),
    })),
    vlans: d.config.vlans ? clone(d.config.vlans) : undefined,
    staticRoutes: clone(d.routingTable.filter((r) => r.type === "static")),
    staticRoutes6: clone(d.routingTable6.filter((r) => r.type === "static")),
    staticMacs: clone(d.macTable.filter((m) => m.static)),
    features,
    json: configDbJson(d),
  };
  files(d)[path] = snap;
  return snap;
}

/**
 * Apply a saved snapshot to the device.
 *   mode "reload": flush config + runtime, then load (config reload)
 *   mode "load":   re-apply the file's config, keep daemons/learned tables (config load)
 */
export function restoreConfig(d: Device, net: NetworkState, snap: SavedConfig, mode: "reload" | "load"): void {
  d.config.hostname = snap.hostname;

  // Interfaces: physical ports keep identity (cabling); logical ones follow the file.
  const saved = new Map(snap.interfaces.map((s) => [s.id, s]));
  const next: NetInterface[] = [];
  for (const cur of d.interfaces) {
    const s = saved.get(cur.id);
    if (!s) {
      if (!cur.logical) next.push(cur); // hardware cannot disappear
      continue;
    }
    next.push(applyIface(cur, s));
  }
  for (const s of snap.interfaces) {
    if (next.some((i) => i.id === s.id) || !s.logical) continue;
    const i = createInterface(s.id, s.name, s.mac);
    i.logical = true;
    i.operState = /^PortChannel/.test(s.name) ? "down" : "up";
    i.statistics = emptyStats();
    next.push(applyIface(i, s));
  }
  d.interfaces = next;

  d.config.vlans = snap.vlans ? clone(snap.vlans) : undefined;

  // Features: the file's config stores; preserved stores stay; runtime per mode.
  const cur = d.config.features ?? {};
  const features: Record<string, unknown> = clone(snap.features);
  for (const [k, v] of Object.entries(cur)) {
    if (PRESERVED_KEYS.has(k) || (mode === "load" && isRuntime(k))) features[k] = v;
  }
  d.config.features = features;

  if (mode === "reload") {
    // swss restart: neighbors/FDB flushed, protocol routes withdrawn until re-learned.
    d.routingTable = clone(snap.staticRoutes);
    d.routingTable6 = clone(snap.staticRoutes6);
    d.arpTable = [];
    d.ndpTable = [];
    d.macTable = clone(snap.staticMacs);
  } else {
    d.routingTable = [...d.routingTable.filter((r) => r.type !== "static"), ...clone(snap.staticRoutes)];
    d.routingTable6 = [...d.routingTable6.filter((r) => r.type !== "static"), ...clone(snap.staticRoutes6)];
    d.macTable = [...d.macTable.filter((m) => !m.static), ...clone(snap.staticMacs)];
  }

  for (const i of d.interfaces) {
    if (i.logical || i.management) continue;
    refreshLink(net, d.id, i.id);
  }
  rebuildConnectedRoutes(d);
  rebuildConnectedRoutes6(d);
}

function applyIface(i: NetInterface, s: SavedIface): NetInterface {
  i.ipv4 = clone(s.ipv4);
  i.ipv6 = clone(s.ipv6);
  i.adminState = s.adminState;
  i.speed = s.speed;
  i.duplex = s.duplex;
  i.vlan = clone(s.vlan);
  if (i.logical && s.adminState === "down") i.operState = "down";
  return i;
}
