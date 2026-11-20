/**
 * Automatic addressing for PCs the learner cables up in the topology editor.
 *
 * A PC port runs DHCP when it is cabled, unless its address was set by hand
 * (static). The store first tries a real DHCP exchange (Simulation.runDhcp, so a
 * dhcp-server or a relay answers on the wire); when nobody answers, the simulator's
 * built-in "lab DHCP" picks an address here, the way a home router would:
 *   - the PC's L2 segment (through switches, same VLAN) is searched for a gateway:
 *     a router / L3 interface or a switch VLAN interface with an IP. If found, the
 *     address comes from that subnet and the gateway is set;
 *   - a router port on the segment with no address yet becomes the gateway: it
 *     takes .1 of the PC's subnet (like a home router's LAN side), and PCs on the
 *     segment without a gateway point at it. This also runs when a bare router
 *     port is cabled to a segment that already has PCs;
 *   - otherwise a /24 is used: the one another host on the segment already has,
 *     else a fresh 192.168.N.0/24 not used anywhere in the lab.
 * Addresses never collide with any address in the lab; hosts start at .10.
 */
import { NetworkState } from "./topology";
import { Device, isSwitch } from "./device";
import { NetInterface } from "./interface";
import { intToIp, ipToInt, networkAddress } from "./ip";
import { featureState, peekFeatureState } from "./feature-state";

const STATIC_KEY = "ip-static";

/** Mark a port's address as set by hand: automatic DHCP leaves it alone. */
export function markStatic(d: Device, ifaceId: string): void {
  featureState<Record<string, true>>(d, STATIC_KEY, () => ({}))[ifaceId] = true;
}

export function isStatic(d: Device, ifaceId: string): boolean {
  return !!peekFeatureState<Record<string, true>>(d, STATIC_KEY)?.[ifaceId];
}

/** Should this port ask for an address automatically when it is cabled? */
export function wantsAutoDhcp(d: Device, iface: NetInterface): boolean {
  return d.type === "pc" && !iface.management && iface.ipv4.length === 0 && !isStatic(d, iface.id);
}

/** Should this router port take the gateway address of its segment automatically? */
export function wantsAutoGateway(d: Device, iface: NetInterface): boolean {
  return (d.type === "router" || d.type === "firewall") && !iface.management && iface.ipv4.length === 0 && !isStatic(d, iface.id);
}

interface PortRef {
  deviceId: string;
  ifaceId: string;
}

interface Segment {
  /** L3 interfaces on the segment (router ports, routed switch ports, SVIs) with an IP. */
  gateways: { address: string; prefix: number }[];
  /** Addresses other hosts on the segment already use. */
  hosts: { address: string; prefix: number }[];
  /** PC ports on the segment. */
  hostPorts: PortRef[];
  /** Router ports on the segment that could become its gateway (wantsAutoGateway). */
  bareRouters: PortRef[];
}

function peerOf(net: NetworkState, deviceId: string, ifaceId: string): { deviceId: string; ifaceId: string } | undefined {
  const c = net.connections.find((x) => (x.a.deviceId === deviceId && x.a.interfaceId === ifaceId) || (x.b.deviceId === deviceId && x.b.interfaceId === ifaceId));
  if (!c) return undefined;
  const far = c.a.deviceId === deviceId && c.a.interfaceId === ifaceId ? c.b : c.a;
  return { deviceId: far.deviceId, ifaceId: far.interfaceId };
}

/** Walk the broadcast domain a PC port is in: across switch ports in the same VLAN. */
function segmentOf(net: NetworkState, pcId: string, ifaceId: string): Segment {
  const seg: Segment = { gateways: [], hosts: [], hostPorts: [], bareRouters: [] };
  const seen = new Set<string>();
  const queue: { deviceId: string; ifaceId: string; vlan?: number }[] = [];
  const first = peerOf(net, pcId, ifaceId);
  if (first) queue.push(first);
  while (queue.length) {
    const { deviceId, ifaceId: inId } = queue.shift()!;
    if (seen.has(`${deviceId}:${inId}`)) continue;
    seen.add(`${deviceId}:${inId}`);
    const d = net.devices[deviceId];
    const ingress = d?.interfaces.find((i) => i.id === inId);
    if (!d || !ingress) continue;
    if (!isSwitch(d.type)) {
      // router / firewall port = the gateway; another host = a neighbour on the segment
      for (const a of ingress.ipv4) (d.type === "router" || d.type === "firewall" ? seg.gateways : seg.hosts).push(a);
      if (wantsAutoGateway(d, ingress)) seg.bareRouters.push({ deviceId, ifaceId: inId });
      else if (d.type === "pc") seg.hostPorts.push({ deviceId, ifaceId: inId });
      continue;
    }
    if (ingress.ipv4.length) {
      seg.gateways.push(...ingress.ipv4); // routed switch port ends the segment
      continue;
    }
    const vlan = ingress.vlan.mode === "access" ? ingress.vlan.accessVlan : ingress.vlan.nativeVlan;
    const svi = d.interfaces.find((i) => i.logical && i.name === `Vlan${vlan}`);
    if (svi) seg.gateways.push(...svi.ipv4);
    for (const p of d.interfaces) {
      if (p.id === inId || p.management || p.logical || p.ipv4.length) continue;
      const inVlan = p.vlan.mode === "trunk" ? p.vlan.allowedVlans.includes(vlan) || p.vlan.nativeVlan === vlan : p.vlan.accessVlan === vlan;
      if (!inVlan) continue;
      const next = peerOf(net, d.id, p.id);
      if (next) queue.push(next);
    }
  }
  return seg;
}

export interface AutoLease {
  address: string;
  prefix: number;
  gateway?: string;
  /** Bare router port that takes `gateway` as its address. */
  gatewayPort?: PortRef;
}

function usedAddresses(net: NetworkState): Set<string> {
  return new Set(Object.values(net.devices).flatMap((d) => d.interfaces.flatMap((i) => i.ipv4.map((a) => a.address))));
}

/** First unused address of the subnet at or after host number `from`. */
function freeHost(netAddr: string, prefix: number, from: number, used: Set<string>): string {
  const size = 2 ** (32 - prefix);
  const start = ipToInt(netAddr);
  for (let h = Math.min(from, size - 2); h < size - 1; h++) {
    const cand = intToIp(start + h);
    if (!used.has(cand)) return cand;
  }
  return "";
}

/** The lab DHCP's choice for this PC port (see the header). */
export function autoLease(net: NetworkState, pcId: string, ifaceId: string): AutoLease {
  const used = usedAddresses(net);
  const usedNets = new Set(Object.values(net.devices).flatMap((d) => d.interfaces.flatMap((i) => i.ipv4.map((a) => networkAddress(a.address, 24)))));
  const seg = segmentOf(net, pcId, ifaceId);
  const base = seg.gateways[0] ?? seg.hosts[0];
  let netAddr: string;
  let prefix: number;
  if (base) {
    prefix = base.prefix;
    netAddr = networkAddress(base.address, base.prefix);
  } else {
    prefix = 24;
    let n = 1;
    while (usedNets.has(`192.168.${n}.0`) && n < 254) n++;
    netAddr = `192.168.${n}.0`;
  }
  if (!seg.gateways.length && seg.bareRouters.length) {
    const gateway = freeHost(netAddr, prefix, 1, used);
    used.add(gateway);
    return { address: freeHost(netAddr, prefix, 10, used), prefix, gateway, gatewayPort: seg.bareRouters[0] };
  }
  return { address: freeHost(netAddr, prefix, 10, used), prefix, gateway: seg.gateways[0]?.address };
}

/**
 * A bare router port was cabled to a segment whose PCs already have addresses but no
 * gateway: the port's address (.1 of their subnet) and the PC ports that should use it.
 */
export function autoGateway(net: NetworkState, routerId: string, ifaceId: string): { address: string; prefix: number; hosts: PortRef[] } | undefined {
  const seg = segmentOf(net, routerId, ifaceId);
  const base = seg.hosts[0];
  if (seg.gateways.length || !base) return undefined;
  const address = freeHost(networkAddress(base.address, base.prefix), base.prefix, 1, usedAddresses(net));
  return address ? { address, prefix: base.prefix, hosts: seg.hostPorts } : undefined;
}
