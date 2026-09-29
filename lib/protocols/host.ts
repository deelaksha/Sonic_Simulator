/**
 * Host receive path (spec §16). A host consumes traffic addressed to it and
 * does NOT forward IP for other destinations (that is the router's job).
 */
import { Device } from "../models/device";
import { NetInterface, ownsIp } from "../models/interface";
import { Frame } from "../models/packet";
import { isBroadcast } from "../models/mac";
import { SimContext } from "../engine/context";
import { handleArpFrame } from "./arp";
import { handleIcmpLocal } from "./icmp";
import { handleUdp } from "./udpapp";
import { hostReceiveV6 } from "./ipv6";

export function hostReceive(
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
    hostReceiveV6(ctx, device, ingress, frame);
    return;
  }

  // OSPF multicast Hellos reach hosts on the segment; hosts don't run OSPF.
  if (frame.ospf) return;

  if (!frame.ipv4) return;

  // NIC address filter: accept our unicast or broadcast only.
  const dstMac = frame.ethernet.dstMac;
  if (!isBroadcast(dstMac) && dstMac !== ingress.mac) {
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

  // UDP apps (NTP unicast, DHCP broadcast) are dispatched before the local-IP
  // check because DHCP is addressed to 255.255.255.255 while the client has no IP.
  if (frame.udp) {
    handleUdp(ctx, device, ingress, frame);
    return;
  }

  const dstIp = frame.ipv4.dstIp;
  // The "internet" upstream answers for any address routed to it (models public
  // reachability — ping/NTP to a public IP is served from that IP).
  const local = device.type === "internet" || device.interfaces.some((i) => ownsIp(i, dstIp));
  if (!local) {
    ctx.emit({
      type: "FRAME_DROPPED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: ${dstIp} is not a local address and this host does not route — dropped`,
      osiLayers: [3],
      frame,
    });
    return;
  }

  if (frame.icmp) {
    handleIcmpLocal(ctx, device, ingress, frame);
    return;
  }

  // TCP/UDP delivery arrives in a later MVP.
  ctx.emit({
    type: "FRAME_DROPPED",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: no listener for ${frame.ipv4.protocol} — dropped`,
    osiLayers: [4],
    frame,
  });
}
