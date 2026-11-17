/**
 * Generic layered packet/frame representation (spec §12).
 *
 * A Frame is the single object that travels the wire. Each network layer is an
 * optional typed sub-header. There is ONE source of truth (this typed object);
 * the packet inspector (§14) is derived from it via `describeFrame`, never the
 * other way around.
 */

/** "Other" = an EtherType the engine does not model (LLDP, LACP, MPLS, …); see typeCode. */
export type EtherType = "IPv4" | "IPv6" | "ARP" | "Other";

export interface EthernetHeader {
  srcMac: string;
  dstMac: string;
  etherType: EtherType;
  /** Numeric EtherType when etherType is "Other". */
  typeCode?: number;
}

/** 802.1Q VLAN tag (spec §8). Present only on tagged frames (trunk links). */
export interface Dot1QTag {
  vlanId: number;
  priority: number;
}

export type ArpOp = "request" | "reply";

export interface ArpPayload {
  op: ArpOp;
  senderMac: string;
  senderIp: string;
  targetMac: string; // 00:00:00:00:00:00 in a request
  targetIp: string;
}

/** "OTHER" = an IP protocol the engine does not model (GRE, SCTP, IGMP, …); see protocolNumber. */
export type IpProtocol = "ICMP" | "TCP" | "UDP" | "OSPF" | "OTHER";

export interface Ipv4Header {
  srcIp: string;
  dstIp: string;
  ttl: number;
  protocol: IpProtocol;
  identification: number;
  /** IP protocol number when protocol is "OTHER". */
  protocolNumber?: number;
}

export type IcmpType = "echo-request" | "echo-reply" | "time-exceeded" | "dest-unreachable";

export interface IcmpPayload {
  type: IcmpType;
  code: number;
  identifier: number;
  sequence: number;
  /** For error messages: a short description of the packet that triggered it. */
  errorInfo?: string;
}

export type Ipv6NextHeader = "ICMPv6" | "UDP" | "TCP" | "OTHER";

export interface Ipv6Header {
  srcIp: string;
  dstIp: string;
  hopLimit: number;
  nextHeader: Ipv6NextHeader;
}

export type Icmp6Type =
  | "echo-request"
  | "echo-reply"
  | "neighbor-solicitation"
  | "neighbor-advertisement"
  | "time-exceeded"
  | "dest-unreachable";

export interface Icmp6Payload {
  type: Icmp6Type;
  code: number;
  identifier?: number;
  sequence?: number;
  /** Target address for NDP Neighbor Solicitation/Advertisement (spec §40). */
  targetAddr?: string;
  /** Link-layer address option (sender MAC in NS, target MAC in NA). */
  linkLayerAddr?: string;
  errorInfo?: string;
}

export interface UdpHeader {
  srcPort: number;
  dstPort: number;
  length: number;
}

/** NTP application payload (spec §23) — carried over UDP/123. */
export interface NtpPayload {
  mode: "client" | "server";
  version: number;
  stratum: number;
  /** Simulated transmit timestamp (ms on the sender's clock). */
  transmitTs: number;
  /** Reference/originate timestamps for the client-side offset/delay maths. */
  originateTs?: number;
  receiveTs?: number;
}

export type DhcpMessageType = "discover" | "offer" | "request" | "ack" | "nak";

/** DHCP application payload (spec §22) — carried over UDP/67-68. */
export interface DhcpPayload {
  messageType: DhcpMessageType;
  clientMac: string;
  yourIp?: string; // offered/assigned address (OFFER/ACK)
  serverIp?: string; // DHCP server identifier
  gateway?: string;
  dns?: string;
  prefix?: number;
  requestedIp?: string; // REQUEST
  leaseSeconds?: number;
  giaddr?: string; // relay agent (gateway) IP — set by a DHCP relay, selects the server's pool
}

/** DNS application payload (spec §DNS) — carried over UDP/53. */
export interface DnsPayload {
  kind: "query" | "response";
  name: string; // queried hostname
  address?: string; // resolved A record (response)
  rcode?: "noerror" | "nxdomain";
}

export interface TcpHeader {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: string[]; // e.g. ["SYN"], ["SYN","ACK"], ["PSH","ACK"]
  window: number;
}

export type BgpMessageType = "open" | "update" | "keepalive" | "notification";

export interface BgpNlri {
  network: string;
  prefix: number;
}

/** BGP message (spec §25) — carried over TCP/179. */
export interface BgpPayload {
  messageType: BgpMessageType;
  as?: number; // OPEN: my AS
  routerId?: string; // OPEN: BGP identifier
  holdTime?: number;
  nlri?: BgpNlri[]; // advertised prefixes (piggybacked)
}

export type OspfPacketType = "hello" | "dbd" | "lsr" | "lsu" | "lsack";

export interface OspfNetworkLsa {
  network: string;
  prefix: number;
  metric: number;
}

/** OSPF packet (spec §24) — carried directly over IP protocol 89. */
export interface OspfPayload {
  packetType: OspfPacketType;
  routerId: string;
  area: string;
  /** Hello: neighbor router-ids seen (for 2-way detection). */
  neighbors?: string[];
  /** LSU (simplified): advertised networks. */
  networks?: OspfNetworkLsa[];
}

/** STP Configuration BPDU payload (IEEE 802.1D / 802.1w). */
export interface StpPayload {
  protocolId: number; // 0 for IEEE 802.1D
  version: number; // 0 for STP, 2 for RSTP
  bpduType: number; // 0 for Configuration BPDU, 0x80 for TCN
  flags: number;
  rootBridgeId: string;
  rootPathCost: number;
  bridgeId: string;
  portId: string;
  messageAge: number;
  maxAge: number;
  helloTime: number;
  forwardDelay: number;
}

export interface FrameMeta {
  sizeBytes: number;
  summary: string; // one-line description for timelines / tcpdump
}

export interface Frame {
  id: string;
  ethernet: EthernetHeader;
  vlan?: Dot1QTag;
  arp?: ArpPayload;
  ipv4?: Ipv4Header;
  icmp?: IcmpPayload;
  ipv6?: Ipv6Header;
  icmp6?: Icmp6Payload;
  udp?: UdpHeader;
  ntp?: NtpPayload;
  dhcp?: DhcpPayload;
  dns?: DnsPayload;
  ospf?: OspfPayload;
  tcp?: TcpHeader;
  bgp?: BgpPayload;
  stp?: StpPayload;
  /** sFlow v5 datagram octets carried as the UDP payload (agent → collector). */
  sflow?: { datagram: number[] };
  /**
   * Bytes after the Ethernet/802.1Q header for frames built by the packet
   * engine (lib/packetgen). The typed headers above are parsed from them and
   * drive forwarding; these bytes are what goes on the wire, so any protocol
   * the engine can build crosses the simulated network intact.
   */
  rawL3?: number[];
  meta: FrameMeta;
}

/** Deep copy so timeline snapshots are immutable against later mutation. */
export function cloneFrame(f: Frame): Frame {
  return JSON.parse(JSON.stringify(f)) as Frame;
}

// ---------------------------------------------------------------------------
// Inspector projection (spec §14). Derived view — do not store separately.
// ---------------------------------------------------------------------------

export interface InspectorField {
  label: string;
  value: string;
}

export interface InspectorLayer {
  /** OSI layer number, for cross-highlighting with the OSI panel (§31). */
  osiLayer: number;
  title: string;
  /** Protocol data unit name at this layer: Frame / Packet / Segment / Datagram / Message (spec: correct terminology). */
  unit?: string;
  fields: InspectorField[];
}

const ETHERTYPE_HEX: Record<EtherType, string> = {
  IPv4: "0x0800",
  ARP: "0x0806",
  IPv6: "0x86DD",
  Other: "",
};
const IP_PROTO_NUM: Record<IpProtocol, number> = { ICMP: 1, TCP: 6, UDP: 17, OSPF: 89, OTHER: 0 };

function etherTypeLabel(e: EthernetHeader): string {
  if (e.etherType === "Other") return `0x${(e.typeCode ?? 0).toString(16).padStart(4, "0").toUpperCase()}`;
  return `${ETHERTYPE_HEX[e.etherType]} (${e.etherType})`;
}
const ICMP_TYPE_NUM: Record<IcmpType, number> = {
  "echo-request": 8,
  "echo-reply": 0,
  "time-exceeded": 11,
  "dest-unreachable": 3,
};

export function describeFrame(f: Frame): InspectorLayer[] {
  const layers: InspectorLayer[] = [];

  layers.push({
    osiLayer: 2,
    title: "Ethernet II",
    unit: "Frame",
    fields: [
      { label: "Destination", value: f.ethernet.dstMac },
      { label: "Source", value: f.ethernet.srcMac },
      {
        label: "Type",
        value: f.vlan
          ? "0x8100 (802.1Q)"
          : etherTypeLabel(f.ethernet),
      },
    ],
  });

  if (f.vlan) {
    layers.push({
      osiLayer: 2,
      title: "802.1Q Virtual LAN",
      fields: [
        { label: "VLAN ID", value: String(f.vlan.vlanId) },
        { label: "Priority", value: String(f.vlan.priority) },
        {
          label: "Encapsulated",
          value: etherTypeLabel(f.ethernet),
        },
      ],
    });
  }

  if (f.arp) {
    layers.push({
      osiLayer: 2,
      title: "Address Resolution Protocol",
      unit: "Message",
      fields: [
        { label: "Hardware type", value: "Ethernet (1)" },
        { label: "Protocol type", value: "IPv4 (0x0800)" },
        { label: "Opcode", value: f.arp.op === "request" ? "request (1)" : "reply (2)" },
        { label: "Sender MAC", value: f.arp.senderMac },
        { label: "Sender IP", value: f.arp.senderIp },
        { label: "Target MAC", value: f.arp.targetMac },
        { label: "Target IP", value: f.arp.targetIp },
      ],
    });
  }

  if (f.ipv4) {
    layers.push({
      osiLayer: 3,
      title: "Internet Protocol Version 4",
      unit: "Packet",
      fields: [
        { label: "Version", value: "4" },
        { label: "Header length", value: "20 bytes (5 words)" },
        { label: "Source", value: f.ipv4.srcIp },
        { label: "Destination", value: f.ipv4.dstIp },
        { label: "TTL", value: String(f.ipv4.ttl) },
        {
          label: "Protocol",
          value: f.ipv4.protocol === "OTHER" ? String(f.ipv4.protocolNumber ?? 0) : `${IP_PROTO_NUM[f.ipv4.protocol]} (${f.ipv4.protocol})`,
        },
        { label: "Identification", value: String(f.ipv4.identification) },
      ],
    });
  }

  if (f.icmp) {
    const typeName: Record<IcmpType, string> = {
      "echo-request": "Echo (ping) request",
      "echo-reply": "Echo (ping) reply",
      "time-exceeded": "Time-to-live exceeded",
      "dest-unreachable": "Destination unreachable",
    };
    const fields: InspectorField[] = [
      { label: "Type", value: `${ICMP_TYPE_NUM[f.icmp.type]} (${typeName[f.icmp.type]})` },
      { label: "Code", value: String(f.icmp.code) },
      { label: "Identifier", value: String(f.icmp.identifier) },
      { label: "Sequence", value: String(f.icmp.sequence) },
    ];
    if (f.icmp.errorInfo) fields.push({ label: "Caused by", value: f.icmp.errorInfo });
    layers.push({ osiLayer: 3, title: "Internet Control Message Protocol", unit: "Message", fields });
  }

  if (f.ipv6) {
    layers.push({
      osiLayer: 3,
      title: "Internet Protocol Version 6",
      unit: "Packet",
      fields: [
        { label: "Version", value: "6" },
        { label: "Source", value: f.ipv6.srcIp },
        { label: "Destination", value: f.ipv6.dstIp },
        { label: "Hop Limit", value: String(f.ipv6.hopLimit) },
        { label: "Next Header", value: f.ipv6.nextHeader },
      ],
    });
  }

  if (f.icmp6) {
    const typeLabel: Record<Icmp6Type, string> = {
      "echo-request": "128 (Echo Request)",
      "echo-reply": "129 (Echo Reply)",
      "neighbor-solicitation": "135 (Neighbor Solicitation)",
      "neighbor-advertisement": "136 (Neighbor Advertisement)",
      "time-exceeded": "3 (Time Exceeded)",
      "dest-unreachable": "1 (Destination Unreachable)",
    };
    const fields: InspectorField[] = [
      { label: "Type", value: typeLabel[f.icmp6.type] },
      { label: "Code", value: String(f.icmp6.code) },
    ];
    if (f.icmp6.targetAddr) fields.push({ label: "Target Address", value: f.icmp6.targetAddr });
    if (f.icmp6.linkLayerAddr) fields.push({ label: "Link-layer Address", value: f.icmp6.linkLayerAddr });
    if (f.icmp6.identifier !== undefined) fields.push({ label: "Identifier", value: String(f.icmp6.identifier) });
    if (f.icmp6.sequence !== undefined) fields.push({ label: "Sequence", value: String(f.icmp6.sequence) });
    if (f.icmp6.errorInfo) fields.push({ label: "Caused by", value: f.icmp6.errorInfo });
    layers.push({ osiLayer: 3, title: "Internet Control Message Protocol v6", unit: "Message", fields });
  }

  if (f.udp) {
    layers.push({
      osiLayer: 4,
      title: "User Datagram Protocol",
      unit: "Datagram",
      fields: [
        { label: "Source Port", value: String(f.udp.srcPort) },
        { label: "Destination Port", value: String(f.udp.dstPort) },
        { label: "Length", value: String(f.udp.length) },
      ],
    });
  }

  if (f.ntp) {
    layers.push({
      osiLayer: 7,
      title: "Network Time Protocol",
      unit: "Message",
      fields: [
        { label: "Mode", value: f.ntp.mode === "client" ? "client (3)" : "server (4)" },
        { label: "Version", value: String(f.ntp.version) },
        { label: "Stratum", value: String(f.ntp.stratum) },
        { label: "Transmit Timestamp", value: String(f.ntp.transmitTs) },
      ],
    });
  }

  if (f.dns) {
    layers.push({
      osiLayer: 7,
      title: "Domain Name System",
      unit: "Message",
      fields: [
        { label: "Type", value: f.dns.kind === "query" ? "query" : "response" },
        { label: "Name", value: f.dns.name },
        ...(f.dns.address ? [{ label: "Address (A)", value: f.dns.address }] : []),
        ...(f.dns.rcode ? [{ label: "Rcode", value: f.dns.rcode }] : []),
      ],
    });
  }

  if (f.tcp) {
    layers.push({
      osiLayer: 4,
      title: "Transmission Control Protocol",
      unit: "Segment",
      fields: [
        { label: "Source Port", value: String(f.tcp.srcPort) },
        { label: "Destination Port", value: String(f.tcp.dstPort) },
        { label: "Sequence", value: String(f.tcp.seq) },
        { label: "Acknowledgement", value: String(f.tcp.ack) },
        { label: "Flags", value: f.tcp.flags.join(", ") || "(none)" },
        { label: "Window", value: String(f.tcp.window) },
      ],
    });
  }

  if (f.bgp) {
    const b = f.bgp;
    const typeLabel: Record<BgpMessageType, string> = {
      open: "1 (OPEN)",
      update: "2 (UPDATE)",
      keepalive: "4 (KEEPALIVE)",
      notification: "3 (NOTIFICATION)",
    };
    const fields: InspectorField[] = [{ label: "Type", value: typeLabel[b.messageType] }];
    if (b.as !== undefined) fields.push({ label: "My AS", value: String(b.as) });
    if (b.routerId) fields.push({ label: "BGP Identifier", value: b.routerId });
    if (b.holdTime !== undefined) fields.push({ label: "Hold Time", value: String(b.holdTime) });
    if (b.nlri?.length) fields.push({ label: "NLRI", value: b.nlri.map((n) => `${n.network}/${n.prefix}`).join(", ") });
    layers.push({ osiLayer: 7, title: "Border Gateway Protocol", unit: "Message", fields });
  }

  if (f.ospf) {
    const o = f.ospf;
    const typeLabel: Record<OspfPacketType, string> = {
      hello: "1 (Hello)",
      dbd: "2 (Database Description)",
      lsr: "3 (Link State Request)",
      lsu: "4 (Link State Update)",
      lsack: "5 (Link State Ack)",
    };
    const fields: InspectorField[] = [
      { label: "Packet Type", value: typeLabel[o.packetType] },
      { label: "Router ID", value: o.routerId },
      { label: "Area", value: o.area },
    ];
    if (o.neighbors?.length) fields.push({ label: "Neighbors seen", value: o.neighbors.join(", ") });
    if (o.networks?.length) {
      fields.push({ label: "Advertised", value: o.networks.map((n) => `${n.network}/${n.prefix}`).join(", ") });
    }
    layers.push({ osiLayer: 3, title: "Open Shortest Path First", unit: "Packet", fields });
  }

  if (f.dhcp) {
    const d = f.dhcp;
    const fields: InspectorField[] = [
      { label: "Message Type", value: d.messageType.toUpperCase() },
      { label: "Client MAC", value: d.clientMac },
    ];
    if (d.yourIp) fields.push({ label: "Your (client) IP", value: d.yourIp });
    if (d.requestedIp) fields.push({ label: "Requested IP", value: d.requestedIp });
    if (d.serverIp) fields.push({ label: "Server Identifier", value: d.serverIp });
    if (d.gateway) fields.push({ label: "Gateway (Router)", value: d.gateway });
    if (d.dns) fields.push({ label: "DNS Server", value: d.dns });
    if (d.leaseSeconds) fields.push({ label: "Lease Time", value: `${d.leaseSeconds}s` });
    layers.push({ osiLayer: 7, title: "Dynamic Host Configuration Protocol", unit: "Message", fields });
  }

  if (f.stp) {
    const s = f.stp;
    layers.push({
      osiLayer: 2,
      title: "Spanning Tree Protocol (IEEE 802.1D)",
      unit: "BPDU",
      fields: [
        { label: "Protocol Identifier", value: "Spanning Tree (0x0000)" },
        { label: "Protocol Version", value: s.version === 2 ? "Rapid STP (2)" : "STP (0)" },
        { label: "BPDU Type", value: s.bpduType === 0 ? "Configuration (0x00)" : "Topology Change (0x80)" },
        { label: "Root Bridge ID", value: s.rootBridgeId },
        { label: "Root Path Cost", value: String(s.rootPathCost) },
        { label: "Bridge ID", value: s.bridgeId },
        { label: "Port ID", value: s.portId },
        { label: "Message Age", value: `${s.messageAge}s` },
        { label: "Max Age", value: `${s.maxAge}s` },
        { label: "Hello Time", value: `${s.helloTime}s` },
        { label: "Forward Delay", value: `${s.forwardDelay}s` },
      ],
    });
  }

  return layers;
}

/**
 * Encapsulation stack (spec §"PACKET ENCAPSULATION VIEW") from outer to inner
 * data unit, e.g. ["Ethernet Frame", "IPv4 Packet", "ICMP Message"].
 */
export function encapsulationStack(f: Frame): string[] {
  const stack: string[] = ["Ethernet Frame"];
  if (f.vlan) stack.push("802.1Q Tag");
  if (f.stp) stack.push("STP BPDU");
  if (f.arp) stack.push("ARP Message");
  if (f.ipv4) stack.push("IPv4 Packet");
  if (f.icmp) stack.push("ICMP Message");
  if (f.ipv6) stack.push("IPv6 Packet");
  if (f.icmp6) stack.push("ICMPv6 Message");
  if (f.udp) stack.push("UDP Datagram");
  if (f.ntp) stack.push("NTP Message");
  if (f.dhcp) stack.push("DHCP Message");
  if (f.dns) stack.push("DNS Message");
  if (f.ospf) stack.push("OSPF Packet");
  if (f.tcp) stack.push("TCP Segment");
  if (f.bgp) stack.push("BGP Message");
  return stack;
}
