/**
 * Running-config sections for L3 / overlay features (see ./registry.ts):
 * FBS, VRRP, LLDP, link state tracking, BFD, IP SLA, NAT, MCLAG, VXLAN/EVPN-MH,
 * SAG, PIM/IGMP, ECMP load-share.
 *
 * Each renders only what the feature's KLISH module stored, in the syntax that
 * module accepts (so the output replays). Sources:
 *   FBS        sonic_cli_show_config.py show_all_fbs_config (classifier → policy order)
 *   VRRP       actioner/show_config_vrrp.py _vrid_lines/_af_block_lines (:153-217)
 *   LLDP       renderer/templates/show_lldp_config.j2, sonic_cli_interface_common.py get_lldp_interface_map (:393-428)
 *   link track renderer/templates/show_running_config_link_state_track.j2
 *   BFD        renderer/templates/show_bfd_running_config.j2 (peer line/timers), KLISH form
 *              `bfd` → ` peer ...` (data/device-capture/klish-xml/bfd.xml; the simulator's bfd view)
 *   IP SLA / NAT / MCLAG / VXLAN / SAG / load-share   data/device-capture/klish-xml/{ipsla,nat,mclag,vxlan,sag,loadshare}.xml
 *              command syntax (no running-config renderer for them in the source tree)
 *   PIM/IGMP   same rendering as features/pim.ts `show running-configuration pim|igmp`
 */
import { Device } from "../../../models/device";
import { peekFeatureState } from "../../../models/feature-state";
import { cpGet, cpList } from "../config-plane";
import type { FbsState } from "../../sonic/fbs";
import type { VrrpConfig, VrrpInstance, VrrpTrack } from "../../../protocols/vrrp";
import { IPV4_HASH_DEFAULT } from "../../../protocols/loadshare-hash";
import { registerRcSection, isSet } from "./registry";

type Row = Record<string, unknown>;
const s = (v: unknown) => String(v);
const has = (v: unknown) => isSet(v) && v !== "---";

// --- FBS (order 40, before interfaces so service-policy bindings replay) -------
const PROTO_NAME: Record<string, string> = { "6": "tcp", "17": "udp", "1": "icmp" };
function matchLine(field: string, value: string): string {
  switch (field) {
    case "src-ip":
      return `match source-address ip ${value}`;
    case "dst-ip":
      return `match destination-address ip ${value}`;
    case "ip-protocol":
      return `match ip protocol ${PROTO_NAME[value] ?? value}`;
    case "src-port":
    case "dst-port": {
      const dir = field === "src-port" ? "source" : "destination";
      const [a, b] = value.split("-");
      return b ? `match l4-port ${dir} range ${a} ${b}` : `match l4-port ${dir} eq ${a}`;
    }
    default:
      return `match ${field} ${value}`;
  }
}
const ACTION_KW: Record<string, string> = { "set-ip-nexthop": "set ip next-hop", "set-interface": "set interface", "set-dscp": "set dscp", "set-pcp": "set pcp", police: "police" };
const fbsState = (dev: Device) => peekFeatureState<FbsState>(dev, "fbs");

function classMapBlocks(dev: Device): string[][] {
  return (fbsState(dev)?.classifiers ?? []).map((c) => [
    `class-map ${c.name} match-type fields match-all`,
    ...(c.description ? [` description ${c.description}`] : []),
    ...c.matches.map((m) => ` ${matchLine(m.field, m.value)}`),
  ]);
}
function policyMapBlocks(dev: Device): string[][] {
  return (fbsState(dev)?.policies ?? []).map((p) => {
    const out = [`policy-map ${p.name} type ${p.type}`];
    if (p.description) out.push(` description ${p.description}`);
    for (const f of p.flows) {
      out.push(` class ${f.classifier}${f.priority ? ` priority ${f.priority}` : ""}`);
      if (f.description) out.push(`  description ${f.description}`);
      for (const a of f.actions) out.push(`  ${ACTION_KW[a.name] ?? a.name} ${a.detail}`);
    }
    return out;
  });
}
registerRcSection({ id: "class-map", order: 40, keywords: [["class-map"]], global: classMapBlocks });
registerRcSection({
  id: "policy-map",
  order: 41,
  keywords: [["policy-map"]],
  global: policyMapBlocks,
  // ` service-policy type <type> <in|out> <policy>` (show_interface_running_config.j2:481-486)
  iface(dev, name) {
    const st = fbsState(dev);
    return (st?.bindings ?? [])
      .filter((b) => b.iface === name)
      .map((b) => ` service-policy type ${st!.policies.find((p) => p.name === b.policy)?.type ?? "forwarding"} ${b.direction} ${b.policy}`);
  },
  ifOrder: 160,
});

// --- VRRP (per interface, show_config_vrrp.py) ---------------------------------
const trackLines = (t: VrrpTrack[] | undefined) => (t ?? []).map((x) => `  track-interface ${x.iface} weight ${x.weight}`);
function vrrpLines(i: VrrpInstance): string[] {
  const out: string[] = [];
  const shared: string[] = [];
  if (i.priority !== undefined && i.priority !== 100) shared.push(`  priority ${i.priority}`);
  // The simulator's KLISH grammar takes the interval in seconds (sonic/vrrp.ts ADV_S).
  if (i.advInterval !== undefined && i.advInterval !== 1000) shared.push(`  advertisement-interval ${i.advInterval / 1000}`);
  const preempt = i.preempt === false ? ["  no preempt"] : [];
  const v4 = !!i.vip || !!i.track?.length || !i.v6;
  if (v4) {
    out.push(` vrrp ${i.vrid} address-family ipv4`, ...shared);
    if (i.version !== undefined && i.version !== 3) out.push(`  version ${i.version}`);
    out.push(...preempt);
    if (i.shutdown) out.push("  shutdown");
    if (i.vip) out.push(`  vip ${i.vip}`);
    out.push(...trackLines(i.track), "  exit");
  }
  if (i.v6) {
    out.push(` vrrp ${i.vrid} address-family ipv6`, ...shared, ...preempt);
    for (const v of i.vips6 ?? []) out.push(`  vip ${v}`);
    out.push(...trackLines(i.track6), "  exit");
  }
  return out;
}
registerRcSection({
  id: "vrrp",
  order: 45,
  keywords: [["vrrp"]],
  iface(dev, name) {
    const insts = peekFeatureState<VrrpConfig>(dev, "vrrp")?.instances ?? [];
    return insts
      .filter((i) => i.iface === name)
      .sort((a, b) => a.vrid - b.vrid)
      .flatMap(vrrpLines);
  },
  ifOrder: 100,
});

// --- LLDP (show_lldp_config.j2; per-interface via get_lldp_interface_map) ------
interface LldpPort {
  enabled: boolean;
  transmit: boolean;
  receive: boolean;
  networkPolicy?: number;
}
interface LldpState {
  enabled: boolean;
  transmit: boolean;
  receive: boolean;
  timer?: number;
  multiplier?: number;
  systemName?: string;
  systemDescription?: string;
  interfaces: Record<string, LldpPort>;
}
registerRcSection({
  id: "lldp",
  order: 110,
  keywords: [["lldp"]],
  global(dev) {
    const st = peekFeatureState<LldpState>(dev, "lldp");
    if (!st) return [];
    // LLDP is on by default; the state record exists once anything was configured.
    const out = [st.enabled ? "lldp enable" : "no lldp enable"];
    if (!st.receive) out.push("no lldp receive");
    if (!st.transmit) out.push("no lldp transmit");
    if (st.timer !== undefined) out.push(`lldp timer ${st.timer}`);
    if (st.multiplier !== undefined) out.push(`lldp multiplier ${st.multiplier}`);
    if (st.systemName) out.push(`lldp system-name ${st.systemName}`);
    if (st.systemDescription) out.push(`lldp system-description ${st.systemDescription}`);
    return [out];
  },
  iface(dev, name) {
    const p = peekFeatureState<LldpState>(dev, "lldp")?.interfaces?.[name];
    if (!p) return [];
    const out: string[] = [];
    if (!p.enabled) out.push(" no lldp enable");
    if (!p.receive) out.push(" no lldp receive");
    if (!p.transmit) out.push(" no lldp transmit");
    if (p.networkPolicy !== undefined) out.push(` network-policy ${p.networkPolicy}`);
    return out;
  },
  ifOrder: 110,
});

// --- link state tracking --------------------------------------------------------
interface LstGroup {
  name: string;
  description?: string;
  timeout?: number;
  downstream?: string;
  thresholdType?: string;
  thresholdUp?: number;
  thresholdDown?: number;
  upstreamIfs?: string[];
  downstreamIfs?: string[];
}
const lstGroups = (dev: Device) => cpList(dev, "link_track", "groups") as unknown as LstGroup[];
registerRcSection({
  id: "link-track",
  order: 115,
  keywords: [["link", "state", "tracking"], ["link", "state"], ["link"]],
  global(dev) {
    return lstGroups(dev).map((g) => {
      const out = [`link state track ${g.name}`];
      if (g.description) out.push(` description ${g.description}`);
      if (g.timeout !== undefined) out.push(` timeout ${g.timeout}`);
      if (g.downstream) out.push(` downstream ${g.downstream}`);
      const th = [g.thresholdType ? `type ${g.thresholdType}` : "", g.thresholdUp !== undefined ? `up ${g.thresholdUp}` : "", g.thresholdDown !== undefined ? `down ${g.thresholdDown}` : ""].filter(Boolean);
      if (th.length) out.push(` threshold ${th.join(" ")}`);
      return out;
    });
  },
  // ` link state track <group> <upstream|downstream>` (show_interface_running_config.j2:427-433)
  iface(dev, name) {
    const out: string[] = [];
    for (const g of lstGroups(dev)) {
      if (g.upstreamIfs?.includes(name)) out.push(` link state track ${g.name} upstream`);
      if (g.downstreamIfs?.includes(name)) out.push(` link state track ${g.name} downstream`);
    }
    return out;
  },
  ifOrder: 140,
});

// --- BFD (show_bfd_running_config.j2) -----------------------------------------
interface BfdPeer {
  peer: string;
  local?: string;
  interface?: string;
  multihop?: boolean;
  rxInterval?: number;
  txInterval?: number;
  multiplier?: number;
  shutdown?: boolean;
  echoMode?: boolean;
  echoInterval?: number;
}
registerRcSection({
  id: "bfd",
  order: 120,
  keywords: [["bfd"]],
  global(dev) {
    const peers = peekFeatureState<{ peers: BfdPeer[] }>(dev, "bfd")?.peers ?? [];
    if (!peers.length) return [];
    const out = ["bfd"];
    for (const p of peers) {
      out.push(` peer ${p.peer}${p.multihop ? " multihop" : ""}${p.interface ? ` interface ${p.interface}` : ""}${p.local ? ` local-address ${p.local}` : ""}`);
      if (p.shutdown) out.push("  shutdown");
      if (p.multiplier !== undefined) out.push(`  detect-multiplier ${p.multiplier}`);
      if (p.txInterval !== undefined) out.push(`  transmit-interval ${p.txInterval}`);
      if (p.rxInterval !== undefined) out.push(`  receive-interval ${p.rxInterval}`);
      if (p.echoInterval !== undefined) out.push(`  echo-interval ${p.echoInterval}`);
      if (p.echoMode) out.push("  echo-mode");
    }
    return [out];
  },
});

// --- IP SLA (order 135: before the tracked static routes at 140) ---------------
const SLA_ICMP: [string, string][] = [["icmp_src_ip", "source-address"], ["icmp_src_if", "source-interface"], ["icmp_size", "request-data-size"], ["icmp_ttl", "ttl"], ["icmp_tos", "tos"], ["icmp_vrf", "source-vrf"]];
const SLA_TCP: [string, string][] = [["tcp_src_ip", "source-address"], ["tcp_src_port", "source-port"], ["tcp_src_if", "source-interface"], ["tcp_ttl", "ttl"], ["tcp_tos", "tos"], ["tcp_vrf", "source-vrf"]];
registerRcSection({
  id: "ipsla",
  order: 135,
  keywords: [["ip", "sla"]],
  global(dev) {
    return [...cpList(dev, "ipsla", "instances")]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((i: Row) => {
        const out = [`ip sla ${s(i.id)}`];
        for (const k of ["frequency", "threshold", "timeout"]) if (has(i[k])) out.push(` ${k} ${s(i[k])}`);
        if (has(i.icmp_dst)) {
          out.push(` icmp-echo ${s(i.icmp_dst)}`);
          for (const [f, kw] of SLA_ICMP) if (has(i[f])) out.push(`  ${kw} ${s(i[f])}`);
        }
        if (has(i.tcp_dst)) {
          out.push(` tcp-connect ${s(i.tcp_dst)} port ${s(i.tcp_dst_port)}`);
          for (const [f, kw] of SLA_TCP) if (has(i[f])) out.push(`  ${kw} ${s(i[f])}`);
        }
        return out;
      });
  },
});

// --- NAT (nat.xml: `nat` sub-mode; interface `nat-zone`) -----------------------
const natSuffix = (r: Row) => `${has(r.nat_type) ? ` ${s(r.nat_type)}` : ""}${has(r.twice_nat_id) ? ` twice-nat-id ${s(r.twice_nat_id)}` : ""}`;
registerRcSection({
  id: "nat",
  order: 170,
  keywords: [["nat"]],
  global(dev) {
    const st = cpGet(dev, "nat");
    if (!st) return [];
    const body: string[] = [];
    if (st.admin_mode === "enabled") body.push(" enable");
    if (has(st.nat_timeout)) body.push(` timeout ${s(st.nat_timeout)}`);
    if (has(st.nat_tcp_timeout)) body.push(` tcp-timeout ${s(st.nat_tcp_timeout)}`);
    if (has(st.nat_udp_timeout)) body.push(` udp-timeout ${s(st.nat_udp_timeout)}`);
    for (const p of cpList(dev, "nat", "pools")) body.push(` pool ${s(p.pool_name)} ${s(p.nat_ip)}${has(p.nat_port) ? ` ${s(p.nat_port)}` : ""}`);
    for (const b of cpList(dev, "nat", "bindings")) body.push(` binding ${s(b.name)} ${s(b.nat_pool)}${has(b.access_list) ? ` ${s(b.access_list)}` : ""}${natSuffix(b)}`);
    for (const r of cpList(dev, "nat", "statics")) {
      if (r.ip_protocol === "all") body.push(` static basic ${s(r.global_ip)} ${s(r.local_ip)}${natSuffix(r)}`);
      else body.push(` static ${s(r.ip_protocol)} ${s(r.global_ip)} ${s(r.global_port)} ${s(r.local_ip)} ${s(r.local_port)}${natSuffix(r)}`);
    }
    return body.length ? [["nat", ...body]] : [];
  },
  iface(dev, name) {
    const z = cpList(dev, "nat", "zones").find((r) => r.port === name);
    return z ? [` nat-zone ${s(z.zone)}`] : [];
  },
  ifOrder: 170,
});

// --- MCLAG (mclag.xml) ---------------------------------------------------------
const MCLAG_FIELDS: [string, string][] = [
  ["source_ip", "source-ip"],
  ["peer_ip", "peer-ip"],
  ["peer_link", "peer-link"],
  ["keepalive_interval", "keepalive-interval"],
  ["session_timeout", "session-timeout"],
  ["delay_restore", "delay-restore"],
  ["mclag_system_mac", "mclag-system-mac"],
  ["session_vrf", "session-vrf"],
];
const MCLAG_BK: [string, string][] = [
  ["backup_keepalive_source_ip", "source-ip"],
  ["backup_keepalive_peer_ip", "peer-ip"],
  ["backup_keepalive_interval", "interval"],
  ["backup_keepalive_session_vrf", "session-vrf"],
];
registerRcSection({
  id: "mclag",
  order: 175,
  keywords: [["mclag"]],
  global(dev) {
    const blocks: string[][] = [];
    const gw = cpGet(dev, "mclag")?.gateway_mac;
    if (has(gw)) blocks.push([`mclag gateway-mac ${s(gw)}`]);
    for (const d of cpList(dev, "mclag", "domains")) {
      const out = [`mclag domain ${s(d.domain_id)}`];
      for (const [f, kw] of MCLAG_FIELDS) if (has(d[f])) out.push(` ${kw} ${s(d[f])}`);
      if (d.fast_convergence === "enable") out.push(" fast-convergence");
      for (const [f, kw] of MCLAG_BK) if (has(d[f])) out.push(` backup-keepalive ${kw} ${s(d[f])}`);
      blocks.push(out);
    }
    return blocks;
  },
  // PortChannel ` mclag <domain>` (MCLAG_INTERFACE, interface.xml:1436-1443)
  iface(dev, name) {
    return cpList(dev, "mclag", "interfaces")
      .filter((r) => r.if_name === name)
      .map((r) => ` mclag ${s(r.domain_id)}`);
  },
  ifOrder: 150,
});

// --- VXLAN (vxlan.xml: `interface vxlan <name>`) + EVPN multihoming -------------
registerRcSection({
  id: "vxlan",
  order: 180,
  keywords: [["interface", "vxlan"]],
  global(dev) {
    const vteps = cpList(dev, "vxlan", "vteps");
    return vteps.map((v, n) => {
      const out = [`interface vxlan ${s(v.name)}`];
      if (has(v.source_ip)) out.push(` source-ip ${s(v.source_ip)}`);
      if (has(v.primary_ip)) out.push(` primary-ip ${s(v.primary_ip)}`);
      if (has(v.external_ip)) out.push(` external-ip ${s(v.external_ip)}`);
      if (has(v.qos_mode)) out.push(` qos-mode ${s(v.qos_mode)}${v.qos_mode === "pipe" && has(v.dscp) ? ` dscp ${s(v.dscp)}` : ""}`);
      const maps = cpList(dev, "vxlan", "vlanmap")
        .filter((m) => m.vtep === v.name)
        .sort((a, b) => Number(a.vni) - Number(b.vni));
      for (const m of maps) out.push(` map vni ${s(m.vni)} vlan ${s(m.vlan).replace(/^Vlan/, "")}`);
      // VRF-VNI maps are not keyed by VTEP in the store: render them under the first one.
      if (n === 0) for (const m of cpList(dev, "vxlan", "vrfmap")) out.push(` map vni ${s(m.vni)} vrf ${s(m.vrf)}`);
      return out;
    });
  },
  // SVI ` neigh-suppress` (interface.xml:1142)
  iface(dev, name) {
    return cpList(dev, "vxlan", "suppress").some((r) => r.name === name && r.suppress === "on") ? [" neigh-suppress"] : [];
  },
  ifOrder: 185,
});

const EVPN_MH_FIELDS = ["startup-delay", "mac-holdtime", "neigh-holdtime", "df-election-time", "es-activation-delay"];
registerRcSection({
  id: "evpn-mh",
  order: 181,
  global(dev) {
    const st = cpGet(dev, "evpn_mh");
    if (!st?._present) return [];
    return [["evpn esi-multihoming", ...EVPN_MH_FIELDS.filter((f) => has(st[f])).map((f) => ` ${f} ${s(st[f])}`)]];
  },
  // PortChannel ` evpn ethernet-segment <esi>` + ES sub-mode (interface.xml:1480-1530)
  iface(dev, name) {
    const es = cpList(dev, "evpn_mh", "es").find((e) => e.ifname === name);
    if (!es) return [];
    return [` evpn ethernet-segment ${s(es.esi)}`, ...(has(es.df_pref) ? [`  df-preference ${s(es.df_pref)}`] : [])];
  },
  ifOrder: 155,
});

// --- SAG (sag.xml) ---------------------------------------------------------------
registerRcSection({
  id: "sag",
  order: 185,
  global(dev) {
    const st = cpGet(dev, "sag");
    if (!st) return [];
    const out: string[] = [];
    if (has(st.gwmac)) out.push(`ip anycast-mac-address ${s(st.gwmac)}`);
    if (st["rmac-forwarding"] === "enable") out.push("ip anycast-mac-address router-mac-for-forwarding");
    if (has(st["ipv4-enable"])) out.push(`ip anycast-address ${s(st["ipv4-enable"])}`);
    if (has(st["ipv6-enable"])) out.push(`ipv6 anycast-address ${s(st["ipv6-enable"])}`);
    return out.length ? [out] : [];
  },
  iface(dev, name) {
    return cpList(dev, "sag", "gateways")
      .filter((g) => g.iface === name)
      .map((g) => ` ${g.family === "IPv6" ? "ipv6" : "ip"} anycast-address ${s(g.addr)}`);
  },
  ifOrder: 180,
});

// --- PIM / IGMP (as features/pim.ts show running-configuration pim|igmp) ---------
registerRcSection({
  id: "pim",
  order: 200,
  global(dev) {
    const globals = cpList(dev, "pim", "globals");
    const rps = cpList(dev, "pim", "rps");
    const out: string[] = [];
    const vrfs = [...new Set([...globals.map((g) => s(g.vrf)), ...rps.map((r) => s(r.vrf))])];
    for (const vrf of vrfs) {
      const v = vrf === "default" ? "" : ` vrf ${vrf}`;
      const g = globals.find((x) => x.vrf === vrf);
      if (g) {
        if (g.ecmpRebalance) out.push(`ip pim${v} ecmp rebalance`);
        else if (g.ecmp) out.push(`ip pim${v} ecmp`);
        if (g.joinPruneInterval !== undefined) out.push(`ip pim${v} join-prune-interval ${s(g.joinPruneInterval)}`);
        if (g.keepAliveTimer !== undefined) out.push(`ip pim${v} keep-alive-timer ${s(g.keepAliveTimer)}`);
        if (g.ssmPrefixList) out.push(`ip pim${v} ssm prefix-list ${s(g.ssmPrefixList)}`);
        if (g.sptInfinity) out.push(`ip pim${v} spt-threshold infinity${g.sptPrefixList ? ` prefix-list ${s(g.sptPrefixList)}` : ""}`);
      }
      for (const r of rps.filter((x) => x.vrf === vrf)) out.push(`ip pim${v} rp-address ${s(r.rp)}${r.prefixList ? ` prefix-list ${s(r.prefixList)}` : ""}`);
    }
    return out.length ? [out] : [];
  },
  iface(dev, name) {
    const out: string[] = [];
    const p = cpList(dev, "pim", "interfaces").find((i) => i.iface === name);
    if (p) {
      if (p.sparseMode) out.push(" ip pim sparse-mode");
      if (p.drPriority !== undefined) out.push(` ip pim drpriority ${s(p.drPriority)}`);
      if (p.helloInterval !== undefined) out.push(` ip pim hello ${s(p.helloInterval)}`);
      if (p.bfd) out.push(` ip pim bfd${p.bfdProfile ? ` profile ${s(p.bfdProfile)}` : ""}`);
    }
    const g = cpList(dev, "igmp", "interfaces").find((i) => i.iface === name);
    if (g) {
      if (g.enabled) out.push(" ip igmp");
      if (g.version !== undefined) out.push(` ip igmp version ${s(g.version)}`);
      if (g.queryInterval !== undefined) out.push(` ip igmp query-interval ${s(g.queryInterval)}`);
      if (g.queryMaxResponseTime !== undefined) out.push(` ip igmp query-max-response-time ${s(g.queryMaxResponseTime)}`);
      if (g.lastMemberQueryCount !== undefined) out.push(` ip igmp last-member-query-count ${s(g.lastMemberQueryCount)}`);
      if (g.lastMemberQueryInterval !== undefined) out.push(` ip igmp last-member-query-interval ${s(g.lastMemberQueryInterval)}`);
    }
    return out;
  },
  ifOrder: 175,
});

// --- ECMP load-share (loadshare.xml) --------------------------------------------
const IPV6_HASH_DEFAULT = ["ipv6-src-ip", "ipv6-dst-ip", "ipv6-next-hdr", "ipv6-l4-src-port", "ipv6-l4-dst-port"];
registerRcSection({
  id: "loadshare",
  order: 190,
  global(dev) {
    const st = cpGet(dev, "loadshare");
    if (!st) return [];
    const out: string[] = [];
    if (has(st.seed)) out.push(`ip load-share hash seed ${s(st.seed)}`);
    if (has(st.offset)) out.push(`ip load-share hash offset ${s(st.offset)}`);
    if (has(st.algorithm)) out.push(`ip load-share hash algorithm ${s(st.algorithm)}`);
    if (has(st.roce)) out.push("ip load-share hash roce qpn");
    if (has(st["ingress-port"])) out.push("ip load-share hash ingress-port");
    // Field lists start from the default set; render the difference from it.
    for (const [fam, dflt] of [["ipv4", IPV4_HASH_DEFAULT], ["ipv6", IPV6_HASH_DEFAULT]] as const) {
      const list = st[fam] as { field: string }[] | undefined;
      if (!list) continue;
      const cur = list.map((f) => f.field);
      for (const f of dflt) if (!cur.includes(f)) out.push(`no ip load-share hash ${fam} ${f}`);
      for (const f of cur) if (!(dflt as readonly string[]).includes(f)) out.push(`ip load-share hash ${fam} ${f}`);
    }
    return out.length ? [out] : [];
  },
});
