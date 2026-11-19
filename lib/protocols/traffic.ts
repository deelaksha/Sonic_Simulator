/**
 * Traffic generator (hping/nc-style) over the simulated data plane. Every packet
 * goes through ipOutput → ARP → switch/router forwarding exactly like ping, so
 * MAC learning, sFlow sampling, port counters and tcpdump all see it.
 *
 * Destination behaviour follows a Linux host:
 *   ICMP echo request → echo reply (existing ICMP handler)
 *   TCP → the host TCP stack (./tcp-stack.ts): listeners (nc -l, sshd, nginx)
 *         complete the handshake; a closed port answers RST / RST,ACK
 *   UDP → counted as received by the destination host (and logged by `nc -u -l`)
 */
import { Device } from "../models/device";
import { NetInterface, ownsIp, primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { longestPrefixMatch } from "../models/route";
import { findInterface } from "../models/device";
import { SimContext } from "../engine/context";
import { ipOutput, IpOutputResult } from "./ipv4";
import { ip6Output } from "./ipv6";
import { ICMP_HEADER_BYTES } from "./icmp";
import { bytesToFrame } from "../packetgen/frame";
import { tcpInput, tcpListenerOwner, udpListenerInput } from "./tcp-stack";

/** "engine" = a packet built by the packet engine (lib/packetgen), any protocol. */
export type TrafficProtocol = "icmp" | "udp" | "tcp" | "engine";

export interface TrafficSpec {
  srcDeviceId: string;
  dstIp: string;
  protocol: TrafficProtocol;
  srcPort: number;
  dstPort: number;
  /** Application payload bytes per packet (ping -s / nc / hping -d). */
  size: number;
  /** Packets to send (ignored when continuous). */
  count: number;
  intervalMs: number;
  continuous: boolean;
  /** protocol "engine": the full frame as built, as seen leaving the source host. */
  packet?: { bytes: number[]; summary: string };
}

export interface TrafficSink {
  icmp: { packets: number; bytes: number };
  udp: { packets: number; bytes: number };
  tcp: { packets: number; bytes: number };
}

const UDP_HEADER = 8;
const TCP_HEADER = 20;

export function peekTrafficSink(device: Device): TrafficSink | undefined {
  return peekFeatureState<TrafficSink>(device, "traffic-sink");
}

function sink(device: Device): TrafficSink {
  return featureState<TrafficSink>(device, "traffic-sink", () => ({
    icmp: { packets: 0, bytes: 0 },
    udp: { packets: 0, bytes: 0 },
    tcp: { packets: 0, bytes: 0 },
  }));
}

function isLocal(device: Device, ip: string): boolean {
  return device.interfaces.some((i) => ownsIp(i, ip));
}

/** Count an ICMP echo request that reached its destination host (called by the ICMP handler path). */
export function countIcmpDelivery(device: Device, frame: Frame): void {
  const s = sink(device);
  s.icmp.packets += 1;
  s.icmp.bytes += frame.meta.sizeBytes;
}

export function receiveTrafficUdp(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  // sFlow datagrams are only consumed by a listening collector (lib/sflow/collector.ts).
  if (!frame.ipv4 || !frame.udp || frame.sflow || !isLocal(device, frame.ipv4.dstIp)) return false;
  const s = sink(device);
  s.udp.packets += 1;
  s.udp.bytes += frame.meta.sizeBytes;
  udpListenerInput(device, frame);
  ctx.emit({
    type: "UDP_DATAGRAM",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: received UDP ${frame.ipv4.srcIp}:${frame.udp.srcPort} → :${frame.udp.dstPort} (${frame.udp.length - UDP_HEADER} bytes)`,
    osiLayers: [4],
    frame,
  });
  return true;
}

export function receiveTrafficTcp(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const ip = frame.ipv4;
  const tcp = frame.tcp;
  if (!ip || !tcp || frame.bgp || !isLocal(device, ip.dstIp)) return false;
  const s = sink(device);
  s.tcp.packets += 1;
  s.tcp.bytes += frame.meta.sizeBytes;
  const syn = tcp.flags.includes("SYN") && !tcp.flags.includes("ACK");
  const closedPort = syn && !tcpListenerOwner(device, tcp.dstPort);
  ctx.emit({
    type: "TCP_SEGMENT",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: TCP [${tcp.flags.join(",")}] ${ip.srcIp}:${tcp.srcPort} → :${tcp.dstPort}${closedPort ? " — port closed, answering RST" : ""}`,
    osiLayers: [4],
    frame,
  });
  return tcpInput(ctx, device, frame);
}

export type SendFailure = NonNullable<IpOutputResult["reason"]> | "ndp-failed" | "no-src-ip" | "iface-down" | "no-device";

export interface SendResult {
  ok: boolean;
  reason?: SendFailure;
}

/**
 * Send one engine-built packet. Untagged IPv4/IPv6 is routed like any host
 * traffic (route lookup + ARP/NDP pick the next-hop MAC); anything else —
 * non-IP protocols (LLDP, LACP, MPLS…) or an 802.1Q-tagged frame — leaves the
 * host NIC exactly as built.
 */
function sendEnginePacket(ctx: SimContext, src: Device, packet: NonNullable<TrafficSpec["packet"]>): SendResult {
  const f = bytesToFrame(Uint8Array.from(packet.bytes), packet.summary);
  if (f.ipv4 && !f.vlan) {
    const ip = f.ipv4;
    const r = ipOutput(ctx, src, {
      srcIp: ip.srcIp,
      dstIp: ip.dstIp,
      ttl: ip.ttl,
      protocol: ip.protocol,
      protocolNumber: ip.protocolNumber,
      identification: ip.identification,
      icmp: f.icmp,
      udp: f.udp,
      tcp: f.tcp,
      rawL3: f.rawL3,
      upperBytes: 0,
      summary: packet.summary,
    });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  if (f.ipv6 && !f.vlan) {
    const ip = f.ipv6;
    const r = ip6Output(ctx, src, {
      srcIp: ip.srcIp,
      dstIp: ip.dstIp,
      hopLimit: ip.hopLimit,
      nextHeader: ip.nextHeader,
      icmp6: f.icmp6,
      rawL3: f.rawL3,
      upperBytes: 0,
      summary: packet.summary,
    });
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
  const nic = src.interfaces.find((i) => i.adminState === "up" && !i.logical);
  if (!nic) return { ok: false, reason: "iface-down" };
  ctx.transmit(src.id, nic.id, f);
  return { ok: true };
}

/** Send ONE generated packet (sequence number `seq`) from the spec's source host. */
export function sendTrafficPacket(ctx: SimContext, src: Device, spec: TrafficSpec, seq: number): SendResult {
  if (spec.protocol === "engine") {
    if (!spec.packet) return { ok: false, reason: "no-device" };
    return sendEnginePacket(ctx, src, spec.packet);
  }
  const match = longestPrefixMatch(src.routingTable, spec.dstIp);
  if (!match) return { ok: false, reason: "no-route" };
  const egress = findInterface(src, match.route.interfaceId);
  if (!egress || egress.adminState !== "up") return { ok: false, reason: "iface-down" };
  const srcIp = primaryIpv4(egress)?.address;
  if (!srcIp) return { ok: false, reason: "no-src-ip" };
  const size = Math.max(0, Math.floor(spec.size));

  let r: IpOutputResult;
  if (spec.protocol === "icmp") {
    r = ipOutput(ctx, src, {
      srcIp,
      dstIp: spec.dstIp,
      ttl: 64,
      protocol: "ICMP",
      identification: seq & 0xffff,
      icmp: { type: "echo-request", code: 0, identifier: spec.srcPort & 0xffff, sequence: seq & 0xffff },
      upperBytes: ICMP_HEADER_BYTES + size,
      summary: `ICMP echo request seq ${seq}`,
    });
  } else if (spec.protocol === "udp") {
    r = ipOutput(ctx, src, {
      srcIp,
      dstIp: spec.dstIp,
      ttl: 64,
      protocol: "UDP",
      identification: seq & 0xffff,
      udp: { srcPort: spec.srcPort, dstPort: spec.dstPort, length: UDP_HEADER + size },
      upperBytes: UDP_HEADER + size,
      summary: `UDP ${spec.srcPort} → ${spec.dstPort} len ${size}`,
    });
  } else {
    r = ipOutput(ctx, src, {
      srcIp,
      dstIp: spec.dstIp,
      ttl: 64,
      protocol: "TCP",
      identification: seq & 0xffff,
      tcp: { srcPort: spec.srcPort, dstPort: spec.dstPort, seq: (seq * 1000) >>> 0, ack: 0, flags: ["SYN"], window: 64240 },
      upperBytes: TCP_HEADER + size,
      summary: `TCP ${spec.srcPort} → ${spec.dstPort} [SYN]`,
    });
  }
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/** Validate a spec; returns an error string or null. */
export function validateTrafficSpec(spec: TrafficSpec): string | null {
  if (spec.protocol === "engine") {
    if (!spec.packet?.bytes.length) return "build the packet first";
    if (spec.packet.bytes.length > 9216) return "packet larger than 9216 bytes (jumbo MTU)";
  } else if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(spec.dstIp)) return `invalid destination IP '${spec.dstIp}'`;
  for (const [k, v] of [["source port", spec.srcPort], ["destination port", spec.dstPort]] as const) {
    if ((spec.protocol === "udp" || spec.protocol === "tcp") && (!Number.isInteger(v) || v < 1 || v > 65535)) return `${k} must be 1-65535`;
  }
  if (!Number.isInteger(spec.size) || spec.size < 0 || spec.size > 9000) return "packet size must be 0-9000 bytes";
  if (!spec.continuous && (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > 100000)) return "count must be 1-100000";
  if (!Number.isFinite(spec.intervalMs) || spec.intervalMs < 0 || spec.intervalMs > 60000) return "interval must be 0-60000 ms";
  return null;
}
