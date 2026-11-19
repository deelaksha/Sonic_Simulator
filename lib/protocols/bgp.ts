/**
 * BGP configuration model (the simulated CONFIG_DB BGP_GLOBALS / BGP_NEIGHBOR
 * tables) + compatibility exports for the engine.
 *
 * The protocol itself — TCP/179 sessions, the RFC 4271 FSM, UPDATE exchange,
 * best path and RIB installation — is the control-plane daemon in
 * ./bgp-daemon.ts, driven by wall-clock ticks like FRR's bgpd.
 *
 * Kept for frozen callers:
 *   handleBgpFrame     router.ts calls it for frames carrying the legacy typed
 *                      `frame.bgp` field. The daemon never sets that field (its
 *                      packets are raw bytes claimed in dispatchL3 before
 *                      router.ts gets here), so this is a no-op.
 *   convergeBgpDomain  Simulation.runBgp() / the `bgp converge` lab helper: runs
 *                      the daemon on every BGP speaker until nothing is due
 *                      "now" (connect timers forced due), i.e. a real
 *                      handshake + OPEN/KEEPALIVE/UPDATE exchange in one call.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { featureState, peekFeatureState } from "../models/feature-state";
import { runBgpToConvergence } from "./bgp-daemon";

export interface BgpNeighbor {
  peer: string;
  remoteAs?: number;
  description?: string;
  ebgpMultihop?: number;
  /** neighbor X timers <keepalive> <hold> */
  keepalive?: number;
  holdtime?: number;
  /** neighbor X timers connect <s> */
  connectRetry?: number;
  /** neighbor X update-source <ip|interface> */
  updateSource?: string;
  bfd?: boolean;
  shutdown?: boolean;
  /** `address-family l2vpn evpn` → `neighbor X activate` (MP capability AFI 25 / SAFI 70). */
  evpn?: boolean;
  /** `address-family ipv6 unicast` → `neighbor X activate` (MP capability AFI 2 / SAFI 1). */
  ipv6?: boolean;
  /** Per address family policy (`neighbor X route-map|prefix-list|filter-list NAME in|out`, ...). */
  af?: Partial<Record<"ipv4" | "ipv6", BgpNbrAf>>;
}

/** Neighbor policy for one address family (bgp_af_ipv4.xml / bgp_af_ipv6.xml nbr-af view). */
export interface BgpNbrAf {
  routeMapIn?: string;
  routeMapOut?: string;
  prefixListIn?: string;
  prefixListOut?: string;
  filterListIn?: string;
  filterListOut?: string;
  /** neighbor X weight N */
  weight?: number;
  /** neighbor X soft-reconfiguration inbound (keeps received-routes viewable) */
  softReconfig?: boolean;
}

export type RedistProto = "connected" | "static" | "ospf";

/** `redistribute <proto> [route-map NAME] [metric N]` */
export interface BgpRedist {
  routeMap?: string;
  metric?: number;
}

/** Per address family settings (`address-family ipv4|ipv6 unicast`). */
export interface BgpAfConfig {
  networks: string[];
  redist?: Partial<Record<RedistProto, BgpRedist>>;
  /** maximum-paths N (eBGP) / maximum-paths ibgp N — FRR default 1 (bgpd.h BGP_DEFAULT_MAXPATHS). */
  maxPaths?: number;
  maxPathsIbgp?: number;
  /** table-map NAME (route-map applied when installing into the RIB). */
  tableMap?: string;
}

export interface BgpConfig {
  localAs?: number;
  routerId?: string;
  neighbors: BgpNeighbor[];
  networks: string[]; // "a.b.c.d/len"
  /** timers bgp <keepalive> <hold> (router-wide defaults) */
  keepalive?: number;
  holdtime?: number;
  redistributeConnected?: boolean;
  /** `address-family l2vpn evpn` → `advertise-all-vni` (BGP learns local VNIs from zebra). */
  advertiseAllVni?: boolean;
  /** IPv4 unicast extras (networks/redistributeConnected above stay the IPv4 fields). */
  redist?: Partial<Record<RedistProto, BgpRedist>>;
  maxPaths?: number;
  maxPathsIbgp?: number;
  tableMap?: string;
  /** `address-family ipv6 unicast` */
  ipv6?: BgpAfConfig;
  /** bgp bestpath as-path multipath-relax */
  multipathRelax?: boolean;
  /** Set on `router bgp <as> vrf <name>` instances. */
  vrf?: string;
}

/** IPv4 unicast settings viewed as a BgpAfConfig (redistribute connected kept in sync). */
export function afConfig(cfg: BgpConfig, af: "ipv4" | "ipv6"): BgpAfConfig {
  if (af === "ipv6") return cfg.ipv6 ?? { networks: [] };
  const redist = { ...(cfg.redist ?? {}) };
  if (cfg.redistributeConnected && !redist.connected) redist.connected = {};
  return { networks: cfg.networks, redist, maxPaths: cfg.maxPaths, maxPathsIbgp: cfg.maxPathsIbgp, tableMap: cfg.tableMap };
}

/** `router bgp <as> vrf <name>` instances (feature "bgpvrf"). */
interface BgpVrfState {
  vrfs: Record<string, BgpConfig>;
}

/** The VRF instances' config store. */
export function bgpVrfState(device: Device): BgpVrfState {
  return featureState<BgpVrfState>(device, "bgpvrf", () => ({ vrfs: {} }));
}

/** VRF names that have a configured `router bgp <as> vrf <name>`. */
export function bgpVrfNames(device: Device): string[] {
  const st = peekFeatureState<BgpVrfState>(device, "bgpvrf");
  return Object.keys(st?.vrfs ?? {}).filter((v) => st!.vrfs[v].localAs !== undefined);
}

/** BGP config when `router bgp <as> [vrf <vrf>]` is configured, else undefined. */
export function getBgpConfig(device: Device, vrf = "default"): BgpConfig | undefined {
  const cfg = vrf === "default" ? peekFeatureState<BgpConfig>(device, "bgp") : peekFeatureState<BgpVrfState>(device, "bgpvrf")?.vrfs[vrf];
  if (!cfg || cfg.localAs === undefined) return undefined;
  if (!cfg.neighbors) cfg.neighbors = [];
  if (!cfg.networks) cfg.networks = [];
  return cfg;
}

/** Config store (created on first use by the config commands). */
export function bgpConfigState(device: Device): BgpConfig {
  return featureState<BgpConfig>(device, "bgp", () => ({ localAs: undefined, routerId: undefined, neighbors: [], networks: [] }));
}

/** No-op: see the module comment. */
export function handleBgpFrame(_ctx: SimContext, _device: Device, _ingress: NetInterface, _frame: Frame): void {}

export interface BgpSummary {
  routers: number;
  /** Established sessions, counted per speaker (A↔B counts 2). */
  sessions: number;
  routesInstalled: number;
}

export function convergeBgpDomain(ctx: SimContext): BgpSummary {
  return runBgpToConvergence(ctx);
}
