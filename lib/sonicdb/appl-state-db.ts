/**
 * APPL_DB and STATE_DB projections: what the *mgrd/*syncd daemons would have
 * written from CONFIG_DB plus what the live protocols learned.
 *
 * APPL_DB (separator ":"), table names sonic-swss-common/common/schema.h:35-118:
 *   PORT_TABLE            portmgrd/portsyncd: admin_status, oper_status, speed, mtu, alias, index, lanes
 *   VLAN_TABLE            vlanmgrd (cfgmgr/vlanmgr.cpp:424-428): admin_status, mtu
 *   VLAN_MEMBER_TABLE     vlanmgrd (vlanmgr.cpp:573): tagging_mode
 *   LAG_TABLE             teamsyncd (teamsyncd/teamsync.cpp:150): admin_status, mtu, oper_status
 *   LAG_MEMBER_TABLE      teamsyncd (teamsync.cpp:351): status enabled|disabled
 *   INTF_TABLE            intfmgrd (cfgmgr/intfmgr.cpp:1275-1280): "<if>:<ip/len>" scope/family
 *   ROUTE_TABLE           fpmsyncd (fpmsyncd/routesync.cpp:861-865): nexthop, ifname, protocol
 *   NEIGH_TABLE           neighsyncd (neighsyncd/neighsync.cpp:171-172): neigh, family
 *   FDB_TABLE             static FDB (config mac add): port, type
 *   VRF_TABLE, SFLOW_TABLE, SFLOW_SESSION_TABLE (cfgmgr/sflowmgr.cpp:277-280),
 *   VXLAN_TUNNEL_TABLE (cfgmgr/vxlanmgr.cpp:24-25 src_ip), VXLAN_TUNNEL_MAP_TABLE,
 *   VXLAN_EVPN_NVO_TABLE, VXLAN_REMOTE_VNI_TABLE, VXLAN_FDB_TABLE (fdbsyncd from EVPN),
 *   LLDP_ENTRY_TABLE (lldp_syncd: lldp_rem_*)
 *   NAT/NAPT, SUPPRESS_VLAN_NEIGH, L2MC member tables: ./appl-state-features.ts
 *
 * STATE_DB (separator "|"), schema.h:523-594:
 *   PORT_TABLE            live capture row: state ok, netdev_oper_status (portsyncd/linksync.cpp:201),
 *                         admin_status, mtu, oper_speed
 *   LAG_TABLE             teamsyncd (teamsync.cpp:173): state ok
 *   VLAN_TABLE, VLAN_MEMBER_TABLE, INTERFACE_TABLE, VRF_TABLE: state ok (the *mgrd "ready" flags)
 *   FDB_TABLE             fdbsyncd: "Vlan<id>:<mac>" port/type
 *   NEIGH_STATE_TABLE     bgpmon (sonic-bgpcfgd/bgpmon/bgpmon.py:128): state
 *   BFD_SESSION_TABLE     "default|<if>|<peer>": state, local_addr, ...
 *   VXLAN_TUNNEL_TABLE    "EVPN_<remote>": src_ip, dst_ip, tnl_src, operstatus
 *   MCLAG_TABLE           iccpd: oper_status, role
 *   MIRROR_SESSION_TABLE  ./appl-state-features.ts
 */
import { Device } from "../models/device";
import { Route, routeDistance } from "../models/route";
import { peekFeatureState } from "../models/feature-state";
import { DEFAULT_VRF, vrfOf } from "../models/vrf";
import { listVlans, vlanMembers } from "../models/vlan-ops";
import { sflowSessions, peekSflowState } from "../sflow/agent";
import { lagConfigs, lacpRuntime } from "../protocols/lacp-daemon";
import { peekBgpRuntime } from "../protocols/bgp-daemon";
import { bfdSessions } from "../protocols/bfd-daemon";
import { lldpRuntime } from "../protocols/lldp-daemon";
import { peekVxlanRuntime } from "../protocols/vxlan-daemon";
import { vxlanConfig } from "../protocols/vxlan";
import { mclagConfig, mclagRuntime } from "../protocols/mclag-daemon";
import { cpList } from "../commands/sonic-cli/config-plane";
import { Tables, put, Row } from "./schema";
import { frontPorts, ifAddrs } from "./config-db";
import { projectFeatureAppl, projectFeatureState } from "./appl-state-features";
import { projectCoppAppl } from "./qos-copp-db";

const portNum = (name: string) => Number(/\d+$/.exec(name)?.[0] ?? 0);
const ifName = (d: Device, id: string) => d.interfaces.find((i) => i.id === id)?.name;

/** Routes the FIB holds: best distance per (vrf, prefix); equal-cost ties are ECMP. `table` = routingTable6 for IPv6. */
export function fibRoutes(d: Device, table: Route[] = d.routingTable): Route[][] {
  const groups = new Map<string, Route[]>();
  for (const r of table) {
    const k = `${r.vrf ?? DEFAULT_VRF}|${r.destination}/${r.prefix}`;
    const g = groups.get(k);
    if (!g) groups.set(k, [r]);
    else if (routeDistance(r) < routeDistance(g[0]) || (routeDistance(r) === routeDistance(g[0]) && r.metric < g[0].metric)) groups.set(k, [r]);
    else if (routeDistance(r) === routeDistance(g[0]) && r.metric === g[0].metric) g.push(r);
  }
  return [...groups.values()];
}

/** fpmsyncd protocol names (zebra route types). */
const PROTO: Record<string, string> = { connected: "connected", static: "static", default: "static", ospf: "ospf", bgp: "bgp" };

/** "aa:bb:..." lower-case as swss writes MACs. */
const mac = (m: string) => m.toLowerCase();

export function projectApplDb(d: Device): Tables {
  const t: Tables = {};

  for (const p of frontPorts(d)) {
    const n = portNum(p.name);
    put(t, "PORT_TABLE", p.name, {
      admin_status: p.adminState,
      oper_status: p.adminState === "up" ? p.operState : "down",
      speed: String(p.speed),
      mtu: "9100",
      alias: `etp${n + 1}`,
      index: String(n + 1),
      lanes: String(n + 1),
    });
  }

  for (const v of listVlans(d)) {
    put(t, "VLAN_TABLE", `Vlan${v.id}`, { admin_status: "up", mtu: "9100" });
    for (const m of vlanMembers(d, v.id)) put(t, "VLAN_MEMBER_TABLE", `Vlan${v.id}:${m.port}`, { tagging_mode: m.tagged ? "tagged" : "untagged" });
  }

  const lacp = lacpRuntime(d);
  for (const lag of lagConfigs(d)) {
    const iface = d.interfaces.find((i) => i.name === lag.name);
    put(t, "LAG_TABLE", lag.name, { admin_status: iface?.adminState ?? "up", mtu: "9100", oper_status: iface?.operState ?? "down" });
    for (const m of lag.members) {
      const sel = lacp?.lags[lag.name]?.ports[m]?.selected ?? false;
      put(t, "LAG_MEMBER_TABLE", `${lag.name}:${m}`, { status: sel ? "enabled" : "disabled" });
    }
  }

  for (const v of peekFeatureState<{ vrfs: { name: string }[] }>(d, "vrf")?.vrfs ?? []) put(t, "VRF_TABLE", v.name);

  for (const i of d.interfaces) {
    if (i.management) continue;
    const addrs = ifAddrs(i);
    const vrf = vrfOf(d, i);
    if (!addrs.length && vrf === DEFAULT_VRF) continue;
    put(t, "INTF_TABLE", i.name, vrf !== DEFAULT_VRF ? { vrf_name: vrf } : {});
    for (const a of addrs) put(t, "INTF_TABLE", `${i.name}:${a}`, { scope: "global", family: a.includes(":") ? "IPv6" : "IPv4" });
  }

  // ROUTE_TABLE: "<prefix>" or "<vrf>:<prefix>" (routesync.cpp), ECMP comma-joined;
  // routes out of eth0 are skipped (routesync.cpp:1674).
  const mgmt = new Set(d.interfaces.filter((i) => i.management).map((i) => i.id));
  // IPv6 routes use the same keys with "::" as the on-link next hop (routesync.cpp).
  for (const [all, onLink] of [...fibRoutes(d).map((g) => [g, "0.0.0.0"] as const), ...fibRoutes(d, d.routingTable6 ?? []).map((g) => [g, "::"] as const)]) {
    const g = all.filter((r) => !mgmt.has(r.interfaceId));
    if (!g.length) continue;
    const r0 = g[0];
    const vrf = r0.vrf ?? DEFAULT_VRF;
    const key = `${vrf === DEFAULT_VRF ? "" : vrf + ":"}${r0.destination}/${r0.prefix}`;
    put(t, "ROUTE_TABLE", key, {
      nexthop: g.map((r) => r.nextHop ?? onLink).join(","),
      ifname: g.map((r) => ifName(d, r.interfaceId) ?? "").join(","),
      protocol: PROTO[r0.type] ?? r0.type,
    });
  }

  for (const n of d.arpTable) {
    if (n.state === "incomplete") continue;
    const ifn = ifName(d, n.interfaceId);
    if (ifn) put(t, "NEIGH_TABLE", `${ifn}:${n.ip}`, { neigh: mac(n.mac), family: "IPv4" });
  }
  for (const n of d.ndpTable) {
    if (n.state === "incomplete") continue;
    const ifn = ifName(d, n.interfaceId);
    if (ifn) put(t, "NEIGH_TABLE", `${ifn}:${n.ip}`, { neigh: mac(n.mac), family: "IPv6" });
  }

  for (const e of d.macTable.filter((x) => x.static)) {
    const p = ifName(d, e.interfaceId);
    if (p) put(t, "FDB_TABLE", `Vlan${e.vlan}:${mac(e.mac).replace(/:/g, "-")}`, { port: p, type: "static" });
  }

  // sflowmgrd output (sflowmgr.cpp): SFLOW_TABLE:global + per-port sessions
  const sf = peekSflowState(d);
  if (sf) {
    const g: Row = { admin_state: sf.enabled ? "up" : "down" };
    if (sf.pollingInterval !== undefined) g.polling_interval = String(sf.pollingInterval);
    if (sf.agentId) g.agent_id = sf.agentId;
    put(t, "SFLOW_TABLE", "global", g);
  }
  for (const s of sflowSessions(d)) {
    put(t, "SFLOW_SESSION_TABLE", s.port, { admin_state: s.adminState, sample_rate: String(s.sampleRate), sample_direction: s.direction });
  }

  // vxlanmgrd
  for (const v of cpList(d, "vxlan", "vteps")) put(t, "VXLAN_TUNNEL_TABLE", String(v.name), v.source_ip ? { src_ip: String(v.source_ip) } : {});
  for (const n of cpList(d, "vxlan", "nvo")) put(t, "VXLAN_EVPN_NVO_TABLE", String(n.name), { source_vtep: String(n.source_vtep) });
  const vx = vxlanConfig(d);
  if (vx) {
    for (const m of vx.maps) put(t, "VXLAN_TUNNEL_MAP_TABLE", `${vx.vtep}:map_${m.vni}_Vlan${m.vlan}`, { vlan: `Vlan${m.vlan}`, vni: String(m.vni) });
    const rt = peekVxlanRuntime(d);
    for (const [vtep, vnis] of Object.entries(rt?.vteps ?? {})) {
      for (const vni of vnis) {
        const vlan = vx.maps.find((m) => m.vni === vni)?.vlan;
        if (vlan !== undefined) put(t, "VXLAN_REMOTE_VNI_TABLE", `Vlan${vlan}:${vtep}`, { vni: String(vni) });
      }
    }
    for (const [k, rm] of Object.entries(rt?.macs ?? {})) {
      const m = k.split("|")[1] ?? "";
      put(t, "VXLAN_FDB_TABLE", `Vlan${rm.vid}:${mac(m)}`, { remote_vtep: rm.vtep, type: "dynamic", vni: String(rm.vni) });
    }
  }

  // lldp_syncd → LLDP_ENTRY_TABLE
  const lr = lldpRuntime(d);
  for (const [port, ns] of Object.entries(lr?.neighbors ?? {})) {
    const n = ns[0];
    if (!n) continue;
    const row: Row = { lldp_rem_chassis_id: n.chassisId, lldp_rem_port_id: n.portId, lldp_rem_time_mark: String(n.ttl) };
    if (n.sysName) row.lldp_rem_sys_name = n.sysName;
    if (n.portDescr) row.lldp_rem_port_desc = n.portDescr;
    if (n.mgmtIp) row.lldp_rem_man_addr = n.mgmtIp;
    put(t, "LLDP_ENTRY_TABLE", port, row);
  }
  projectFeatureAppl(d, t);
  projectCoppAppl(d, t);
  return t;
}

const BFD_STATE = ["Admin_Down", "Down", "Init", "Up"];

export function projectStateDb(d: Device): Tables {
  const t: Tables = {};

  for (const p of frontPorts(d)) {
    put(t, "PORT_TABLE", p.name, {
      state: "ok",
      netdev_oper_status: p.adminState === "up" ? p.operState : "down",
      admin_status: p.adminState,
      mtu: "9100",
      oper_speed: String(p.speed),
    });
  }

  for (const lag of lagConfigs(d)) {
    const iface = d.interfaces.find((i) => i.name === lag.name);
    put(t, "LAG_TABLE", lag.name, { state: "ok", oper_status: iface?.operState ?? "down" });
  }

  for (const v of listVlans(d)) {
    put(t, "VLAN_TABLE", `Vlan${v.id}`, { state: "ok" });
    for (const m of vlanMembers(d, v.id)) put(t, "VLAN_MEMBER_TABLE", `Vlan${v.id}|${m.port}`, { state: "ok" });
  }

  for (const v of peekFeatureState<{ vrfs: { name: string }[] }>(d, "vrf")?.vrfs ?? []) put(t, "VRF_TABLE", v.name, { state: "ok" });

  for (const i of d.interfaces) {
    if (i.management) continue;
    const addrs = ifAddrs(i);
    if (!addrs.length) continue;
    const vrf = vrfOf(d, i);
    put(t, "INTERFACE_TABLE", i.name, { vrf: vrf === DEFAULT_VRF ? "" : vrf });
    for (const a of addrs) put(t, "INTERFACE_TABLE", `${i.name}|${a}`, { state: "ok" });
  }

  for (const e of d.macTable) {
    const p = ifName(d, e.interfaceId);
    if (p) put(t, "FDB_TABLE", `Vlan${e.vlan}:${mac(e.mac)}`, { port: p, type: e.static ? "static" : "dynamic" });
  }

  const bgp = peekBgpRuntime(d);
  for (const [ip, p] of Object.entries(bgp?.peers ?? {})) put(t, "NEIGH_STATE_TABLE", ip, { state: p.state });

  for (const s of bfdSessions(d)) {
    const row: Row = { state: BFD_STATE[s.state] ?? "Down", type: s.multihop ? "async_active_multihop" : "async_active", multiplier: String(s.detectMult) };
    if (s.local) row.local_addr = s.local;
    put(t, "BFD_SESSION_TABLE", `default|${s.ifname ?? "default"}|${s.peer}`, row);
  }

  const vx = vxlanConfig(d);
  if (vx) {
    for (const vtep of Object.keys(peekVxlanRuntime(d)?.vteps ?? {})) {
      put(t, "VXLAN_TUNNEL_TABLE", `EVPN_${vtep}`, { src_ip: vx.sourceIp, dst_ip: vtep, tnl_src: "EVPN", operstatus: "up" });
    }
  }

  const mc = mclagConfig(d);
  if (mc) {
    const rt = mclagRuntime(d);
    put(t, "MCLAG_TABLE", mc.id, { oper_status: rt?.session ? "up" : "down", role: rt?.role || "none", peer_ip: mc.peerIp, local_ip: mc.sourceIp });
  }
  projectFeatureState(d, t);
  return t;
}
