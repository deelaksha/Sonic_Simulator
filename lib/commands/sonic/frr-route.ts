/**
 * `show ip route` as SONiC prints it — FRR 10.3 zebra (zebra_vty.c
 * vty_show_ip_route / show_route_nexthop_helper, header from route_types.pl).
 * One renderer for every route source (connected, local, static, OSPF, BGP),
 * so each routing protocol only has to install routes.
 */
import { Device, findInterface } from "../../models/device";
import { RouteType, routeDistance } from "../../models/route";
import { networkAddress } from "../../models/ip";
import { inactiveStatics } from "../../models/static-routes";

export const FRR_ROUTE_CODES = [
  "Codes: K - kernel route, C - connected, L - local, S - static,",
  "       R - RIP, O - OSPF, I - IS-IS, B - BGP, E - EIGRP, N - NHRP,",
  "       T - Table, v - VNC, V - VNC-Direct, A - Babel, F - PBR,",
  "       f - OpenFabric, t - Table-Direct,",
  "       > - selected route, * - FIB route, q - queued, r - rejected, b - backup",
  "       t - trapped, o - offload failure",
];

const CODE: Record<RouteType | "local", string> = { connected: "C", local: "L", static: "S", default: "S", ospf: "O", bgp: "B" };

/** FRR uptime2str: HH:MM:SS under a day, then XdXXhXXm, then XXwXdXXh. */
export function frrUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d === 0) return `${p(h)}:${p(m)}:${p(s % 60)}`;
  if (d < 7) return `${d}d${p(h)}h${p(m)}m`;
  return `${p(Math.floor(d / 7))}w${d % 7}d${p(h)}h`;
}

interface Entry {
  type: RouteType | "local";
  dest: string;
  prefix: number;
  distance: number;
  metric: number;
  nextHop: string | null;
  ifName: string;
  /** Next hop outside every subnet of the egress interface (EVPN/VXLAN): FRR prints "onlink". */
  onlink?: boolean;
  since: number;
  vrf: string;
  /** Static route whose next hop does not resolve (configured, not installed). */
  inactive?: boolean;
}

function entries(device: Device, nowMs: number): Entry[] {
  const out: Entry[] = [];
  const ifName = (id: string) => findInterface(device, id)?.name ?? id;
  for (const r of device.routingTable) {
    out.push({
      type: r.type,
      dest: r.destination,
      prefix: r.prefix,
      distance: routeDistance(r),
      metric: r.metric,
      nextHop: r.nextHop,
      ifName: ifName(r.interfaceId),
      onlink: !!r.nextHop && !(findInterface(device, r.interfaceId)?.ipv4 ?? []).some((a) => networkAddress(a.address, a.prefix) === networkAddress(r.nextHop!, a.prefix)),
      since: r.installedAtMs ?? nowMs,
      vrf: r.vrf ?? "default",
    });
    // FRR 10 installs a /32 local route for every connected address.
    if (r.type === "connected") {
      const iface = findInterface(device, r.interfaceId);
      for (const a of iface?.ipv4 ?? []) {
        if (a.prefix < 32 && networkAddress(a.address, a.prefix) === r.destination && a.prefix === r.prefix) {
          out.push({ ...out[out.length - 1], type: "local", dest: a.address, prefix: 32 });
        }
      }
    }
  }
  for (const r of inactiveStatics(device)) {
    out.push({ type: r.type, dest: r.destination, prefix: r.prefix, distance: routeDistance(r), metric: r.metric, nextHop: r.nextHop, ifName: "", since: r.installedAtMs ?? nowMs, vrf: r.vrf ?? "default", inactive: true });
  }
  return out;
}

const ipKey = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);

export function renderFrrRoutes(
  device: Device,
  nowMs: number,
  filter?: { network: string; prefix: number },
  vrf = "default",
  omitCodes = false,
  types?: string[],
): string[] {
  let all = entries(device, nowMs).filter((e) => e.vrf === vrf);
  if (filter) all = all.filter((e) => e.dest === filter.network && e.prefix === filter.prefix);
  // `show ip route static|connected|ospf|bgp|…` (zebra: route type filter; "default" is a static).
  if (types) all = all.filter((e) => types.includes(e.type === "default" ? "static" : e.type));
  const lines = [...(omitCodes ? [] : FRR_ROUTE_CODES), "", `IPv4 unicast VRF ${vrf}:`];
  const byPrefix = new Map<string, Entry[]>();
  for (const e of all) {
    const k = `${e.dest}/${e.prefix}`;
    byPrefix.set(k, [...(byPrefix.get(k) ?? []), e]);
  }
  const keys = [...byPrefix.keys()].sort((a, b) => {
    const [na, pa] = a.split("/");
    const [nb, pb] = b.split("/");
    return ipKey(na) - ipKey(nb) || Number(pa) - Number(pb);
  });
  for (const k of keys) {
    const group = byPrefix.get(k)!;
    // Selected = lowest distance, then metric; equal-cost entries are ECMP nexthops.
    // Inactive statics are never selected (zebra: no active nexthop).
    const live = group.filter((e) => !e.inactive);
    const best = live.length ? live.reduce((b, e) => (e.distance < b.distance || (e.distance === b.distance && e.metric < b.metric) ? e : b)) : undefined;
    const bySource = new Map<string, Entry[]>();
    for (const e of group) {
      const key = `${e.type}/${e.distance}/${e.metric}${e.inactive ? "/inactive" : ""}`;
      bySource.set(key, [...(bySource.get(key) ?? []), e]);
    }
    for (const [, set] of bySource) {
      const head = set[0];
      const selected = !!best && !head.inactive && head.type === best.type && head.distance === best.distance && head.metric === best.metric;
      const showDm = head.type !== "connected" && head.type !== "local";
      const prefixText = `${CODE[head.type]}${selected ? ">" : " "}${selected ? "*" : " "} ${k}${showDm ? ` [${head.distance}/${head.metric}]` : ""}`;
      set.forEach((e, i) => {
        // lib/nexthop.c nexthop_vty_helper: an unresolved gateway has no ifindex, then " inactive".
        const nh = e.inactive
          ? ` via ${e.nextHop} inactive, weight 1`
          : e.nextHop
            ? ` via ${e.nextHop}, ${e.ifName}${e.onlink ? " onlink" : ""}, weight 1`
            : ` is directly connected, ${e.ifName}`;
        const lead = i === 0 ? prefixText : `  ${selected ? "*" : " "}${" ".repeat(Math.max(1, prefixText.length - 3))}`;
        lines.push(`${lead}${nh}, ${frrUptime(nowMs - e.since)}`);
      });
    }
  }
  return lines;
}

/** Longest-prefix match for `show ip route <A.B.C.D>` (zebra rib_match). */
export function frrRouteLookup(device: Device, nowMs: number, ip: string, vrf = "default"): { network: string; prefix: number } | undefined {
  const hits = entries(device, nowMs).filter((e) => e.vrf === vrf && !e.inactive && networkAddress(ip, e.prefix) === e.dest);
  const best = hits.sort((a, b) => b.prefix - a.prefix)[0];
  return best && { network: best.dest, prefix: best.prefix };
}

/** Per route-type RIB / FIB counts for `show ip route summary` (zebra vty_show_ip_route_summary). */
export function frrRouteSummary(device: Device, nowMs: number, vrf = "default"): { type: string; rib: number; fib: number }[] {
  const counts = new Map<string, { rib: number; fib: number }>();
  for (const e of entries(device, nowMs).filter((x) => x.vrf === vrf)) {
    const t = e.type === "default" ? "static" : e.type;
    const c = counts.get(t) ?? { rib: 0, fib: 0 };
    c.rib++;
    if (!e.inactive) c.fib++;
    counts.set(t, c);
  }
  return [...counts].map(([type, c]) => ({ type, ...c }));
}
