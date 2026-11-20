/** SONiC Redis DB projections (lib/sonicdb) driven through the real CLI on fake time. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { keyspace } from "../lib/sonicdb/project";
import { Device } from "../lib/models/device";
import { cliModeFor } from "../lib/commands/sonic-cli";

const dev = (name: string): Device => byName(name);
const sw = (): Device => Object.values(S().network.devices).find((d) => d.type === "switch")!;
const pcs = (): Device[] => Object.values(S().network.devices).filter((d) => d.type === "pc");
/** Run at the Linux/Click shell: leave the KLISH (sonic-cli) mode switches start in. */
function run(d: Device, cmd: string): string {
  for (let i = 0; i < 4 && cliModeFor(S().network.devices[d.id], S().cliMode[d.id]).length > 0; i++) S().execCommand(d.id, "exit");
  return out(S().execCommand(d.id, cmd));
}
const db = (d: Device, name: Parameters<typeof keyspace>[1]) => keyspace(S().network.devices[d.id], name);
const asicKeys = (d: Device, type: string) => [...db(d, "ASIC_DB").keys()].filter((k) => k.startsWith(`ASIC_STATE:SAI_OBJECT_TYPE_${type}:`));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("CONFIG_DB from Click config (VLAN, IP, static route, sFlow)", () => {
  beforeEach(() => S().loadVlanLab());

  it("VLAN / VLAN_MEMBER / INTERFACE / STATIC_ROUTE rows with sonic-yang field names", () => {
    const s = sw();
    // Cable Ethernet3: zebra only has the connected route of an operationally up port.
    const pc = S().addDevice("pc", { x: 0, y: 0 });
    S().connect(pc, `${pc}-if0`, s.id, s.interfaces.find((i) => i.name === "Ethernet3")!.id, { autoDhcp: false });
    run(s, "config vlan add 100");
    run(s, "config vlan member add -u 100 Ethernet3");
    run(s, "config interface ip add Ethernet3 10.1.1.1/24");
    run(s, "config route add prefix 172.16.0.0/16 nexthop 10.1.1.2");
    const c = db(s, "CONFIG_DB");
    expect(c.get("VLAN|Vlan100")).toEqual({ vlanid: "100", "members@": "Ethernet3" });
    expect(c.get("VLAN|Vlan10")).toEqual({ vlanid: "10", "members@": "Ethernet0,Ethernet1" });
    expect(c.get("VLAN_MEMBER|Vlan100|Ethernet3")).toEqual({ tagging_mode: "untagged" });
    expect(c.get("INTERFACE|Ethernet3|10.1.1.1/24")).toEqual({ NULL: "NULL" }); // empty row as ConfigDBConnector stores it
    expect(c.get("STATIC_ROUTE|172.16.0.0/16")).toMatchObject({ nexthop: "10.1.1.2", ifname: "Ethernet3" });
    expect(c.get("PORT|Ethernet0")).toMatchObject({ admin_status: "up", mtu: "9100", speed: "1000" });
    // APPL_DB: vlanmgrd / intfmgrd / fpmsyncd outputs
    const a = db(s, "APPL_DB");
    expect(a.get("VLAN_TABLE:Vlan100")).toEqual({ admin_status: "up", mtu: "9100" });
    expect(a.get("VLAN_MEMBER_TABLE:Vlan100:Ethernet3")).toEqual({ tagging_mode: "untagged" });
    expect(a.get("INTF_TABLE:Ethernet3:10.1.1.1/24")).toEqual({ scope: "global", family: "IPv4" });
    expect(a.get("ROUTE_TABLE:172.16.0.0/16")).toEqual({ nexthop: "10.1.1.2", ifname: "Ethernet3", protocol: "static" });
    expect(a.get("ROUTE_TABLE:10.1.1.0/24")).toEqual({ nexthop: "0.0.0.0", ifname: "Ethernet3", protocol: "connected" });
    expect([...a.keys()].some((k) => k.includes("192.168.100.0"))).toBe(false); // eth0 routes skipped
    // STATE_DB ready flags, ASIC_DB objects
    const st = db(s, "STATE_DB");
    expect(st.get("VLAN_TABLE|Vlan100")).toEqual({ state: "ok" });
    expect(st.get("INTERFACE_TABLE|Ethernet3|10.1.1.1/24")).toEqual({ state: "ok" });
    const asic = db(s, "ASIC_DB");
    expect(asic.get("ASIC_STATE:SAI_OBJECT_TYPE_VLAN:oid:0x26000000000064")).toEqual({ SAI_VLAN_ATTR_VLAN_ID: "100" });
    const rif = asicKeys(s, "ROUTER_INTERFACE").map((k) => asic.get(k)!);
    expect(rif).toContainEqual(expect.objectContaining({ SAI_ROUTER_INTERFACE_ATTR_TYPE: "SAI_ROUTER_INTERFACE_TYPE_PORT", SAI_ROUTER_INTERFACE_ATTR_PORT_ID: "oid:0x1000000000004" }));
    const route = asic.get('ASIC_STATE:SAI_OBJECT_TYPE_ROUTE_ENTRY:{"dest":"172.16.0.0/16","switch_id":"oid:0x21000000000000","vr":"oid:0x3000000000001"}')!;
    const nh = asic.get(`ASIC_STATE:SAI_OBJECT_TYPE_NEXT_HOP:${route.SAI_ROUTE_ENTRY_ATTR_NEXT_HOP_ID}`)!;
    expect(nh).toMatchObject({ SAI_NEXT_HOP_ATTR_TYPE: "SAI_NEXT_HOP_TYPE_IP", SAI_NEXT_HOP_ATTR_IP: "10.1.1.2" });
    expect(asic.has('ASIC_STATE:SAI_OBJECT_TYPE_ROUTE_ENTRY:{"dest":"10.1.1.1/32","switch_id":"oid:0x21000000000000","vr":"oid:0x3000000000001"}')).toBe(true); // ip2me
  });

  it("sFlow: SFLOW / SFLOW_COLLECTOR in CONFIG_DB, sflowmgrd sessions in APPL_DB", () => {
    const s = sw();
    run(s, "config sflow enable");
    run(s, "config sflow collector add col1 10.0.0.100");
    run(s, "config sflow polling-interval 30");
    run(s, "config sflow interface sample-rate Ethernet1 4096");
    const c = db(s, "CONFIG_DB");
    expect(c.get("SFLOW|global")).toMatchObject({ admin_state: "up", polling_interval: "30" });
    expect(c.get("SFLOW_COLLECTOR|col1")).toEqual({ collector_ip: "10.0.0.100", collector_port: "6343", collector_vrf: "default" });
    expect(c.get("SFLOW_SESSION|Ethernet1")).toMatchObject({ sample_rate: "4096" });
    const a = db(s, "APPL_DB");
    expect(a.get("SFLOW_TABLE:global")).toMatchObject({ admin_state: "up", polling_interval: "30" });
    expect(a.get("SFLOW_SESSION_TABLE:Ethernet0")).toEqual({ admin_state: "up", sample_rate: "1000", sample_direction: "rx" });
    expect(a.get("SFLOW_SESSION_TABLE:Ethernet1")).toMatchObject({ sample_rate: "4096" });
  });

  it("FDB: learned MACs in STATE_DB FDB_TABLE and ASIC_DB FDB_ENTRY; counters move with traffic", () => {
    const s = sw();
    const [pc1] = pcs();
    const before = db(s, "COUNTERS_DB").get("COUNTERS:oid:0x1000000000001")!;
    expect(before.SAI_PORT_STAT_IF_IN_OCTETS).toBe("0");
    run(pc1, "ping -c 2 10.0.0.2");
    const st = db(s, "STATE_DB");
    const pc1Mac = pc1.interfaces[0].mac.toLowerCase();
    expect(st.get(`FDB_TABLE|Vlan10:${pc1Mac}`)).toEqual({ port: "Ethernet0", type: "dynamic" });
    const fdb = asicKeys(s, "FDB_ENTRY");
    const key = fdb.find((k) => k.includes(pc1Mac.toUpperCase()))!;
    expect(key).toBe(`ASIC_STATE:SAI_OBJECT_TYPE_FDB_ENTRY:{"bvid":"oid:0x2600000000000a","mac":"${pc1Mac.toUpperCase()}","switch_id":"oid:0x21000000000000"}`);
    expect(db(s, "ASIC_DB").get(key)).toMatchObject({ SAI_FDB_ENTRY_ATTR_TYPE: "SAI_FDB_ENTRY_TYPE_DYNAMIC", SAI_FDB_ENTRY_ATTR_BRIDGE_PORT_ID: "oid:0x3a000000000001" });
    const c = db(s, "COUNTERS_DB");
    expect(c.get("COUNTERS_PORT_NAME_MAP")).toMatchObject({ Ethernet0: "oid:0x1000000000001" });
    const after = c.get("COUNTERS:oid:0x1000000000001")!;
    expect(Number(after.SAI_PORT_STAT_IF_IN_OCTETS)).toBeGreaterThan(0);
    expect(Number(after.SAI_PORT_STAT_IF_IN_UCAST_PKTS)).toBeGreaterThan(0);
    expect(Number(after.SAI_PORT_STAT_IF_OUT_OCTETS)).toBeGreaterThan(0);
  });

  it("STATE_DB PORT_TABLE tracks admin/oper state", () => {
    const s = sw();
    expect(db(s, "STATE_DB").get("PORT_TABLE|Ethernet0")).toEqual({ state: "ok", netdev_oper_status: "up", admin_status: "up", mtu: "9100", oper_speed: "1000" });
    expect(db(s, "STATE_DB").get("PORT_TABLE|Ethernet3")).toMatchObject({ netdev_oper_status: "down" }); // no cable
    run(s, "config interface shutdown Ethernet0");
    expect(db(s, "STATE_DB").get("PORT_TABLE|Ethernet0")).toMatchObject({ netdev_oper_status: "down", admin_status: "down" });
    expect(db(s, "APPL_DB").get("PORT_TABLE:Ethernet0")).toMatchObject({ admin_status: "down", oper_status: "down" });
    expect(db(s, "ASIC_DB").get("ASIC_STATE:SAI_OBJECT_TYPE_PORT:oid:0x1000000000001")).toMatchObject({ SAI_PORT_ATTR_ADMIN_STATE: "false" });
  });
});

describe("protocol state in the DBs", () => {
  it("BGP: CONFIG_DB BGP_* rows, APPL_DB ROUTE_TABLE bgp routes, STATE_DB NEIGH_STATE_TABLE, ASIC neighbor/route", () => {
    S().loadFeatureLab("bgp");
    advance(5000);
    const s1 = dev("S1");
    const c = db(s1, "CONFIG_DB");
    expect(c.get("BGP_GLOBALS|default")).toEqual({ local_asn: "65001", router_id: "1.1.1.1" });
    expect(c.get("BGP_NEIGHBOR|default|10.0.12.2")).toMatchObject({ asn: "65002", admin_status: "up" });
    expect(c.has("BGP_GLOBALS_AF_NETWORK|default|ipv4_unicast|192.168.1.0/24")).toBe(true);
    expect(c.get("DEVICE_METADATA|localhost")).toMatchObject({ hostname: "S1", bgp_asn: "65001" });
    const a = db(s1, "APPL_DB");
    expect(a.get("ROUTE_TABLE:192.168.3.0/24")).toEqual({ nexthop: "10.0.13.2", ifname: "Ethernet1", protocol: "bgp" });
    expect(db(s1, "STATE_DB").get("NEIGH_STATE_TABLE|10.0.12.2")).toEqual({ state: "Established" });
    const neigh = a.get("NEIGH_TABLE:Ethernet1:10.0.13.2");
    expect(neigh).toMatchObject({ family: "IPv4" });
    const asic = db(s1, "ASIC_DB");
    const nKey = asicKeys(s1, "NEIGHBOR_ENTRY").find((k) => k.includes('"ip":"10.0.13.2"'))!;
    expect(asic.get(nKey)).toEqual({ SAI_NEIGHBOR_ENTRY_ATTR_DST_MAC_ADDRESS: neigh!.neigh.toUpperCase() });
    const rKey = asicKeys(s1, "ROUTE_ENTRY").find((k) => k.includes('"dest":"192.168.3.0/24"'))!;
    const nh = asic.get(`ASIC_STATE:SAI_OBJECT_TYPE_NEXT_HOP:${asic.get(rKey)!.SAI_ROUTE_ENTRY_ATTR_NEXT_HOP_ID}`)!;
    expect(nh.SAI_NEXT_HOP_ATTR_IP).toBe("10.0.13.2");
    expect(nKey).toContain(`"rif":"${nh.SAI_NEXT_HOP_ATTR_ROUTER_INTERFACE_ID}"`);
  });

  it("OSPF: OSPFV2_* config and ospf routes in APPL_DB ROUTE_TABLE", () => {
    S().loadFeatureLab("ospf");
    advance(60_000, 500);
    const s1 = dev("S1");
    const c = db(s1, "CONFIG_DB");
    expect(c.get("OSPFV2_ROUTER|default")).toMatchObject({ enable: "true", "router-id": "1.1.1.1" });
    expect(c.has("OSPFV2_ROUTER_AREA_NETWORK|default|0.0.0.0|10.0.12.0/30")).toBe(true);
    expect(db(s1, "APPL_DB").get("ROUTE_TABLE:192.168.3.0/24")).toMatchObject({ protocol: "ospf", ifname: "Ethernet1", nexthop: "10.0.13.2" });
    expect(db(s1, "APPL_DB").get("ROUTE_TABLE:10.0.23.0/30")?.protocol).toBe("ospf");
  });
});
