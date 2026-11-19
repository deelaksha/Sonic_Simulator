/** CONFIG_DB / APPL_DB / STATE_DB projection of the round-12 feature labs, read through sonic-db-cli. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { cliModeFor } from "../lib/commands/sonic-cli";
import { savedFile } from "../lib/sonicdb/persist";

/** Run a Click/Linux command (switches start in KLISH: `exit` first). */
function run(dev: string, cmd: string): string {
  const id = byName(dev).id;
  for (let i = 0; i < 4 && cliModeFor(S().network.devices[id], S().cliMode[id]).length > 0; i++) S().execCommand(id, "exit");
  return out(S().execCommand(id, cmd));
}
const klish = (dev: string, lines: string[]) => S().runCliScript(byName(dev).id, ["configure terminal", ...lines, "end"]);

/** `sonic-db-cli <DB> hgetall <key>` parsed back from its python-dict output. */
function hgetall(dev: string, db: string, key: string): Record<string, string> {
  const txt = run(dev, `sonic-db-cli ${db} hgetall "${key}"`);
  return Object.fromEntries([...txt.matchAll(/'([^']*)': '([^']*)'/g)].map((m) => [m[1], m[2]]));
}
const keys = (dev: string, db: string, pattern: string) => run(dev, `sonic-db-cli ${db} keys "${pattern}"`).split("\n").filter(Boolean);
const lab = (id: string, ms = 30_000) => {
  S().loadFeatureLab(id);
  advance(ms, 500);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("round-12 feature labs in the SONiC DBs", () => {
  it("ospf-areas: OSPFV2_ROUTER log-adjacency-changes, stub / nssa areas, area range, redistribute", () => {
    lab("ospf-areas");
    expect(hgetall("S1", "CONFIG_DB", "OSPFV2_ROUTER|default")).toEqual({ enable: "true", "router-id": "1.1.1.1", "log-adjacency-changes": "brief" });
    expect(hgetall("S1", "CONFIG_DB", "OSPFV2_ROUTER_AREA|default|0.0.0.1")).toEqual({ stub: "true" });
    expect(hgetall("S2", "CONFIG_DB", "OSPFV2_ROUTER_AREA_POLICY_ADDRESS_RANGE|default|0.0.0.1|10.1.0.0/16")).toEqual({ enable: "true", advertise: "true" });
    expect(hgetall("S3", "CONFIG_DB", "OSPFV2_ROUTER_AREA|default|0.0.0.2")).toEqual({ nssa: "true" });
    expect(keys("S4", "CONFIG_DB", "OSPFV2_ROUTER_DISTRIBUTE_ROUTE|*")).toEqual(["OSPFV2_ROUTER_DISTRIBUTE_ROUTE|default|DIRECTLY_CONNECTED|IMPORT"]);
    expect(hgetall("S1", "CONFIG_DB", "OSPFV2_INTERFACE|Ethernet0|10.1.12.1")).toEqual({ "network-type": "POINT_TO_POINT_NETWORK" });

    klish("S1", ["router ospf", "area 0.0.0.1 stub no-summary", "area 0.0.0.1 default-cost 20", "area 0.0.0.1 range 10.1.0.0/16 not-advertise"]);
    expect(hgetall("S1", "CONFIG_DB", "OSPFV2_ROUTER_AREA|default|0.0.0.1")).toEqual({ "stub-no-summary": "true", "stub-default-cost": "20" });
    expect(hgetall("S1", "CONFIG_DB", "OSPFV2_ROUTER_AREA_POLICY_ADDRESS_RANGE|default|0.0.0.1|10.1.0.0/16")).toEqual({ enable: "true", advertise: "false" });
  });

  it("bgp-policy: ROUTE_MAP, PREFIX_SET/PREFIX, COMMUNITY_SET, AS_PATH_SET, neighbor AF bindings, ROUTE_REDISTRIBUTE", () => {
    lab("bgp-policy", 10_000);
    klish("E1", [
      "route-map PREFER-B permit 10", "set local-preference 200", "exit",
      "route-map PREPEND-A permit 10", "match ip address prefix-list ONLY-LAN", "set as-path prepend 65001 65001", "set community 65001:100 additive", "exit",
      "ip prefix-list ONLY-LAN seq 5 permit 192.168.1.0/24",
      "ip prefix-list FROM-ISP seq 5 permit 192.168.0.0/16 le 24",
      "bgp community-list standard FROM-E1 permit 65001:100",
      "bgp as-path-list A1 seq 10 permit ^65002$",
      "router bgp 65001", "neighbor 10.0.13.2", "address-family ipv4 unicast", "route-map PREFER-B in", "prefix-list FROM-ISP in", "exit", "exit",
      "neighbor 10.0.12.2", "address-family ipv4 unicast", "route-map PREPEND-A out",
    ]);
    expect(hgetall("E1", "CONFIG_DB", "ROUTE_MAP|PREFER-B|10")).toEqual({ route_operation: "permit", set_local_pref: "200" });
    expect(hgetall("E1", "CONFIG_DB", "ROUTE_MAP|PREPEND-A|10")).toEqual({ route_operation: "permit", match_prefix_set: "ONLY-LAN", set_asn_list: "65001,65001", "set_community_inline@": "65001:100,additive" });
    expect(hgetall("E1", "CONFIG_DB", "PREFIX_SET|FROM-ISP")).toEqual({ mode: "IPv4" });
    expect(hgetall("E1", "CONFIG_DB", "PREFIX|FROM-ISP|5|192.168.0.0/16|16..24")).toEqual({ action: "permit" });
    expect(keys("E1", "CONFIG_DB", "PREFIX|ONLY-LAN|*")).toEqual(["PREFIX|ONLY-LAN|5|192.168.1.0/24|exact"]);
    expect(hgetall("E1", "CONFIG_DB", "COMMUNITY_SET|FROM-E1")).toEqual({ set_type: "STANDARD", match_action: "ALL", action: "permit", "community_member@": "65001:100" });
    expect(hgetall("E1", "CONFIG_DB", "AS_PATH_SET|A1")).toEqual({ action: "permit", "as_path_set_member@": "^65002$" });
    expect(hgetall("E1", "CONFIG_DB", "BGP_NEIGHBOR_AF|default|10.0.13.2|ipv4_unicast")).toEqual({ admin_status: "true", "route_map_in@": "PREFER-B", prefix_list_in: "FROM-ISP" });
    expect(hgetall("E1", "CONFIG_DB", "BGP_NEIGHBOR_AF|default|10.0.12.2|ipv4_unicast")).toEqual({ admin_status: "true", "route_map_out@": "PREPEND-A" });
    expect(run("E1", "sonic-db-cli CONFIG_DB exists ROUTE_REDISTRIBUTE|default|connected|bgp|ipv4")).toBe("1");
    // and in show runningconfiguration all
    const json = JSON.parse(run("E1", "show runningconfiguration all"));
    expect(json.ROUTE_MAP["PREFER-B|10"]).toEqual({ route_operation: "permit", set_local_pref: "200" });
  });

  it("evpn-irb: VRF vni, L3VNI tunnel map, SAG / SAG_GLOBAL, SUPPRESS_VLAN_NEIGH, per-VRF BGP_GLOBALS", () => {
    lab("evpn-irb");
    expect(hgetall("LEAF1", "CONFIG_DB", "VRF|Vrf-red")).toEqual({ vni: "50000" });
    expect(hgetall("LEAF1", "CONFIG_DB", "VXLAN_TUNNEL_MAP|vtep1|map_50000_Vlan500")).toEqual({ vlan: "Vlan500", vni: "50000" });
    expect(hgetall("LEAF1", "CONFIG_DB", "SAG_GLOBAL|IP")).toEqual({ gwmac: "00:00:5e:00:01:01" });
    expect(hgetall("LEAF1", "CONFIG_DB", "SAG|Vlan10|IPv4")).toEqual({ "gwip@": "10.1.0.1/24" });
    expect(hgetall("LEAF1", "CONFIG_DB", "SUPPRESS_VLAN_NEIGH|Vlan10")).toEqual({ suppress: "on" });
    expect(hgetall("LEAF1", "APPL_DB", "SUPPRESS_VLAN_NEIGH_TABLE:Vlan10")).toEqual({ suppress: "on" });
    expect(hgetall("LEAF1", "CONFIG_DB", "BGP_GLOBALS|Vrf-red")).toEqual({ local_asn: "65001" });
    expect(hgetall("LEAF1", "CONFIG_DB", "BGP_GLOBALS_AF|Vrf-red|l2vpn_evpn")).toEqual({ "advertise-ipv4-unicast": "true" });
    expect(hgetall("LEAF1", "CONFIG_DB", "BGP_GLOBALS_AF|default|l2vpn_evpn")).toEqual({ "advertise-all-vni": "true" });
  });

  it("l2-protect: MIRROR_SESSION (+STATE status), PORT_STORM_CONTROL, DHCP trust, UDLD, ERRDISABLE, LINK_STATE_TRACKING", () => {
    lab("l2-protect");
    expect(hgetall("SW1", "CONFIG_DB", "MIRROR_SESSION|SPAN1")).toEqual({ type: "SPAN", dst_port: "Ethernet4", src_port: "Ethernet0", direction: "BOTH" });
    expect(hgetall("SW1", "STATE_DB", "MIRROR_SESSION_TABLE|SPAN1")).toEqual({ status: "active" });
    expect(hgetall("SW1", "CONFIG_DB", "PORT_STORM_CONTROL|Ethernet3|broadcast")).toEqual({ kbps: "100" });
    expect(hgetall("SW1", "CONFIG_DB", "PORT|Ethernet2")).toMatchObject({ dhcpv4_snooping_trust: "enable" });
    expect(hgetall("SW1", "CONFIG_DB", "PORT|Ethernet0").dhcpv4_snooping_trust).toBeUndefined();
    expect(run("SW1", "sonic-db-cli CONFIG_DB exists UDLD|GLOBAL")).toBe("1");
    expect(hgetall("SW1", "CONFIG_DB", "UDLD_PORT|Ethernet5")).toEqual({ admin_enable: "true" });
    expect(hgetall("SW1", "CONFIG_DB", "ERRDISABLE|RECOVERY")).toEqual({ interval: "30" });
    expect(hgetall("SW1", "CONFIG_DB", "LINK_STATE_TRACKING|UPLINK")).toEqual({ timeout: "10" });
    expect(hgetall("SW1", "CONFIG_DB", "LINK_STATE_TRACKING_MEMBER|Ethernet5")).toEqual({ group: "UPLINK", role: "upstream" });
    expect(hgetall("SW1", "CONFIG_DB", "LINK_STATE_TRACKING_MEMBER|Ethernet0")).toEqual({ group: "UPLINK", role: "downstream" });

    klish("SW1", ["mirror-session ER1", "destination erspan dst-ip 10.9.9.9 src-ip 10.9.9.1 dscp 10 ttl 64 gre 0x88ee source Ethernet1 direction rx"]);
    expect(hgetall("SW1", "CONFIG_DB", "MIRROR_SESSION|ER1")).toMatchObject({ type: "ERSPAN", src_ip: "10.9.9.1", dst_ip: "10.9.9.9", dscp: "10", ttl: "64", gre_type: "0x88ee", src_port: "Ethernet1", direction: "RX" });
    expect(hgetall("SW1", "STATE_DB", "MIRROR_SESSION_TABLE|ER1")).toEqual({ status: "inactive" }); // no route to 10.9.9.9
  });

  it("multicast: CFG_L2MC_TABLE, PIM_GLOBALS_RENDEZVOUS_POINT, PIM_INTERFACE, IGMP_INTERFACE_QUERY, APPL L2MC members", () => {
    lab("multicast");
    expect(hgetall("S3", "CONFIG_DB", "CFG_L2MC_TABLE|Vlan30")).toEqual({ enabled: "true" });
    expect(run("S3", "sonic-db-cli CONFIG_DB exists PIM_GLOBALS_RENDEZVOUS_POINT|default|ipv4|2.2.2.2")).toBe("1");
    expect(hgetall("S3", "CONFIG_DB", "PIM_INTERFACE|default|ipv4|Vlan30")).toEqual({ mode: "sm" });
    expect(hgetall("S3", "CONFIG_DB", "IGMP_INTERFACE_QUERY|Vlan30")).toEqual({ enabled: "true", version: "2" });

    klish("S3", ["interface Vlan 30", "ip igmp snooping querier", "ip igmp snooping mrouter interface Ethernet2", "ip igmp snooping static-group 239.9.9.9 interface Ethernet3", "exit", "ip pim join-prune-interval 90"]);
    expect(hgetall("S3", "CONFIG_DB", "CFG_L2MC_TABLE|Vlan30")).toEqual({ enabled: "true", querier: "true" });
    expect(run("S3", "sonic-db-cli CONFIG_DB exists CFG_L2MC_MROUTER_TABLE|Vlan30|Ethernet2 CFG_L2MC_STATIC_MEMBER_TABLE|Vlan30|239.9.9.9|Ethernet3")).toBe("2");
    expect(hgetall("S3", "CONFIG_DB", "PIM_GLOBALS|default|ipv4")).toEqual({ "join-prune-interval": "90" });
    expect(keys("S3", "APPL_DB", "APP_L2MC_MEMBER_TABLE:*")).toContain("APP_L2MC_MEMBER_TABLE:Vlan30:239.9.9.9:0.0.0.0:Ethernet3");
    expect(keys("S3", "APPL_DB", "APP_L2MC_MROUTER_TABLE:*")).toContain("APP_L2MC_MROUTER_TABLE:Vlan30:Ethernet2");
  });

  it("l3-services: NAT tables + APPL NAPT_TABLE, FBS tables, IP_SLA + tracked STATIC_ROUTE, ECMP load-share", () => {
    lab("l3-services");
    expect(hgetall("S1", "CONFIG_DB", "NAT_GLOBAL|Values")).toEqual({ admin_mode: "enabled" });
    expect(hgetall("S1", "CONFIG_DB", "NAT_POOL|INET")).toEqual({ nat_ip: "100.64.0.1", nat_port: "20000-29999" });
    expect(hgetall("S1", "CONFIG_DB", "NAT_BINDINGS|LAN")).toEqual({ nat_pool: "INET" });
    expect(hgetall("S1", "CONFIG_DB", "STATIC_NAPT|100.64.0.1|TCP|8080")).toEqual({ local_ip: "192.168.1.10", local_port: "80" });
    expect(hgetall("S1", "CONFIG_DB", "INTERFACE|Ethernet0")).toEqual({ nat_zone: "1" });
    expect(hgetall("S1", "APPL_DB", "NAPT_TABLE:TCP:100.64.0.1:8080")).toEqual({ translated_ip: "192.168.1.10", nat_type: "dnat", entry_type: "static", translated_l4_port: "80" });
    expect(hgetall("S1", "APPL_DB", "NAPT_TABLE:TCP:192.168.1.10:80")).toMatchObject({ translated_ip: "100.64.0.1", nat_type: "snat", translated_l4_port: "8080" });

    expect(hgetall("S1", "CONFIG_DB", "CLASSIFIER_TABLE|LAN2")).toEqual({ MATCH_TYPE: "FIELDS", SRC_IP: "192.168.2.0/24" });
    expect(hgetall("S1", "CONFIG_DB", "POLICY_TABLE|PBR-LAN2")).toEqual({ TYPE: "FORWARDING" });
    expect(hgetall("S1", "CONFIG_DB", "POLICY_SECTIONS_TABLE|PBR-LAN2|LAN2")).toEqual({ PRIORITY: "10", "SET_IP_NEXTHOP@": "10.0.13.2||10" });
    expect(hgetall("S1", "CONFIG_DB", "POLICY_BINDING_TABLE|Ethernet3")).toEqual({ INGRESS_FORWARDING_POLICY: "PBR-LAN2" });

    expect(hgetall("S1", "CONFIG_DB", "IP_SLA|1")).toEqual({ frequency: "5", threshold: "2", timeout: "2", icmp_dst_ip: "10.0.12.2" });
    // floating backup (distance 200) + the SLA-tracked primary: per-nexthop lists
    expect(hgetall("S1", "CONFIG_DB", "STATIC_ROUTE|0.0.0.0/0")).toEqual({ nexthop: "10.0.13.2,10.0.12.2", ifname: "Ethernet1,Ethernet0", distance: "200,0", blackhole: "false,false", track: "0,1" });

    klish("S1", ["ip load-share hash seed 10", "ip load-share hash ipv4 ipv4-src-ip"]);
    expect(hgetall("S1", "CONFIG_DB", "ECMP_LOADSHARE_TABLE_SEED|hash")).toEqual({ ecmp_hash_seed: "10" });
    expect(hgetall("S1", "CONFIG_DB", "ECMP_LOADSHARE_TABLE_IPV4|ipv4")).toMatchObject({ ipv4_src_ip: "true" });
  });

  it("ipvx: ND_CFG_MSG from `ipv6 nd` interface config", () => {
    lab("ipvx");
    expect(hgetall("S1", "CONFIG_DB", "ND_CFG_MSG|Ethernet0")).toEqual({ suppress_ra: "true" });
    klish("S1", ["interface Ethernet 2", "ipv6 nd ra-interval 30", "ipv6 nd managed-config-flag"]);
    expect(hgetall("S1", "CONFIG_DB", "ND_CFG_MSG|Ethernet2")).toMatchObject({ ra_interval: "30", managed_config_flag: "true" });
  });
});

describe("config save / reload with the round-12 features", () => {
  it("NAT + IP SLA config survives save → drift → reload; runtime stores are never saved", () => {
    lab("l3-services");
    expect(run("S1", "config save -y")).toContain("config_db.json");
    const saved = savedFile(byName("S1"))!;
    expect(Object.keys(saved.features)).toEqual(expect.arrayContaining(["cp_nat", "cp_ipsla", "ipsla_routes", "fbs"]));
    for (const k of ["_nat", "_ipsla", "counters"]) expect(saved.features[k]).toBeUndefined();
    expect(JSON.parse(saved.json).STATIC_NAPT).toEqual({ "100.64.0.1|TCP|8080": { local_ip: "192.168.1.10", local_port: "80" } });

    klish("S1", ["nat", "no static all", "no pool INET", "exit", "no ip sla 1"]);
    expect(run("S1", "sonic-db-cli CONFIG_DB exists STATIC_NAPT|100.64.0.1|TCP|8080 NAT_POOL|INET IP_SLA|1")).toBe("0");

    run("S1", "config reload -y");
    expect(hgetall("S1", "CONFIG_DB", "STATIC_NAPT|100.64.0.1|TCP|8080")).toEqual({ local_ip: "192.168.1.10", local_port: "80" });
    expect(hgetall("S1", "CONFIG_DB", "NAT_POOL|INET")).toEqual({ nat_ip: "100.64.0.1", nat_port: "20000-29999" });
    expect(hgetall("S1", "CONFIG_DB", "IP_SLA|1")).toMatchObject({ icmp_dst_ip: "10.0.12.2" });
    // the daemons start over: no translations / probe runs carried across the reload
    const f = byName("S1").config.features!;
    expect(f._nat).toBeUndefined();
    expect(f._ipsla).toBeUndefined();
    advance(15_000, 500);
    expect(hgetall("S1", "CONFIG_DB", "STATIC_ROUTE|0.0.0.0/0").track).toBe("0,1");
  });

  it("per-VRF bgpd and the L2-protection operational stores are runtime", () => {
    lab("evpn-irb", 10_000);
    run("LEAF1", "config save -y");
    expect(byName("LEAF1").config.features!["bgpd:Vrf-red"]).toBeDefined();
    expect(savedFile(byName("LEAF1"))!.features["bgpd:Vrf-red"]).toBeUndefined();
    expect(savedFile(byName("LEAF1"))!.features.bgpvrf).toBeDefined();

    lab("l2-protect", 10_000);
    run("SW1", "config save -y");
    const sf = savedFile(byName("SW1"))!.features;
    expect(byName("SW1").config.features!.udld).toBeDefined();
    expect(sf.udld).toBeUndefined();
    expect(sf.cp_udld).toBeDefined();
  });
});
