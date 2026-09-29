/**
 * Router forwarding path (spec §9, §10, §17). The key L3 learning moment:
 * the old Ethernet frame is discarded, the IP packet's TTL is decremented, and a
 * BRAND NEW Ethernet frame is built for the next hop. When TTL hits zero the
 * router returns ICMP Time Exceeded (this is what powers traceroute).
 */
import { Device } from "../models/device";
import { NetInterface, ownsIp, primaryIpv4 } from "../models/interface";
import { Frame, IcmpPayload } from "../models/packet";
import { isBroadcast } from "../models/mac";
import { SimContext } from "../engine/context";
import { handleArpFrame } from "./arp";
import { handleIcmpLocal } from "./icmp";
import { routerReceiveV6 } from "./ipv6";
import { handleOspfFrame } from "./ospf";
import { handleBgpFrame } from "./bgp";
import { handleDhcpRelay } from "./dhcp-relay";
import { acceptsVMac, ownsVipAsMaster } from "./vrrp";
import { ipOutput, IPV4_HEADER_BYTES } from "./ipv4";
import { ETH_HEADER_BYTES, ETH_FCS_BYTES, DOT1Q_BYTES } from "./ethernet";
import { ICMP_HEADER_BYTES } from "./icmp";

const ICMP_ERROR_UPPER_BYTES = ICMP_HEADER_BYTES + 28; // ICMP hdr + IP hdr + 8 bytes of original

/** Bytes above the IP header in a received frame (protocol-agnostic). */
function upperBytesOf(frame: Frame): number {
  const overhead = ETH_HEADER_BYTES + ETH_FCS_BYTES + (frame.vlan ? DOT1Q_BYTES : 0) + IPV4_HEADER_BYTES;
  return Math.max(0, frame.meta.sizeBytes - overhead);
}

function sendIcmpError(
  ctx: SimContext,
  device: Device,
  ingress: NetInterface,
  origSrcIp: string,
  icmp: IcmpPayload,
  info: string,
): void {
  const srcAddr = primaryIpv4(ingress);
  if (!srcAddr) return; // router interface has no address to source the error from
  ipOutput(ctx, device, {
    srcIp: srcAddr.address,
    dstIp: origSrcIp,
    ttl: 64,
    protocol: "ICMP",
    identification: icmp.identifier,
    icmp: { ...icmp, errorInfo: info },
    upperBytes: ICMP_ERROR_UPPER_BYTES,
    summary: `ICMP ${icmp.type} → ${origSrcIp}`,
  });
}

export function routerReceive(
  ctx: SimContext,
  device: Device,
  ingress: NetInterface,
  frame: Frame,
): void {
  if (frame.arp) {
    handleArpFrame(ctx, device, ingress, frame);
    return;
  }

  if (frame.ipv6) {
    routerReceiveV6(ctx, device, ingress, frame);
    return;
  }

  if (frame.ospf) {
    handleOspfFrame(ctx, device, ingress, frame);
    return;
  }

  // BGP addressed to this router (TCP/179 unicast); otherwise fall through to forward.
  if (frame.bgp && frame.ipv4 && device.interfaces.some((i) => ownsIp(i, frame.ipv4!.dstIp))) {
    handleBgpFrame(ctx, device, ingress, frame);
    return;
  }

  // DHCP relay: intercept client broadcasts / server replies on relay-configured interfaces.
  if (frame.dhcp && handleDhcpRelay(ctx, device, ingress, frame)) return;

  const ip = frame.ipv4;
  if (!ip) return;

  const dstMac = frame.ethernet.dstMac;
  // Accept frames to our own MAC, broadcast, or a VRRP virtual MAC we currently
  // master (Backups silently drop virtual-MAC frames — only the Master forwards).
  if (!isBroadcast(dstMac) && dstMac !== ingress.mac && !acceptsVMac(ctx.state, device, dstMac)) {
    ctx.emit({
      type: "FRAME_DROPPED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: frame not addressed to ${ingress.name} — dropped`,
      osiLayers: [2],
      frame,
    });
    return;
  }

  // Packet addressed to the router itself, or to a VRRP VIP we master (ping the gateway).
  if (device.interfaces.some((i) => ownsIp(i, ip.dstIp)) || ownsVipAsMaster(ctx.state, device, ip.dstIp)) {
    if (frame.icmp) {
      handleIcmpLocal(ctx, device, ingress, frame);
      return;
    }
    ctx.emit({
      type: "FRAME_DROPPED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: no listener for ${ip.protocol} — dropped`,
      osiLayers: [4],
      frame,
    });
    return;
  }

  // --- Forwarding ---
  const newTtl = ip.ttl - 1;
  ctx.emit({
    type: "TTL_DECREMENT",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: decrement TTL ${ip.ttl} → ${newTtl}`,
    osiLayers: [3],
  });

  if (newTtl <= 0) {
    ctx.emit({
      type: "ICMP_TIME_EXCEEDED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: TTL expired for ${ip.dstIp} → ICMP time exceeded to ${ip.srcIp}`,
      osiLayers: [3],
    });
    sendIcmpError(
      ctx,
      device,
      ingress,
      ip.srcIp,
      { type: "time-exceeded", code: 0, identifier: frame.icmp?.identifier ?? 0, sequence: frame.icmp?.sequence ?? 0 },
      `IP ${ip.srcIp} → ${ip.dstIp}`,
    );
    return;
  }

  const res = ipOutput(ctx, device, {
    srcIp: ip.srcIp,
    dstIp: ip.dstIp,
    ttl: newTtl,
    protocol: ip.protocol,
    identification: ip.identification,
    // Preserve the full upper-layer payload when forwarding (not just ICMP), so
    // routed UDP/TCP apps (NTP, DHCP, BGP, …) survive the hop.
    icmp: frame.icmp,
    udp: frame.udp,
    ntp: frame.ntp,
    dhcp: frame.dhcp,
    dns: frame.dns,
    tcp: frame.tcp,
    bgp: frame.bgp,
    upperBytes: upperBytesOf(frame),
    summary: frame.meta.summary,
  });

  if (!res.ok) {
    if (res.reason === "no-route") {
      ctx.emit({
        type: "ICMP_UNREACHABLE",
        deviceId: device.id,
        deviceName: device.name,
        interfaceId: ingress.id,
        interfaceName: ingress.name,
        message: `${device.name}: no route to ${ip.dstIp} → ICMP destination unreachable to ${ip.srcIp}`,
        osiLayers: [3],
      });
      sendIcmpError(
        ctx,
        device,
        ingress,
        ip.srcIp,
        { type: "dest-unreachable", code: 0, identifier: frame.icmp?.identifier ?? 0, sequence: frame.icmp?.sequence ?? 0 },
        `IP ${ip.srcIp} → ${ip.dstIp}`,
      );
    } else {
      ctx.emit({
        type: "FRAME_DROPPED",
        deviceId: device.id,
        deviceName: device.name,
        interfaceId: ingress.id,
        interfaceName: ingress.name,
        message: `${device.name}: could not forward to ${ip.dstIp} (${res.reason})`,
        osiLayers: [3],
        frame,
      });
    }
  }
}
