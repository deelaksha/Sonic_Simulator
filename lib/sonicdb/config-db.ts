/**
 * CONFIG_DB projection: the device model rendered as the tables the SONiC CLI
 * would have written (what `sonic-cfggen -d --print-data` / config_db.json show).
 *
 * Table and field names follow sonic-buildimage/src:
 *   sonic-swss-common/common/schema.h:323-457  CFG_*_TABLE_NAME (PORT, INTERFACE, VLAN, ...)
 *   sonic-yang-models/yang-models/
 *     sonic-port.yang, sonic-vlan.yang (VLAN vlanid/members, VLAN_MEMBER tagging_mode),
 *     sonic-interface.yang / sonic-loopback-interface.yang / sonic-portchannel.yang:85-200,
 *     sonic-vrf.yang:28-50, sonic-static-route.yang:69-150 (nexthop/ifname/distance),
 *     sonic-bgp-global.yang:37-503 (BGP_GLOBALS local_asn/router_id, BGP_GLOBALS_AF_NETWORK
 *       "vrf|afi_safi|prefix"), sonic-bgp-neighbor.yang:73 + sonic-bgp-common.yang:157-333
 *       (asn/name/keepalive/holdtime/local_addr/bfd/admin_status),
 *     sonic-ospf.yang:281-840 (OSPFV2_ROUTER, _AREA, _AREA_NETWORK "vrf|area|network"),
 *     sonic-ospf-interface.yang:81-194 (OSPFV2_INTERFACE "ifname|ip": area-id/metric/...),
 *     sonic-sflow.yang:62-192, sonic-acl.yang, sonic-mclag.yang:48-128,
 *     sonic-vxlan.yang:42-114, sonic-vrrp.yang:71-140, sonic-snmp.yang:90-387,
 *     sonic-lldp.yang:63-193, sonic-ntp.yang:177, sonic-dns.yang:122-137,
 *     sonic-bfd.yang:252-272 (key "remote-address|interface|vrf|local-address"),
 *     (BGP/OSPF and the newer feature tables: ./config-db-features.ts)
 *     sonic-device_metadata.yang:38-105,
 *     QoS / CoPP tables: ./qos-copp-db.ts.
 * Live capture: data/device-capture/sflow-live/configdb-and-click-show.txt.
 *
 * Read-only: never creates feature state (peek accessors only).
 */
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { peekFeatureState } from "../models/feature-state";
import { isLinkLocal6 } from "../models/ipv6";
import { vrfOf, DEFAULT_VRF } from "../models/vrf";
import { inactiveStatics } from "../models/static-routes";
import { listVlans, vlanMembers } from "../models/vlan-ops";
import { peekSflowState } from "../sflow/agent";
import { getBgpConfig } from "../protocols/bgp";
import { lagConfigs, systemMac } from "../protocols/lacp-daemon";
import { AclState, ruleFields, sonicTableType, AclType } from "../protocols/acl-rules";
import { SnmpState } from "../protocols/snmp-config";
import { VrrpConfig } from "../protocols/vrrp";
import { BfdPeerConfig } from "../protocols/bfd-daemon";
import { cpList } from "../commands/sonic-cli/config-plane";
import { Tables, put, Row } from "./schema";
import { projectBgp, projectPolicy, projectOspf, projectNd, projectEvpn, projectL2Protect, projectMulticast, projectL3Services } from "./config-db-features";
import { projectQosConfig, projectCoppConfig } from "./qos-copp-db";

/** Front-panel ports (PORT table): not mgmt, not logical. */
export function frontPorts(d: Device): NetInterface[] {
  return d.interfaces.filter((i) => !i.management && !i.logical);
}

/** CONFIG_DB interface table for an L3 interface name. */
export function intfTable(name: string): string {
  if (/^Vlan\d+$/.test(name)) return "VLAN_INTERFACE";
  if (/^Loopback\d+$/.test(name)) return "LOOPBACK_INTERFACE";
  if (/^PortChannel\d+$/.test(name)) return "PORTCHANNEL_INTERFACE";
  if (/^(Ethernet|PortChannel)\d+\.\d+$/.test(name)) return "VLAN_SUB_INTERFACE";
  return "INTERFACE";
}

const portNum = (name: string) => Number(/\d+$/.exec(name)?.[0] ?? 0);

/** Addresses as SONiC keys them ("10.0.0.1/24"; link-local v6 is kernel-only). */
export function ifAddrs(i: NetInterface): string[] {
  return [...i.ipv4.map((a) => `${a.address}/${a.prefix}`), ...i.ipv6.filter((a) => !isLinkLocal6(a.address)).map((a) => `${a.address}/${a.prefix}`)];
}

/** The SONiC CLI is available on switches (and the routers the labs model as SONiC boxes). */
export function isSonicDevice(d: Device): boolean {
  return isSwitch(d.type) || d.type === "router";
}

const str = (v: unknown) => String(v);

function bool(v: boolean | undefined): string {
  return v ? "true" : "false";
}

/** ACL_TABLE / ACL_RULE (sonic-acl.yang; rule fields from acl-rules.ts ruleFields, xfmr_acl.go). */
export function projectAcl(d: Device, t: Tables): void {
  const acl = peekFeatureState<AclState>(d, "acl");
  for (const tb of acl?.tables ?? []) {
    const row: Row = { type: sonicTableType(tb.type), stage: (tb.stage ?? "ingress").toUpperCase() };
    if (tb.ports.length) row.ports = [...tb.ports];
    if (tb.description) row.policy_desc = tb.description;
    put(t, "ACL_TABLE", tb.name, row);
    for (const r of acl?.rules[tb.name] ?? []) put(t, "ACL_RULE", `${tb.name}|RULE_${r.seq}`, ruleFields((tb.type ?? "ip") as AclType, r));
  }
}

export function projectConfigDb(d: Device): Tables {
  const t: Tables = {};
  const bgp = getBgpConfig(d);

  // DEVICE_METADATA|localhost (sonic-device_metadata.yang:42-105)
  const meta: Row = {
    hostname: d.config.hostname || d.name,
    mac: systemMac(d).toLowerCase(),
    platform: "x86_64-networklab_sim-r0",
    hwsku: "NetworkLab-Sim",
    type: "LeafRouter",
    docker_routing_config_mode: "split",
  };
  if (bgp?.localAs !== undefined) meta.bgp_asn = str(bgp.localAs);
  put(t, "DEVICE_METADATA", "localhost", meta);

  // PORT (sonic-port.yang) — live capture row: admin_status/alias/index/lanes/mtu/speed
  for (const p of frontPorts(d)) {
    const n = portNum(p.name);
    put(t, "PORT", p.name, {
      admin_status: p.adminState,
      alias: `etp${n + 1}`,
      index: str(n + 1),
      lanes: str(n + 1),
      mtu: "9100",
      speed: str(p.speed),
    });
  }

  // MGMT_PORT / MGMT_INTERFACE (sonic-mgmt_port.yang, sonic-mgmt_interface.yang)
  for (const m of d.interfaces.filter((i) => i.management)) {
    put(t, "MGMT_PORT", m.name, { admin_status: m.adminState, alias: m.name });
    for (const a of ifAddrs(m)) put(t, "MGMT_INTERFACE", `${m.name}|${a}`);
  }

  // VLAN / VLAN_MEMBER (sonic-vlan.yang; vlanmgr reads vlanid + tagging_mode)
  for (const v of listVlans(d)) {
    const mem = vlanMembers(d, v.id);
    const row: Row = { vlanid: str(v.id) };
    if (mem.length) row.members = mem.map((m) => m.port);
    put(t, "VLAN", `Vlan${v.id}`, row);
    for (const m of mem) put(t, "VLAN_MEMBER", `Vlan${v.id}|${m.port}`, { tagging_mode: m.tagged ? "tagged" : "untagged" });
  }

  // PORTCHANNEL / PORTCHANNEL_MEMBER (sonic-portchannel.yang:85-176)
  for (const lag of lagConfigs(d)) {
    const iface = d.interfaces.find((i) => i.name === lag.name);
    const row: Row = { admin_status: iface?.adminState ?? "up", mtu: "9100", lacp_key: "auto" };
    if (lag.minLinks !== undefined) row.min_links = str(lag.minLinks);
    if (lag.fallback !== undefined) row.fallback = bool(lag.fallback);
    if (lag.fastRate !== undefined) row.fast_rate = bool(lag.fastRate);
    put(t, "PORTCHANNEL", lag.name, row);
    for (const m of lag.members) put(t, "PORTCHANNEL_MEMBER", `${lag.name}|${m}`);
  }

  // VRF (sonic-vrf.yang:28-50)
  const vrfs = peekFeatureState<{ vrfs: { name: string; interfaces: string[] }[] }>(d, "vrf")?.vrfs ?? [];
  for (const v of vrfs) put(t, "VRF", v.name);

  // INTERFACE / VLAN_INTERFACE / LOOPBACK_INTERFACE / PORTCHANNEL_INTERFACE:
  // "<ifname>" (vrf_name) + "<ifname>|<ip/prefix>" rows, as config interface ip add writes.
  for (const i of d.interfaces) {
    if (i.management) continue;
    const addrs = ifAddrs(i);
    const vrf = vrfOf(d, i);
    if (!addrs.length && vrf === DEFAULT_VRF && !(i.logical && /^Loopback\d+$/.test(i.name))) continue;
    const table = intfTable(i.name);
    put(t, table, i.name, vrf !== DEFAULT_VRF ? { vrf_name: vrf } : {});
    for (const a of addrs) put(t, table, `${i.name}|${a}`);
  }

  // STATIC_ROUTE (sonic-static-route.yang:69-150): key "prefix" or "vrf|prefix"
  // Unresolved (inactive) statics are still configured.
  for (const r of [...d.routingTable.filter((x) => x.type === "static"), ...inactiveStatics(d)]) {
    const vrf = r.vrf ?? DEFAULT_VRF;
    const key = `${vrf === DEFAULT_VRF ? "" : vrf + "|"}${r.destination}/${r.prefix}`;
    const ifname = d.interfaces.find((i) => i.id === r.interfaceId)?.name ?? "";
    const prev = t.STATIC_ROUTE?.[key];
    if (prev) {
      // several next hops: per-nexthop comma lists (frrcfgd.py:1963-1968 IpNextHopSet)
      prev.nexthop = `${prev.nexthop},${r.nextHop ?? "0.0.0.0"}`;
      prev.ifname = `${prev.ifname},${ifname}`;
      prev.distance = `${prev.distance},${r.distance ?? 0}`;
      prev.blackhole = `${prev.blackhole},false`;
      continue;
    }
    put(t, "STATIC_ROUTE", key, { nexthop: r.nextHop ?? "0.0.0.0", ifname, distance: str(r.distance ?? 0), blackhole: "false" });
  }

  // BGP (all VRFs) + routing policy, OSPFv2 (all VRFs): ./config-db-features.ts
  projectBgp(d, t);
  projectPolicy(d, t);
  projectOspf(d, t);

  // BFD (sonic-bfd.yang:252-272)
  const bfdPeers = peekFeatureState<{ peers: BfdPeerConfig[] }>(d, "bfd")?.peers ?? [];
  for (const p of bfdPeers) {
    const row: Row = { enabled: bool(!p.shutdown) };
    if (p.txInterval !== undefined) row["desired-minimum-tx-interval"] = str(p.txInterval);
    if (p.rxInterval !== undefined) row["required-minimum-receive"] = str(p.rxInterval);
    if (p.multiplier !== undefined) row["detection-multiplier"] = str(p.multiplier);
    put(t, p.multihop ? "BFD_PEER_MULTI_HOP" : "BFD_PEER_SINGLE_HOP", `${p.peer}|${p.interface ?? "null"}|${DEFAULT_VRF}|${p.local ?? "null"}`, row);
  }

  // sFlow (sonic-sflow.yang; live capture SFLOW|global / SFLOW_COLLECTOR / SFLOW_SESSION)
  const sf = peekSflowState(d);
  if (sf) {
    const g: Row = { admin_state: sf.enabled ? "up" : "down" };
    if (sf.pollingInterval !== undefined) g.polling_interval = str(sf.pollingInterval);
    if (sf.sampleRate !== undefined) g.sample_rate = str(sf.sampleRate);
    if (sf.agentId) g.agent_id = sf.agentId;
    if (sf.direction) g.sample_direction = sf.direction;
    put(t, "SFLOW", "global", g);
    for (const c of sf.collectors) put(t, "SFLOW_COLLECTOR", c.name, { collector_ip: c.ip, collector_port: str(c.port), collector_vrf: c.vrf });
    if (sf.allInterfaces !== undefined || sf.allDirection) {
      const all: Row = { admin_state: sf.allInterfaces === false ? "down" : "up" };
      if (sf.allDirection) all.sample_direction = sf.allDirection;
      put(t, "SFLOW_SESSION", "all", all);
    }
    for (const [port, s] of Object.entries(sf.interfaces)) {
      const row: Row = {};
      if (s.enabled !== undefined) row.admin_state = s.enabled ? "up" : "down";
      if (s.sampleRate !== undefined) row.sample_rate = str(s.sampleRate);
      if (s.direction) row.sample_direction = s.direction;
      put(t, "SFLOW_SESSION", port, row);
    }
  }

  projectAcl(d, t);

  // MCLAG_DOMAIN / MCLAG_INTERFACE (sonic-mclag.yang:48-128; stored by KLISH as CONFIG_DB-shaped rows)
  for (const dom of cpList(d, "mclag", "domains")) {
    const row: Row = {};
    for (const k of ["source_ip", "peer_ip", "peer_link", "keepalive_interval", "session_timeout"]) if (dom[k] !== undefined) row[k] = str(dom[k]);
    put(t, "MCLAG_DOMAIN", str(dom.domain_id), row);
  }
  for (const i of cpList(d, "mclag", "interfaces")) put(t, "MCLAG_INTERFACE", `${str(i.domain_id)}|${str(i.if_name)}`, { if_type: str(i.if_type ?? "PortChannel") });

  // VXLAN_TUNNEL / VXLAN_TUNNEL_MAP / VXLAN_EVPN_NVO (sonic-vxlan.yang:42-114)
  for (const v of cpList(d, "vxlan", "vteps")) {
    const row: Row = {};
    if (v.source_ip) row.src_ip = str(v.source_ip);
    put(t, "VXLAN_TUNNEL", str(v.name), row);
  }
  for (const n of cpList(d, "vxlan", "nvo")) put(t, "VXLAN_EVPN_NVO", str(n.name), { source_vtep: str(n.source_vtep) });
  for (const m of cpList(d, "vxlan", "vlanmap")) {
    const vtep = str(m.vtep ?? cpList(d, "vxlan", "vteps")[0]?.name ?? "vtep");
    put(t, "VXLAN_TUNNEL_MAP", `${vtep}|map_${str(m.vni)}_${str(m.vlan)}`, { vlan: str(m.vlan), vni: str(m.vni) });
  }

  // VRRP (sonic-vrrp.yang:71-140) key "ifname|vrid"
  for (const v of peekFeatureState<VrrpConfig>(d, "vrrp")?.instances ?? []) {
    const row: Row = {};
    if (v.vip) row.vip = [v.vip];
    if (v.priority !== undefined) row.priority = str(v.priority);
    if (v.advInterval !== undefined) row.adv_interval = str(v.advInterval);
    if (v.preempt !== undefined) row.preempt = bool(v.preempt);
    if (v.version !== undefined) row.version = str(v.version);
    if (v.shutdown) row.admin_status = "down";
    put(t, "VRRP", `${v.iface}|${v.vrid}`, row);
  }

  // SNMP (sonic-snmp.yang:90-387)
  const snmp = peekFeatureState<SnmpState>(d, "snmp");
  if (snmp) {
    if (snmp.location !== undefined) put(t, "SNMP", "LOCATION", { Location: snmp.location });
    if (snmp.contact !== undefined) put(t, "SNMP", "CONTACT", { Contact: snmp.contact });
    for (const c of snmp.communities) put(t, "SNMP_COMMUNITY", c.name, { TYPE: c.access.toUpperCase() });
    for (const u of snmp.users) put(t, "SNMP_USER", u.name, { SNMP_USER_TYPE: "Priv", SNMP_USER_PERMISSION: u.permission.toUpperCase() });
    for (const a of snmp.agentAddresses ?? []) put(t, "SNMP_AGENT_ADDRESS_CONFIG", `${a.ip}|${a.port}|${a.vrf}`);
    for (const h of snmp.trapHosts ?? []) {
      const row: Row = { port: str(h.port) };
      if (h.version) row.version = h.version;
      if (h.community) row.community = h.community;
      if (h.user) row.user = h.user;
      if (h.sourceInterface) row.source_interface = h.sourceInterface;
      put(t, "SNMP_TRAP", h.ip, row);
    }
  }

  // LLDP (sonic-lldp.yang:63-193)
  const lldp = peekFeatureState<{ enabled: boolean; timer?: number; multiplier?: number; systemName?: string; systemDescription?: string; interfaces: Record<string, { enabled: boolean }> }>(d, "lldp");
  if (lldp) {
    const g: Row = { enabled: bool(lldp.enabled) };
    if (lldp.timer !== undefined) g.hello_time = str(lldp.timer);
    if (lldp.multiplier !== undefined) g.multiplier = str(lldp.multiplier);
    if (lldp.systemName) g.system_name = lldp.systemName;
    if (lldp.systemDescription) g.system_description = lldp.systemDescription;
    put(t, "LLDP", "GLOBAL", g);
    for (const [p, s] of Object.entries(lldp.interfaces ?? {})) put(t, "LLDP_PORT", p, { enabled: bool(s.enabled) });
  }

  // NTP / DNS (sonic-ntp.yang:99-177, sonic-dns.yang:122-137)
  const ntp = peekFeatureState<{ servers: string[]; sourceInterface?: string; vrf?: string }>(d, "ntp");
  if (ntp) {
    const g: Row = {};
    if (ntp.sourceInterface) g.src_intf = [ntp.sourceInterface];
    if (ntp.vrf) g.vrf = ntp.vrf;
    if (Object.keys(g).length) put(t, "NTP", "global", g);
    for (const s of ntp.servers) put(t, "NTP_SERVER", s, { association_type: "server", iburst: "on" });
  }
  for (const ns of peekFeatureState<{ nameservers: string[] }>(d, "dns")?.nameservers ?? []) put(t, "DNS_NAMESERVER", ns);

  // Features whose rows extend the tables above (VRF vni, PORT trust, INTERFACE nat_zone,
  // STATIC_ROUTE track): ./config-db-features.ts
  projectNd(d, t);
  projectEvpn(d, t);
  projectL2Protect(d, t);
  projectMulticast(d, t);
  projectL3Services(d, t);
  projectQosConfig(d, t);
  projectCoppConfig(d, t);

  // Generic KLISH config-plane stores (cp_banner, cp_logging, ...) are not projected:
  // their keys are KLISH command names, not CONFIG_DB fields.
  return t;
}
