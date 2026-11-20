/**
 * Core running-config sections: VRF, VLAN, interfaces (L1/L2/L3), OSPFv2,
 * OSPFv3, prefix-lists, community/as-path lists, route-maps, BGP, static
 * routes, and the generic config-plane lines.
 *
 * Sources (sonic-mgmt-framework CLI):
 *   interface block   renderer/templates/show_interface_running_config.j2
 *   ip ospf lines     actioner/sonic_cli_interface_common.py get_ospf_interface_map
 *   router ospf       renderer/templates/show_running_config_ospf.j2
 *   router bgp        renderer/templates/show_bgp_{config,global,neighbor,address_family}.j2
 *   ip vrf            renderer/templates/show_vrf_config.j2
 *   vlan              actioner/sonic_cli_vlan.py show_vlan_config / show_vlan_switchport_interfaces
 *   prefix-list       actioner/sonic_cli_ip_prefix.py show_prefix_list_config
 *   route-map         renderer/templates/show_routemap_config.j2
 *   ip route          renderer/templates/show_static_routes_config.j2
 *   community/as-path data/device-capture/klish-xml/bgp_community_sets.xml (KLISH syntax)
 *   router ospf6 / ipv6 ospf6   FRR ospf6d config_write (the simulator's OSPFv3 syntax)
 */
import { Device } from "../../../models/device";
import { NetInterface } from "../../../models/interface";
import { peekFeatureState } from "../../../models/feature-state";
import { listVlans } from "../../../models/vlan-ops";
import { DEFAULT_VRF, vrfOf } from "../../../models/vrf";
import { lagEntry, LacpState } from "../../sonic/lacp";
import { ospfConfig, ospfConfiguredVrfs, OspfConfig } from "../../../protocols/ospf-config";
import { ospf6Config } from "../../../protocols/ospf6-config";
import { ndConfig } from "../../../protocols/radv-daemon";
import { getBgpConfig, bgpVrfNames, BgpConfig, BgpAfConfig, BgpNbrAf, BgpNeighbor, RedistProto } from "../../../protocols/bgp";
import { BgpListsState } from "../../../protocols/bgp-policy";
import { cpRunningLines } from "../config-plane";
import { inactiveStatics } from "../../../models/static-routes";
import { isLinkLocal6 } from "../../../models/ipv6";
import { registerRcSection, natCompare, vlanRanges, isSet } from "./registry";

const ifByName = (dev: Device, name: string) => dev.interfaces.find((i) => i.name === name);

// --- VRF (show_vrf_config.j2) ------------------------------------------------
interface VrfState {
  vrfs: { name: string; interfaces: string[] }[];
}
registerRcSection({
  id: "vrf",
  order: 10,
  keywords: [["vrf"]],
  global(dev) {
    const vrfs = peekFeatureState<VrfState>(dev, "vrf")?.vrfs ?? [];
    const names = vrfs.map((v) => v.name).filter((n) => n !== DEFAULT_VRF).sort(natCompare);
    return names.length ? [names.map((n) => `ip vrf ${n}`)] : [];
  },
  // `show running-configuration vrf` also lists the interfaces bound to each VRF
  // (sonic_cli_show_config.py show_vrf_only → show_vrf_bound_interfaces).
  iface(dev, name) {
    const v = vrfOf(dev, ifByName(dev, name));
    return v !== DEFAULT_VRF ? [` ip vrf forwarding ${v}`] : [];
  },
  ifOrder: 50,
});

// --- VLAN (show_vlan_config: "!" + "vlan <id>" each) -------------------------
registerRcSection({
  id: "vlan",
  order: 20,
  keywords: [["vlan"]],
  global(dev) {
    return [...listVlans(dev)].sort((a, b) => a.id - b.id).map((v) => [`vlan ${v.id}`]);
  },
  // switchport lines (show_vlan_switchport_interfaces; _switchport_lines in the interface block)
  iface(dev, name) {
    const i = ifByName(dev, name);
    if (!i || i.management || name.startsWith("Vlan") || name.startsWith("Loopback")) return [];
    const vlans = new Set(listVlans(dev).map((v) => v.id));
    const out: string[] = [];
    if (vlans.has(i.vlan.accessVlan) && (i.vlan.mode === "access" || i.vlan.accessVlan !== 1)) out.push(` switchport access Vlan ${i.vlan.accessVlan}`);
    if (i.vlan.mode === "trunk") {
      const t = i.vlan.allowedVlans.filter((v) => vlans.has(v) && v !== i.vlan.accessVlan);
      if (t.length) out.push(` switchport trunk allowed Vlan ${vlanRanges(t)}`);
    }
    return out;
  },
  ifOrder: 40,
});

// --- interface L1/L2/L3 core lines (show_interface_running_config.j2) -------
function coreIfLines(dev: Device, i: NetInterface): string[] {
  const out: string[] = [];
  const name = i.name;
  const pc = name.startsWith("PortChannel") ? lagEntry(dev, name) : undefined;
  if (pc) {
    if (pc.minLinks !== undefined && pc.minLinks !== 1) out.push(` min-links ${pc.minLinks}`);
    if (pc.fastRate) out.push(" fast_rate");
    if (pc.fallback) out.push(" fallback");
  }
  const owner = peekFeatureState<LacpState>(dev, "lacp")?.portchannels.find((p) => p.members.includes(name));
  if (owner) out.push(` channel-group ${owner.name.replace(/^PortChannel/, "")}`);
  // Physical ports always carry admin_status (" no shutdown"/" shutdown"); logical ones print shutdown only.
  const physical = name.startsWith("Ethernet") && !name.includes(".");
  if (i.adminState === "down") out.push(" shutdown");
  else if (physical || i.management) out.push(" no shutdown");
  return out;
}

function ipLines(i: NetInterface): string[] {
  const out = i.ipv4.map((a, n) => ` ip address ${a.address}/${a.prefix}${n > 0 ? " secondary" : ""}`);
  // The kernel's link-local is not configuration (no INTERFACE key, like config-db.ts).
  for (const a of i.ipv6) if (!isLinkLocal6(a.address)) out.push(` ipv6 address ${a.address}/${a.prefix}`);
  return out;
}

registerRcSection({
  id: "interface",
  order: 50,
  iface(dev, name) {
    const i = ifByName(dev, name);
    return i ? coreIfLines(dev, i) : [];
  },
  ifOrder: 30,
});
registerRcSection({
  id: "interface-ip",
  order: 50,
  keywords: [["ip"], ["ipv6"]],
  iface(dev, name) {
    const i = ifByName(dev, name);
    return i ? ipLines(i) : [];
  },
  ifOrder: 60,
});

// ipv6 nd (show_interface_running_config.j2:362-377: managed, other, ra-interval, suppress-ra)
registerRcSection({
  id: "ipv6-nd",
  order: 50,
  iface(dev, name) {
    const c = ndConfig(dev)[name];
    if (!c) return [];
    const out: string[] = [];
    if (c.managed) out.push(" ipv6 nd managed-config-flag");
    if (c.other) out.push(" ipv6 nd other-config-flag");
    if (c.raInterval !== undefined) out.push(` ipv6 nd ra-interval ${c.raInterval}`);
    if (c.suppressRa) out.push(" ipv6 nd suppress-ra");
    return out;
  },
  ifOrder: 80,
});

// --- OSPFv2 ------------------------------------------------------------------
const OSPF_REDIST_ORDER = ["bgp", "default", "connected", "kernel", "static"]; // DB names BGP < DEFAULT_ROUTE < DIRECTLY_CONNECTED < KERNEL < STATIC

function ospfBlock(dev: Device, vrf: string, c: OspfConfig): string[] {
  const out = [`router ospf${vrf === DEFAULT_VRF ? "" : ` vrf ${vrf}`}`];
  if (c.routerId) out.push(` ospf router-id ${c.routerId}`);
  if (c.refBandwidth !== undefined) out.push(` auto-cost reference-bandwidth ${c.refBandwidth}`);
  if (c.logAdjacencyChanges === "detail") out.push(" log-adjacency-changes detail");
  else if (c.logAdjacencyChanges === true) out.push(" log-adjacency-changes");
  if (c.passiveDefault) out.push(" passive-interface default");
  for (const p of [...(c.passive ?? [])].sort(natCompare)) out.push(` passive-interface ${p}`);
  for (const p of [...(c.nonPassive ?? [])].sort(natCompare)) out.push(` no passive-interface ${p}`);
  const metric = (m?: number, t?: 1 | 2) => `${m !== undefined ? ` metric ${m}` : ""}${t ? ` metric-type ${t}` : ""}`;
  for (const proto of OSPF_REDIST_ORDER) {
    if (proto === "default") {
      const d = c.defaultInfo;
      if (d) out.push(` default-information originate${d.always ? " always" : ""}${metric(d.metric, d.metricType)}`);
      continue;
    }
    const r = c.redistribute?.find((x) => x.protocol === proto);
    if (r) out.push(` redistribute ${proto}${metric(r.metric, r.metricType)}${r.routeMap ? ` route-map ${r.routeMap}` : ""}`);
  }
  const areas = [...(c.areas ?? [])].sort((a, b) => natCompare(a.id, b.id));
  for (const a of areas) {
    if (a.type === "stub") out.push(` area ${a.id} stub${a.noSummary ? " no-summary" : ""}`);
    if (a.type === "nssa") out.push(` area ${a.id} nssa${a.noSummary ? " no-summary" : ""}`);
    if (a.defaultCost !== undefined && a.type) out.push(` area ${a.id} default-cost ${a.defaultCost}`);
  }
  for (const a of areas) {
    for (const r of a.ranges ?? []) out.push(` area ${a.id} range ${r.prefix}${r.notAdvertise ? " not-advertise" : r.cost !== undefined ? ` cost ${r.cost}` : ""}`);
  }
  for (const n of c.networks ?? []) out.push(` network ${n.network} area ${n.area}`);
  // Lines the generic config-plane store kept in this view (unmodelled, e.g. redistribute ... route-map).
  if (vrf === DEFAULT_VRF) for (const l of cpRunningLines(dev)) if (l.ctx === "router-ospf") out.push(` ${l.line}`);
  return out;
}

/** ` ip ospf ...` lines (get_ospf_interface_map order: area, network, cost, priority, bfd, dead, hello). */
function ospfIfLines(dev: Device, name: string): string[] {
  for (const vrf of ospfConfiguredVrfs(dev)) {
    const p = ospfConfig(dev, vrf)?.ifParams?.[name];
    if (!p) continue;
    const out: string[] = [];
    if (p.area) out.push(` ip ospf area ${p.area}`);
    if (p.network) out.push(` ip ospf network ${p.network}`);
    if (p.cost !== undefined) out.push(` ip ospf cost ${p.cost}`);
    if (p.priority !== undefined) out.push(` ip ospf priority ${p.priority}`);
    if (p.bfd) out.push(" ip ospf bfd");
    if (p.dead !== undefined) out.push(` ip ospf dead-interval ${p.dead}`);
    if (p.hello !== undefined) out.push(` ip ospf hello-interval ${p.hello}`);
    return out;
  }
  return [];
}

registerRcSection({
  id: "ospf",
  order: 55, // source prints it first; after the interfaces so passive-interface/ip ospf refer to existing interfaces on replay
  keywords: [["ospf"]],
  global(dev) {
    return ospfConfiguredVrfs(dev)
      .map((v) => [v, ospfConfig(dev, v)] as const)
      .filter(([, c]) => c)
      .map(([v, c]) => ospfBlock(dev, v, c!));
  },
  iface: ospfIfLines,
  ifOrder: 90,
});

// --- OSPFv3 (router ospf6 / ipv6 ospf6 ...) ---------------------------------
registerRcSection({
  id: "ospf6",
  order: 35,
  keywords: [["ospf6"], ["ospfv3"]],
  global(dev) {
    const c = ospf6Config(dev);
    if (!c) return [];
    const out = ["router ospf6"];
    if (c.routerId) out.push(` ospf6 router-id ${c.routerId}`);
    if (c.logAdjacencyChanges === "detail") out.push(" log-adjacency-changes detail");
    else if (c.logAdjacencyChanges === true) out.push(" log-adjacency-changes");
    return [out];
  },
  iface(dev, name) {
    const p = ospf6Config(dev)?.ifParams?.[name];
    if (!p) return [];
    const out: string[] = [];
    if (p.area) out.push(` ipv6 ospf6 area ${p.area}`);
    if (p.cost !== undefined) out.push(` ipv6 ospf6 cost ${p.cost}`);
    if (p.hello !== undefined) out.push(` ipv6 ospf6 hello-interval ${p.hello}`);
    if (p.dead !== undefined) out.push(` ipv6 ospf6 dead-interval ${p.dead}`);
    if (p.priority !== undefined) out.push(` ipv6 ospf6 priority ${p.priority}`);
    if (p.passive) out.push(" ipv6 ospf6 passive");
    if (p.network) out.push(` ipv6 ospf6 network ${p.network}`);
    return out;
  },
  ifOrder: 95,
});

// --- prefix-lists (show_prefix_list_config) ----------------------------------
interface PrefixEntry {
  seq: number;
  action: string;
  prefix: string;
  ge?: number;
  le?: number;
}
function prefixLines(dev: Device, af: "ip" | "ipv6", name?: string): string[] {
  const st = peekFeatureState<{ lists?: Record<string, PrefixEntry[]>; lists6?: Record<string, PrefixEntry[]> }>(dev, "prefixlist");
  const lists = (af === "ip" ? st?.lists : st?.lists6) ?? {};
  const max = af === "ip" ? 32 : 128;
  const out: string[] = [];
  for (const n of Object.keys(lists).sort()) {
    if (name && n !== name) continue;
    for (const e of [...lists[n]].sort((a, b) => a.seq - b.seq)) {
      // _masklength_suffix: le-only when ge == prefix length, else ge+le
      const len = Number(e.prefix.split("/")[1]);
      let sfx = "";
      if (e.ge !== undefined || e.le !== undefined) {
        const lo = e.ge ?? len;
        sfx = lo === len ? ` le ${e.le ?? max}` : ` ge ${lo} le ${e.le ?? max}`;
      }
      out.push(`${af} prefix-list ${n} seq ${e.seq} ${e.action} ${e.prefix}${sfx}`);
    }
  }
  return out;
}
registerRcSection({
  id: "prefix-list",
  order: 60,
  keywords: [["ip", "prefix-list"]],
  global: (dev) => [prefixLines(dev, "ip")].filter((b) => b.length),
});
registerRcSection({
  id: "prefix-list6",
  order: 61,
  keywords: [["ipv6", "prefix-list"]],
  global: (dev) => [prefixLines(dev, "ipv6")].filter((b) => b.length),
});

// --- community-lists / as-path lists (bgp_community_sets.xml syntax) ---------
function bgpLists(dev: Device, kind: "community" | "aspath"): string[] {
  const st = peekFeatureState<BgpListsState>(dev, "bgpclist");
  const out: string[] = [];
  if (kind === "community") {
    for (const n of Object.keys(st?.community ?? {}).sort()) {
      for (const e of [...st!.community[n]].sort((a, b) => a.seq - b.seq)) out.push(`bgp community-list standard ${n} ${e.action} ${e.members.join(" ")}${e.any ? " any" : ""}`);
    }
  } else {
    for (const n of Object.keys(st?.aspath ?? {}).sort()) {
      for (const e of [...st!.aspath[n]].sort((a, b) => a.seq - b.seq)) out.push(`bgp as-path-list ${n} ${e.action} ${e.regex}`);
    }
  }
  return out;
}
registerRcSection({
  id: "bgp-community-list",
  order: 65,
  keywords: [["bgp", "community-list"]],
  global: (dev) => [bgpLists(dev, "community")].filter((b) => b.length),
});
registerRcSection({
  id: "bgp-as-path-list",
  order: 66,
  keywords: [["bgp", "as-path-access-list"], ["bgp", "as-path-acess-list"]],
  global: (dev) => [bgpLists(dev, "aspath")].filter((b) => b.length),
});

// --- route-maps (show_routemap_config.j2) ------------------------------------
interface RouteMapStatement {
  seq: number;
  action: string;
  match: string[];
  set: string[];
}
export function routeMapBlocks(dev: Device, name?: string, seq?: number): string[][] {
  const maps = peekFeatureState<{ maps: Record<string, RouteMapStatement[]> }>(dev, "routemap")?.maps ?? {};
  const out: string[][] = [];
  for (const n of Object.keys(maps).sort()) {
    if (name && n !== name) continue;
    for (const s of [...maps[n]].sort((a, b) => a.seq - b.seq)) {
      if (seq !== undefined && s.seq !== seq) continue;
      out.push([`route-map ${n} ${s.action} ${s.seq}`, ...s.match.map((m) => ` match ${m}`), ...s.set.map((c) => ` set ${c}`)]);
    }
  }
  return out;
}
registerRcSection({ id: "route-map", order: 80, keywords: [["route-map"]], global: (dev) => routeMapBlocks(dev) });

// --- BGP (show_bgp_config.j2) ------------------------------------------------
const REDIST: RedistProto[] = ["connected", "ospf", "static"];

function afGlobal(name: string, af: BgpAfConfig, extra: string[] = []): string[] {
  const body: string[] = [];
  if (af.maxPaths !== undefined) body.push(`  maximum-paths ${af.maxPaths}`);
  if (af.maxPathsIbgp !== undefined) body.push(`  maximum-paths ibgp ${af.maxPathsIbgp}`);
  if (af.tableMap) body.push(`  table-map ${af.tableMap}`);
  for (const p of REDIST) {
    const r = af.redist?.[p];
    if (r) body.push(`  redistribute ${p}${r.routeMap ? ` route-map ${r.routeMap}` : ""}${r.metric !== undefined ? ` metric ${r.metric}` : ""}`);
  }
  for (const n of af.networks ?? []) body.push(`  network ${n}`);
  body.push(...extra);
  return body.length ? [" !", ` address-family ${name}`, ...body, "  exit"] : [];
}

function nbrAf(name: string, a: BgpNbrAf | undefined, activate: boolean): string[] {
  const body: string[] = [];
  if (activate) body.push("   activate");
  if (a?.routeMapIn) body.push(`   route-map ${a.routeMapIn} in`);
  if (a?.routeMapOut) body.push(`   route-map ${a.routeMapOut} out`);
  if (a?.prefixListIn) body.push(`   prefix-list ${a.prefixListIn} in`);
  if (a?.prefixListOut) body.push(`   prefix-list ${a.prefixListOut} out`);
  if (a?.filterListIn) body.push(`   filter-list ${a.filterListIn} in`);
  if (a?.filterListOut) body.push(`   filter-list ${a.filterListOut} out`);
  if (a?.softReconfig) body.push("   soft-reconfiguration inbound");
  if (a?.weight !== undefined) body.push(`   weight ${a.weight}`);
  return body.length ? ["  !", `  address-family ${name}`, ...body, "   exit"] : [];
}

/** update-source: an interface name renders as "<type> <number>" (show_bgp_neighbor.j2 update_source). */
function updateSource(s: string): string {
  const m = /^(Ethernet|Loopback|PortChannel|Vlan|Management)(\d.*)$/.exec(s);
  return m ? `interface ${m[1]} ${m[2]}` : s;
}

function neighborBlock(nb: BgpNeighbor): string[] {
  const out = [" !", ` neighbor ${nb.peer}`];
  if (nb.description) out.push(`  description ${nb.description}`);
  if (nb.ebgpMultihop !== undefined) out.push(nb.ebgpMultihop ? `  ebgp-multihop ${nb.ebgpMultihop}` : "  ebgp-multihop");
  if (nb.remoteAs !== undefined) out.push(`  remote-as ${nb.remoteAs}`);
  if (nb.keepalive !== undefined && nb.holdtime !== undefined) out.push(`  timers ${nb.keepalive} ${nb.holdtime}`);
  if (nb.connectRetry !== undefined) out.push(`  timers connect ${nb.connectRetry}`);
  if (nb.updateSource) out.push(`  update-source ${updateSource(nb.updateSource)}`);
  if (nb.shutdown) out.push("  shutdown");
  if (nb.bfd) out.push("  bfd");
  // IPv4 unicast is active by default for every peer (FRR bgp default ipv4-unicast).
  out.push(...nbrAf("ipv4 unicast", nb.af?.ipv4, nb.remoteAs !== undefined));
  out.push(...nbrAf("ipv6 unicast", nb.af?.ipv6, !!nb.ipv6));
  if (nb.evpn) out.push("  !", "  address-family l2vpn evpn", "   activate", "   exit");
  out.push("  exit");
  return out;
}

/** VRFs whose l2vpn evpn AF has `advertise ipv4 unicast` (stored by the KLISH vxlan module). */
function evpnAdvertiseV4(dev: Device, vrf: string): boolean {
  const st = peekFeatureState<{ bgpvrf?: Record<string, unknown>[] }>(dev, "cp_vxlan");
  return (st?.bgpvrf ?? []).some((b) => b.vrf === vrf && b.advertise_ipv4 === "true");
}

function bgpBlock(dev: Device, vrf: string, c: BgpConfig): string[] {
  const out = [`router bgp ${c.localAs}${vrf === DEFAULT_VRF ? "" : ` vrf ${vrf}`}`];
  if (c.routerId) out.push(` router-id ${c.routerId}`);
  if (c.keepalive !== undefined && c.holdtime !== undefined) out.push(` timers ${c.keepalive} ${c.holdtime}`);
  if (c.multipathRelax) out.push(" bestpath as-path multipath-relax");
  out.push(...afGlobal("ipv4 unicast", { networks: c.networks, redist: { ...(c.redist ?? {}), ...(c.redistributeConnected && !c.redist?.connected ? { connected: {} } : {}) }, maxPaths: c.maxPaths, maxPathsIbgp: c.maxPathsIbgp, tableMap: c.tableMap }));
  if (c.ipv6) out.push(...afGlobal("ipv6 unicast", c.ipv6));
  const evpn: string[] = [];
  if (c.advertiseAllVni) evpn.push("  advertise-all-vni");
  if (evpnAdvertiseV4(dev, vrf)) evpn.push("  advertise ipv4 unicast");
  out.push(...afGlobal("l2vpn evpn", { networks: [] }, evpn));
  for (const nb of c.neighbors) out.push(...neighborBlock(nb));
  // Lines the generic config-plane store kept for this instance (unmodelled commands).
  if (vrf === DEFAULT_VRF) for (const l of cpRunningLines(dev)) if (l.ctx === "router-bgp" && !/^(no\s+)?timers\b/.test(l.line)) out.push(` ${l.line}`);
  out.push("exit");
  return out;
}

registerRcSection({
  id: "bgp",
  order: 90,
  keywords: [["bgp"]],
  global(dev) {
    const out: string[][] = [];
    const def = getBgpConfig(dev);
    if (def) out.push(bgpBlock(dev, DEFAULT_VRF, def));
    for (const v of [...bgpVrfNames(dev)].sort(natCompare)) out.push(bgpBlock(dev, v, getBgpConfig(dev, v)!));
    return out;
  },
});

// --- static routes (show_static_routes_config.j2) ----------------------------
interface TrackedRoute {
  prefix: string;
  len: number;
  nexthop: string;
  track: number;
  distance?: number;
  vrf?: string;
}
registerRcSection({
  id: "static-route",
  order: 140,
  keywords: [["ip", "route"]],
  global(dev) {
    const out: string[] = [];
    const tracked = peekFeatureState<{ routes: TrackedRoute[] }>(dev, "ipsla_routes")?.routes ?? [];
    const key = (vrf: string | undefined, p: string, nh: string) => `${vrf ?? DEFAULT_VRF}|${p}|${nh}`;
    const trackedKeys = new Set(tracked.map((r) => key(r.vrf, `${r.prefix}/${r.len}`, r.nexthop)));
    const vrfPart = (v?: string) => (v && v !== DEFAULT_VRF ? `vrf ${v} ` : "");
    // Installed and inactive (unresolved next hop, still configured) statics, keyed like STATIC_ROUTE.
    const statics = [...(dev.routingTable ?? []), ...inactiveStatics(dev)].filter((r) => r.type === "static");
    statics.sort((a, b) => natCompare(a.vrf ?? "", b.vrf ?? "") || natCompare(`${a.destination}/${a.prefix}`, `${b.destination}/${b.prefix}`));
    for (const r of statics) {
      const p = `${r.destination}/${r.prefix}`;
      if (trackedKeys.has(key(r.vrf, p, r.nextHop ?? ""))) continue;
      out.push(`ip route ${vrfPart(r.vrf)}${p} ${r.nextHop}`);
    }
    for (const r of (dev.routingTable6 ?? []).filter((x) => x.type === "static" && x.nextHop)) out.push(`ipv6 route ${vrfPart(r.vrf)}${r.destination}/${r.prefix} ${r.nextHop}`);
    for (const r of tracked) out.push(`ip route ${vrfPart(r.vrf)}${r.prefix}/${r.len} ${r.nexthop} track ${r.track}${isSet(r.distance) && r.distance !== 0 ? ` ${r.distance}` : ""}`);
    return out.length ? [out] : [];
  },
});

// --- generic config-plane lines (accepted, unmodelled commands) -------------
registerRcSection({
  id: "config-plane",
  order: 990,
  global(dev) {
    const lines = cpRunningLines(dev);
    const ifNames = new Set(dev.interfaces.map((i) => i.name));
    const blocks: string[][] = [];
    const top = lines.filter((l) => l.ctx === "config").map((l) => l.line);
    if (top.length) blocks.push(top);
    const groups = new Map<string, string[]>();
    for (const l of lines) {
      if (l.ctx === "config" || ifNames.has(l.ctx) || l.ctx === "router-bgp" || l.ctx === "router-ospf") continue;
      if (!groups.has(l.ctx)) groups.set(l.ctx, []);
      groups.get(l.ctx)!.push(` ${l.line}`);
    }
    for (const [ctx, ls] of groups) blocks.push([`! ${ctx}`, ...ls]);
    return blocks;
  },
  iface(dev, name) {
    return cpRunningLines(dev)
      .filter((l) => l.ctx === name)
      .map((l) => ` ${l.line}`);
  },
  ifOrder: 999,
});
