/**
 * DHCP relay agent (spec: cross-subnet DHCP). A router interface configured with
 * relay server IPs (device.config.features.dhcpRelay[ifname]) intercepts the
 * client's broadcast DISCOVER/REQUEST, stamps giaddr = the ingress interface IP,
 * and UNICASTS it to each configured server (routed). The server allocates from
 * the pool matching giaddr's subnet and unicasts OFFER/ACK back to giaddr; the
 * relay then broadcasts it to the client on the giaddr interface.
 */
import { SimContext } from "../engine/context";
import { Device } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { BROADCAST_MAC } from "../models/mac";
import { ipOutput } from "./ipv4";
import { dhcpFrame, DHCP_SERVER_PORT, DHCP_CLIENT_PORT, DHCP_UPPER_BYTES } from "./udpapp";

export type DhcpRelayConfig = Record<string, string[]>; // ifname -> server IPs

export function relayServersFor(device: Device, ifname: string): string[] {
  const m = device.config.features?.dhcpRelay as DhcpRelayConfig | undefined;
  return m?.[ifname] ?? [];
}

/** Returns true if this router acted as a DHCP relay for the frame (and consumed it). */
export function handleDhcpRelay(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const d = frame.dhcp;
  if (!d) return false;

  // Client -> server: relay the broadcast DISCOVER/REQUEST out to the server(s).
  if (d.messageType === "discover" || d.messageType === "request") {
    if (d.giaddr) return false; // already relayed once — avoid loops
    const servers = relayServersFor(device, ingress.name);
    const gi = primaryIpv4(ingress);
    if (!servers.length || !gi) return false;
    const payload = { ...d, giaddr: gi.address };
    for (const server of servers) {
      ctx.emit({
        type: "DHCP_RELAY", deviceId: device.id, deviceName: device.name, interfaceId: ingress.id, interfaceName: ingress.name,
        message: `${device.name}: relay DHCP ${d.messageType.toUpperCase()} (${d.clientMac}) → server ${server} [giaddr ${gi.address}]`, osiLayers: [7],
      });
      ipOutput(ctx, device, {
        srcIp: gi.address, dstIp: server, ttl: 64, protocol: "UDP", identification: 0,
        udp: { srcPort: DHCP_SERVER_PORT, dstPort: DHCP_SERVER_PORT, length: DHCP_UPPER_BYTES },
        dhcp: payload, upperBytes: DHCP_UPPER_BYTES, summary: `DHCP ${d.messageType.toUpperCase()} (relayed → ${server})`,
      });
    }
    return true;
  }

  // Server -> client: OFFER/ACK unicast to giaddr (a relay interface) → broadcast to the client.
  if (d.messageType === "offer" || d.messageType === "ack") {
    if (!d.giaddr) return false;
    const relayIf = device.interfaces.find((i) => primaryIpv4(i)?.address === d.giaddr);
    if (!relayIf || !relayServersFor(device, relayIf.name).length) return false;
    ctx.emit({
      type: "DHCP_RELAY", deviceId: device.id, deviceName: device.name, interfaceId: relayIf.id, interfaceName: relayIf.name,
      message: `${device.name}: relay DHCP ${d.messageType.toUpperCase()} ${d.yourIp} → client ${d.clientMac}`, osiLayers: [7],
    });
    ctx.transmit(device.id, relayIf.id, dhcpFrame(relayIf, BROADCAST_MAC, d.giaddr, "255.255.255.255", DHCP_SERVER_PORT, DHCP_CLIENT_PORT, d));
    return true;
  }
  return false;
}
