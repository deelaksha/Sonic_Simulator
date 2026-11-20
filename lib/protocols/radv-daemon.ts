/**
 * IPv6 router advertisement daemon (SONiC docker-router-advertiser / radvd)
 * and the host side of Neighbor Discovery: SLAAC + default router list.
 *
 * Router side (switches and routers): every up L3 interface with a global
 * IPv6 address advertises, as radvd does with dockers/docker-router-advertiser/
 * radvd.conf.j2:
 *   MaxRtrAdvInterval 180 (MinRtrAdvInterval 60; the simulator always uses
 *   Max, no random jitter), AdvLinkMTU 9100, AdvDefaultLifetime 3 x Max = 540,
 *   AdvCurHopLimit 64, one prefix option per configured prefix with
 *   AdvOnLink on and valid/preferred lifetime infinity.
 *   Startup: an RA at once, then MAX_INITIAL_RTR_ADVERTISEMENTS (3) at
 *   MAX_INITIAL_RTR_ADVERT_INTERVAL (16 s) (RFC 4861 10, radvd defaults.h).
 *   Router Solicitations are answered with a multicast RA, at most one per
 *   MIN_DELAY_BETWEEN_RAS (3 s).
 *   KLISH interface config (cli-xml/ipv6.xml `ipv6 nd ...`): suppress-ra,
 *   ra-interval <1-1800> (= MaxRtrAdvInterval), managed-config-flag (M),
 *   other-config-flag (O) — M/O are off unless configured.
 *   Deviation: the SONiC template sets AdvManagedFlag on / AdvAutonomous off
 *   (it expects DHCPv6); the simulator has no DHCPv6 server for hosts, so /64
 *   prefixes are advertised with the A flag on and hosts autoconfigure.
 *
 * Host side (Linux accept_ra=1, autoconf=1, addr_gen_mode eui64): an RA from a
 * link-local source with hop limit 255 adds the source to the default router
 * list (`default via fe80::… proto ra metric 1024`, router lifetime), learns
 * its MAC from the source link-layer option, and each /64 prefix with the A
 * flag forms prefix + EUI-64 (RFC 4862 5.5.3). Hosts with IPv6 send up to
 * MAX_RTR_SOLICITATIONS (3) Router Solicitations RTR_SOLICITATION_INTERVAL
 * (4 s) apart when their link comes up without a default router.
 *
 * Every IPv6-enabled interface also gets its EUI-64 link-local, and connected
 * IPv6 routes are kept in sync (switches included) — see ipv6.ts.
 */
import { registerDaemon } from "../control/daemon";
import { Device, findInterface, isHost, isRouter, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { peekFeatureState } from "../models/feature-state";
import { isLinkLocal6, networkAddress6, normalizeIpv6, slaacAddress, parseIpv6 } from "../models/ipv6";
import { SimContext } from "../engine/context";
import {
  IPV6_NH,
  registerV6Receiver,
  transmitIpv6,
  multicastMac6,
  ip6Payload,
  ip6NextHeader,
  ensureLinkLocal,
  addGlobal6,
  syncConnected6,
  linkLocalOf,
  ipv6Enabled,
  learnNdp,
} from "./ipv6";
import { ALL_NODES, ALL_ROUTERS, ICMP6_RA, ICMP6_RS, INFINITY, encodeRa, encodeRs, decodeRa, decodeRs, icmp6ChecksumOk, describeNd } from "./radv-wire";

// radvd.conf.j2 / radvd defaults.h / RFC 4861 10
export const MAX_RTR_ADV_INTERVAL = 180;
export const MIN_RTR_ADV_INTERVAL = 60;
export const ADV_LINK_MTU = 9100;
const MAX_INITIAL_RTR_ADVERTISEMENTS = 3;
const MAX_INITIAL_RTR_ADVERT_INTERVAL = 16;
const MIN_DELAY_BETWEEN_RAS = 3;
const MAX_RTR_SOLICITATIONS = 3;
const RTR_SOLICITATION_INTERVAL = 4;
const RTR_SOLICITATION_DELAY = 1;
/** Linux metric of RA-learned default routes (IP6_RT_PRIO_USER). */
export const RA_DEFAULT_METRIC = 1024;

/** KLISH `ipv6 nd …` per interface (cli-xml/ipv6.xml:566-602), keyed by interface name. */
export interface NdIfConfig {
  suppressRa?: boolean;
  raInterval?: number;
  managed?: boolean;
  other?: boolean;
}
export const ND_KEY = "ipv6-nd";
export const ndConfig = (device: Device): Record<string, NdIfConfig> => peekFeatureState<Record<string, NdIfConfig>>(device, ND_KEY) ?? {};

interface RaIf {
  ifId: string;
  next: number;
  initLeft: number;
  last?: number;
  sent: number;
}
export interface RadvdRt {
  sig: string;
  ifs: Record<string, RaIf>;
}

export interface SlaacRouter {
  ifId: string;
  addr: string;
  lifetime: number;
  expiresMs: number;
  managed: boolean;
  other: boolean;
}
export interface SlaacAddr {
  ifId: string;
  address: string;
  prefix: number;
  /** undefined = infinite valid lifetime. */
  expiresMs?: number;
}
export interface SlaacRt {
  sig: string;
  routers: SlaacRouter[];
  addrs: SlaacAddr[];
  rs: Record<string, { sent: number; due?: number }>;
}

const RADVD = "radvd";
const SLAAC = "slaac";
export const radvdRuntime = (d: Device) => peekFeatureState<RadvdRt>(d, RADVD);
export const slaacRuntime = (d: Device) => peekFeatureState<SlaacRt>(d, SLAAC);

const isRouterLike = (d: Device) => isRouter(d.type) || isSwitch(d.type);
const up = (i: NetInterface) => i.adminState === "up" && i.operState === "up";
const globals = (i: NetInterface) => i.ipv6.filter((a) => !isLinkLocal6(a.address));

function emit(ctx: SimContext, d: Device, iface: NetInterface, type: "NDP_ADVERTISEMENT" | "NDP_SOLICITATION", message: string): void {
  ctx.emit({ type, deviceId: d.id, deviceName: d.name, interfaceId: iface.id, interfaceName: iface.name, message: `${d.name}: ${message}`, osiLayers: [3] });
}

/** Interfaces radvd advertises on: up, L3, a global prefix, not suppressed. */
function raInterfaces(d: Device): NetInterface[] {
  const nd = ndConfig(d);
  return d.interfaces.filter((i) => !i.management && !/^(Loopback|lo)/.test(i.name) && up(i) && globals(i).length > 0 && !nd[i.name]?.suppressRa);
}

/** Everything that changes addressing / advertising, so a change makes the daemon due at once. */
function sig(d: Device): string {
  const ifs = d.interfaces.filter((i) => ipv6Enabled(i)).map((i) => [i.id, i.ipv6, i.adminState, i.operState]);
  if (!ifs.length && !radvdRuntime(d) && !slaacRuntime(d)) return "";
  const conn = (d.routingTable6 ?? []).filter((r) => r.type === "connected").length;
  return JSON.stringify([ifs, conn, isRouterLike(d) ? ndConfig(d) : null]);
}

/**
 * KLISH `show ipv6 nd ra-interfaces [<if>]` (data/device-capture/klish-xml/ipv6-neighbors.xml:1229-1262;
 * the per-interface lines are FRR zebra rtadv.c:1736-1803 nd_dump_vty). Lists the interfaces
 * that send RAs — an `ipv6 nd suppress-ra` interface is absent. Values are radvd's
 * (reachable/retrans 0, hop limit 64, lifetime 3 x interval, MTU 9100).
 */
export function renderRaInterfaces(d: Device, ifname?: string): string[] {
  const out = ["Interfaces:"];
  for (const i of raInterfaces(d).filter((x) => !ifname || x.name === ifname)) {
    const cfg = ndConfig(d)[i.name] ?? {};
    out.push(
      `    ${i.name}`,
      "  ND advertised reachable time is 0 milliseconds",
      "  ND advertised retransmit interval is 0 milliseconds",
      "  ND advertised hop-count limit is 64 hops",
      `  ND router advertisements sent: ${radvdRuntime(d)?.ifs[i.name]?.sent ?? 0} rcvd: 0`,
      `  ND router advertisements are sent every ${maxInterval(d, i.name)} seconds`,
      "  ND router advertisements lifetime tracks ra-interval",
      "  ND router advertisement default router preference is MEDIUM",
      cfg.managed ? "  Hosts use DHCP to obtain routable addresses." : "  Hosts use stateless autoconfig for addresses.",
      `  Advertised Link MTU is ${ADV_LINK_MTU}`,
    );
  }
  return out;
}

const maxInterval = (d: Device, name: string) => ndConfig(d)[name]?.raInterval ?? MAX_RTR_ADV_INTERVAL;

// --- router side ---------------------------------------------------------------

function sendRa(ctx: SimContext, d: Device, iface: NetInterface, now: number): void {
  const src = linkLocalOf(iface);
  if (!src) return;
  const cfg = ndConfig(d)[iface.name] ?? {};
  const max = maxInterval(d, iface.name);
  const seen = new Set<string>();
  const prefixes = globals(iface).flatMap((a) => {
    const net = `${networkAddress6(a.address, a.prefix)}/${a.prefix}`;
    if (seen.has(net)) return [];
    seen.add(net);
    return [{ prefix: networkAddress6(a.address, a.prefix), len: a.prefix, onLink: true, autonomous: a.prefix === 64, valid: INFINITY, preferred: INFINITY }];
  });
  const msg = encodeRa(src, ALL_NODES, {
    curHopLimit: 64,
    managed: !!cfg.managed,
    other: !!cfg.other,
    lifetime: Math.min(9000, 3 * max),
    reachable: 0,
    retrans: 0,
    prefixes,
    mtu: ADV_LINK_MTU,
    slla: iface.mac.toLowerCase(),
  });
  transmitIpv6(ctx, d, iface, multicastMac6(ALL_NODES), { src, dst: ALL_NODES, nextHeader: IPV6_NH.ICMPV6, hopLimit: 255, payload: msg, summary: `ICMPv6 Router Advertisement ${prefixes.map((p) => `${p.prefix}/${p.len}`).join(" ")}` });
  emit(ctx, d, iface, "NDP_ADVERTISEMENT", `radvd: Router Advertisement on ${iface.name} (${prefixes.map((p) => `${p.prefix}/${p.len}`).join(", ")}) → ff02::1`);
  const st = radvdRuntime(d)?.ifs[iface.name];
  if (st) {
    st.last = now;
    st.sent++;
  }
}

function reconcileRouter(d: Device, now: number): void {
  const f = (d.config.features ??= {});
  const rt = (f[RADVD] ??= { sig: "", ifs: {} }) as RadvdRt;
  const want = raInterfaces(d);
  for (const name of Object.keys(rt.ifs)) if (!want.some((i) => i.name === name && i.id === rt.ifs[name].ifId)) delete rt.ifs[name];
  for (const i of want) rt.ifs[i.name] ??= { ifId: i.id, next: now, initLeft: MAX_INITIAL_RTR_ADVERTISEMENTS, sent: 0 };
}

// --- host side -------------------------------------------------------------------

function slaacState(d: Device): SlaacRt {
  const f = (d.config.features ??= {});
  return (f[SLAAC] ??= { sig: "", routers: [], addrs: [], rs: {} }) as SlaacRt;
}

/** Install / refresh the RA-learned default routes in the RIB. */
function syncRaRoutes(d: Device, st: SlaacRt): void {
  const table = d.routingTable6 ?? (d.routingTable6 = []);
  const isRa = (r: { type: string; nextHop: string | null; destination: string; prefix: number }) => r.type === "default" && r.prefix === 0 && !!r.nextHop && isLinkLocal6(r.nextHop);
  const keep = table.filter((r) => !isRa(r));
  const ra = st.routers.map((r) => {
    const old = table.find((x) => isRa(x) && x.nextHop === r.addr && x.interfaceId === r.ifId);
    return { destination: "::", prefix: 0, nextHop: r.addr, interfaceId: r.ifId, type: "default" as const, metric: RA_DEFAULT_METRIC, installedAtMs: old?.installedAtMs ?? Date.now() };
  });
  d.routingTable6 = [...keep, ...ra];
}

function raRoutesMissing(d: Device, st: SlaacRt): boolean {
  return st.routers.some((r) => !(d.routingTable6 ?? []).some((x) => x.type === "default" && x.nextHop === r.addr && x.interfaceId === r.ifId));
}

function reconcileHost(d: Device, now: number): void {
  const st = slaacState(d);
  for (const i of d.interfaces) {
    const rs = (st.rs[i.id] ??= { sent: 0 });
    if (i.adminState !== "up" && (st.routers.some((r) => r.ifId === i.id) || st.addrs.some((a) => a.ifId === i.id))) {
      // `ip link set <if> down` (addrconf_ifdown): the kernel drops the routes via the
      // interface, its RA default routers and its autoconfigured addresses; they come
      // back from the RA answering the Router Solicitation sent when the link is up again.
      // (Carrier loss alone only marks the routes linkdown and keeps them.)
      const gone = st.addrs.filter((a) => a.ifId === i.id).map((a) => a.address);
      i.ipv6 = i.ipv6.filter((x) => !gone.includes(normalizeIpv6(x.address)));
      st.addrs = st.addrs.filter((a) => a.ifId !== i.id);
      st.routers = st.routers.filter((r) => r.ifId !== i.id);
      syncConnected6(d);
      syncRaRoutes(d, st);
    }
    if (!up(i) || !ipv6Enabled(i)) {
      rs.sent = 0;
      rs.due = undefined;
      continue;
    }
    const hasRouter = st.routers.some((r) => r.ifId === i.id);
    if (!hasRouter && rs.sent < MAX_RTR_SOLICITATIONS && rs.due === undefined) rs.due = now + RTR_SOLICITATION_DELAY * 1000;
    if (hasRouter) rs.due = undefined;
  }
}

function sendRs(ctx: SimContext, d: Device, iface: NetInterface): void {
  const src = linkLocalOf(iface) ?? "::";
  const msg = encodeRs(src, ALL_ROUTERS, iface.mac.toLowerCase());
  transmitIpv6(ctx, d, iface, multicastMac6(ALL_ROUTERS), { src, dst: ALL_ROUTERS, nextHeader: IPV6_NH.ICMPV6, hopLimit: 255, payload: msg, summary: "ICMPv6 Router Solicitation" });
  emit(ctx, d, iface, "NDP_SOLICITATION", `Router Solicitation on ${iface.name} → ff02::2`);
}

function onRa(ctx: SimContext, d: Device, iface: NetInterface, src: string, msg: number[], now: number): void {
  const ra = decodeRa(msg);
  if (!ra) return;
  const st = slaacState(d);
  ensureLinkLocal(iface);
  if (ra.slla) learnNdp(d, src, ra.slla.toUpperCase(), iface.id);
  const idx = st.routers.findIndex((r) => r.ifId === iface.id && r.addr === src);
  if (ra.lifetime > 0) {
    const entry = { ifId: iface.id, addr: src, lifetime: ra.lifetime, expiresMs: now + ra.lifetime * 1000, managed: ra.managed, other: ra.other };
    if (idx >= 0) st.routers[idx] = entry;
    else st.routers.push(entry);
  } else if (idx >= 0) st.routers.splice(idx, 1);
  const formed: string[] = [];
  for (const p of ra.prefixes) {
    if (!p.autonomous || p.len !== 64 || p.valid === 0 || isLinkLocal6(p.prefix)) continue;
    const address = slaacAddress(p.prefix, iface.mac);
    const expiresMs = p.valid === INFINITY ? undefined : now + p.valid * 1000;
    const a = st.addrs.find((x) => x.ifId === iface.id && x.address === address);
    if (a) a.expiresMs = expiresMs;
    else st.addrs.push({ ifId: iface.id, address, prefix: 64, expiresMs });
    if (addGlobal6(iface, address, 64)) formed.push(address);
  }
  syncConnected6(d);
  syncRaRoutes(d, st);
  if (st.rs[iface.id]) st.rs[iface.id].due = undefined;
  emit(ctx, d, iface, "NDP_ADVERTISEMENT", `Router Advertisement from ${src} on ${iface.name}: default router (lifetime ${ra.lifetime}s)${formed.length ? `, SLAAC ${formed.map((x) => `${x}/64`).join(", ")}` : ""}`);
}

function expireHost(d: Device, st: SlaacRt, now: number): void {
  const before = st.routers.length;
  st.routers = st.routers.filter((r) => r.expiresMs > now);
  const gone = st.addrs.filter((a) => a.expiresMs !== undefined && a.expiresMs <= now);
  for (const a of gone) {
    const iface = findInterface(d, a.ifId);
    if (iface) iface.ipv6 = iface.ipv6.filter((x) => normalizeIpv6(x.address) !== a.address);
  }
  st.addrs = st.addrs.filter((a) => !gone.includes(a));
  if (gone.length) syncConnected6(d);
  if (gone.length || st.routers.length !== before) syncRaRoutes(d, st);
}

// --- daemon ------------------------------------------------------------------------

function nextDue(d: Device, now: number): number | undefined {
  const s = sig(d);
  if (!s) return undefined;
  const r = radvdRuntime(d);
  const h = slaacRuntime(d);
  if (isRouterLike(d) ? r?.sig !== s : isHost(d.type) && h?.sig !== s) return now;
  const t: number[] = [];
  if (r) for (const i of Object.values(r.ifs)) t.push(i.next);
  if (h) {
    if (raRoutesMissing(d, h)) return now;
    for (const x of h.routers) t.push(x.expiresMs);
    for (const a of h.addrs) if (a.expiresMs !== undefined) t.push(a.expiresMs);
    for (const x of Object.values(h.rs)) if (x.due !== undefined) t.push(x.due);
  }
  return t.length ? Math.min(...t) : undefined;
}

function tick(ctx: SimContext, d: Device, now: number): boolean {
  const before = JSON.stringify([radvdRuntime(d) ?? null, slaacRuntime(d) ?? null, d.routingTable6, d.interfaces.map((i) => i.ipv6)]);
  const s = sig(d);
  if (isRouterLike(d)) {
    const rt = radvdRuntime(d);
    if (rt?.sig !== s) {
      for (const i of d.interfaces) if (ipv6Enabled(i) && globals(i).length) ensureLinkLocal(i);
      syncConnected6(d);
      reconcileRouter(d, now);
      radvdRuntime(d)!.sig = sig(d);
    }
    for (const [name, st] of Object.entries(radvdRuntime(d)!.ifs)) {
      if (st.next > now) continue;
      const iface = findInterface(d, st.ifId);
      if (!iface) continue;
      sendRa(ctx, d, iface, now);
      const max = maxInterval(d, name);
      if (st.initLeft > 0) st.initLeft--;
      st.next = now + (st.initLeft > 0 ? Math.min(MAX_INITIAL_RTR_ADVERT_INTERVAL, max) : max) * 1000;
    }
  } else if (isHost(d.type)) {
    const st = slaacState(d);
    if (st.sig !== s) {
      for (const i of d.interfaces) if (ipv6Enabled(i)) ensureLinkLocal(i);
      syncConnected6(d);
      reconcileHost(d, now);
      st.sig = sig(d);
    }
    expireHost(d, st, now);
    if (raRoutesMissing(d, st)) syncRaRoutes(d, st);
    for (const [ifId, rs] of Object.entries(st.rs)) {
      if (rs.due === undefined || rs.due > now) continue;
      const iface = findInterface(d, ifId);
      if (!iface || !up(iface)) {
        rs.due = undefined;
        continue;
      }
      rs.sent++;
      rs.due = rs.sent < MAX_RTR_SOLICITATIONS ? now + RTR_SOLICITATION_INTERVAL * 1000 : undefined;
      sendRs(ctx, d, iface); // an answering RA clears rs.due synchronously
    }
    st.sig = sig(d);
  }
  return JSON.stringify([radvdRuntime(d) ?? null, slaacRuntime(d) ?? null, d.routingTable6, d.interfaces.map((i) => i.ipv6)]) !== before;
}

/** RS / RA addressed to this device's stack (validated per RFC 4861 6.1). */
function receive(ctx: SimContext, d: Device, ingress: NetInterface, frame: Frame): boolean {
  if (ip6NextHeader(frame) !== IPV6_NH.ICMPV6) return false;
  const msg = ip6Payload(frame);
  const ip6 = frame.ipv6!;
  if (!msg || (msg[0] !== ICMP6_RS && msg[0] !== ICMP6_RA)) return false;
  if (ip6.hopLimit !== 255 || !icmp6ChecksumOk(ip6.srcIp, ip6.dstIp, msg)) return true; // invalid ND: discarded
  const now = ctx.wallNow();
  if (msg[0] === ICMP6_RA) {
    // Routers (forwarding=1) ignore RAs; hosts accept them from link-local sources only.
    if (isHost(d.type) && isLinkLocal6(ip6.srcIp)) onRa(ctx, d, ingress, ip6.srcIp, msg, now);
    return true;
  }
  if (!isRouterLike(d)) return true;
  const rs = decodeRs(msg);
  if (rs?.slla && ip6.srcIp !== "::") learnNdp(d, ip6.srcIp, rs.slla.toUpperCase(), ingress.id);
  const st = radvdRuntime(d)?.ifs[ingress.name];
  if (!st) return true;
  emit(ctx, d, ingress, "NDP_SOLICITATION", `radvd: Router Solicitation from ${ip6.srcIp} on ${ingress.name}`);
  if (st.last === undefined || now - st.last >= MIN_DELAY_BETWEEN_RAS * 1000) {
    sendRa(ctx, d, ingress, now);
    st.next = Math.max(st.next, now + 1000);
  } else st.next = Math.min(st.next, st.last + MIN_DELAY_BETWEEN_RAS * 1000);
  return true;
}

function describe(frame: Frame, verbose: boolean): string | undefined {
  if (!frame.ipv6 || ip6NextHeader(frame) !== IPV6_NH.ICMPV6) return undefined;
  const msg = ip6Payload(frame);
  const text = msg && describeNd(msg, verbose);
  return text ? `IP6 ${frame.ipv6.srcIp} > ${frame.ipv6.dstIp}: ${text}` : undefined;
}

registerDaemon({ id: "radv", nextDue, tick, describe });
registerV6Receiver("radv", receive);

// --- `ip -6 addr` / `ip -6 route` (iproute2 layout) --------------------------------

/** iproute2 `ip -6 addr show`: interfaces with IPv6, global before link scope. */
export function renderIp6Addr(d: Device, nowMs: number): string[] {
  const out: string[] = [];
  const st = slaacRuntime(d);
  d.interfaces.forEach((iface, idx) => {
    if (!iface.ipv6.length) return;
    const flags = ["BROADCAST", "MULTICAST"];
    if (iface.adminState === "up") flags.push("UP");
    if (iface.operState === "up") flags.push("LOWER_UP");
    out.push(`${idx + 1}: ${iface.name}: <${flags.join(",")}> mtu ${isSwitch(d.type) ? 9100 : 1500} state ${iface.operState.toUpperCase()} qlen 1000`);
    const sorted = [...iface.ipv6].sort((a, b) => Number(isLinkLocal6(a.address)) - Number(isLinkLocal6(b.address)));
    for (const a of sorted) {
      const ll = isLinkLocal6(a.address);
      const dyn = st?.addrs.find((x) => x.ifId === iface.id && x.address === normalizeIpv6(a.address));
      const lft = dyn?.expiresMs !== undefined ? `${Math.max(0, Math.floor((dyn.expiresMs - nowMs) / 1000))}sec` : "forever";
      out.push(`    inet6 ${a.address}/${a.prefix} scope ${ll ? "link" : "global"}${dyn ? " dynamic" : ""} `);
      out.push(`       valid_lft ${lft} preferred_lft ${lft}`);
    }
  });
  return out;
}

const PROTO: Record<string, string> = { ospf: "ospf", bgp: "bgp", static: "static" };

/** iproute2 `ip -6 route show`. */
export function renderIp6Route(d: Device, nowMs: number): string[] {
  const st = slaacRuntime(d);
  const ifName = (id: string) => findInterface(d, id)?.name ?? id;
  const rows: { key: bigint; len: number; text: string }[] = [];
  for (const r of d.routingTable6 ?? []) {
    const dev = ifName(r.interfaceId);
    const key = parseIpv6(r.destination) ?? 0n;
    if (r.type === "connected") rows.push({ key, len: r.prefix, text: `${r.destination}/${r.prefix} dev ${dev} proto kernel metric 256 pref medium` });
    else if (r.type === "default" && r.prefix === 0) {
      const ra = st?.routers.find((x) => x.addr === r.nextHop && x.ifId === r.interfaceId);
      const text = ra
        ? `default via ${r.nextHop} dev ${dev} proto ra metric ${RA_DEFAULT_METRIC} expires ${Math.max(0, Math.floor((ra.expiresMs - nowMs) / 1000))}sec hoplimit 64 pref medium`
        : `default via ${r.nextHop} dev ${dev} metric ${RA_DEFAULT_METRIC} pref medium`;
      rows.push({ key: -1n, len: 0, text });
    } else {
      const head = r.prefix === 0 ? "default" : `${r.destination}/${r.prefix}`;
      // A host's `ip -6 route add` route is RTPROT_BOOT, which iproute2 does not print.
      const proto = PROTO[r.type] && (isRouterLike(d) || r.type !== "static") ? ` proto ${PROTO[r.type]}` : "";
      rows.push({ key: r.prefix === 0 ? -1n : key, len: r.prefix, text: `${head}${r.nextHop ? ` via ${r.nextHop}` : ""} dev ${dev}${proto} metric ${isRouterLike(d) ? 20 : 1024} pref medium` });
    }
  }
  for (const iface of d.interfaces) {
    if (linkLocalOf(iface)) rows.push({ key: 0xfe80n << 112n, len: 64, text: `fe80::/64 dev ${iface.name} proto kernel metric 256 pref medium` });
  }
  rows.sort((a, b) => (a.key === -1n ? 1 : b.key === -1n ? -1 : a.key < b.key ? -1 : a.key > b.key ? 1 : a.len - b.len));
  return rows.map((r) => r.text);
}
