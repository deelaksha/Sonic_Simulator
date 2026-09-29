/**
 * Layer-2 switch forwarding plane (spec §7, §8). Real logical state:
 *   - source MAC learning per VLAN
 *   - known-unicast forwarding, unknown-unicast/broadcast flooding
 *   - 802.1Q ingress classification + egress tag/untag
 * No fake animation — the MAC table is authoritative and drives every decision.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame, cloneFrame } from "../models/packet";
import { BROADCAST_MAC, NULL_MAC, isBroadcast, isMulticast } from "../models/mac";
import { DOT1Q_BYTES } from "./ethernet";
import { SimContext } from "../engine/context";
import { MacTableRow } from "../engine/events";

/** Snapshot the MAC table with port NAMES for the inspector (spec §7). */
function macTableSnapshot(sw: Device, highlightMac?: string): MacTableRow[] {
  return sw.macTable.map((e) => ({
    mac: e.mac,
    port: sw.interfaces.find((i) => i.id === e.interfaceId)?.name ?? e.interfaceId,
    vlan: e.vlan,
    isNew: highlightMac !== undefined && e.mac === highlightMac,
  }));
}

/** Determine the internal VLAN a frame belongs to when it enters a port. */
function classifyIngress(iface: NetInterface, frame: Frame): { vid: number | null; drop?: string } {
  const cfg = iface.vlan;
  if (cfg.mode === "access") {
    if (frame.vlan) return { vid: null, drop: "tagged frame arrived on access port" };
    return { vid: cfg.accessVlan };
  }
  // trunk
  if (frame.vlan) {
    if (!cfg.allowedVlans.includes(frame.vlan.vlanId)) {
      return { vid: null, drop: `VLAN ${frame.vlan.vlanId} not allowed on trunk` };
    }
    return { vid: frame.vlan.vlanId };
  }
  return { vid: cfg.nativeVlan };
}

/** Does this port carry the given VLAN (and is it usable)? */
function participates(iface: NetInterface, vid: number): boolean {
  if (iface.management || iface.logical) return false; // mgmt + logical ifaces are not in the L2 fabric
  if (iface.operState !== "up" || iface.adminState !== "up") return false;
  if (iface.vlan.mode === "access") return iface.vlan.accessVlan === vid;
  return iface.vlan.allowedVlans.includes(vid);
}

/** Produce the frame as it should leave a given egress port (tag/untag). */
function egressFrame(frame: Frame, egress: NetInterface, vid: number): Frame {
  const out = cloneFrame(frame);
  const cfg = egress.vlan;
  const wasTagged = !!out.vlan;

  if (cfg.mode === "access" || vid === cfg.nativeVlan) {
    // Untagged on the wire.
    if (out.vlan) {
      delete out.vlan;
      out.meta.sizeBytes = Math.max(64, out.meta.sizeBytes - DOT1Q_BYTES);
    }
  } else {
    // Tagged on the wire.
    out.vlan = { vlanId: vid, priority: 0 };
    if (!wasTagged) out.meta.sizeBytes += DOT1Q_BYTES;
  }
  return out;
}

export function switchForward(
  ctx: SimContext,
  sw: Device,
  ingress: NetInterface,
  frame: Frame,
): void {
  const { vid, drop } = classifyIngress(ingress, frame);
  if (vid === null) {
    ctx.emit({
      type: "FRAME_DROPPED",
      deviceId: sw.id,
      deviceName: sw.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${sw.name}: dropped frame on ${ingress.name} (${drop})`,
      osiLayers: [2],
      frame,
    });
    return;
  }

  // --- Source MAC learning ---
  const src = frame.ethernet.srcMac;
  if (!isBroadcast(src) && !isMulticast(src) && src !== NULL_MAC) {
    const existing = sw.macTable.find((e) => e.mac === src && e.vlan === vid);
    if (!existing) {
      sw.macTable.push({ mac: src, interfaceId: ingress.id, vlan: vid });
      ctx.emit({
        type: "MAC_LEARNED",
        deviceId: sw.id,
        deviceName: sw.name,
        interfaceId: ingress.id,
        interfaceName: ingress.name,
        message: `${sw.name}: learned ${src} on ${ingress.name} (VLAN ${vid})`,
        osiLayers: [2],
        detail: {
          kind: "mac-learn",
          ingressInterface: ingress.name,
          sourceMac: src,
          vlan: vid,
          moved: false,
          macTable: macTableSnapshot(sw, src),
        },
      });
    } else if (existing.interfaceId !== ingress.id) {
      existing.interfaceId = ingress.id; // MAC moved to a new port
      ctx.emit({
        type: "MAC_LEARNED",
        deviceId: sw.id,
        deviceName: sw.name,
        interfaceId: ingress.id,
        interfaceName: ingress.name,
        message: `${sw.name}: ${src} moved to ${ingress.name} (VLAN ${vid})`,
        osiLayers: [2],
        detail: {
          kind: "mac-learn",
          ingressInterface: ingress.name,
          sourceMac: src,
          vlan: vid,
          moved: true,
          macTable: macTableSnapshot(sw, src),
        },
      });
    }
  }

  // --- Destination lookup ---
  const dst = frame.ethernet.dstMac;
  const candidates = sw.interfaces.filter((i) => i.id !== ingress.id && participates(i, vid));
  const broadcast = isBroadcast(dst) || isMulticast(dst);
  const known = broadcast ? undefined : sw.macTable.find((e) => e.mac === dst && e.vlan === vid);

  let egressPorts: NetInterface[];
  if (broadcast || !known) {
    egressPorts = candidates;
    const reason = broadcast ? (dst === BROADCAST_MAC ? "broadcast" : "multicast") : "unknown unicast";
    ctx.emit({
      type: "FRAME_FLOODED",
      deviceId: sw.id,
      deviceName: sw.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message:
        egressPorts.length > 0
          ? `${sw.name}: flood (${reason}) → ${egressPorts.map((p) => p.name).join(", ")} [VLAN ${vid}]`
          : `${sw.name}: ${reason} but no other ports in VLAN ${vid}`,
      osiLayers: [2],
      frame,
      detail: {
        kind: "mac-lookup",
        ingressInterface: ingress.name,
        sourceMac: src,
        destinationMac: dst,
        vlan: vid,
        result: broadcast ? (dst === BROADCAST_MAC ? "broadcast" : "multicast") : "unknown-unicast",
        action: "flood",
        outputInterfaces: egressPorts.map((p) => p.name),
        macTable: macTableSnapshot(sw),
      },
    });
  } else {
    const port = sw.interfaces.find((i) => i.id === known.interfaceId);
    if (!port || port.id === ingress.id || !participates(port, vid)) {
      ctx.emit({
        type: "FRAME_DROPPED",
        deviceId: sw.id,
        deviceName: sw.name,
        interfaceId: ingress.id,
        interfaceName: ingress.name,
        message: `${sw.name}: ${dst} known on ingress port — not forwarded`,
        osiLayers: [2],
        frame,
      });
      return;
    }
    egressPorts = [port];
    ctx.emit({
      type: "FRAME_FORWARDED",
      deviceId: sw.id,
      deviceName: sw.name,
      interfaceId: port.id,
      interfaceName: port.name,
      message: `${sw.name}: forward ${dst} → ${port.name} [VLAN ${vid}]`,
      osiLayers: [2],
      frame,
      detail: {
        kind: "mac-lookup",
        ingressInterface: ingress.name,
        sourceMac: src,
        destinationMac: dst,
        vlan: vid,
        result: "found",
        action: "forward",
        outputInterfaces: [port.name],
        macTable: macTableSnapshot(sw),
      },
    });
  }

  for (const port of egressPorts) {
    ctx.transmit(sw.id, port.id, egressFrame(frame, port, vid));
  }
}
