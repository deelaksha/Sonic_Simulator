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
export function longestPrefixMatch(table: Route[], dstIp: string): RouteMatch | null {
  let best: Route | null = null;
  for (const r of table) {
    if (!cidrContains(r.destination, r.prefix, dstIp)) continue;
    if (best === null || r.prefix > best.prefix || (r.prefix === best.prefix && r.metric < best.metric)) {
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
