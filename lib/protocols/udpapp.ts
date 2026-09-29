/**
 * UDP application engines: NTP (spec §23) and DHCP (spec §22). Real packet-plane
 * behavior — requests traverse the actual L2/L3 path (ARP, switching, routing)
 * and servers reply with real frames. Client orchestration (send → wait → apply)
 * lives in the Simulation; this module holds the payload builders + the SERVER
 * receive handlers, invoked from host.ts when a UDP frame arrives.
 */
import { Device } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame, NtpPayload, DhcpPayload, DhcpMessageType, DnsPayload } from "../models/packet";
import { BROADCAST_MAC } from "../models/mac";
import { ipToInt, intToIp, networkInt } from "../models/ip";
import { SimContext } from "../engine/context";
import { buildFrame } from "./ethernet";
import { ipOutput } from "./ipv4";

export const NTP_PORT = 123;
export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;
const UDP_HEADER = 8;
const NTP_BYTES = 48;
const DHCP_BYTES = 300;
/** Servers run a slightly-ahead clock so a synced client sees a non-zero offset. */
const SERVER_CLOCK_SKEW_MS = 8;

// --- server capability -----------------------------------------------------

export function isNtpServer(device: Device): boolean {
  return device.type === "ntp-server" || device.type === "server";
}

export function isDhcpServer(device: Device): boolean {
  return device.type === "dhcp-server" || device.config.features?.dhcpServer !== undefined;
}

export const DNS_PORT = 53;
const DNS_BYTES = 60;
export const DNS_UPPER_BYTES = UDP_HEADER + DNS_BYTES;

/** A device answers DNS if it is a dns-server, the internet upstream, or has records. */
export function isDnsServer(device: Device): boolean {
  return device.type === "dns-server" || device.type === "internet" || device.config.features?.dnsRecords !== undefined;
}

/** Resolve a hostname to an A record: configured records first, else a stable public IP. */
export function resolveHostname(device: Device, name: string): string {
  const recs = device.config.features?.dnsRecords as Record<string, string> | undefined;
  if (recs && recs[name.toLowerCase()]) return recs[name.toLowerCase()];
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return `198.51.100.${(h % 250) + 1}`; // deterministic public IP (answered by the internet node)
}

export const NTP_UPPER_BYTES = UDP_HEADER + NTP_BYTES;
export const DHCP_UPPER_BYTES = UDP_HEADER + DHCP_BYTES;

// --- DHCP server state ------------------------------------------------------

interface DhcpServerConfig {
  gateway: string;
  dns: string;
  prefix: number;
  subnet?: string; // network address of this pool (for giaddr matching); defaults to ingress subnet
  leases: Record<string, string>; // clientMac -> assigned IP
  pools?: DhcpServerConfig[]; // additional pools for relayed subnets (giaddr selection)
}

/** Server pool derived from (or overriding via features.dhcpServer) the ingress subnet. */
function dhcpConfig(device: Device, ingress: NetInterface): DhcpServerConfig | null {
  const ip = primaryIpv4(ingress);
  if (!ip) return null;
  const store = device.config.features ?? (device.config.features = {});
  if (!store.dhcpServer) {
    store.dhcpServer = { gateway: ip.address, dns: ip.address, prefix: ip.prefix, leases: {} };
  }
  return store.dhcpServer as DhcpServerConfig;
}

/** Pick the pool serving a relayed request (giaddr is in the client subnet). */
function poolForGiaddr(device: Device, giaddr: string): DhcpServerConfig | null {
  const root = device.config.features?.dhcpServer as DhcpServerConfig | undefined;
  if (!root) return null;
  const all = [root, ...(root.pools ?? [])];
  for (const p of all) {
    const subnet = p.subnet ?? (root === p ? undefined : undefined);
    if (subnet && networkInt(giaddr, p.prefix) === networkInt(subnet, p.prefix)) return p;
  }
  return null;
}

function allocateIn(cfg: DhcpServerConfig, subnetIp: string, clientMac: string): string | null {
  if (cfg.leases[clientMac]) return cfg.leases[clientMac];
  const net = networkInt(subnetIp, cfg.prefix);
  const taken = new Set(Object.values(cfg.leases).map(ipToInt));
  taken.add(ipToInt(cfg.gateway));
  for (let host = 100; host < 200; host++) {
    const cand = (net + host) >>> 0;
    if (!taken.has(cand)) {
      const addr = intToIp(cand);
      cfg.leases[clientMac] = addr;
      return addr;
    }
  }
  return null;
}


// --- receive dispatch (server responds; client records for the orchestrator) ---

export function handleUdp(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  if (frame.ntp) return handleNtp(ctx, device, ingress, frame);
  if (frame.dhcp) return handleDhcp(ctx, device, ingress, frame);
  if (frame.dns) return handleDns(ctx, device, ingress, frame);
  // Unknown UDP service.
  ctx.emit({
    type: "FRAME_DROPPED",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: no UDP listener on port ${frame.udp?.dstPort}`,
    osiLayers: [4],
    frame,
  });
}

function handleNtp(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const ntp = frame.ntp!;
  const ip = frame.ipv4!;
  if (ntp.mode === "server") {
    // A response arriving back at the client.
    ctx.recordUdp(device.id, frame);
    return;
  }
  // A request: answer if we run NTP and own the target IP, OR we are the
  // "internet" upstream (models a public NTP server like time.google.com reached
  // over the network — it answers for any address routed to it, from that IP).
  const isInternet = device.type === "internet";
  const owner = device.interfaces.find((i) => i.ipv4.some((a) => a.address === ip.dstIp));
  if (!isInternet && (!owner || !isNtpServer(device))) return;

  const reply: NtpPayload = {
    mode: "server",
    version: ntp.version,
    stratum: 2,
    transmitTs: ctx.now() + SERVER_CLOCK_SKEW_MS,
    originateTs: ntp.transmitTs,
    receiveTs: ctx.now(),
  };
  ctx.emit({
    type: "NTP_RESPONSE",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: NTP response → ${ip.srcIp} (stratum 2)`,
    osiLayers: [7],
  });
  // Route the reply back (from the queried IP) — works for a directly-connected
  // server AND for an upstream reached across routers / the internet node.
  ipOutput(ctx, device, {
    srcIp: ip.dstIp,
    dstIp: ip.srcIp,
    ttl: 64,
    protocol: "UDP",
    identification: ip.identification,
    udp: { srcPort: NTP_PORT, dstPort: frame.udp!.srcPort, length: UDP_HEADER + NTP_BYTES },
    ntp: reply,
    upperBytes: UDP_HEADER + NTP_BYTES,
    summary: "NTP server response stratum 2",
  });
}

export function dhcpFrame(
  src: NetInterface,
  dstMac: string,
  srcIp: string,
  dstIp: string,
  srcPort: number,
  dstPort: number,
  payload: DhcpPayload,
): Frame {
  return buildFrame(
    {
      srcMac: src.mac,
      dstMac,
      etherType: "IPv4",
      payloadBytes: 20 + UDP_HEADER + DHCP_BYTES,
      summary: `DHCP ${payload.messageType.toUpperCase()}`,
    },
    {
      ipv4: { srcIp, dstIp, ttl: 64, protocol: "UDP", identification: 0 },
      udp: { srcPort, dstPort, length: UDP_HEADER + DHCP_BYTES },
      dhcp: payload,
    },
  );
}

function handleDns(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const d = frame.dns!;
  const ip = frame.ipv4!;
  if (d.kind === "response") {
    ctx.recordUdp(device.id, frame); // answer arriving back at the resolver client
    return;
  }
  // A query: answer only if we run DNS (a dns-server, the internet upstream, or have records).
  if (!isDnsServer(device)) return;
  const address = resolveHostname(device, d.name);
  ctx.emit({
    type: "DNS_RESPONSE", deviceId: device.id, deviceName: device.name, interfaceId: ingress.id, interfaceName: ingress.name,
    message: `${device.name}: DNS ${d.name} → ${address}`, osiLayers: [7],
  });
  // Route the reply back (from the queried resolver IP) — works direct or via the internet.
  ipOutput(ctx, device, {
    srcIp: ip.dstIp, dstIp: ip.srcIp, ttl: 64, protocol: "UDP", identification: ip.identification,
    udp: { srcPort: DNS_PORT, dstPort: frame.udp!.srcPort, length: DNS_UPPER_BYTES },
    dns: { kind: "response", name: d.name, address, rcode: "noerror" },
    upperBytes: DNS_UPPER_BYTES, summary: `DNS response ${d.name} A ${address}`,
  });
}

function handleDhcp(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const d = frame.dhcp!;

  // OFFER / ACK arriving at the requesting client.
  if (d.messageType === "offer" || d.messageType === "ack") {
    const mine = device.interfaces.some((i) => i.mac === d.clientMac);
    if (mine) ctx.recordUdp(device.id, frame);
    return;
  }

  // DISCOVER / REQUEST reach the server (directly, or unicast from a relay with giaddr set).
  if (!isDhcpServer(device)) return;
  const relayed = !!d.giaddr;
  const cfg = relayed ? poolForGiaddr(device, d.giaddr!) : dhcpConfig(device, ingress);
  if (!cfg) return; // no pool for the relayed subnet
  const serverIp = primaryIpv4(ingress)!.address;
  const subnetBase = relayed ? d.giaddr! : serverIp;

  // Direct: broadcast on the client segment. Relayed: unicast back to the relay (giaddr).
  const reply = (payload: DhcpPayload): void => {
    if (relayed) {
      ipOutput(ctx, device, {
        srcIp: serverIp, dstIp: d.giaddr!, ttl: 64, protocol: "UDP", identification: 0,
        udp: { srcPort: DHCP_SERVER_PORT, dstPort: DHCP_SERVER_PORT, length: DHCP_UPPER_BYTES },
        dhcp: payload, upperBytes: DHCP_UPPER_BYTES, summary: `DHCP ${payload.messageType.toUpperCase()} → relay ${d.giaddr}`,
      });
    } else {
      ctx.transmit(device.id, ingress.id, dhcpFrame(ingress, BROADCAST_MAC, serverIp, "255.255.255.255", DHCP_SERVER_PORT, DHCP_CLIENT_PORT, payload));
    }
  };

  if (d.messageType === "discover") {
    const offerIp = allocateIn(cfg, subnetBase, d.clientMac);
    if (!offerIp) return;
    ctx.emit({
      type: "DHCP_OFFER", deviceId: device.id, deviceName: device.name, interfaceId: ingress.id, interfaceName: ingress.name,
      message: `${device.name}: DHCP OFFER ${offerIp} → ${d.clientMac}${relayed ? ` (via relay ${d.giaddr})` : ""}`, osiLayers: [7],
    });
    reply({ messageType: "offer", clientMac: d.clientMac, yourIp: offerIp, serverIp, gateway: cfg.gateway, dns: cfg.dns, prefix: cfg.prefix, leaseSeconds: 86400, giaddr: d.giaddr });
    return;
  }

  if (d.messageType === "request") {
    const assigned = d.requestedIp ?? cfg.leases[d.clientMac];
    if (!assigned) return;
    cfg.leases[d.clientMac] = assigned;
    ctx.emit({
      type: "DHCP_ACK", deviceId: device.id, deviceName: device.name, interfaceId: ingress.id, interfaceName: ingress.name,
      message: `${device.name}: DHCP ACK ${assigned} → ${d.clientMac}${relayed ? ` (via relay ${d.giaddr})` : ""}`, osiLayers: [7],
    });
    reply({ messageType: "ack", clientMac: d.clientMac, yourIp: assigned, serverIp, gateway: cfg.gateway, dns: cfg.dns, prefix: cfg.prefix, leaseSeconds: 86400, giaddr: d.giaddr });
  }
}
