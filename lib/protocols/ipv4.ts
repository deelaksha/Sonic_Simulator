/**
 * IPv4 output path (spec §9, §60): route lookup → next-hop ARP → new Ethernet
 * frame → transmit. Shared by hosts originating traffic and by ICMP replies.
 * Router forwarding lives in the router module and reuses resolveArp/buildFrame.
 */
import { Device, findInterface } from "../models/device";
import { IcmpPayload, IpProtocol, Ipv4Header, UdpHeader, NtpPayload, DhcpPayload, DnsPayload, TcpHeader, BgpPayload } from "../models/packet";
import { longestPrefixMatch, Route } from "../models/route";
import { cidrContains } from "../models/ip";
import { SimContext } from "../engine/context";
import { RouteTableRow } from "../engine/events";
import { buildFrame } from "./ethernet";
import { resolveArp } from "./arp";

export const IPV4_HEADER_BYTES = 20;

/**
 * Snapshot the routing table for the inspector, flagging which routes CONTAIN the
 * destination IP and which one WON the longest-prefix match (spec §9 lesson).
 */
export function routeTableSnapshot(device: Device, dstIp: string, matched?: Route): RouteTableRow[] {
  return device.routingTable.map((r) => ({
    destination: r.destination,
    prefix: r.prefix,
    nextHop: r.nextHop,
    iface: findInterface(device, r.interfaceId)?.name ?? r.interfaceId,
    type: r.type,
    contains: cidrContains(r.destination, r.prefix, dstIp),
    matched: !!matched && r.destination === matched.destination && r.prefix === matched.prefix && r.type === matched.type,
  }));
}

export interface IpOutputOpts {
  srcIp: string;
  dstIp: string;
  ttl: number;
  protocol: IpProtocol;
  identification: number;
  icmp?: IcmpPayload;
  udp?: UdpHeader;
  ntp?: NtpPayload;
  dhcp?: DhcpPayload;
  dns?: DnsPayload;
  tcp?: TcpHeader;
  bgp?: BgpPayload;
  /** Override the destination MAC (e.g. broadcast for DHCP); default resolves via ARP. */
  dstMacOverride?: string;
  upperBytes: number; // bytes above the IP header (L4 + data)
  summary: string;
}

export interface IpOutputResult {
  ok: boolean;
  reason?: "no-route" | "no-egress" | "arp-failed";
  egressInterfaceId?: string;
}

export function ipOutput(ctx: SimContext, device: Device, opts: IpOutputOpts): IpOutputResult {
  const match = longestPrefixMatch(device.routingTable, opts.dstIp);
  const egress = match ? findInterface(device, match.route.interfaceId) : undefined;

  ctx.emit({
    type: "ROUTE_LOOKUP",
    deviceId: device.id,
    deviceName: device.name,
    message: `${device.name}: routing lookup for ${opts.dstIp}`,
    osiLayers: [3],
    detail: {
      kind: "route-lookup",
      destinationIp: opts.dstIp,
      result: match ? "matched" : "no-route",
      outputInterface: egress?.name,
      nextHop: match ? match.route.nextHop : undefined,
      routingTable: routeTableSnapshot(device, opts.dstIp, match?.route),
    },
  });

  if (!match) return { ok: false, reason: "no-route" };
  if (!egress) return { ok: false, reason: "no-egress" };

  const via = match.route.nextHop ? `via ${match.route.nextHop}` : "connected";
  ctx.emit({
    type: "ROUTE_MATCH",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: egress.id,
    interfaceName: egress.name,
    message: `${device.name}: match ${match.route.destination}/${match.route.prefix} (${match.route.type}) ${via} dev ${egress.name}`,
    osiLayers: [3],
  });

  // DHCP and other broadcast traffic supply the L2 destination directly; unicast resolves via ARP.
  const mac = opts.dstMacOverride ?? resolveArp(ctx, device, egress, match.nextHopIp);
  if (!mac) return { ok: false, reason: "arp-failed", egressInterfaceId: egress.id };

  const ipv4: Ipv4Header = {
    srcIp: opts.srcIp,
    dstIp: opts.dstIp,
    ttl: opts.ttl,
    protocol: opts.protocol,
    identification: opts.identification,
  };

  const frame = buildFrame(
    {
      srcMac: egress.mac,
      dstMac: mac,
      etherType: "IPv4",
      payloadBytes: IPV4_HEADER_BYTES + opts.upperBytes,
      summary: opts.summary,
    },
    { ipv4, icmp: opts.icmp, udp: opts.udp, ntp: opts.ntp, dhcp: opts.dhcp, dns: opts.dns, tcp: opts.tcp, bgp: opts.bgp },
  );

  ctx.emit({
    type: "IP_PACKET_CREATED",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: egress.id,
    interfaceName: egress.name,
    message: `${device.name}: created IP packet ${opts.srcIp} → ${opts.dstIp} (${opts.protocol}, ttl ${opts.ttl})`,
    osiLayers: [3],
    frame,
  });

  ctx.transmit(device.id, egress.id, frame);
  return { ok: true, egressInterfaceId: egress.id };
}
