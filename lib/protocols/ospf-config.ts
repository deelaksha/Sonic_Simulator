/**
 * OSPFv2 configuration (the simulated CONFIG_DB for `router ospf`), stored in
 * device.config.features.ospf. Written by the Click/KLISH commands, read by the
 * daemon (ospf-daemon.ts) and the show renderers (ospf-show.ts).
 *
 * Defaults are FRR 10.3's (lib/libospf.h): hello 10 s (:58), dead 40 s (:56),
 * retransmit 5 s (:61), transmit-delay 1 s (:63), priority 1 (:60),
 * reference bandwidth 100000 (:67).
 */
import { Device, isRouter, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { cidrContains, ipToInt } from "../models/ip";
import { vrfOf, DEFAULT_VRF } from "../models/vrf";
import { peekFeatureState } from "../models/feature-state";

export interface OspfNetwork {
  network: string; // "10.0.12.0/30"
  area: string; // dotted
}

export interface OspfRange {
  prefix: string; // "10.1.0.0/16"
  /** `area X range P not-advertise` */
  notAdvertise?: boolean;
  /** `area X range P cost N` */
  cost?: number;
}

export interface OspfArea {
  id: string;
  type?: string; // "stub" | "nssa"
  /** `area X stub no-summary` / `area X nssa no-summary` (totally stubby). */
  noSummary?: boolean;
  /** `area X default-cost N` — metric of the ABR's default summary (FRR default 1, ospfd.c:926). */
  defaultCost?: number;
  ranges?: OspfRange[];
}

export type RedistProto = "connected" | "static" | "bgp" | "kernel";

export interface OspfRedist {
  protocol: RedistProto;
  metric?: number;
  metricType?: 1 | 2;
  /** `route-map NAME`: deny keeps the route out, `set metric` sets the external metric (ospf_zebra.c ospf_redistribute_check). */
  routeMap?: string;
}

/** Interface-level `ip ospf …` parameters (keyed by interface name). */
export interface OspfIfParams {
  cost?: number;
  hello?: number;
  dead?: number;
  priority?: number;
  network?: "point-to-point" | "broadcast";
  bfd?: boolean;
  area?: string;
}

export interface OspfConfig {
  routerId?: string;
  networks: OspfNetwork[];
  areas: OspfArea[];
  passive?: string[];
  passiveDefault?: boolean;
  nonPassive?: string[];
  ifParams?: Record<string, OspfIfParams>;
  /** auto-cost reference-bandwidth (FRR stores the number as given; default 100000). */
  refBandwidth?: number;
  /** `redistribute connected|static|bgp|kernel [metric N] [metric-type 1|2] [route-map NAME]` */
  redistribute?: OspfRedist[];
  /** `default-information originate [always] [metric N] [metric-type 1|2]` */
  defaultInfo?: { always?: boolean; metric?: number; metricType?: 1 | 2 };
  /**
   * `log-adjacency-changes [detail]`. Unset = off: FRR's default is per build
   * profile (ospf_vty.c:47-50, on only for "datacenter"); SONiC builds FRR
   * without --enable-datacenter (sonic-frr debian/rules), so the "traditional"
   * profile applies, and frrcfgd only renders the command when configured
   * (sonic-frr-mgmt-framework templates/ospfd/ospfd.conf.db.comm_list.j2:16-25).
   */
  logAdjacencyChanges?: boolean | "detail";
}

export const OSPF_HELLO_DEFAULT = 10;
export const OSPF_DEAD_DEFAULT = 40;
export const OSPF_RXMT_DEFAULT = 5;
export const OSPF_PRIORITY_DEFAULT = 1;
export const OSPF_REF_BW_DEFAULT = 100000;
/** FRR's fallback when an interface reports no speed (OSPF_DEFAULT_BANDWIDTH, lib/libospf.h:64). */
const OSPF_DEFAULT_BANDWIDTH = 10000;

/**
 * Instances: `router ospf` (VRF default) lives in features.ospf; `router ospf
 * vrf NAME` in features["ospf:NAME"] (OSPFV2_ROUTER is keyed by vrf_name).
 */
export const ospfCfgKey = (vrf: string = DEFAULT_VRF) => (vrf === DEFAULT_VRF ? "ospf" : `ospf:${vrf}`);

export function ospfConfig(device: Device, vrf: string = DEFAULT_VRF): OspfConfig | undefined {
  return peekFeatureState<OspfConfig>(device, ospfCfgKey(vrf));
}

/** VRFs with a configured OSPF instance (default first). */
export function ospfConfiguredVrfs(device: Device): string[] {
  const f = device.config.features ?? {};
  const out = f.ospf ? [DEFAULT_VRF] : [];
  for (const k of Object.keys(f)) if (k.startsWith("ospf:") && f[k]) out.push(k.slice(5));
  return out;
}

/** OSPF runs on routers and SONiC switches (routed ports, SVIs, loopbacks) — never hosts. */
export function ospfCapable(device: Device): boolean {
  return isRouter(device.type) || isSwitch(device.type);
}

export const isLoopback = (iface: NetInterface) => /^(Loopback|lo)/.test(iface.name);

/**
 * Router ID: the configured one, else what zebra hands ospfd — the highest
 * loopback address, else the highest interface address.
 */
export function ospfRouterId(device: Device, cfg: OspfConfig): string {
  if (cfg.routerId) return cfg.routerId;
  const pick = (ifs: NetInterface[]) =>
    ifs.flatMap((i) => i.ipv4.map((a) => a.address)).filter((a) => !a.startsWith("127.")).sort((a, b) => ipToInt(b) - ipToInt(a))[0];
  return pick(device.interfaces.filter(isLoopback)) ?? pick(device.interfaces) ?? "0.0.0.0";
}

export interface OspfIfSpec {
  iface: NetInterface;
  ip: string;
  prefix: number;
  area: string;
  type: "broadcast" | "point-to-point" | "loopback";
  cost: number;
  hello: number;
  dead: number;
  priority: number;
  passive: boolean;
  bfd: boolean;
  up: boolean;
}

export function isPassive(cfg: OspfConfig, name: string): boolean {
  return cfg.passiveDefault ? !(cfg.nonPassive ?? []).includes(name) : (cfg.passive ?? []).includes(name);
}

/**
 * Output cost: `ip ospf cost` if configured, else reference-bandwidth / speed
 * rounded, clamped to 1..65535, loopback 0 (ospfd/ospf_interface.c:99-139).
 * Note FRR 10.3 divides the reference (100000) by the speed in Mb/s, so a 25G
 * port costs 4, 10G 10, 1G 100.
 */
export function ospfCost(cfg: OspfConfig, iface: NetInterface): number {
  const p = cfg.ifParams?.[iface.name];
  if (p?.cost !== undefined) return p.cost;
  const bw = iface.speed || OSPF_DEFAULT_BANDWIDTH;
  let cost = Math.floor((cfg.refBandwidth ?? OSPF_REF_BW_DEFAULT) / bw + 0.5);
  cost = Math.min(65535, Math.max(1, cost));
  return isLoopback(iface) ? 0 : cost;
}

/** Every interface OSPF is enabled on (network statement or `ip ospf area`), up or not. */
export function ospfInterfaces(device: Device, cfg: OspfConfig, vrf: string = DEFAULT_VRF): OspfIfSpec[] {
  const out: OspfIfSpec[] = [];
  for (const iface of device.interfaces) {
    const a = iface.ipv4[0];
    if (!a) continue;
    // Each instance only runs on interfaces of its own VRF (`router ospf vrf NAME`).
    if (vrfOf(device, iface) !== vrf) continue;
    const p = cfg.ifParams?.[iface.name] ?? {};
    let area = p.area;
    if (area === undefined) {
      for (const n of cfg.networks) {
        const [net, len] = n.network.split("/");
        if (cidrContains(net, Number(len), a.address)) {
          area = n.area;
          break;
        }
      }
    }
    if (area === undefined) continue;
    const hello = p.hello ?? OSPF_HELLO_DEFAULT;
    out.push({
      iface,
      ip: a.address,
      prefix: a.prefix,
      area,
      type: isLoopback(iface) ? "loopback" : (p.network ?? "broadcast"),
      cost: ospfCost(cfg, iface),
      hello,
      dead: p.dead ?? (p.hello !== undefined ? 4 * hello : OSPF_DEAD_DEFAULT),
      priority: p.priority ?? OSPF_PRIORITY_DEFAULT,
      passive: isPassive(cfg, iface.name),
      bfd: !!p.bfd,
      up: iface.adminState === "up" && iface.operState === "up",
    });
  }
  return out;
}

/** Areas the instance knows: from network statements, `area` commands and `ip ospf area`. */
export function ospfAreas(cfg: OspfConfig): OspfArea[] {
  const byId = new Map<string, OspfArea>();
  for (const n of cfg.networks) if (!byId.has(n.area)) byId.set(n.area, { id: n.area });
  for (const p of Object.values(cfg.ifParams ?? {})) if (p.area && !byId.has(p.area)) byId.set(p.area, { id: p.area });
  for (const a of cfg.areas) byId.set(a.id, { ...a });
  return [...byId.values()].sort((x, y) => ipToInt(x.id) - ipToInt(y.id));
}

export function areaType(cfg: OspfConfig, area: string): string | undefined {
  return cfg.areas.find((a) => a.id === area)?.type;
}

export function areaCfg(cfg: OspfConfig, area: string): OspfArea | undefined {
  return cfg.areas.find((a) => a.id === area);
}
