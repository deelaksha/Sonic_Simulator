/**
 * BGP routing policy: prefix-lists, community-lists, AS-path access-lists and
 * route-maps evaluated the way FRR does it. The config lives where the CLI
 * modules store it (simulated CONFIG_DB):
 *   prefix-lists   device.config.features.prefixlist.lists / lists6
 *                  (lib/commands/sonic/prefixlist.ts)
 *   route-maps     device.config.features.routemap.maps — clause strings exactly
 *                  as typed (lib/commands/sonic/routemap.ts)
 *   community / AS-path lists   device.config.features.bgpclist (this module)
 *
 * Semantics (FRR 10.3):
 *   prefix-list    lib/plist.c prefix_list_apply (:770): lowest-seq matching entry
 *                  wins; an entry matches when the prefix lies inside the entry's
 *                  prefix and its length is exact (no ge/le) or within ge..le
 *                  (prefix_list_entry_match); no match → deny; a list that does not
 *                  exist → deny (:783); an empty list → permit (:789).
 *   community-list bgpd/bgp_clist.c community_list_match: first matching entry
 *                  decides, an entry matches when the route carries ALL its
 *                  communities (community_match); no match → deny. `exact-match`
 *                  (community_list_exact_match) needs the same set. The KLISH form
 *                  `bgp community-list standard N permit A B any` matches ANY member.
 *   as-path list   bgpd/bgp_filter.c as_list_apply: first entry whose regex matches
 *                  the AS path string wins; no match → deny. `_` is FRR's
 *                  "(^|[,{}() ]|$)" (bgp_regex.c bgp_regcomp).
 *   route-map      lib/routemap.c route_map_apply_ext (:2565): statements in seq
 *                  order; the first whose match clauses ALL match decides — permit
 *                  applies its set clauses, deny denies; no statement matches →
 *                  implicit deny. A missing route-map denies (bgp_route.c:1892,
 *                  bgp_input_modifier); a match on a missing prefix-/community-list
 *                  does not match (bgp_routemap.c route_match_*).
 *   sets           bgp_routemap.c: local-preference, metric [+|-]N, weight, origin,
 *                  community <list>|none [additive], as-path prepend <asn..>,
 *                  ip next-hop <addr>, ipv6 next-hop [global] <addr>.
 */
import { Device } from "../models/device";
import { cidrContains, networkAddress } from "../models/ip";
import { contains6, networkAddress6 } from "../models/ipv6";
import { featureState, peekFeatureState } from "../models/feature-state";

export type Af = "ipv4" | "ipv6";

/** RFC 1997 / RFC 3765 well-known communities (bgpd/bgp_community.h). */
export const COMMUNITY = { NO_EXPORT: 0xffffff01, NO_ADVERTISE: 0xffffff02, LOCAL_AS: 0xffffff03, NO_PEER: 0xffffff04 } as const;
const WELL_KNOWN: Record<string, number> = { "no-export": COMMUNITY.NO_EXPORT, "no-advertise": COMMUNITY.NO_ADVERTISE, "local-as": COMMUNITY.LOCAL_AS, "no-peer": COMMUNITY.NO_PEER };
/** community_str names (bgp_community.c community_com2str). */
const WELL_KNOWN_STR: Record<number, string> = { [COMMUNITY.NO_EXPORT]: "no-export", [COMMUNITY.NO_ADVERTISE]: "no-advertise", [COMMUNITY.LOCAL_AS]: "local-AS", [COMMUNITY.NO_PEER]: "no-peer" };

/** "65001:100" | "no-export" | "local-AS" | "4259840100" → 32-bit value, else null. */
export function parseCommunity(tok: string): number | null {
  const t = tok.toLowerCase();
  if (WELL_KNOWN[t] !== undefined) return WELL_KNOWN[t];
  const m = /^(\d+):(\d+)$/.exec(t);
  if (m) {
    const [a, n] = [Number(m[1]), Number(m[2])];
    return a <= 0xffff && n <= 0xffff ? ((a << 16) | n) >>> 0 : null;
  }
  return /^\d+$/.test(t) && Number(t) <= 0xffffffff ? Number(t) : null;
}

export function communityStr(v: number): string {
  return WELL_KNOWN_STR[v] ?? `${v >>> 16}:${v & 0xffff}`;
}

/** FRR keeps a community attribute sorted and unique (community_uniq_sort). */
export const sortCommunities = (c: number[]) => [...new Set(c)].sort((a, b) => a - b);
export const communitiesStr = (c: number[] | undefined) => (c ?? []).map(communityStr).join(" ");

// ---------------------------------------------------------------------------
// stored config

interface PrefixEntry {
  seq: number;
  action: "permit" | "deny";
  prefix: string;
  ge?: number;
  le?: number;
}
interface RouteMapStatement {
  seq: number;
  action: "permit" | "deny";
  match: string[];
  set: string[];
}
export interface CommunityEntry {
  seq: number;
  action: "permit" | "deny";
  /** Community tokens as configured (`65001:100`, `no-export`, ...). */
  members: string[];
  /** KLISH `any`: one member suffices (default: all members, FRR line semantics). */
  any?: boolean;
}
export interface AsPathEntry {
  seq: number;
  action: "permit" | "deny";
  regex: string;
}
export interface BgpListsState {
  community: Record<string, CommunityEntry[]>;
  aspath: Record<string, AsPathEntry[]>;
}

export function bgpListsState(device: Device): BgpListsState {
  return featureState<BgpListsState>(device, "bgpclist", () => ({ community: {}, aspath: {} }));
}
export function peekBgpLists(device: Device): BgpListsState | undefined {
  return peekFeatureState<BgpListsState>(device, "bgpclist");
}

function prefixLists(device: Device, af: Af): Record<string, PrefixEntry[]> | undefined {
  const st = peekFeatureState<{ lists?: Record<string, PrefixEntry[]>; lists6?: Record<string, PrefixEntry[]> }>(device, "prefixlist");
  return af === "ipv4" ? st?.lists : st?.lists6;
}

function routeMaps(device: Device): Record<string, RouteMapStatement[]> | undefined {
  return peekFeatureState<{ maps: Record<string, RouteMapStatement[]> }>(device, "routemap")?.maps;
}

/** Everything policy evaluation reads, for the daemon's change detection. */
export function policySig(device: Device): string {
  const f = device.config.features ?? {};
  return JSON.stringify([f.prefixlist ?? null, f.routemap ?? null, f.bgpclist ?? null]);
}

// ---------------------------------------------------------------------------
// prefix-list

function entryMatches(e: PrefixEntry, prefix: string, af: Af): boolean {
  const [addr, l] = prefix.split("/");
  const len = Number(l);
  const [eAddr, eLenS] = e.prefix.split("/");
  const eLen = Number(eLenS);
  if (len < eLen) return false;
  const inside = af === "ipv4" ? cidrContains(eAddr, eLen, addr) && networkAddress(addr, eLen) === eAddr : contains6(eAddr, eLen, addr) && networkAddress6(addr, eLen) === networkAddress6(eAddr, eLen);
  if (!inside) return false;
  if (e.ge === undefined && e.le === undefined) return len === eLen;
  if (e.ge !== undefined && len < e.ge) return false;
  if (e.le !== undefined && len > e.le) return false;
  return true;
}

/** prefix_list_apply: true = permit. */
export function prefixListPermits(device: Device, name: string, prefix: string, af: Af): boolean {
  const list = prefixLists(device, af)?.[name];
  if (!list) return false;
  if (!list.length) return true;
  const hit = [...list].sort((a, b) => a.seq - b.seq).find((e) => entryMatches(e, prefix, af));
  return hit?.action === "permit";
}

/** Is a prefix-list with this name configured? */
export function prefixListExists(device: Device, name: string, af: Af): boolean {
  return !!prefixLists(device, af)?.[name];
}

// ---------------------------------------------------------------------------
// community-list / as-path list

function communityEntryMatches(e: CommunityEntry, comms: number[], exact: boolean): boolean {
  const vals = e.members.map(parseCommunity).filter((v): v is number => v !== null);
  if (exact) return vals.length === new Set(comms).size && vals.every((v) => comms.includes(v));
  return e.any ? vals.some((v) => comms.includes(v)) : vals.every((v) => comms.includes(v));
}

export function communityListPermits(device: Device, name: string, comms: number[], exact = false): boolean {
  const list = peekBgpLists(device)?.community[name];
  if (!list) return false;
  const hit = [...list].sort((a, b) => a.seq - b.seq).find((e) => communityEntryMatches(e, comms, exact));
  return hit?.action === "permit";
}

/** FRR AS-path regex → JS RegExp (`_` = "(^|[,{}() ]|$)"). */
export function asPathRegex(re: string): RegExp {
  return new RegExp(re.replace(/_/g, "(?:^|[,{}() ]|$)"));
}

export function asPathListPermits(device: Device, name: string, asPath: number[]): boolean {
  const list = peekBgpLists(device)?.aspath[name];
  if (!list) return false;
  const s = asPath.join(" ");
  const hit = [...list]
    .sort((a, b) => a.seq - b.seq)
    .find((e) => {
      try {
        return asPathRegex(e.regex).test(s);
      } catch {
        return false;
      }
    });
  return hit?.action === "permit";
}

// ---------------------------------------------------------------------------
// route-map

/** The attributes a route-map can match on and modify. */
export interface PolicyAttrs {
  origin: number;
  asPath: number[];
  nextHop: string;
  med?: number;
  localPref?: number;
  weight: number;
  communities?: number[];
}

export interface PolicyRoute {
  prefix: string;
  af: Af;
  /** Neighbor the route came from / goes to (match peer). */
  peer?: string;
  /** Source protocol of a redistributed route (match source-protocol). */
  protocol?: string;
}

const ORIGINS: Record<string, number> = { igp: 0, egp: 1, incomplete: 2 };

function matchClause(device: Device, clause: string, r: PolicyRoute, a: PolicyAttrs): boolean {
  const t = clause.split(/\s+/);
  const k = t[0];
  if ((k === "ip" || k === "ipv6") && t[1] === "address" && t[2] === "prefix-list") {
    const af: Af = k === "ip" ? "ipv4" : "ipv6";
    return af === r.af && !!t[3] && prefixListExists(device, t[3], af) && prefixListPermits(device, t[3], r.prefix, af);
  }
  if (k === "community") return !!t[1] && communityListPermits(device, t[1], a.communities ?? [], t[2] === "exact-match");
  if (k === "as-path") return !!t[1] && asPathListPermits(device, t[1], a.asPath);
  if (k === "metric") return (a.med ?? 0) === Number(t[1]);
  if (k === "local-preference") return (a.localPref ?? 100) === Number(t[1]);
  if (k === "origin") return ORIGINS[t[1]] === a.origin;
  if (k === "peer") return r.peer === t[1];
  if (k === "source-protocol") return (r.protocol ?? "bgp") === t[1];
  return false; // clause this simulator does not evaluate: never matches
}

function setClause(clause: string, r: PolicyRoute, a: PolicyAttrs): void {
  const t = clause.split(/\s+/);
  const k = t[0];
  const n = Number(t[1]);
  if (k === "local-preference" && Number.isFinite(n)) a.localPref = n;
  else if (k === "weight" && Number.isFinite(n)) a.weight = n;
  else if (k === "metric") {
    const v = t[1] ?? "";
    if (/^\+\d+$/.test(v)) a.med = (a.med ?? 0) + Number(v.slice(1));
    else if (/^-\d+$/.test(v)) a.med = Math.max(0, (a.med ?? 0) - Number(v.slice(1)));
    else if (/^\d+$/.test(v)) a.med = Number(v);
  } else if (k === "origin" && ORIGINS[t[1]] !== undefined) a.origin = ORIGINS[t[1]];
  else if (k === "as-path" && t[1] === "prepend") {
    const asns = t.slice(2).filter((x) => /^\d+$/.test(x)).map(Number);
    a.asPath = [...asns, ...a.asPath];
  } else if (k === "community") {
    const rest = t.slice(1);
    if (rest[0] === "none") {
      a.communities = undefined;
      return;
    }
    const additive = rest.includes("additive");
    const vals = rest.map(parseCommunity).filter((v): v is number => v !== null);
    const merged = sortCommunities([...(additive ? (a.communities ?? []) : []), ...vals]);
    a.communities = merged.length ? merged : undefined;
  } else if (k === "ip" && t[1] === "next-hop" && r.af === "ipv4" && /^\d+\.\d+\.\d+\.\d+$/.test(t[2] ?? "")) a.nextHop = t[2];
  else if (k === "ipv6" && t[1] === "next-hop" && r.af === "ipv6") {
    const v = t[2] === "global" ? t[3] : t[2];
    if (v && v.includes(":")) a.nextHop = v;
  }
}

/**
 * route_map_apply: "permit" (attrs modified in place) or "deny". A route-map
 * name that is not configured denies.
 */
export function applyRouteMap(device: Device, name: string, r: PolicyRoute, a: PolicyAttrs): "permit" | "deny" {
  const stmts = routeMaps(device)?.[name];
  if (!stmts) return "deny";
  for (const s of [...stmts].sort((x, y) => x.seq - y.seq)) {
    if (!s.match.every((m) => matchClause(device, m, r, a))) continue;
    if (s.action === "deny") return "deny";
    for (const c of s.set) setClause(c, r, a);
    return "permit";
  }
  return "deny";
}

export function routeMapExists(device: Device, name: string): boolean {
  return !!routeMaps(device)?.[name];
}
