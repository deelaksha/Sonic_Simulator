/**
 * IPv6 engine (spec §40): the v6 counterpart to arp.ts + ipv4.ts + icmp.ts + the
 * host/router receive paths. Uses NDP (Neighbor Solicitation / Advertisement over
 * ICMPv6) instead of ARP, and ICMPv6 for echo. Reuses the same L2 delivery so v6
 * frames traverse the real switch/flood path and show in the timeline/inspector.
 */
import { Device, NdpEntry, findInterface, isHost, isRouter, isSwitch } from "../models/device";
import { NetInterface, primaryIpv6, ownsIp6 } from "../models/interface";
import { Frame, Icmp6Payload, Ipv6NextHeader } from "../models/packet";
import { NULL_MAC, isBroadcast, isMulticast, normalizeMac } from "../models/mac";
import {
  parseIpv6,
  formatIpv6,
  normalizeIpv6,
  isLinkLocal6,
  isMulticast6,
  linkLocalFromMac,
  networkAddress6,
  ipv6Bytes,
} from "../models/ipv6";
import { Route, longestPrefixMatch6, carryInstallTime } from "../models/route";
import { SimContext } from "../engine/context";
import { vrfOf } from "../models/vrf";
import { isExtraLocalIp6, isExtraLocalMac } from "../control/hooks";
import { inetChecksum } from "../sflow/wire";
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

/** Ethernet MAC for an IPv6 multicast group: 33:33 + its low 32 bits (RFC 2464 7). */
export function multicastMac6(group: string): string {
  const t = parseIpv6(group) ?? 0n;
  const b = (shift: bigint) => Number((t >> shift) & 0xffn).toString(16).padStart(2, "0").toUpperCase();
  return `33:33:${b(24n)}:${b(16n)}:${b(8n)}:${b(0n)}`;
}

// --- real IPv6 bytes for control-plane packets (RA/RS, OSPFv3, ...) --------

export const IPV6_NH = { ICMPV6: 58, OSPF: 89 } as const;

/** Internet checksum over the IPv6 pseudo-header (RFC 8200 8.1) + upper-layer packet. */
export function pseudoChecksum6(src: string, dst: string, nextHeader: number, upper: number[]): number {
  const len = upper.length;
  return inetChecksum([
    ...ipv6Bytes(src),
    ...ipv6Bytes(dst),
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    0, 0, 0, nextHeader,
    ...upper,
  ]);
}

/** 40-byte IPv6 header + payload. */
export function ipv6Packet(o: { src: string; dst: string; nextHeader: number; hopLimit: number; trafficClass?: number; payload: number[] }): number[] {
  const tc = o.trafficClass ?? 0;
  const len = o.payload.length;
  return [
    0x60 | (tc >> 4), (tc & 0x0f) << 4, 0, 0,
    (len >> 8) & 0xff, len & 0xff, o.nextHeader, o.hopLimit & 0xff,
    ...ipv6Bytes(o.src),
    ...ipv6Bytes(o.dst),
    ...o.payload,
  ];
}

/** Upper-layer bytes of an IPv6 frame that carries real bytes (no extension headers). */
export function ip6Payload(frame: Frame): number[] | undefined {
  const r = frame.rawL3;
  if (!r || !frame.ipv6 || r.length < 40 || r[0] >> 4 !== 6) return undefined;
  return r.slice(40, 40 + ((r[4] << 8) | r[5]));
}

/** Next Header byte of an IPv6 frame with real bytes. */
export const ip6NextHeader = (frame: Frame): number | undefined => (frame.rawL3 && frame.rawL3.length >= 40 ? frame.rawL3[6] : undefined);

export interface ControlIpv6 {
  src: string;
  dst: string;
  nextHeader: number;
  hopLimit: number;
  trafficClass?: number;
  /** Upper-layer packet with its checksum already filled in. */
  payload: number[];
  summary: string;
}

/**
 * Send a link-scoped control packet (multicast or link-local unicast) out of
 * one interface to a given MAC — no route lookup, no NDP.
 */
export function transmitIpv6(ctx: SimContext, device: Device, iface: NetInterface, dstMac: string, o: ControlIpv6): void {
  const rawL3 = ipv6Packet(o);
  const frame = buildFrame(
    { srcMac: iface.mac, dstMac, etherType: "IPv6", payloadBytes: rawL3.length, summary: o.summary },
    { ipv6: { srcIp: o.src, dstIp: o.dst, hopLimit: o.hopLimit, nextHeader: o.nextHeader === IPV6_NH.ICMPV6 ? "ICMPv6" : "OTHER" } },
  );
  frame.rawL3 = rawL3;
  ctx.transmit(device.id, iface.id, frame);
}

// --- control-plane receive registry ------------------------------------------
// IPv6 packets reaching a device's own stack (link-local multicast such as
// ff02::1 / ff02::2 / ff02::5, or unicast to one of its addresses) are offered
// to these receivers first: radvd/SLAAC (radv-daemon.ts), ospf6d (ospf6-daemon.ts).

export type V6Receiver = (ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame) => boolean;
const V6_RECEIVERS: { id: string; fn: V6Receiver }[] = [];

export function registerV6Receiver(id: string, fn: V6Receiver): void {
  const i = V6_RECEIVERS.findIndex((r) => r.id === id);
  if (i >= 0) V6_RECEIVERS[i] = { id, fn };
  else V6_RECEIVERS.push({ id, fn });
}

function dispatchV6(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const dst = frame.ethernet.dstMac;
  if (!isMulticast(dst) && normalizeMac(dst) !== normalizeMac(ingress.mac) && !isExtraLocalMac(device, ingress, dst)) return false;
  for (const r of V6_RECEIVERS) if (r.fn(ctx, device, ingress, frame)) return true;
  return false;
}

// --- addressing: link-locals + connected routes ------------------------------

/** Interface has IPv6 configured (a global address or a link-local). */
export const ipv6Enabled = (iface: NetInterface): boolean => iface.ipv6.length > 0;

/** The interface's link-local address, if any. */
export function linkLocalOf(iface: NetInterface): string | undefined {
  return iface.ipv6.find((a) => isLinkLocal6(a.address))?.address;
}

/** First global (non-link-local) address of an interface. */
export function globalIpv6(iface: NetInterface): string | undefined {
  return iface.ipv6.find((a) => !isLinkLocal6(a.address))?.address;
}

/**
 * Give an IPv6-enabled interface its EUI-64 link-local (fe80::/64) if missing,
 * as the kernel does when IPv6 comes up on it. Link-locals are kept after the
 * global addresses so the primary (source) address stays global.
 */
export function ensureLinkLocal(iface: NetInterface): boolean {
  if (iface.management || /^(Loopback|lo)/.test(iface.name) || linkLocalOf(iface)) return false;
  iface.ipv6.push({ address: linkLocalFromMac(iface.mac), prefix: 64 });
  return true;
}

/** Add a global address before any link-local (keeps primaryIpv6 global). */
export function addGlobal6(iface: NetInterface, address: string, prefix: number): boolean {
  const key = normalizeIpv6(address);
  if (iface.ipv6.some((a) => normalizeIpv6(a.address) === key)) return false;
  const ll = iface.ipv6.findIndex((a) => isLinkLocal6(a.address));
  const entry = { address: key, prefix };
  if (ll < 0) iface.ipv6.push(entry);
  else iface.ipv6.splice(ll, 0, entry);
  return true;
}

/**
 * Rebuild the connected IPv6 routes from interface addressing on hosts,
 * routers AND SONiC switches (routed ports / SVIs), keeping every other route
 * (static, default, OSPFv3, BGP) untouched. Link-locals add no route.
 */
export function syncConnected6(device: Device): boolean {
  if (!isHost(device.type) && !isRouter(device.type) && !isSwitch(device.type)) return false;
  const table = device.routingTable6 ?? (device.routingTable6 = []);
  const prev = table.filter((r) => r.type === "connected");
  const next: Route[] = [];
  for (const iface of device.interfaces) {
    if (iface.operState !== "up" && iface.adminState !== "up") continue;
    if (iface.management && isSwitch(device.type)) continue;
    for (const a of iface.ipv6) {
      if (isLinkLocal6(a.address)) continue;
      const destination = networkAddress6(a.address, a.prefix);
      if (next.some((r) => r.destination === destination && r.prefix === a.prefix && r.interfaceId === iface.id)) continue;
      next.push({ destination, prefix: a.prefix, nextHop: null, interfaceId: iface.id, type: "connected", metric: 0 });
    }
  }
  const strip = (l: Route[]) => JSON.stringify(l.map(({ installedAtMs: _t, ...rest }) => rest));
  if (strip(prev) === strip(next)) return false;
  carryInstallTime(prev, next, Date.now());
  device.routingTable6 = [...next, ...table.filter((r) => r.type !== "connected")];
  return true;
}

/**
 * Unsolicited Neighbor Advertisement (RFC 4861 7.2.6) for `address` out of
 * `iface` to all-nodes (ff02::1), Override flag set — used when an address moves
 * to a new MAC (VRRPv3 Master, address added). `mac` defaults to the interface MAC.
 */
export function sendUnsolicitedNa(ctx: SimContext, device: Device, iface: NetInterface, address: string, mac = iface.mac): void {
  const frame = buildFrame(
    {
      srcMac: mac,
      dstMac: multicastMac6("ff02::1"),
      etherType: "IPv6",
      payloadBytes: IPV6_HEADER_BYTES + NDP_BYTES,
      summary: `NDP unsolicited Neighbor Advertisement ${address} is-at ${mac}`,
    },
    {
      ipv6: { srcIp: address, dstIp: "ff02::1", hopLimit: 255, nextHeader: "ICMPv6" },
      icmp6: { type: "neighbor-advertisement", code: 0, targetAddr: address, linkLayerAddr: mac },
    },
  );
  ctx.emit({
    type: "NDP_ADVERTISEMENT",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: iface.id,
    interfaceName: iface.name,
    message: `${device.name}: unsolicited NA ${address} is-at ${mac} → ff02::1`,
    osiLayers: [3],
    frame,
  });
  ctx.transmit(device.id, iface.id, frame);
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

  const src = isLinkLocal6(ip) ? (linkLocalOf(iface) ?? primaryIpv6(iface)?.address) : primaryIpv6(iface)?.address;
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
      ipv6: { srcIp: src, dstIp: solicitedNode(ip), hopLimit: 255, nextHeader: "ICMPv6" },
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
  /** Engine-built packet bytes (IPv6 header onward) to carry verbatim (Frame.rawL3). */
  rawL3?: number[];
  /** Routing table to use (Route.vrf); default VRF when unset. */
  vrf?: string;
}

export interface Ip6OutputResult {
  ok: boolean;
  reason?: "no-route" | "no-egress" | "ndp-failed";
}

export function ip6Output(ctx: SimContext, device: Device, opts: Ip6OutputOpts): Ip6OutputResult {
  const match = longestPrefixMatch6(device.routingTable6 ?? [], opts.dstIp, opts.vrf);
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
      payloadBytes: opts.rawL3 ? opts.rawL3.length : IPV6_HEADER_BYTES + opts.upperBytes,
      summary: opts.summary,
    },
    {
      ipv6: { srcIp: opts.srcIp, dstIp: opts.dstIp, hopLimit: opts.hopLimit, nextHeader: opts.nextHeader },
      icmp6: opts.icmp6,
    },
  );
  if (opts.rawL3) frame.rawL3 = opts.rawL3;
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
    // Learn the solicitor, then answer if we own the target (link-locals are per link).
    if (icmp6.linkLayerAddr && ip6.srcIp !== "::") learnNdp(device, ip6.srcIp, icmp6.linkLayerAddr, ingress.id);
    const target = icmp6.targetAddr;
    const owner = target
      ? ownsIp6(ingress, target)
        ? ingress
        : isLinkLocal6(target)
          ? undefined
          : device.interfaces.find((i) => ownsIp6(i, target))
      : undefined;
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

const isNdp = (frame: Frame) => frame.icmp6?.type === "neighbor-solicitation" || frame.icmp6?.type === "neighbor-advertisement";

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
  if (icmp6.type === "echo-reply") {
    ctx.recordEchoReply(device.id, frame);
    return;
  }
  if (icmp6.type === "time-exceeded" || icmp6.type === "dest-unreachable") {
    // An ICMPv6 error for a packet we sent (traceroute6 reads these events).
    ctx.emit({
      type: icmp6.type === "time-exceeded" ? "ICMP_TIME_EXCEEDED" : "ICMP_UNREACHABLE",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: ICMPv6 ${icmp6.type === "time-exceeded" ? "time exceeded in-transit" : "destination unreachable"} from ${ip6.srcIp}`,
      osiLayers: [3],
      frame,
    });
  }
}

/** ICMPv6 error sizes: 8-byte header + as much of the invoking packet as fits in 1280 (RFC 4443 2.4). */
const ICMP6_ERROR_UPPER_BYTES = ICMP6_HEADER_BYTES + IPV6_HEADER_BYTES + ICMP6_ECHO_TOTAL;

/**
 * Send an ICMPv6 error (RFC 4443) back to the source of `frame`. Never in
 * response to an ICMPv6 error, a multicast destination or the unspecified /
 * a link-local source beyond its link (RFC 4443 2.4 (e)).
 */
function sendIcmp6Error(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame, type: "time-exceeded" | "dest-unreachable", code: number): void {
  const ip6 = frame.ipv6!;
  if (frame.icmp6 && (frame.icmp6.type === "time-exceeded" || frame.icmp6.type === "dest-unreachable")) return;
  if (isMulticast6(ip6.dstIp) || ip6.srcIp === "::" || isMulticast6(ip6.srcIp)) return;
  const src = globalIpv6(ingress) ?? linkLocalOf(ingress);
  if (!src) return;
  ctx.emit({
    type: type === "time-exceeded" ? "ICMP_TIME_EXCEEDED" : "ICMP_UNREACHABLE",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message:
      type === "time-exceeded"
        ? `${device.name}: hop limit exceeded for ${ip6.dstIp} → ICMPv6 time exceeded to ${ip6.srcIp}`
        : `${device.name}: no route to ${ip6.dstIp} → ICMPv6 destination unreachable (code ${code}) to ${ip6.srcIp}`,
    osiLayers: [3],
  });
  ip6Output(ctx, device, {
    srcIp: src,
    dstIp: ip6.srcIp,
    hopLimit: 64,
    nextHeader: "ICMPv6",
    icmp6: {
      type,
      code,
      identifier: frame.icmp6?.identifier,
      sequence: frame.icmp6?.sequence,
      errorInfo: `IPv6 ${ip6.srcIp} → ${ip6.dstIp}`,
    },
    upperBytes: ICMP6_ERROR_UPPER_BYTES,
    summary: `ICMPv6 ${type} → ${ip6.srcIp}`,
  });
}

/** Host IPv6 receive: NDP, control-plane receivers (RA → SLAAC), then local ICMPv6; hosts never forward. */
export function hostReceiveV6(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const ip6 = frame.ipv6;
  if (!ip6) return;
  if (isNdp(frame)) {
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
  if (dispatchV6(ctx, device, ingress, frame)) return;
  if (device.interfaces.some((i) => ownsIp6(i, ip6.dstIp))) {
    localEcho6(ctx, device, ingress, frame);
    return;
  }
  if (isMulticast6(ip6.dstIp)) return; // a group this host has not joined: filtered silently
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

/**
 * Router IPv6 receive: NDP, control-plane receivers (RS, OSPFv3), local
 * ICMPv6, else forward with hop-limit decrement. Multicast and link-local
 * scoped packets are never forwarded (RFC 4291 2.5.6); expiry and no-route
 * answer ICMPv6 Time Exceeded / Destination Unreachable (RFC 4443 3.1, 3.3).
 */
export function routerReceiveV6(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const ip6 = frame.ipv6;
  if (!ip6) return;
  if (isNdp(frame)) {
    handleNdp(ctx, device, ingress, frame);
    return;
  }
  if (dispatchV6(ctx, device, ingress, frame)) return;
  if (device.interfaces.some((i) => ownsIp6(i, ip6.dstIp)) || isExtraLocalIp6(device, ip6.dstIp)) {
    localEcho6(ctx, device, ingress, frame);
    return;
  }
  const dstMac = frame.ethernet.dstMac;
  if (isMulticast6(ip6.dstIp) || isMulticast(dstMac) || isBroadcast(dstMac)) return; // link-scoped: not routed
  if (normalizeMac(dstMac) !== normalizeMac(ingress.mac) && !isExtraLocalMac(device, ingress, dstMac)) {
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
  if (isLinkLocal6(ip6.dstIp) || isLinkLocal6(ip6.srcIp)) {
    ctx.emit({
      type: "FRAME_DROPPED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: link-local ${ip6.srcIp} → ${ip6.dstIp} is not forwarded beyond its link — dropped`,
      osiLayers: [3],
      frame,
    });
    return;
  }
  // Linux resolves the route on input (ip6_route_input): no route is answered
  // with Destination Unreachable before the hop limit is looked at (ip6_forward).
  const vrf = vrfOf(device, ingress);
  if (!longestPrefixMatch6(device.routingTable6 ?? [], ip6.dstIp, vrf)) {
    sendIcmp6Error(ctx, device, ingress, frame, "dest-unreachable", 0); // code 0: no route to destination
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
    sendIcmp6Error(ctx, device, ingress, frame, "time-exceeded", 0); // code 0: hop limit exceeded in transit
    return;
  }
  const res = ip6Output(ctx, device, {
    srcIp: ip6.srcIp,
    dstIp: ip6.dstIp,
    hopLimit: newHop,
    nextHeader: ip6.nextHeader,
    icmp6: frame.icmp6,
    upperBytes: ICMP6_ECHO_TOTAL,
    summary: frame.meta.summary,
    rawL3: frame.rawL3,
    vrf,
  });
  if (!res.ok) {
    if (res.reason === "no-route") sendIcmp6Error(ctx, device, ingress, frame, "dest-unreachable", 0); // code 0: no route
    else if (res.reason === "ndp-failed") sendIcmp6Error(ctx, device, ingress, frame, "dest-unreachable", 3); // code 3: address unreachable
  }
}
