/**
 * IPv6 engine (spec §40): the v6 counterpart to arp.ts + ipv4.ts + icmp.ts + the
 * host/router receive paths. Uses NDP (Neighbor Solicitation / Advertisement over
 * ICMPv6) instead of ARP, and ICMPv6 for echo. Reuses the same L2 delivery so v6
 * frames traverse the real switch/flood path and show in the timeline/inspector.
 */
import { Device, NdpEntry, findInterface } from "../models/device";
import { NetInterface, primaryIpv6, ownsIp6 } from "../models/interface";
import { Frame, Icmp6Payload, Ipv6NextHeader } from "../models/packet";
import { BROADCAST_MAC, NULL_MAC, isBroadcast, isMulticast } from "../models/mac";
import { parseIpv6, formatIpv6, normalizeIpv6 } from "../models/ipv6";
import { longestPrefixMatch6 } from "../models/route";
import { SimContext } from "../engine/context";
import { buildFrame } from "./ethernet";

export const IPV6_HEADER_BYTES = 40;
export const ICMP6_HEADER_BYTES = 8;
export const ICMP6_ECHO_DATA_BYTES = 56;
export const ICMP6_ECHO_TOTAL = ICMP6_HEADER_BYTES + ICMP6_ECHO_DATA_BYTES;
const NDP_BYTES = 32;

export function echo6(type: "echo-request" | "echo-reply", identifier: number, sequence: number): Icmp6Payload {
  return { type, code: 0, identifier, sequence };
}

/** Solicited-node multicast address for a target: ff02::1:ffXX:XXXX (spec §40). */
function solicitedNode(target: string): string {
  const t = parseIpv6(target);
  if (t === null) return "ff02::1:ff00:0";
  const base = parseIpv6("ff02::1:ff00:0")!;
  return formatIpv6(base | (t & 0xffffffn));
}

/** Multicast MAC 33:33:ff:xx:xx:xx from the low 24 bits of the target (spec §40). */
function multicastMac(target: string): string {
  const t = parseIpv6(target);
  const low = t === null ? 0n : t & 0xffffffn;
  const b = (shift: bigint) => Number((low >> shift) & 0xffn).toString(16).padStart(2, "0").toUpperCase();
  return `33:33:FF:${b(16n)}:${b(8n)}:${b(0n)}`;
}

// --- neighbor cache --------------------------------------------------------

export function learnNdp(device: Device, ip: string, mac: string, interfaceId: string): boolean {
  const key = normalizeIpv6(ip);
  const table = device.ndpTable ?? (device.ndpTable = []);
  const existing = table.find((e) => normalizeIpv6(e.ip) === key);
  if (existing) {
    const changed = existing.mac !== mac || existing.state !== "reachable";
    existing.mac = mac;
    existing.interfaceId = interfaceId;
    existing.state = "reachable";
    return changed;
  }
  const entry: NdpEntry = { ip: key, mac, interfaceId, state: "reachable" };
  table.push(entry);
  return true;
}

function markIncomplete(device: Device, ip: string, interfaceId: string): void {
  const table = device.ndpTable ?? (device.ndpTable = []);
  const key = normalizeIpv6(ip);
  const e = table.find((x) => normalizeIpv6(x.ip) === key);
  if (e) e.state = "incomplete";
  else table.push({ ip: key, mac: NULL_MAC, interfaceId, state: "incomplete" });
}

/** Resolve a next-hop v6 address to a MAC via NDP (cache, else Neighbor Solicitation). */
export function resolveNdp(ctx: SimContext, device: Device, iface: NetInterface, ip: string): string | null {
  if (ownsIp6(iface, ip)) return iface.mac;
  const key = normalizeIpv6(ip);
  const cached = (device.ndpTable ?? []).find((e) => normalizeIpv6(e.ip) === key && e.state === "reachable");
  if (cached) return cached.mac;

  const src = primaryIpv6(iface);
  if (!src) return null;

  const ns: Icmp6Payload = {
    type: "neighbor-solicitation",
    code: 0,
    targetAddr: ip,
    linkLayerAddr: iface.mac,
  };
  const frame = buildFrame(
    {
      srcMac: iface.mac,
      dstMac: multicastMac(ip),
      etherType: "IPv6",
      payloadBytes: IPV6_HEADER_BYTES + NDP_BYTES,
      summary: `NDP Neighbor Solicitation who-has ${ip}`,
    },
    {
      ipv6: { srcIp: src.address, dstIp: solicitedNode(ip), hopLimit: 255, nextHeader: "ICMPv6" },
      icmp6: ns,
    },
  );
  ctx.emit({
    type: "NDP_SOLICITATION",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: iface.id,
    interfaceName: iface.name,
    message: `${device.name}: NDP who-has ${ip}? (solicited-node multicast)`,
    osiLayers: [3],
    frame,
  });
  ctx.transmit(device.id, iface.id, frame);

  const resolved = (device.ndpTable ?? []).find((e) => normalizeIpv6(e.ip) === key && e.state === "reachable");
  if (resolved) {
    ctx.emit({
      type: "NDP_RESOLVED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: iface.id,
      interfaceName: iface.name,
      message: `${device.name}: ${ip} is at ${resolved.mac}`,
      osiLayers: [3],
    });
    return resolved.mac;
  }
  markIncomplete(device, ip, iface.id);
  return null;
}

// --- IPv6 output (route → NDP → frame → transmit) --------------------------

export interface Ip6OutputOpts {
  srcIp: string;
  dstIp: string;
  hopLimit: number;
  nextHeader: Ipv6NextHeader;
  icmp6?: Icmp6Payload;
  upperBytes: number;
  summary: string;
}

export interface Ip6OutputResult {
  ok: boolean;
  reason?: "no-route" | "no-egress" | "ndp-failed";
}

export function ip6Output(ctx: SimContext, device: Device, opts: Ip6OutputOpts): Ip6OutputResult {
  const match = longestPrefixMatch6(device.routingTable6 ?? [], opts.dstIp);
  const egress = match ? findInterface(device, match.route.interfaceId) : undefined;
  ctx.emit({
    type: "ROUTE_LOOKUP",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: egress?.id,
    interfaceName: egress?.name,
    message: `${device.name}: IPv6 routing lookup for ${opts.dstIp}${match ? "" : " — no route"}`,
    osiLayers: [3],
  });
  if (!match) return { ok: false, reason: "no-route" };
  if (!egress) return { ok: false, reason: "no-egress" };

  const mac = resolveNdp(ctx, device, egress, match.nextHopIp);
  if (!mac) return { ok: false, reason: "ndp-failed" };

  const frame = buildFrame(
    {
      srcMac: egress.mac,
      dstMac: mac,
      etherType: "IPv6",
      payloadBytes: IPV6_HEADER_BYTES + opts.upperBytes,
      summary: opts.summary,
    },
    {
      ipv6: { srcIp: opts.srcIp, dstIp: opts.dstIp, hopLimit: opts.hopLimit, nextHeader: opts.nextHeader },
      icmp6: opts.icmp6,
    },
  );
  ctx.emit({
    type: "IP_PACKET_CREATED",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: egress.id,
    interfaceName: egress.name,
    message: `${device.name}: created IPv6 packet ${opts.srcIp} → ${opts.dstIp} (${opts.nextHeader}, hlim ${opts.hopLimit})`,
    osiLayers: [3],
    frame,
  });
  ctx.transmit(device.id, egress.id, frame);
  return { ok: true };
}

// --- NDP frame handlers ----------------------------------------------------

function handleNdp(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const icmp6 = frame.icmp6!;
  const ip6 = frame.ipv6!;
  if (icmp6.type === "neighbor-solicitation") {
    // Learn the solicitor, then answer if we own the target.
    if (icmp6.linkLayerAddr && ip6.srcIp !== "::") learnNdp(device, ip6.srcIp, icmp6.linkLayerAddr, ingress.id);
    const owner = device.interfaces.find((i) => icmp6.targetAddr && ownsIp6(i, icmp6.targetAddr));
    if (!owner) return;
    const na: Icmp6Payload = {
      type: "neighbor-advertisement",
      code: 0,
      targetAddr: icmp6.targetAddr,
      linkLayerAddr: owner.mac,
    };
    const out = buildFrame(
      {
        srcMac: owner.mac,
        dstMac: frame.ethernet.srcMac,
        etherType: "IPv6",
        payloadBytes: IPV6_HEADER_BYTES + NDP_BYTES,
        summary: `NDP Neighbor Advertisement ${icmp6.targetAddr} is-at ${owner.mac}`,
      },
      {
        ipv6: { srcIp: icmp6.targetAddr!, dstIp: ip6.srcIp, hopLimit: 255, nextHeader: "ICMPv6" },
        icmp6: na,
      },
    );
    ctx.emit({
      type: "NDP_ADVERTISEMENT",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: ${icmp6.targetAddr} is-at ${owner.mac} → ${ip6.srcIp}`,
      osiLayers: [3],
      frame: out,
    });
    ctx.transmit(device.id, ingress.id, out);
    return;
  }
  if (icmp6.type === "neighbor-advertisement" && icmp6.targetAddr && icmp6.linkLayerAddr) {
    learnNdp(device, icmp6.targetAddr, icmp6.linkLayerAddr, ingress.id);
  }
}

function localEcho6(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const icmp6 = frame.icmp6;
  const ip6 = frame.ipv6!;
  if (!icmp6) return;
  if (icmp6.type === "echo-request") {
    ctx.emit({
      type: "ICMP6_ECHO_REPLY",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: ICMPv6 echo request from ${ip6.srcIp} → sending reply`,
      osiLayers: [3],
    });
    ip6Output(ctx, device, {
      srcIp: ip6.dstIp,
      dstIp: ip6.srcIp,
      hopLimit: 64,
      nextHeader: "ICMPv6",
      icmp6: echo6("echo-reply", icmp6.identifier ?? 0, icmp6.sequence ?? 0),
      upperBytes: ICMP6_ECHO_TOTAL,
      summary: `ICMPv6 echo reply id ${icmp6.identifier} seq ${icmp6.sequence}`,
    });
    return;
  }
  if (icmp6.type === "echo-reply") ctx.recordEchoReply(device.id, frame);
}

/** Host IPv6 receive: NDP, then local ICMPv6; hosts never forward. */
export function hostReceiveV6(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const ip6 = frame.ipv6;
  if (!ip6) return;
  if (frame.icmp6 && (frame.icmp6.type === "neighbor-solicitation" || frame.icmp6.type === "neighbor-advertisement")) {
    handleNdp(ctx, device, ingress, frame);
    return;
  }
  const dstMac = frame.ethernet.dstMac;
  if (!isBroadcast(dstMac) && !isMulticast(dstMac) && dstMac !== ingress.mac) {
    ctx.emit({
      type: "FRAME_DROPPED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: IPv6 frame not addressed to ${ingress.name} — dropped`,
      osiLayers: [2],
      frame,
    });
    return;
  }
  if (device.interfaces.some((i) => ownsIp6(i, ip6.dstIp))) {
    localEcho6(ctx, device, ingress, frame);
    return;
  }
  ctx.emit({
    type: "FRAME_DROPPED",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: ${ip6.dstIp} not local and host does not forward — dropped`,
    osiLayers: [3],
    frame,
  });
}

/** Router IPv6 receive: NDP, local ICMPv6, else forward with hop-limit decrement. */
export function routerReceiveV6(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const ip6 = frame.ipv6;
  if (!ip6) return;
  if (frame.icmp6 && (frame.icmp6.type === "neighbor-solicitation" || frame.icmp6.type === "neighbor-advertisement")) {
    handleNdp(ctx, device, ingress, frame);
    return;
  }
  if (device.interfaces.some((i) => ownsIp6(i, ip6.dstIp))) {
    localEcho6(ctx, device, ingress, frame);
    return;
  }
  const newHop = ip6.hopLimit - 1;
  ctx.emit({
    type: "TTL_DECREMENT",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: decrement IPv6 hop-limit ${ip6.hopLimit} → ${newHop}`,
    osiLayers: [3],
  });
  if (newHop <= 0) {
    ctx.emit({
      type: "FRAME_DROPPED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: IPv6 hop-limit exceeded for ${ip6.dstIp}`,
      osiLayers: [3],
      frame,
    });
    return;
  }
  ip6Output(ctx, device, {
    srcIp: ip6.srcIp,
    dstIp: ip6.dstIp,
    hopLimit: newHop,
    nextHeader: ip6.nextHeader,
    icmp6: frame.icmp6,
    upperBytes: ICMP6_ECHO_TOTAL,
    summary: frame.meta.summary,
  });
}
