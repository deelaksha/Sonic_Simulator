/**
 * ARP engine (spec §11). Real request/reply/cache behavior — nothing faked.
 */
import { Device, ArpEntry, findInterface } from "../models/device";
import { NetInterface, ownsIp, primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { BROADCAST_MAC, NULL_MAC } from "../models/mac";
import { SimContext } from "../engine/context";
import { ownsVipAsMaster, masteredVips } from "./vrrp";
import { ArpTableRow } from "../engine/events";
import { buildFrame } from "./ethernet";

/** Snapshot the neighbour cache with interface names for the inspector (spec §11). */
function arpTableSnapshot(device: Device, highlightIp?: string): ArpTableRow[] {
  return device.arpTable.map((e) => ({
    ip: e.ip,
    mac: e.mac,
    iface: findInterface(device, e.interfaceId)?.name ?? e.interfaceId,
    state: e.state,
    matched: highlightIp !== undefined && e.ip === highlightIp,
  }));
}

const ARP_PAYLOAD_BYTES = 28;

export function buildArpRequest(senderMac: string, senderIp: string, targetIp: string): Frame {
  return buildFrame(
    {
      srcMac: senderMac,
      dstMac: BROADCAST_MAC,
      etherType: "ARP",
      payloadBytes: ARP_PAYLOAD_BYTES,
      summary: `ARP, Request who-has ${targetIp} tell ${senderIp}`,
    },
    {
      arp: {
        op: "request",
        senderMac,
        senderIp,
        targetMac: NULL_MAC,
        targetIp,
      },
    },
  );
}

export function buildArpReply(
  senderMac: string,
  senderIp: string,
  targetMac: string,
  targetIp: string,
): Frame {
  return buildFrame(
    {
      srcMac: senderMac,
      dstMac: targetMac,
      etherType: "ARP",
      payloadBytes: ARP_PAYLOAD_BYTES,
      summary: `ARP, Reply ${senderIp} is-at ${senderMac}`,
    },
    {
      arp: {
        op: "reply",
        senderMac,
        senderIp,
        targetMac,
        targetIp,
      },
    },
  );
}

/** Insert/update a neighbor cache entry. Returns true if new or changed. */
export function learnArp(
  device: Device,
  ip: string,
  mac: string,
  interfaceId: string,
): boolean {
  const existing = device.arpTable.find((e) => e.ip === ip);
  if (existing) {
    const changed = existing.mac !== mac || existing.state !== "reachable";
    existing.mac = mac;
    existing.interfaceId = interfaceId;
    existing.state = "reachable";
    return changed;
  }
  const entry: ArpEntry = { ip, mac, interfaceId, state: "reachable" };
  device.arpTable.push(entry);
  return true;
}

function markIncomplete(device: Device, ip: string, interfaceId: string): void {
  const existing = device.arpTable.find((e) => e.ip === ip);
  if (existing) {
    existing.state = "incomplete";
    existing.mac = NULL_MAC;
  } else {
    device.arpTable.push({ ip, mac: NULL_MAC, interfaceId, state: "incomplete" });
  }
}

/**
 * Resolve the MAC for `ip` reachable via `iface`. On a cache miss, broadcasts an
 * ARP request; because the engine delivers frames synchronously, the reply (if
 * any) has updated the cache by the time transmit() returns.
 */
export function resolveArp(
  ctx: SimContext,
  device: Device,
  iface: NetInterface,
  ip: string,
): string | null {
  if (ownsIp(iface, ip)) return iface.mac;

  const cached = device.arpTable.find((e) => e.ip === ip && e.state === "reachable");
  if (cached) return cached.mac;

  const senderIp = primaryIpv4(iface);
  if (!senderIp) return null; // no source address => cannot ARP

  const request = buildArpRequest(iface.mac, senderIp.address, ip);
  ctx.emit({
    type: "ARP_REQUEST",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: iface.id,
    interfaceName: iface.name,
    message: `${device.name}: ARP who-has ${ip}? (broadcast)`,
    osiLayers: [2],
    frame: request,
    detail: {
      kind: "arp-lookup",
      targetIp: ip,
      result: "miss",
      arpTable: arpTableSnapshot(device, ip),
    },
  });
  ctx.transmit(device.id, iface.id, request);

  const resolved = device.arpTable.find((e) => e.ip === ip && e.state === "reachable");
  if (resolved) {
    ctx.emit({
      type: "ARP_RESOLVED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: iface.id,
      interfaceName: iface.name,
      message: `${device.name}: ${ip} is at ${resolved.mac}`,
      osiLayers: [2],
      detail: {
        kind: "arp-lookup",
        targetIp: ip,
        result: "resolved",
        resolvedMac: resolved.mac,
        arpTable: arpTableSnapshot(device, ip),
      },
    });
    return resolved.mac;
  }

  markIncomplete(device, ip, iface.id);
  return null;
}

/** Process an ARP frame that arrived on `ingress`. */
export function handleArpFrame(
  ctx: SimContext,
  device: Device,
  ingress: NetInterface,
  frame: Frame,
): void {
  const arp = frame.arp;
  if (!arp) return;

  // Learn the sender from any ARP frame (request or reply).
  learnArp(device, arp.senderIp, arp.senderMac, ingress.id);

  if (arp.op !== "request") return;

  // VRRP: the Master answers ARP for a virtual IP with the virtual MAC (Backups stay silent).
  if (!device.interfaces.some((i) => ownsIp(i, arp.targetIp)) && ownsVipAsMaster(ctx.state, device, arp.targetIp)) {
    const vmac = masteredVips(ctx.state, device).find((v) => v.vip === arp.targetIp)!.vmac;
    const vreply = buildArpReply(vmac, arp.targetIp, arp.senderMac, arp.senderIp);
    ctx.emit({
      type: "ARP_REPLY", deviceId: device.id, deviceName: device.name, interfaceId: ingress.id, interfaceName: ingress.name,
      message: `${device.name}: VRRP VIP ${arp.targetIp} is-at ${vmac} (virtual) → ${arp.senderIp}`, osiLayers: [2], frame: vreply,
    });
    ctx.transmit(device.id, ingress.id, vreply);
    return;
  }

  // Answer only if we own the requested IP on some interface.
  const owner = device.interfaces.find((i) => ownsIp(i, arp.targetIp));
  if (!owner) return;

  const reply = buildArpReply(owner.mac, arp.targetIp, arp.senderMac, arp.senderIp);
  ctx.emit({
    type: "ARP_REPLY",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: ${arp.targetIp} is-at ${owner.mac} → ${arp.senderIp}`,
    osiLayers: [2],
    frame: reply,
  });
  // Reply goes back out the interface the request arrived on.
  ctx.transmit(device.id, ingress.id, reply);
}
