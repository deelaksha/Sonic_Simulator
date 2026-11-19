/** Per-feature CONFIG_DB / APPL_DB / STATE_DB / ASIC_DB coverage on the feature labs. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";
import { keyspace } from "../lib/sonicdb/project";

const db = (name: string, d: Parameters<typeof keyspace>[1]) => keyspace(S().network.devices[byName(name).id], d);
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

describe("feature tables", () => {
  it("LACP: PORTCHANNEL(_MEMBER), LAG_TABLE/LAG_MEMBER_TABLE, ASIC LAG/LAG_MEMBER/VLAN_MEMBER", () => {
    lab("lacp", 10_000);
    const c = db("S1", "CONFIG_DB");
    expect(c.get("PORTCHANNEL|PortChannel1")).toMatchObject({ admin_status: "up", lacp_key: "auto" });
    expect(c.get("PORTCHANNEL_MEMBER|PortChannel1|Ethernet0")).toEqual({ NULL: "NULL" });
    const a = db("S1", "APPL_DB");
    expect(a.get("LAG_TABLE:PortChannel1")).toMatchObject({ oper_status: "up" });
    expect(a.get("LAG_MEMBER_TABLE:PortChannel1:Ethernet1")).toEqual({ status: "enabled" });
    expect(db("S1", "STATE_DB").get("LAG_TABLE|PortChannel1")).toMatchObject({ state: "ok" });
    const asic = db("S1", "ASIC_DB");
    expect(asic.get("ASIC_STATE:SAI_OBJECT_TYPE_LAG_MEMBER:oid:0x1b000000000201")).toMatchObject({ SAI_LAG_MEMBER_ATTR_LAG_ID: "oid:0x2000000000002", SAI_LAG_MEMBER_ATTR_PORT_ID: "oid:0x1000000000001" });
    const lagBridge = asic.get("ASIC_STATE:SAI_OBJECT_TYPE_BRIDGE_PORT:oid:0x3a000000001001");
    expect(lagBridge).toMatchObject({ SAI_BRIDGE_PORT_ATTR_PORT_ID: "oid:0x2000000000002" });
  });

  it("MCLAG: MCLAG_DOMAIN / MCLAG_INTERFACE and STATE_DB MCLAG_TABLE", () => {
    lab("mclag");
    const c = db("P1", "CONFIG_DB");
    expect(c.get("MCLAG_DOMAIN|10")).toMatchObject({ source_ip: "10.0.0.1", peer_ip: "10.0.0.2", peer_link: "Ethernet1" });
    expect(c.get("MCLAG_INTERFACE|10|PortChannel1")).toEqual({ if_type: "PortChannel" });
    expect(db("P1", "STATE_DB").get("MCLAG_TABLE|10")).toMatchObject({ oper_status: "up" });
  });

  it("VRF: VRF table, per-VRF STATIC_ROUTE and ROUTE_TABLE keys, second virtual router in ASIC", () => {
    lab("vrf");
    const c = db("S1", "CONFIG_DB");
    expect(c.has("VRF|Vrf-red")).toBe(true);
    expect(c.get("STATIC_ROUTE|Vrf-red|192.168.3.0/24")).toMatchObject({ nexthop: "10.0.13.2", ifname: "Ethernet1" });
    expect(c.get("INTERFACE|Ethernet1")).toEqual({ vrf_name: "Vrf-red" });
    expect(db("S1", "APPL_DB").get("ROUTE_TABLE:Vrf-red:192.168.3.0/24")).toMatchObject({ protocol: "static" });
    expect(db("S1", "STATE_DB").get("VRF_TABLE|Vrf-red")).toEqual({ state: "ok" });
    const asic = db("S1", "ASIC_DB");
    expect(asic.has("ASIC_STATE:SAI_OBJECT_TYPE_VIRTUAL_ROUTER:oid:0x3000000000002")).toBe(true);
    expect([...asic.keys()].some((k) => k.includes('"dest":"192.168.3.0/24"') && k.includes('"vr":"oid:0x3000000000002"'))).toBe(true);
  });

  it("VXLAN EVPN: VXLAN_TUNNEL / _MAP / EVPN_NVO, remote VNI in APPL_DB, tunnel in STATE_DB", () => {
    lab("vxlan");
    const c = db("LEAF1", "CONFIG_DB");
    expect(c.get("VXLAN_TUNNEL|vtep1")).toEqual({ src_ip: "10.0.0.1" });
    expect(c.get("VXLAN_EVPN_NVO|nvo1")).toEqual({ source_vtep: "vtep1" });
    expect(c.get("VXLAN_TUNNEL_MAP|vtep1|map_10100_Vlan100")).toEqual({ vlan: "Vlan100", vni: "10100" });
    expect(db("LEAF1", "APPL_DB").get("VXLAN_REMOTE_VNI_TABLE:Vlan100:10.0.0.2")).toEqual({ vni: "10100" });
    expect(db("LEAF1", "STATE_DB").get("VXLAN_TUNNEL_TABLE|EVPN_10.0.0.2")).toMatchObject({ dst_ip: "10.0.0.2", operstatus: "up" });
    expect(db("SPINE", "CONFIG_DB").get("BGP_NEIGHBOR_AF|default|10.0.11.1|l2vpn_evpn")).toEqual({ admin_status: "true" });
  });

  it("BFD, ACL, SNMP, LLDP config tables + BFD/LLDP runtime", () => {
    lab("bfd");
    expect(db("S1", "CONFIG_DB").get("BFD_PEER_SINGLE_HOP|10.0.12.2|Ethernet0|default|null")).toEqual({ enabled: "true" });
    expect(db("S1", "STATE_DB").get("BFD_SESSION_TABLE|default|Ethernet0|10.0.12.2")).toMatchObject({ state: "Up" });
    expect(db("S1", "APPL_DB").get("LLDP_ENTRY_TABLE:Ethernet0")).toMatchObject({ lldp_rem_sys_name: "S2", lldp_rem_port_id: "Ethernet0" });

    lab("acl", 1000);
    const acl = db("S1", "CONFIG_DB");
    expect(acl.get("ACL_TABLE|H1-POLICY")).toMatchObject({ type: "L3", stage: "INGRESS" });
    expect(acl.get("ACL_RULE|H1-POLICY|RULE_10")).toMatchObject({ PACKET_ACTION: "DROP", SRC_IP: "192.168.1.10/32", IP_PROTOCOL: "1", PRIORITY: "65526" });

    lab("snmp", 1000);
    const snmp = db("S1", "CONFIG_DB");
    expect(snmp.get("SNMP_COMMUNITY|public")).toEqual({ TYPE: "RO" });
    expect(snmp.get("SNMP|LOCATION")).toEqual({ Location: "Lab-Row1-Rack1" });
    expect(snmp.get("SNMP_TRAP|192.168.100.250")).toMatchObject({ port: "162", version: "v2c" });
  });
});
