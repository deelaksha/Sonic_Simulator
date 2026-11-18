/**
 * IPv4 routing table entry + longest-prefix-match lookup.
 */
import { cidrContains } from "./ip";
import { contains6 } from "./ipv6";

export type RouteType = "connected" | "static" | "default" | "ospf" | "bgp";

export interface Route {
  destination: string; // network address, e.g. "192.168.1.0"
  prefix: number; // e.g. 24 (0 for default route)
  /** null => on-link / connected (next hop is the destination host itself). */
  nextHop: string | null;
  interfaceId: string;
  type: RouteType;
  metric: number;
  /** Administrative distance (FRR): connected 0, static 1, eBGP 20, OSPF 110, iBGP 200. */
  distance?: number;
  /** Wall-clock ms the route was installed (FRR uptime column). */
  installedAtMs?: number;
  /** VRF the route belongs to; undefined = "default". */
  vrf?: string;
}

const DEFAULT_DISTANCE: Record<RouteType, number> = { connected: 0, static: 1, default: 1, ospf: 110, bgp: 20 };

export function routeDistance(r: Route): number {
  return r.distance ?? DEFAULT_DISTANCE[r.type];
}

export interface RouteMatch {
  route: Route;
  /** The IP we must actually resolve at L2: next hop, or the destination on a connected route. */
  nextHopIp: string;
}

/**
 * Longest-prefix match. Returns the most specific matching route, or null when
 * the destination is unreachable from this table (spec §9, §37).
 */
export function longestPrefixMatch(table: Route[], dstIp: string, vrf = "default"): RouteMatch | null {
  let best: Route | null = null;
  for (const r of table) {
    if ((r.vrf ?? "default") !== vrf) continue; // VRFs are separate routing tables
    if (!cidrContains(r.destination, r.prefix, dstIp)) continue;
    if (
      best === null ||
      r.prefix > best.prefix ||
      (r.prefix === best.prefix &&
        (routeDistance(r) < routeDistance(best) || (routeDistance(r) === routeDistance(best) && r.metric < best.metric)))
    ) {
      best = r;
    }
  }
  if (!best) return null;
  return { route: best, nextHopIp: best.nextHop ?? dstIp };
}

/** Longest-prefix match over an IPv6 routing table (destination/nextHop are v6 strings). */
export function longestPrefixMatch6(table: Route[], dstIp: string): RouteMatch | null {
  let best: Route | null = null;
  for (const r of table) {
    if (!contains6(r.destination, r.prefix, dstIp)) continue;
    if (best === null || r.prefix > best.prefix || (r.prefix === best.prefix && r.metric < best.metric)) {
      best = r;
    }
  }
  if (!best) return null;
  return { route: best, nextHopIp: best.nextHop ?? dstIp };
}

/** Keep an existing route's install time when the table is rebuilt. */
export function carryInstallTime(prev: Route[], next: Route[], nowMs: number): void {
  for (const r of next) {
    if (r.installedAtMs !== undefined) continue;
    const old = prev.find((p) => p.type === r.type && p.destination === r.destination && p.prefix === r.prefix && p.interfaceId === r.interfaceId);
    r.installedAtMs = old?.installedAtMs ?? nowMs;
  }
}
