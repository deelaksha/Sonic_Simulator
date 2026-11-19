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
 * ECMP flow hash over the 5-tuple SONiC hashes by default (running-config
 * `ip load-share hash ipv4 ipv4-src-ip / ipv4-dst-ip / ipv4-ip-proto /
 * ipv4-l4-src-port / ipv4-l4-dst-port`). FNV-1a + fmix32: deterministic, so one
 * flow always takes the same next hop and different flows spread.
 */
export function flowHash5(srcIp: string, dstIp: string, proto: string | number, srcPort = 0, dstPort = 0, seed = 0): number {
  let h = 0x811c9dc5;
  for (const c of `${srcIp}|${dstIp}|${proto}|${srcPort}|${dstPort}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  // `ip load-share hash seed <n>` (lib/protocols/loadshare-hash.ts); seed 0 = unchanged hash.
  if (seed) h = Math.imul(h ^ seed, 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Longest-prefix match. Returns the most specific matching route, or null when
 * the destination is unreachable from this table (spec §9, §37). Among equal
 * best routes (same prefix, distance and metric — ECMP), `flowHash` picks one;
 * without it the first is used.
 */
export function longestPrefixMatch(table: Route[], dstIp: string, vrf = "default", flowHash?: number): RouteMatch | null {
  let best: Route[] = [];
  for (const r of table) {
    if ((r.vrf ?? "default") !== vrf) continue; // VRFs are separate routing tables
    if (!cidrContains(r.destination, r.prefix, dstIp)) continue;
    const b = best[0];
    const cmp = !b
      ? -1
      : r.prefix !== b.prefix
        ? b.prefix - r.prefix
        : routeDistance(r) !== routeDistance(b)
          ? routeDistance(r) - routeDistance(b)
          : r.metric - b.metric;
    if (cmp < 0) best = [r];
    else if (cmp === 0) best.push(r);
  }
  if (!best.length) return null;
  const chosen = best.length > 1 && flowHash !== undefined ? best[flowHash % best.length] : best[0];
  return { route: chosen, nextHopIp: chosen.nextHop ?? dstIp };
}

/** Longest-prefix match over an IPv6 routing table (destination/nextHop are v6 strings). */
export function longestPrefixMatch6(table: Route[], dstIp: string, vrf = "default"): RouteMatch | null {
  let best: Route | null = null;
  for (const r of table) {
    if ((r.vrf ?? "default") !== vrf || !contains6(r.destination, r.prefix, dstIp)) continue;
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

/** Keep an existing route's install time when the table is rebuilt. */
export function carryInstallTime(prev: Route[], next: Route[], nowMs: number): void {
  for (const r of next) {
    if (r.installedAtMs !== undefined) continue;
    const old = prev.find((p) => p.type === r.type && p.destination === r.destination && p.prefix === r.prefix && p.interfaceId === r.interfaceId);
    r.installedAtMs = old?.installedAtMs ?? nowMs;
  }
}
