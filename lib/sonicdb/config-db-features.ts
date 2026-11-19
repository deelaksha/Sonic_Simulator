/**
 * CONFIG_DB rows for the routing / policy / EVPN / L2-protection / multicast /
 * L3-service features, rendered from each feature's config store (see
 * ./config-db.ts for the base tables). Table and field names, by source
 * (sonic-buildimage/src unless noted; "klish-xml" = the real box's CLI tree in
 * data/device-capture/klish-xml, whose command_tables/dbpath attributes name the
 * sonic-yang list + leaf each command writes):
 *
 *   BGP        sonic-bgp-global.yang (BGP_GLOBALS keyed vrf_name, BGP_GLOBALS_AF "vrf|afi_safi"),
 *              sonic-bgp-common.yang:398-500 (route_map_in@/route_map_out@, prefix_list_in/out,
 *              filter_list_in/out, weight, soft_reconfiguration_in),
 *              sonic-route-common.yang:29-70 (ROUTE_REDISTRIBUTE "vrf|src|dst|af", route_map@, metric),
 *              sonic-frr-mgmt-framework/frrcfgd/frrcfgd.py:2407-2408 (max_ebgp_paths / max_ibgp_paths),
 *              :2419 (BGP_GLOBALS_AF l2vpn_evpn advertise-ipv4-unicast)
 *   Policy     sonic-route-map.yang:140-410 (ROUTE_MAP "name|seq", route_operation, match_* / set_*),
 *              frrcfgd.py:2496-2535 (which leaf renders which FRR clause; set_asn_list "a,b" :1165),
 *              sonic-routing-policy-sets.yang:43-220 (PREFIX_SET mode, PREFIX "name|seq|prefix|range"
 *              action, COMMUNITY_SET set_type/match_action/action/community_member@,
 *              AS_PATH_SET action/as_path_set_member@)
 *   OSPFv2     sonic-ospf.yang:392 (log-adjacency-changes detail|brief), :664-720
 *              (OSPFV2_ROUTER_DISTRIBUTE_ROUTE "vrf|protocol|direction"), :749-790
 *              (_AREA_POLICY_ADDRESS_RANGE enable/advertise/metric), :838-915 (_AREA stub,
 *              stub-no-summary, stub-default-cost, nssa, nssa-no-summary); protocol names
 *              templates/ospfd/ospfd.conf.db.distributeroute.j2:3 (BGP/KERNEL/STATIC/DIRECTLY_CONNECTED)
 *   IPv6 RA    sonic-frr-nd.yang:22-66 (ND_CFG_MSG keyed ifname: suppress_ra, ra_interval,
 *              managed_config_flag, other_config_flag)
 *   EVPN       sonic-vrf.yang:50 (VRF vni), schema.h:426 + klish-xml interface.xml:1142
 *              (SUPPRESS_VLAN_NEIGH suppress=on), klish-xml sag.xml:63,172-175 (SAG
 *              "ifname|IPv4", SAG_GLOBAL|IP gwmac / rmac-forwarding), klish-xml
 *              interface.xml:1480 (EVPN_ETHERNET_SEGMENT keyed ifname; esi / df_pref)
 *   L2 prot.   sonic-mirror-session.yang:59-190 + sonic-utilities config/main.py:3116-3206
 *              (type SPAN|ERSPAN, dst_port, src_port, direction upper-case, src_ip/dst_ip/dscp/
 *              ttl/gre_type/queue/policer), sonic-storm-control.yang:30-50 ("ifname|storm_type" kbps),
 *              klish-xml dhcp_snooping.xml:152,345 (DHCP_SNOOPING|GLOBAL dhcpv4_verify_mac_address,
 *              PORT/PORTCHANNEL dhcpv4_snooping_trust), klish-xml udld.xml:153-302 (UDLD|GLOBAL
 *              aggressive/msg_time/multiplier, UDLD_PORT admin_enable/aggressive), klish-xml
 *              errdisable.xml:68-121 (ERRDISABLE|RECOVERY interval), sonic-link-state-tracking.yang
 *              (LINK_STATE_TRACKING description/timeout, LINK_STATE_TRACKING_MEMBER group/role)
 *   Multicast  sonic-mgmt-common/cvl/testdata/schema/sonic-igmp-snooping.yang:96-228
 *              (CFG_L2MC_TABLE enabled/querier/fast-leave/version/query-interval/
 *              last-member-query-interval/query-max-response-time, CFG_L2MC_MROUTER_TABLE,
 *              CFG_L2MC_STATIC_MEMBER_TABLE), klish-xml pim.xml:347,652 (PIM_GLOBALS
 *              "vrf|af", _RENDEZVOUS_POINT "vrf|af|rp", PIM_INTERFACE "vrf|af|ifname"),
 *              frrcfgd.py:2670-2694 (PIM/IGMP leaf names), klish-xml igmp.xml (IGMP_INTERFACE_QUERY
 *              keyed interface-id)
 *   L3 svc.    sonic-nat.yang:58-290 + sonic-utilities config/nat.py:449 (STATIC_NAPT
 *              "global_ip|TCP|port"), sonic-interface.yang:124 (nat_zone),
 *              sonic-flow-based-services.yang:108-1160 (CLASSIFIER_TABLE / POLICY_TABLE /
 *              POLICY_SECTIONS_TABLE SET_IP_NEXTHOP@ "ip|vrf|prio", SET_INTERFACE@ "if|prio" /
 *              POLICY_BINDING_TABLE), frrcfgd.py:2698-2718 + 4784-4800 (IP_SLA leaves),
 *              frrcfgd.py static_route_map (STATIC_ROUTE track), klish-xml loadshare.xml:17-202
 *              (ECMP_LOADSHARE_TABLE_IPV4|ipv4 / _IPV6|ipv6 / _SEED|hash / _OFFSET|hash,
 *              SWITCH|switch ecmp_hash_algorithm)
 *
 * Not projected (no table/field name in the sources): OSPFv3 (klish-xml ospfv3.xml names
 * OSPFV3_ROUTER/OSPFV3_INTERFACE keys, but no sonic-ospfv3 yang/transformer gives their
 * leaves), DHCP-snooping global/VLAN enable fields, ERRDISABLE per-cause leaves, SAG
 * IPv4/IPv6 enable leaves, EVPN_MH_GLOBAL timers, PIM RP prefix-list, IGMP static joins,
 * link-track thresholds, loadshare UDF/resilient/RoCE/ingress-port rows. The SAG gateway
 * leaf-list name "gwip" is the Broadcom sonic-sag.yang one (not in this source tree).
 *
 * Read-only: never creates feature state (peek accessors only).
 */
import { Device } from "../models/device";
import { peekFeatureState } from "../models/feature-state";
import { DEFAULT_VRF, vrfOf } from "../models/vrf";
import { BgpConfig, BgpNbrAf, afConfig, getBgpConfig, bgpVrfNames } from "../protocols/bgp";
import { BgpListsState } from "../protocols/bgp-policy";
import { OspfConfig, ospfConfig, ospfConfiguredVrfs } from "../protocols/ospf-config";
import { NdIfConfig, ndConfig } from "../protocols/radv-daemon";
import { mirrorSessions } from "../protocols/mirror";
import { TrackedRoute } from "../protocols/ipsla-daemon";
import { peekFbs } from "../protocols/pbr";
import { cpGet, cpList } from "../commands/sonic-cli/config-plane";
import { Tables, put, Row } from "./schema";

const str = (v: unknown) => String(v);
const set = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== "---";

// ---------------------------------------------------------------------------
// BGP

function nbrAfRow(af: BgpNbrAf | undefined): Row {
  const row: Row = { admin_status: "true" };
  if (!af) return row;
  if (af.routeMapIn) row.route_map_in = [af.routeMapIn];
  if (af.routeMapOut) row.route_map_out = [af.routeMapOut];
  if (af.prefixListIn) row.prefix_list_in = af.prefixListIn;
  if (af.prefixListOut) row.prefix_list_out = af.prefixListOut;
  if (af.filterListIn) row.filter_list_in = af.filterListIn;
  if (af.filterListOut) row.filter_list_out = af.filterListOut;
  if (af.weight !== undefined) row.weight = str(af.weight);
  if (af.softReconfig) row.soft_reconfiguration_in = "true";
  return row;
}

function bgpInstance(t: Tables, vrf: string, cfg: BgpConfig): void {
  const g: Row = { local_asn: str(cfg.localAs) };
  if (cfg.routerId) g.router_id = cfg.routerId;
  put(t, "BGP_GLOBALS", vrf, g);
  for (const n of cfg.neighbors) {
    const row: Row = { admin_status: n.shutdown ? "down" : "up" };
    if (n.remoteAs !== undefined) row.asn = str(n.remoteAs);
    if (n.description) row.name = n.description;
    const ka = n.keepalive ?? cfg.keepalive;
    const ho = n.holdtime ?? cfg.holdtime;
    if (ka !== undefined) row.keepalive = str(ka);
    if (ho !== undefined) row.holdtime = str(ho);
    if (n.connectRetry !== undefined) row.conn_retry = str(n.connectRetry);
    if (n.ebgpMultihop !== undefined) {
      row.ebgp_multihop = "true";
      row.ebgp_multihop_ttl = str(n.ebgpMultihop);
    }
    if (n.updateSource) row.local_addr = n.updateSource;
    if (n.bfd) row.bfd = "true";
    put(t, "BGP_NEIGHBOR", `${vrf}|${n.peer}`, row);
    put(t, "BGP_NEIGHBOR_AF", `${vrf}|${n.peer}|ipv4_unicast`, nbrAfRow(n.af?.ipv4));
    if (n.ipv6) put(t, "BGP_NEIGHBOR_AF", `${vrf}|${n.peer}|ipv6_unicast`, nbrAfRow(n.af?.ipv6));
    if (n.evpn) put(t, "BGP_NEIGHBOR_AF", `${vrf}|${n.peer}|l2vpn_evpn`, { admin_status: "true" });
  }
  for (const af of ["ipv4", "ipv6"] as const) {
    if (af === "ipv6" && !cfg.ipv6) continue;
    const a = afConfig(cfg, af);
    const row: Row = {};
    if (a.maxPaths !== undefined) row.max_ebgp_paths = str(a.maxPaths);
    if (a.maxPathsIbgp !== undefined) row.max_ibgp_paths = str(a.maxPathsIbgp);
    put(t, "BGP_GLOBALS_AF", `${vrf}|${af}_unicast`, row);
    for (const net of a.networks) put(t, "BGP_GLOBALS_AF_NETWORK", `${vrf}|${af}_unicast|${net}`);
    for (const [proto, r] of Object.entries(a.redist ?? {})) {
      const rr: Row = {};
      if (r?.routeMap) rr.route_map = [r.routeMap];
      if (r?.metric !== undefined) rr.metric = str(r.metric);
      put(t, "ROUTE_REDISTRIBUTE", `${vrf}|${proto}|bgp|${af}`, rr);
    }
  }
  if (cfg.advertiseAllVni) put(t, "BGP_GLOBALS_AF", `${vrf}|l2vpn_evpn`, { "advertise-all-vni": "true" });
}

export function projectBgp(d: Device, t: Tables): void {
  const def = getBgpConfig(d);
  if (def) bgpInstance(t, DEFAULT_VRF, def);
  for (const vrf of bgpVrfNames(d)) bgpInstance(t, vrf, getBgpConfig(d, vrf)!);
  // `advertise ipv4 unicast` under the VRF's l2vpn evpn AF (stored by the KLISH vxlan module)
  for (const b of cpList(d, "vxlan", "bgpvrf")) {
    if (b.advertise_ipv4 !== "true") continue;
    const k = `${str(b.vrf)}|l2vpn_evpn`;
    put(t, "BGP_GLOBALS_AF", k, { ...(t.BGP_GLOBALS_AF?.[k] ?? {}), "advertise-ipv4-unicast": "true" });
  }
}

// ---------------------------------------------------------------------------
// Routing policy (route-map / prefix-list / community-list / as-path list)

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

/** `match <clause>` → ROUTE_MAP leaf (frrcfgd.py:2496-2513 in reverse). */
function matchLeaf(row: Row, clause: string): void {
  const w = clause.trim().split(/\s+/);
  const rest = (n: number) => w.slice(n).join(" ");
  if (w[0] === "ip" && w[1] === "address" && w[2] === "prefix-list") row.match_prefix_set = rest(3);
  else if (w[0] === "ipv6" && w[1] === "address" && w[2] === "prefix-list") row.match_ipv6_prefix_set = rest(3);
  else if (w[0] === "ip" && w[1] === "next-hop" && w[2] === "prefix-list") row.match_next_hop_set = rest(3);
  else if (w[0] === "community") row.match_community = w[1];
  else if (w[0] === "as-path") row.match_as_path = w[1];
  else if (w[0] === "metric") row.match_med = w[1];
  else if (w[0] === "local-preference") row.match_local_pref = w[1];
  else if (w[0] === "origin") row.match_origin = (w[1] ?? "").toUpperCase();
  else if (w[0] === "interface") row.match_interface = w[1];
  else if (w[0] === "tag") row.match_tag = [w[1]];
  else if (w[0] === "peer") row.match_neighbor = [w[1]];
}

/** `set <clause>` → ROUTE_MAP leaf (frrcfgd.py:2516-2534 in reverse). */
function setLeaf(row: Row, clause: string): void {
  const w = clause.trim().split(/\s+/);
  if (w[0] === "local-preference") row.set_local_pref = w[1];
  else if (w[0] === "metric") row.set_med = w[1];
  else if (w[0] === "weight") row.set_weight = w[1];
  else if (w[0] === "origin") row.set_origin = (w[1] ?? "").toUpperCase();
  else if (w[0] === "tag") row.set_tag = w[1];
  else if (w[0] === "ip" && w[1] === "next-hop") row.set_next_hop = w[2];
  else if (w[0] === "as-path" && w[1] === "prepend") row.set_asn_list = w.slice(2).join(",");
  else if (w[0] === "community") row.set_community_inline = w.slice(1);
}

export function projectPolicy(d: Device, t: Tables): void {
  const pl = peekFeatureState<{ lists?: Record<string, PrefixEntry[]>; lists6?: Record<string, PrefixEntry[]> }>(d, "prefixlist");
  for (const [mode, lists, max] of [["IPv4", pl?.lists, 32], ["IPv6", pl?.lists6, 128]] as const) {
    for (const [name, entries] of Object.entries(lists ?? {})) {
      put(t, "PREFIX_SET", name, { mode });
      for (const e of entries) {
        const len = Number(e.prefix.split("/")[1]);
        const range = e.ge === undefined && e.le === undefined ? "exact" : `${e.ge ?? len}..${e.le ?? max}`;
        put(t, "PREFIX", `${name}|${e.seq}|${e.prefix}|${range}`, { action: e.action });
      }
    }
  }

  const maps = peekFeatureState<{ maps: Record<string, RouteMapStatement[]> }>(d, "routemap")?.maps ?? {};
  for (const [name, stmts] of Object.entries(maps)) {
    for (const s of stmts) {
      const row: Row = { route_operation: s.action };
      for (const m of s.match) matchLeaf(row, m);
      for (const c of s.set) setLeaf(row, c);
      put(t, "ROUTE_MAP", `${name}|${s.seq}`, row);
    }
  }

  // FRR lists hold ordered entries; CONFIG_DB keeps one set per name.
  const lists = peekFeatureState<BgpListsState>(d, "bgpclist");
  for (const [name, entries] of Object.entries(lists?.community ?? {})) {
    if (!entries.length) continue;
    put(t, "COMMUNITY_SET", name, {
      set_type: "STANDARD",
      match_action: entries.some((e) => e.any) ? "ANY" : "ALL",
      action: entries[0].action,
      community_member: [...new Set(entries.flatMap((e) => e.members))],
    });
  }
  for (const [name, entries] of Object.entries(lists?.aspath ?? {})) {
    if (!entries.length) continue;
    put(t, "AS_PATH_SET", name, { action: entries[0].action, as_path_set_member: entries.map((e) => e.regex) });
  }
}

// ---------------------------------------------------------------------------
// OSPFv2

const OSPF_PROTO: Record<string, string> = { connected: "DIRECTLY_CONNECTED", static: "STATIC", bgp: "BGP", kernel: "KERNEL" };
const metricType = (m: 1 | 2 | undefined) => (m === 1 ? "TYPE_1" : m === 2 ? "2" : undefined);

function ospfInstance(d: Device, t: Tables, vrf: string, ospf: OspfConfig): void {
  const r: Row = { enable: "true" };
  if (ospf.routerId) r["router-id"] = ospf.routerId;
  if (ospf.passiveDefault) r["passive-interface-default"] = "true";
  if (ospf.refBandwidth !== undefined) r["auto-cost-reference-bandwidth"] = str(ospf.refBandwidth);
  if (ospf.logAdjacencyChanges) r["log-adjacency-changes"] = ospf.logAdjacencyChanges === "detail" ? "detail" : "brief";
  put(t, "OSPFV2_ROUTER", vrf, r);

  const areas = new Set<string>([...ospf.areas.map((a) => a.id), ...ospf.networks.map((n) => n.area)]);
  for (const id of areas) {
    const a = ospf.areas.find((x) => x.id === id);
    const row: Row = {};
    if (a?.type === "stub") row[a.noSummary ? "stub-no-summary" : "stub"] = "true";
    if (a?.type === "nssa") {
      row.nssa = "true";
      if (a.noSummary) row["nssa-no-summary"] = "true";
    }
    if (a?.defaultCost !== undefined) row["stub-default-cost"] = str(a.defaultCost);
    put(t, "OSPFV2_ROUTER_AREA", `${vrf}|${id}`, row);
    for (const rg of a?.ranges ?? []) {
      const rr: Row = { enable: "true", advertise: rg.notAdvertise ? "false" : "true" };
      if (rg.cost !== undefined) rr.metric = str(rg.cost);
      put(t, "OSPFV2_ROUTER_AREA_POLICY_ADDRESS_RANGE", `${vrf}|${id}|${rg.prefix}`, rr);
    }
  }
  for (const n of ospf.networks) put(t, "OSPFV2_ROUTER_AREA_NETWORK", `${vrf}|${n.area}|${n.network}`);
  for (const rd of ospf.redistribute ?? []) {
    const row: Row = {};
    if (rd.metric !== undefined) row.metric = str(rd.metric);
    const mt = metricType(rd.metricType);
    if (mt) row["metric-type"] = mt;
    put(t, "OSPFV2_ROUTER_DISTRIBUTE_ROUTE", `${vrf}|${OSPF_PROTO[rd.protocol] ?? rd.protocol.toUpperCase()}|IMPORT`, row);
  }
  if (ospf.defaultInfo) {
    const di = ospf.defaultInfo;
    const row: Row = {};
    if (di.always) row.always = "true";
    if (di.metric !== undefined) row.metric = str(di.metric);
    const mt = metricType(di.metricType);
    if (mt) row["metric-type"] = mt;
    put(t, "OSPFV2_ROUTER_DISTRIBUTE_ROUTE", `${vrf}|DEFAULT_ROUTE|IMPORT`, row);
  }
  for (const p of ospf.passive ?? []) put(t, "OSPFV2_ROUTER_PASSIVE_INTERFACE", `${vrf}|${p}|0.0.0.0`);
  for (const [ifname, p] of Object.entries(ospf.ifParams ?? {})) {
    const ip = d.interfaces.find((i) => i.name === ifname)?.ipv4[0]?.address ?? "0.0.0.0";
    const row: Row = {};
    if (p.area) row["area-id"] = p.area;
    if (p.cost !== undefined) row.metric = str(p.cost);
    if (p.hello !== undefined) row["hello-interval"] = str(p.hello);
    if (p.dead !== undefined) row["dead-interval"] = str(p.dead);
    if (p.priority !== undefined) row.priority = str(p.priority);
    if (p.network) row["network-type"] = p.network === "point-to-point" ? "POINT_TO_POINT_NETWORK" : "BROADCAST_NETWORK";
    if (p.bfd) row["bfd-enable"] = "true";
    put(t, "OSPFV2_INTERFACE", `${ifname}|${ip}`, row);
  }
}

export function projectOspf(d: Device, t: Tables): void {
  for (const vrf of ospfConfiguredVrfs(d)) {
    const cfg = ospfConfig(d, vrf);
    if (cfg) ospfInstance(d, t, vrf, cfg);
  }
}

// ---------------------------------------------------------------------------
// IPv6 router advertisements

export function projectNd(d: Device, t: Tables): void {
  for (const [ifname, c] of Object.entries(ndConfig(d)) as [string, NdIfConfig][]) {
    const row: Row = {};
    if (c.suppressRa !== undefined) row.suppress_ra = c.suppressRa ? "true" : "false";
    if (c.raInterval !== undefined) row.ra_interval = str(c.raInterval);
    if (c.managed) row.managed_config_flag = "true";
    if (c.other) row.other_config_flag = "true";
    put(t, "ND_CFG_MSG", ifname, row);
  }
}

// ---------------------------------------------------------------------------
// EVPN: VRF L3VNI, neigh-suppress, SAG, ethernet segments

export function projectEvpn(d: Device, t: Tables): void {
  for (const m of cpList(d, "vxlan", "vrfmap")) {
    const v = str(m.vrf);
    if (t.VRF?.[v]) t.VRF[v] = { ...t.VRF[v], vni: str(m.vni) };
  }
  for (const s of cpList(d, "vxlan", "suppress")) put(t, "SUPPRESS_VLAN_NEIGH", str(s.name), { suppress: str(s.suppress ?? "on") });

  const sag = cpGet(d, "sag");
  if (sag) {
    const g: Row = {};
    if (sag.gwmac) g.gwmac = str(sag.gwmac).toLowerCase();
    if (sag["rmac-forwarding"]) g["rmac-forwarding"] = str(sag["rmac-forwarding"]);
    if (Object.keys(g).length) put(t, "SAG_GLOBAL", "IP", g);
    const byKey = new Map<string, string[]>();
    for (const gw of cpList(d, "sag", "gateways")) {
      const k = `${str(gw.iface)}|${str(gw.family)}`;
      byKey.set(k, [...(byKey.get(k) ?? []), str(gw.addr)]);
    }
    for (const [k, addrs] of byKey) put(t, "SAG", k, { gwip: addrs });
  }

  for (const es of cpList(d, "evpn_mh", "es")) {
    const row: Row = { esi: es.esi === "auto-system-mac" ? "AUTO" : str(es.esi) };
    if (es.esi === "auto-system-mac") row.esi_type = "TYPE_3_MAC_BASED";
    if (set(es.df_pref)) row.df_pref = str(es.df_pref);
    put(t, "EVPN_ETHERNET_SEGMENT", str(es.ifname), row);
  }
}

// ---------------------------------------------------------------------------
// Mirroring and L2 protection

export function projectL2Protect(d: Device, t: Tables): void {
  for (const s of mirrorSessions(d)) {
    const erspan = s.type === "erspan";
    const row: Row = { type: erspan ? "ERSPAN" : "SPAN" };
    if (erspan) {
      for (const k of ["src_ip", "dst_ip", "dscp", "ttl"] as const) if (set(s[k])) row[k] = str(s[k]);
      if (set(s.gre)) row.gre_type = str(s.gre);
    } else if (s.dst) row.dst_port = s.dst;
    if (set(s.queue)) row.queue = str(s.queue);
    if (set(s.policer)) row.policer = str(s.policer);
    if (s.src) {
      row.src_port = s.src;
      row.direction = (s.direction ?? "both").toUpperCase();
    }
    put(t, "MIRROR_SESSION", s.name, row);
  }

  for (const p of cpList(d, "storm_control", "ports")) put(t, "PORT_STORM_CONTROL", `${str(p.iface)}|${str(p.type)}`, { kbps: str(p.kbps) });

  const snoop = cpGet(d, "dhcp_snooping");
  if (snoop?.v4_verify_mac || snoop?.v6_verify_mac) {
    const g: Row = {};
    if (snoop.v4_verify_mac) g.dhcpv4_verify_mac_address = "enable";
    if (snoop.v6_verify_mac) g.dhcpv6_verify_mac_address = "enable";
    put(t, "DHCP_SNOOPING", "GLOBAL", g);
  }
  for (const [fam, field] of [["v4", "dhcpv4_snooping_trust"], ["v6", "dhcpv6_snooping_trust"]] as const) {
    for (const tr of cpList(d, "dhcp_snooping", `${fam}_trust`)) {
      const ifn = str(tr.iface);
      const table = /^PortChannel/.test(ifn) ? "PORTCHANNEL" : "PORT";
      if (t[table]?.[ifn]) t[table][ifn] = { ...t[table][ifn], [field]: "enable" };
    }
  }

  const udld = cpGet(d, "udld");
  if (udld?.enable) {
    const g: Row = {};
    if (udld.aggressive) g.aggressive = "true";
    if (set(udld.msg_time)) g.msg_time = str(udld.msg_time);
    if (set(udld.multiplier)) g.multiplier = str(udld.multiplier);
    put(t, "UDLD", "GLOBAL", g);
  }
  for (const p of cpList(d, "udld", "ports")) {
    const row: Row = {};
    if (p.admin_enable) row.admin_enable = "true";
    if (p.aggressive) row.aggressive = "true";
    put(t, "UDLD_PORT", str(p.ifname), row);
  }

  const ed = cpGet(d, "errdisable");
  if (ed && set(ed.interval)) put(t, "ERRDISABLE", "RECOVERY", { interval: str(ed.interval) });

  for (const g of cpList(d, "link_track", "groups")) {
    const row: Row = {};
    if (set(g.description)) row.description = str(g.description);
    if (set(g.timeout)) row.timeout = str(g.timeout);
    put(t, "LINK_STATE_TRACKING", str(g.name), row);
    for (const [role, list] of [["upstream", g.upstreamIfs], ["downstream", g.downstreamIfs]] as const) {
      for (const ifn of (list as string[] | undefined) ?? []) put(t, "LINK_STATE_TRACKING_MEMBER", ifn, { group: str(g.name), role });
    }
  }
}

// ---------------------------------------------------------------------------
// Multicast: IGMP snooping, PIM, IGMP

export function projectMulticast(d: Device, t: Tables): void {
  for (const v of cpList(d, "igmp_snooping", "vlans")) {
    const vlan = str(v.vlan);
    const row: Row = { enabled: "true" };
    if (v.querier) row.querier = "true";
    if (v.fastLeave) row["fast-leave"] = "true";
    if (v.version !== undefined) row.version = str(v.version);
    if (v.queryInterval !== undefined) row["query-interval"] = str(v.queryInterval);
    if (v.lastMemberQueryInterval !== undefined) row["last-member-query-interval"] = str(v.lastMemberQueryInterval);
    if (v.maxResponseTime !== undefined) row["query-max-response-time"] = str(v.maxResponseTime);
    put(t, "CFG_L2MC_TABLE", vlan, row);
    for (const m of (v.mrouters as string[] | undefined) ?? []) put(t, "CFG_L2MC_MROUTER_TABLE", `${vlan}|${m}`);
    for (const s of (v.staticGroups as { group: string; intf: string }[] | undefined) ?? []) put(t, "CFG_L2MC_STATIC_MEMBER_TABLE", `${vlan}|${s.group}|${s.intf}`);
  }

  for (const g of cpList(d, "pim", "globals")) {
    const row: Row = {};
    if (g.joinPruneInterval !== undefined) row["join-prune-interval"] = str(g.joinPruneInterval);
    if (g.keepAliveTimer !== undefined) row["keep-alive-timer"] = str(g.keepAliveTimer);
    if (set(g.ssmPrefixList)) row["ssm-ranges"] = str(g.ssmPrefixList);
    if (g.ecmp) row["ecmp-enabled"] = "true";
    if (g.ecmpRebalance) row["ecmp-rebalance-enabled"] = "true";
    put(t, "PIM_GLOBALS", `${str(g.vrf)}|ipv4`, row);
  }
  for (const r of cpList(d, "pim", "rps")) put(t, "PIM_GLOBALS_RENDEZVOUS_POINT", `${str(r.vrf)}|ipv4|${str(r.rp)}`);
  for (const c of cpList(d, "pim", "interfaces")) {
    const row: Row = {};
    if (c.sparseMode) row.mode = "sm";
    if (c.drPriority !== undefined) row["dr-priority"] = str(c.drPriority);
    if (c.helloInterval !== undefined) row["hello-interval"] = str(c.helloInterval);
    if (c.bfd) row["bfd-enabled"] = "true";
    const vrf = vrfOf(d, d.interfaces.find((i) => i.name === c.iface));
    put(t, "PIM_INTERFACE", `${vrf}|ipv4|${str(c.iface)}`, row);
  }
  for (const c of cpList(d, "igmp", "interfaces")) {
    const row: Row = {};
    if (c.enabled) row.enabled = "true";
    if (c.version !== undefined) row.version = str(c.version);
    if (c.queryInterval !== undefined) row["query-interval"] = str(c.queryInterval);
    if (c.queryMaxResponseTime !== undefined) row["query-max-response-time"] = str(c.queryMaxResponseTime);
    if (c.lastMemberQueryCount !== undefined) row["last-member-query-count"] = str(c.lastMemberQueryCount);
    if (c.lastMemberQueryInterval !== undefined) row["last-member-query-interval"] = str(c.lastMemberQueryInterval);
    put(t, "IGMP_INTERFACE_QUERY", str(c.iface), row);
  }
}

// ---------------------------------------------------------------------------
// L3 services: NAT, FBS/PBR, IP SLA, ECMP load-share

const IP_SLA_FIELD: Record<string, string> = {
  frequency: "frequency",
  threshold: "threshold",
  timeout: "timeout",
  icmp_dst: "icmp_dst_ip",
  icmp_src_ip: "icmp_source_ip",
  icmp_src_if: "icmp_source_interface",
  icmp_vrf: "icmp_vrf",
  icmp_size: "icmp_size",
  icmp_ttl: "icmp_ttl",
  icmp_tos: "icmp_tos",
  tcp_dst: "tcp_dst_ip",
  tcp_dst_port: "tcp_dst_port",
  tcp_src_ip: "tcp_source_ip",
  tcp_src_port: "tcp_source_port",
  tcp_src_if: "tcp_source_interface",
  tcp_vrf: "tcp_vrf",
  tcp_ttl: "tcp_ttl",
  tcp_tos: "tcp_tos",
};

const FBS_MATCH: Record<string, string> = { "src-ip": "SRC_IP", "dst-ip": "DST_IP", dscp: "DSCP", pcp: "PCP", vlan: "VLAN", "ip-protocol": "IP_PROTOCOL" };
const FBS_BIND: Record<string, string> = { "forwarding|in": "INGRESS_FORWARDING_POLICY", "qos|in": "INGRESS_QOS_POLICY", "qos|out": "EGRESS_QOS_POLICY", "monitoring|in": "INGRESS_MONITORING_POLICY" };

const LOADSHARE_V4: Record<string, string> = { "ipv4-src-ip": "ipv4_src_ip", "ipv4-dst-ip": "ipv4_dst_ip", "ipv4-ip-proto": "ipv4_protocol", "ipv4-l4-src-port": "ipv4_l4_src_port", "ipv4-l4-dst-port": "ipv4_l4_dst_port", symmetric: "ipv4_symmetric" };
const LOADSHARE_V6: Record<string, string> = { "ipv6-src-ip": "ipv6_src_ip", "ipv6-dst-ip": "ipv6_dst_ip", "ipv6-next-hdr": "ipv6_next_hdr", "ipv6-flow-label": "ipv6_flow_label", "ipv6-l4-src-port": "ipv6_l4_src_port", "ipv6-l4-dst-port": "ipv6_l4_dst_port", symmetric: "ipv6_symmetric" };

export function projectL3Services(d: Device, t: Tables): void {
  // NAT (sonic-nat.yang): NAT_GLOBAL|Values, pools, bindings, static entries, INTERFACE nat_zone
  const nat = cpGet(d, "nat");
  if (nat) {
    const g: Row = {};
    for (const k of ["admin_mode", "nat_timeout", "nat_tcp_timeout", "nat_udp_timeout"]) if (set(nat[k])) g[k] = str(nat[k]);
    if (Object.keys(g).length) put(t, "NAT_GLOBAL", "Values", g);
    for (const p of cpList(d, "nat", "pools")) {
      const row: Row = { nat_ip: str(p.nat_ip) };
      if (set(p.nat_port)) row.nat_port = str(p.nat_port);
      put(t, "NAT_POOL", str(p.pool_name), row);
    }
    for (const b of cpList(d, "nat", "bindings")) {
      const row: Row = { nat_pool: str(b.nat_pool) };
      for (const k of ["access_list", "nat_type", "twice_nat_id"]) if (set(b[k])) row[k] = str(b[k]);
      put(t, "NAT_BINDINGS", str(b.name), row);
    }
    for (const s of cpList(d, "nat", "statics")) {
      const row: Row = { local_ip: str(s.local_ip) };
      const napt = s.ip_protocol !== "all";
      if (napt) row.local_port = str(s.local_port);
      for (const k of ["nat_type", "twice_nat_id"]) if (set(s[k])) row[k] = str(s[k]);
      if (napt) put(t, "STATIC_NAPT", `${str(s.global_ip)}|${str(s.ip_protocol).toUpperCase()}|${str(s.global_port)}`, row);
      else put(t, "STATIC_NAT", str(s.global_ip), row);
    }
    for (const z of cpList(d, "nat", "zones")) {
      const ifn = str(z.port);
      const table = /^Vlan\d+$/.test(ifn) ? "VLAN_INTERFACE" : /^PortChannel\d+$/.test(ifn) ? "PORTCHANNEL_INTERFACE" : /^Loopback\d+$/.test(ifn) ? "LOOPBACK_INTERFACE" : "INTERFACE";
      put(t, table, ifn, { ...(t[table]?.[ifn] ?? {}), nat_zone: str(z.zone) });
    }
  }

  // Flow-based services (sonic-flow-based-services.yang)
  const fbs = peekFbs(d);
  for (const c of fbs?.classifiers ?? []) {
    const row: Row = { MATCH_TYPE: "FIELDS" };
    if (c.description) row.DESCRIPTION = c.description;
    for (const m of c.matches) {
      if (FBS_MATCH[m.field]) row[FBS_MATCH[m.field]] = m.value;
      else {
        const base = m.field === "src-port" ? "L4_SRC_PORT" : "L4_DST_PORT";
        if (/^\d+$/.test(m.value)) row[base] = m.value;
        else row[`${base}_RANGE`] = m.value;
      }
    }
    put(t, "CLASSIFIER_TABLE", c.name, row);
  }
  for (const p of fbs?.policies ?? []) {
    const row: Row = { TYPE: p.type.toUpperCase() };
    if (p.description) row.DESCRIPTION = p.description;
    put(t, "POLICY_TABLE", p.name, row);
    for (const f of p.flows) {
      const sec: Row = { PRIORITY: str(f.priority) };
      if (f.description) sec.DESCRIPTION = f.description;
      const nh: string[] = [];
      const intf: string[] = [];
      for (const a of f.actions) {
        if (a.name === "set-ip-nexthop") nh.push(`${a.target}|${a.vrf ?? ""}|${a.priority ?? ""}`);
        else if (a.name === "set-interface" && a.target === "null") sec.DEFAULT_PACKET_ACTION = "DROP";
        else if (a.name === "set-interface") intf.push(`${a.target}|${a.priority ?? ""}`);
        else if (a.name === "set-dscp") sec.SET_DSCP = a.detail;
        else if (a.name === "set-pcp") sec.SET_PCP = a.detail;
      }
      if (nh.length) sec.SET_IP_NEXTHOP = nh;
      if (intf.length) sec.SET_INTERFACE = intf;
      put(t, "POLICY_SECTIONS_TABLE", `${p.name}|${f.classifier}`, sec);
    }
  }
  for (const b of fbs?.bindings ?? []) {
    const type = fbs?.policies.find((p) => p.name === b.policy)?.type ?? "forwarding";
    const field = FBS_BIND[`${type}|${b.direction}`];
    if (field) put(t, "POLICY_BINDING_TABLE", b.iface, { ...(t.POLICY_BINDING_TABLE?.[b.iface] ?? {}), [field]: b.policy });
  }

  // IP SLA (frrcfgd.py:2698-2718)
  for (const inst of cpList(d, "ipsla", "instances")) {
    const row: Row = {};
    for (const [k, v] of Object.entries(inst)) if (IP_SLA_FIELD[k] && set(v)) row[IP_SLA_FIELD[k]] = str(v);
    put(t, "IP_SLA", str(inst.id), row);
  }
  // SLA-tracked static routes: per-nexthop STATIC_ROUTE track list, 0 = untracked
  // (frrcfgd.py:1963, 2277); the next hop stays configured while the SLA is down.
  for (const r of peekFeatureState<{ routes: TrackedRoute[] }>(d, "ipsla_routes")?.routes ?? []) {
    const key = `${r.vrf && r.vrf !== DEFAULT_VRF ? r.vrf + "|" : ""}${r.prefix}/${r.len}`;
    const row = { ...(t.STATIC_ROUTE?.[key] ?? {}) } as Record<string, string>;
    const cols = ["nexthop", "ifname", "distance", "blackhole", "track"] as const;
    const lists = Object.fromEntries(cols.map((c) => [c, row[c] !== undefined ? row[c].split(",") : []])) as Record<(typeof cols)[number], string[]>;
    let i = lists.nexthop.indexOf(r.nexthop);
    if (i < 0) {
      i = lists.nexthop.length;
      lists.nexthop.push(r.nexthop);
      lists.ifname.push("");
      lists.distance.push(str(r.distance ?? 0));
      lists.blackhole.push("false");
    }
    lists.track = lists.nexthop.map((_, j) => lists.track[j] ?? "0");
    lists.track[i] = str(r.track);
    put(t, "STATIC_ROUTE", key, Object.fromEntries(cols.map((c) => [c, lists[c].join(",")])));
  }

  // ECMP load-share hashing (klish-xml loadshare.xml)
  const ls = cpGet(d, "loadshare");
  if (ls) {
    for (const [fam, map] of [["ipv4", LOADSHARE_V4], ["ipv6", LOADSHARE_V6]] as const) {
      const fields = ls[fam] as { field: string }[] | undefined;
      if (!fields) continue;
      const row: Row = {};
      for (const f of fields) if (map[f.field]) row[map[f.field]] = "true";
      put(t, `ECMP_LOADSHARE_TABLE_${fam.toUpperCase()}`, fam, row);
    }
    if (set(ls.seed)) put(t, "ECMP_LOADSHARE_TABLE_SEED", "hash", { ecmp_hash_seed: str(ls.seed) });
    if (set(ls.offset)) put(t, "ECMP_LOADSHARE_TABLE_OFFSET", "hash", { "ecmp-hash-offset": str(ls.offset) });
    if (set(ls.algorithm)) put(t, "SWITCH", "switch", { ecmp_hash_algorithm: str(ls.algorithm) });
  }
}
