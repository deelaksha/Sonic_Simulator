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
}

/** BGP config when `router bgp <as>` is configured, else undefined. */
export function getBgpConfig(device: Device): BgpConfig | undefined {
  const cfg = peekFeatureState<BgpConfig>(device, "bgp");
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
