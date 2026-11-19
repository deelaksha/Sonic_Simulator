/**
 * ASIC_DB, COUNTERS_DB and FLEX_COUNTER_DB projections — what orchagent pushed
 * to syncd (SAI objects) and what syncd's flex-counter thread polls back.
 *
 * ASIC_DB keys: "ASIC_STATE:<SAI_OBJECT_TYPE_x>:<oid | json entry>"
 *   sonic-sairedis/lib/sairediscommon.h:13           ASIC_STATE_TABLE "ASIC_STATE"
 *   sonic-sairedis/SAI/inc/saitypes.h:191-248         object type numbers (PORT 1, LAG 2,
 *     VIRTUAL_ROUTER 3, NEXT_HOP 4, NEXT_HOP_GROUP 5, ROUTER_INTERFACE 6, HOSTIF 13,
 *     LAG_MEMBER 27, FDB_ENTRY 32, SWITCH 33, NEIGHBOR_ENTRY 36, ROUTE_ENTRY 37, VLAN 38,
 *     VLAN_MEMBER 39, BRIDGE 57, BRIDGE_PORT 58)
 *   Virtual OIDs encode the object type in bits 48..55 (sairedis VirtualObjectIdManager),
 *   e.g. a port "oid:0x1000000000001", the switch "oid:0x21000000000000".
 *   Non-object entries (route/neighbor/fdb) are keyed by their sorted JSON struct:
 *   {"dest":"10.0.0.0/24","switch_id":"oid:0x21000000000000","vr":"oid:0x3000000000001"}.
 *   OID numbering here is deterministic (derived from names/ids), not real hardware RIDs.
 *
 * COUNTERS_DB (schema.h:208-211): COUNTERS_PORT_NAME_MAP (port → oid) and
 *   COUNTERS:<port oid> with SAI_PORT_STAT_* (the stat ids portsorch.cpp:187-274 polls),
 *   filled from the simulator's InterfaceStats.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { vrfNames, vrfOf } from "../models/vrf";
import { listVlans, vlanMembers } from "../models/vlan-ops";
import { lagConfigs, lacpRuntime, systemMac } from "../protocols/lacp-daemon";
import { Tables, put, Row } from "./schema";
import { frontPorts } from "./config-db";
import { fibRoutes } from "./appl-state-db";

const T = {
  PORT: 0x1,
  LAG: 0x2,
  VIRTUAL_ROUTER: 0x3,
  NEXT_HOP: 0x4,
  NEXT_HOP_GROUP: 0x5,
  ROUTER_INTERFACE: 0x6,
  HOSTIF: 0xd,
  LAG_MEMBER: 0x1b,
  SWITCH: 0x21,
  VLAN: 0x26,
  VLAN_MEMBER: 0x27,
  BRIDGE: 0x39,
  BRIDGE_PORT: 0x3a,
} as const;

export function oid(type: number, n: number): string {
  return `oid:0x${type.toString(16)}${n.toString(16).padStart(12, "0")}`;
}

const num = (name: string) => Number(/(\d+)(?:\.\d+)?$/.exec(name)?.[1] ?? 0);
export const SWITCH_OID = oid(T.SWITCH, 0);
const CPU_PORT_OID = oid(T.PORT, 0);
export const portOid = (name: string) => oid(T.PORT, num(name) + 1);
const lagOid = (name: string) => oid(T.LAG, num(name) + 1);
const vlanOid = (vid: number) => oid(T.VLAN, vid);
const MAC = (m: string) => m.toUpperCase(); // sai_serialize_mac: %02X

/** sairedis entry keys: JSON with sorted member names, no spaces. */
const entryKey = (o: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));

/** Interfaces that get a SAI router interface (L3 port/LAG/SVI/sub-port with an address or VRF). */
function rifInterfaces(d: Device): NetInterface[] {
  return d.interfaces.filter(
    (i) => !i.management && !/^Loopback/.test(i.name) && (i.ipv4.length > 0 || i.ipv6.length > 0 || vrfOf(d, i) !== "default"),
  );
}

export function projectAsicDb(d: Device): Tables {
  const t: Tables = {};
  const A = (type: string, key: string, row: Row) => put(t, "ASIC_STATE", `SAI_OBJECT_TYPE_${type}:${key}`, row);
  const sysMac = MAC(systemMac(d));

  A("SWITCH", SWITCH_OID, { SAI_SWITCH_ATTR_INIT_SWITCH: "true", SAI_SWITCH_ATTR_SRC_MAC_ADDRESS: sysMac });

  const vrOid = new Map<string, string>();
  vrfNames(d).forEach((v, i) => {
    vrOid.set(v, oid(T.VIRTUAL_ROUTER, i + 1));
    A("VIRTUAL_ROUTER", oid(T.VIRTUAL_ROUTER, i + 1), i === 0 ? {} : { SAI_VIRTUAL_ROUTER_ATTR_ADMIN_V4_STATE: "true", SAI_VIRTUAL_ROUTER_ATTR_ADMIN_V6_STATE: "true" });
  });

  const ports = frontPorts(d);
  for (const p of ports) {
    A("PORT", portOid(p.name), { SAI_PORT_ATTR_ADMIN_STATE: p.adminState === "up" ? "true" : "false", SAI_PORT_ATTR_SPEED: String(p.speed), SAI_PORT_ATTR_MTU: "9122" });
    A("HOSTIF", oid(T.HOSTIF, num(p.name) + 1), { SAI_HOSTIF_ATTR_TYPE: "SAI_HOSTIF_TYPE_NETDEV", SAI_HOSTIF_ATTR_OBJ_ID: portOid(p.name), SAI_HOSTIF_ATTR_NAME: p.name, SAI_HOSTIF_ATTR_OPER_STATUS: p.operState === "up" ? "true" : "false" });
  }

  // LAGs
  const lacp = lacpRuntime(d);
  const lagOfPort = new Map<string, string>();
  for (const lag of lagConfigs(d)) {
    A("LAG", lagOid(lag.name), {});
    for (const m of lag.members) {
      lagOfPort.set(m, lag.name);
      const sel = lacp?.lags[lag.name]?.ports[m]?.selected ?? false;
      A("LAG_MEMBER", oid(T.LAG_MEMBER, (num(lag.name) + 1) * 256 + num(m) + 1), {
        SAI_LAG_MEMBER_ATTR_LAG_ID: lagOid(lag.name),
        SAI_LAG_MEMBER_ATTR_PORT_ID: portOid(m),
        SAI_LAG_MEMBER_ATTR_EGRESS_DISABLE: sel ? "false" : "true",
        SAI_LAG_MEMBER_ATTR_INGRESS_DISABLE: sel ? "false" : "true",
      });
    }
  }

  // Bridge ports (one per port/LAG that is a VLAN member or has learned MACs)
  const bridgeOid = (name: string) => (/^PortChannel/.test(name) ? oid(T.BRIDGE_PORT, 0x1000 + num(name)) : oid(T.BRIDGE_PORT, num(name) + 1));
  const bridged = new Set<string>();
  const bridge = (name: string) => {
    if (bridged.has(name)) return;
    bridged.add(name);
    const isLag = /^PortChannel/.test(name);
    A("BRIDGE_PORT", bridgeOid(name), {
      SAI_BRIDGE_PORT_ATTR_TYPE: "SAI_BRIDGE_PORT_TYPE_PORT",
      SAI_BRIDGE_PORT_ATTR_PORT_ID: isLag ? lagOid(name) : portOid(name),
      SAI_BRIDGE_PORT_ATTR_ADMIN_STATE: "true",
    });
  };
  A("BRIDGE", oid(T.BRIDGE, 1), { SAI_BRIDGE_ATTR_TYPE: "SAI_BRIDGE_TYPE_1Q" });

  // VLANs (VLAN 1 is the SAI default VLAN, always present)
  const vids = new Set<number>([1, ...listVlans(d).map((v) => v.id), ...d.macTable.map((e) => e.vlan)]);
  for (const vid of [...vids].sort((a, b) => a - b)) A("VLAN", vlanOid(vid), { SAI_VLAN_ATTR_VLAN_ID: String(vid) });
  for (const v of listVlans(d)) {
    for (const m of vlanMembers(d, v.id)) {
      if (lagOfPort.has(m.port)) continue;
      bridge(m.port);
      const memberN = /^PortChannel/.test(m.port) ? 0x1000 + num(m.port) : num(m.port) + 1;
      A("VLAN_MEMBER", oid(T.VLAN_MEMBER, v.id * 0x10000 + memberN), {
        SAI_VLAN_MEMBER_ATTR_VLAN_ID: vlanOid(v.id),
        SAI_VLAN_MEMBER_ATTR_BRIDGE_PORT_ID: bridgeOid(m.port),
        SAI_VLAN_MEMBER_ATTR_VLAN_TAGGING_MODE: m.tagged ? "SAI_VLAN_TAGGING_MODE_TAGGED" : "SAI_VLAN_TAGGING_MODE_UNTAGGED",
      });
    }
  }

  // FDB entries
  for (const e of d.macTable) {
    const iface = d.interfaces.find((i) => i.id === e.interfaceId);
    if (!iface || iface.management) continue;
    const port = lagOfPort.get(iface.name) ?? iface.name;
    if (iface.logical && !/^PortChannel\d+$/.test(port)) continue;
    bridge(port);
    A("FDB_ENTRY", entryKey({ bvid: vlanOid(e.vlan), mac: MAC(e.mac), switch_id: SWITCH_OID }), {
      SAI_FDB_ENTRY_ATTR_TYPE: e.static ? "SAI_FDB_ENTRY_TYPE_STATIC" : "SAI_FDB_ENTRY_TYPE_DYNAMIC",
      SAI_FDB_ENTRY_ATTR_BRIDGE_PORT_ID: bridgeOid(port),
      SAI_FDB_ENTRY_ATTR_PACKET_ACTION: "SAI_PACKET_ACTION_FORWARD",
    });
  }

  // Router interfaces
  const rifOid = new Map<string, string>(); // interface id → RIF oid
  d.interfaces.forEach((i, idx) => {
    if (!rifInterfaces(d).includes(i)) return;
    const o = oid(T.ROUTER_INTERFACE, idx + 1);
    rifOid.set(i.id, o);
    const row: Row = { SAI_ROUTER_INTERFACE_ATTR_VIRTUAL_ROUTER_ID: vrOid.get(vrfOf(d, i)) ?? vrOid.get("default")! };
    const vlan = /^Vlan(\d+)$/.exec(i.name);
    const sub = /^(Ethernet\d+)\.(\d+)$/.exec(i.name);
    if (vlan) {
      row.SAI_ROUTER_INTERFACE_ATTR_TYPE = "SAI_ROUTER_INTERFACE_TYPE_VLAN";
      row.SAI_ROUTER_INTERFACE_ATTR_VLAN_ID = vlanOid(Number(vlan[1]));
    } else if (sub) {
      row.SAI_ROUTER_INTERFACE_ATTR_TYPE = "SAI_ROUTER_INTERFACE_TYPE_SUB_PORT";
      row.SAI_ROUTER_INTERFACE_ATTR_PORT_ID = portOid(sub[1]);
      row.SAI_ROUTER_INTERFACE_ATTR_OUTER_VLAN_ID = sub[2];
    } else {
      row.SAI_ROUTER_INTERFACE_ATTR_TYPE = "SAI_ROUTER_INTERFACE_TYPE_PORT";
      row.SAI_ROUTER_INTERFACE_ATTR_PORT_ID = /^PortChannel/.test(i.name) ? lagOid(i.name) : portOid(i.name);
    }
    row.SAI_ROUTER_INTERFACE_ATTR_SRC_MAC_ADDRESS = MAC(i.mac);
    row.SAI_ROUTER_INTERFACE_ATTR_MTU = "9100";
    A("ROUTER_INTERFACE", o, row);
  });

  // Neighbors
  for (const n of [...d.arpTable, ...d.ndpTable]) {
    const rif = rifOid.get(n.interfaceId);
    if (!rif || n.state === "incomplete") continue;
    A("NEIGHBOR_ENTRY", entryKey({ ip: n.ip, rif, switch_id: SWITCH_OID }), { SAI_NEIGHBOR_ENTRY_ATTR_DST_MAC_ADDRESS: MAC(n.mac) });
  }

  // Next hops, next-hop groups, routes
  const nhOid = new Map<string, string>();
  const nextHop = (ip: string, rif: string) => {
    const k = `${ip}@${rif}`;
    let o = nhOid.get(k);
    if (!o) {
      o = oid(T.NEXT_HOP, nhOid.size + 1);
      nhOid.set(k, o);
      A("NEXT_HOP", o, { SAI_NEXT_HOP_ATTR_TYPE: "SAI_NEXT_HOP_TYPE_IP", SAI_NEXT_HOP_ATTR_IP: ip, SAI_NEXT_HOP_ATTR_ROUTER_INTERFACE_ID: rif });
    }
    return o;
  };
  let nhg = 0;
  const route = (vrf: string, dest: string, row: Row) =>
    A("ROUTE_ENTRY", entryKey({ dest, switch_id: SWITCH_OID, vr: vrOid.get(vrf) ?? vrOid.get("default")! }), { SAI_ROUTE_ENTRY_ATTR_PACKET_ACTION: "SAI_PACKET_ACTION_FORWARD", ...row });

  for (const g of fibRoutes(d)) {
    const usable = g.filter((r) => rifOid.has(r.interfaceId));
    if (!usable.length) continue; // e.g. management-port routes are kernel-only
    const r0 = usable[0];
    const vrf = r0.vrf ?? "default";
    const dest = `${r0.destination}/${r0.prefix}`;
    if (r0.nextHop === null) {
      route(vrf, dest, { SAI_ROUTE_ENTRY_ATTR_NEXT_HOP_ID: rifOid.get(r0.interfaceId)! }); // directly connected subnet
    } else if (usable.length === 1) {
      route(vrf, dest, { SAI_ROUTE_ENTRY_ATTR_NEXT_HOP_ID: nextHop(r0.nextHop, rifOid.get(r0.interfaceId)!) });
    } else {
      const go = oid(T.NEXT_HOP_GROUP, ++nhg);
      A("NEXT_HOP_GROUP", go, { SAI_NEXT_HOP_GROUP_ATTR_TYPE: "SAI_NEXT_HOP_GROUP_TYPE_DYNAMIC_UNORDERED_ECMP" });
      usable.forEach((r, k) => {
        A("NEXT_HOP_GROUP_MEMBER", oid(0x2d, nhg * 256 + k + 1), {
          SAI_NEXT_HOP_GROUP_MEMBER_ATTR_NEXT_HOP_GROUP_ID: go,
          SAI_NEXT_HOP_GROUP_MEMBER_ATTR_NEXT_HOP_ID: nextHop(r.nextHop ?? "0.0.0.0", rifOid.get(r.interfaceId)!),
        });
      });
      route(vrf, dest, { SAI_ROUTE_ENTRY_ATTR_NEXT_HOP_ID: go });
    }
  }
  // ip2me: every local address is a /32 trapped to the CPU port (intfsorch addIp2MeRoute)
  for (const i of d.interfaces) {
    if (i.management) continue;
    for (const a of i.ipv4) route(vrfOf(d, i), `${a.address}/32`, { SAI_ROUTE_ENTRY_ATTR_NEXT_HOP_ID: CPU_PORT_OID });
  }
  return t;
}

export function projectCountersDb(d: Device): Tables {
  const t: Tables = {};
  const map: Row = {};
  for (const p of frontPorts(d)) {
    map[p.name] = portOid(p.name);
    const s = p.statistics;
    const inB = s.rxBroadcast ?? 0;
    const inM = s.rxMulticast ?? 0;
    const outB = s.txBroadcast ?? 0;
    const outM = s.txMulticast ?? 0;
    put(t, "COUNTERS", portOid(p.name), {
      SAI_PORT_STAT_IF_IN_OCTETS: String(s.rxBytes),
      SAI_PORT_STAT_IF_IN_UCAST_PKTS: String(Math.max(0, s.rxFrames - inB - inM)),
      SAI_PORT_STAT_IF_IN_NON_UCAST_PKTS: String(inB + inM),
      SAI_PORT_STAT_IF_IN_BROADCAST_PKTS: String(inB),
      SAI_PORT_STAT_IF_IN_MULTICAST_PKTS: String(inM),
      SAI_PORT_STAT_IF_IN_DISCARDS: String(s.rxDropped),
      SAI_PORT_STAT_IF_IN_ERRORS: "0",
      SAI_PORT_STAT_IF_OUT_OCTETS: String(s.txBytes),
      SAI_PORT_STAT_IF_OUT_UCAST_PKTS: String(Math.max(0, s.txFrames - outB - outM)),
      SAI_PORT_STAT_IF_OUT_NON_UCAST_PKTS: String(outB + outM),
      SAI_PORT_STAT_IF_OUT_BROADCAST_PKTS: String(outB),
      SAI_PORT_STAT_IF_OUT_MULTICAST_PKTS: String(outM),
      SAI_PORT_STAT_IF_OUT_DISCARDS: String(s.txDropped),
      SAI_PORT_STAT_IF_OUT_ERRORS: "0",
    });
  }
  if (Object.keys(map).length) put(t, "COUNTERS_PORT_NAME_MAP", "", map);
  return t;
}

/** FLEX_COUNTER_DB: the port-stat polling group and one entry per port (flex_counter_manager). */
export function projectFlexCounterDb(d: Device): Tables {
  const t: Tables = {};
  put(t, "FLEX_COUNTER_GROUP_TABLE", "PORT_STAT_COUNTER", { POLL_INTERVAL: "1000", STATS_MODE: "STATS_MODE_READ", FLEX_COUNTER_STATUS: "enable" });
  for (const p of frontPorts(d)) put(t, "FLEX_COUNTER_TABLE", `PORT_STAT_COUNTER:${portOid(p.name)}`, { PORT_COUNTER_ID_LIST: "SAI_PORT_STAT_IF_IN_OCTETS,SAI_PORT_STAT_IF_IN_UCAST_PKTS,SAI_PORT_STAT_IF_OUT_OCTETS,SAI_PORT_STAT_IF_OUT_UCAST_PKTS" });
  return t;
}
