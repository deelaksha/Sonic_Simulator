/**
 * Simulation events (spec §35, §36). Every meaningful decision the engine makes
 * emits one of these. The timeline, packet animation, inspector, and tcpdump are
 * all views over this single event stream.
 */
import { Frame } from "../models/packet";

export type SimEventType =
  // L1/L2 frame lifecycle
  | "FRAME_CREATED"
  | "FRAME_SENT"
  | "FRAME_RECEIVED"
  | "FRAME_FORWARDED"
  | "FRAME_FLOODED"
  | "FRAME_DROPPED"
  // L2 switching
  | "MAC_LEARNED"
  // ARP
  | "ARP_REQUEST"
  | "ARP_REPLY"
  | "ARP_RESOLVED"
  // L3
  | "IP_PACKET_CREATED"
  | "ROUTE_LOOKUP"
  | "ROUTE_MATCH"
  | "TTL_DECREMENT"
  // ICMP
  | "ICMP_ECHO_REQUEST"
  | "ICMP_ECHO_REPLY"
  | "ICMP_TIME_EXCEEDED"
  | "ICMP_UNREACHABLE"
  // IPv6 / NDP / ICMPv6 (spec §40)
  | "NDP_SOLICITATION"
  | "NDP_ADVERTISEMENT"
  | "NDP_RESOLVED"
  | "ICMP6_ECHO_REQUEST"
  | "ICMP6_ECHO_REPLY"
  // OSPF (spec §24)
  | "OSPF_HELLO"
  | "OSPF_NEIGHBOR"
  | "OSPF_ROUTE"
  // BGP (spec §25)
  | "BGP_OPEN"
  | "BGP_ESTABLISHED"
  | "BGP_UPDATE"
  | "BGP_ROUTE"
  // L4/L7 (UDP apps)
  | "UDP_DATAGRAM"
  | "NTP_REQUEST"
  | "NTP_RESPONSE"
  | "DHCP_DISCOVER"
  | "DHCP_OFFER"
  | "DHCP_REQUEST"
  | "DHCP_ACK"
  | "DHCP_RELAY"
  | "DNS_QUERY"
  | "DNS_RESPONSE"
  | "VRRP_MASTER"
  | "VRRP_FAILOVER"
  // command-level summary
  | "PING_RESULT";

export interface LinkTraversal {
  fromDeviceId: string;
  fromInterfaceId: string;
  toDeviceId: string;
  toInterfaceId: string;
}

// ---------------------------------------------------------------------------
// Structured per-event detail. Snapshots of the device's own tables + the
// lookup result AT THE MOMENT of the event, computed by the engine so the
// inspector renders real MAC/route/ARP lookups and never recomputes anything
// in the UI (spec: "the simulation engine should calculate; the UI displays").
// These are immutable plain snapshots — safe against later state mutation.
// ---------------------------------------------------------------------------

export interface MacTableRow {
  mac: string;
  port: string;
  vlan: number;
  isNew?: boolean; // just-learned / just-moved row (for highlight)
}

export interface RouteTableRow {
  destination: string;
  prefix: number;
  nextHop: string | null;
  iface: string;
  type: string;
  contains?: boolean; // this route's prefix contains the destination IP
  matched?: boolean; // the winning (longest-prefix) route
}

export interface ArpTableRow {
  ip: string;
  mac: string;
  iface: string;
  state: string;
  matched?: boolean; // the entry being looked up
}

export interface MacLearnDetail {
  kind: "mac-learn";
  ingressInterface: string;
  sourceMac: string;
  vlan: number;
  moved: boolean;
  macTable: MacTableRow[];
}

export interface MacLookupDetail {
  kind: "mac-lookup";
  ingressInterface: string;
  sourceMac: string;
  destinationMac: string;
  vlan: number;
  result: "found" | "unknown-unicast" | "broadcast" | "multicast";
  action: "forward" | "flood";
  outputInterfaces: string[];
  macTable: MacTableRow[];
}

export interface RouteLookupDetail {
  kind: "route-lookup";
  destinationIp: string;
  result: "matched" | "no-route";
  outputInterface?: string;
  nextHop?: string | null;
  routingTable: RouteTableRow[];
}

export interface ArpLookupDetail {
  kind: "arp-lookup";
  targetIp: string;
  result: "miss" | "resolved";
  resolvedMac?: string;
  arpTable: ArpTableRow[];
}

export type SimEventDetail =
  | MacLearnDetail
  | MacLookupDetail
  | RouteLookupDetail
  | ArpLookupDetail;

export interface SimEvent {
  id: string;
  seq: number; // strictly increasing order of occurrence
  timeMs: number; // simulated clock timestamp
  type: SimEventType;
  deviceId: string;
  deviceName: string;
  interfaceId?: string;
  interfaceName?: string;
  message: string; // human-readable timeline line
  osiLayers: number[]; // OSI layers involved (spec §31)
  frame?: Frame; // immutable snapshot at this moment
  link?: LinkTraversal; // set on FRAME_SENT for animation
  detail?: SimEventDetail; // structured lookup/table snapshot for the inspector
}

/** Fields a caller provides; the log fills in id/seq/timeMs. */
export type EmitInput = Omit<SimEvent, "id" | "seq" | "timeMs">;

export const OSI_BY_TYPE: Partial<Record<SimEventType, number[]>> = {
  FRAME_CREATED: [1, 2],
  FRAME_SENT: [1, 2],
  FRAME_RECEIVED: [1, 2],
  FRAME_FORWARDED: [1, 2],
  FRAME_FLOODED: [1, 2],
  FRAME_DROPPED: [1, 2],
  MAC_LEARNED: [2],
  ARP_REQUEST: [2],
  ARP_REPLY: [2],
  ARP_RESOLVED: [2],
  IP_PACKET_CREATED: [3],
  ROUTE_LOOKUP: [3],
  ROUTE_MATCH: [3],
  TTL_DECREMENT: [3],
  ICMP_ECHO_REQUEST: [3],
  ICMP_ECHO_REPLY: [3],
  ICMP_TIME_EXCEEDED: [3],
  ICMP_UNREACHABLE: [3],
  PING_RESULT: [3],
};
