/**
 * Data-plane hooks. Features that change how frames are forwarded (ACLs, LAG,
 * MCLAG, VXLAN, VRRP) register here instead of editing the forwarding engine;
 * the engine (lib/engine/simulation.ts, lib/protocols/switch.ts) calls these at
 * fixed points:
 *
 *   portIngress    frame arrived on a port, before any processing (ACL ingress)
 *   portEgress     frame about to leave a port (ACL egress)
 *   lagOf          physical port → its PortChannel (LAG member); null = member
 *                  that is not collecting/distributing (frames dropped)
 *   egressMember   PortChannel → the member a frame leaves on (hashing)
 *   allowEgress    may the bridge send this frame out of this port? (MCLAG
 *                  peer-link isolation, split horizon)
 *   flood          extra flood targets beyond local ports (VXLAN remote VTEPs)
 *   forwardVirtual deliver to a MAC-table entry whose interfaceId is not a local
 *                  port (e.g. "vtep:10.0.0.3")
 *   isLocalMac     extra MACs an L3 interface accepts as its own (VRRP vMAC)
 *   isLocalIp6     extra IPv6 addresses the device answers for (VRRPv3 VIP on the Master)
 *   l3Ingress      routed IPv4 packet on a router/L3 switch, after control-plane
 *                  daemons and before local delivery / forwarding: return a
 *                  replacement frame (NAT), null if the hook consumed it
 *                  (PBR, multicast routing — the hook emits its own events),
 *                  undefined to continue unchanged
 *   hostIngress    IPv4 frame reaching a host, before its NIC address filter;
 *                  true = consumed (multicast receivers)
 *   toCpu          a packet is trapped from the ASIC to the switch CPU (hostif
 *                  trap); return false to drop it (CoPP policer), or a string
 *                  naming another drop cause
 *
 * Every hook is optional; with nothing registered the engine behaves as before.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";

export interface DataPlaneHook {
  id: string;
  /** Return false to drop the frame (the hook records its own counters). */
  portIngress?(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame): boolean;
  portEgress?(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame): boolean;
  /** undefined = not a LAG member; NetInterface = its PortChannel; null = member, not collecting. */
  lagOf?(device: Device, iface: NetInterface): NetInterface | null | undefined;
  /** undefined = not my logical port; NetInterface = member to use; null = no usable member. */
  egressMember?(device: Device, logical: NetInterface, frame: Frame): NetInterface | null | undefined;
  allowEgress?(ctx: SimContext, sw: Device, ingressId: string | null, egress: NetInterface, vid: number, frame: Frame): boolean;
  flood?(ctx: SimContext, sw: Device, ingressId: string | null, vid: number, frame: Frame): void;
  forwardVirtual?(ctx: SimContext, sw: Device, entryInterfaceId: string, vid: number, frame: Frame): boolean;
  isLocalMac?(device: Device, iface: NetInterface, mac: string): boolean;
  isLocalIp6?(device: Device, ip: string): boolean;
  toCpu?(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame): boolean | string;
  l3Ingress?(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame, vrf: string): Frame | null | undefined;
  hostIngress?(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean;
}

const HOOKS: DataPlaneHook[] = [];

export function registerDataPlaneHook(h: DataPlaneHook): void {
  const i = HOOKS.findIndex((x) => x.id === h.id);
  if (i >= 0) HOOKS[i] = h;
  else HOOKS.push(h);
}

export function dataPlaneHooks(): readonly DataPlaneHook[] {
  return HOOKS;
}

/** First hook that rejects the frame, or undefined if every hook allows it. */
export function rejectingIngress(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame): string | undefined {
  for (const h of HOOKS) if (h.portIngress && !h.portIngress(ctx, device, iface, frame)) return h.id;
  return undefined;
}

export function rejectingEgress(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame): string | undefined {
  for (const h of HOOKS) if (h.portEgress && !h.portEgress(ctx, device, iface, frame)) return h.id;
  return undefined;
}

export function lagOf(device: Device, iface: NetInterface): NetInterface | null | undefined {
  for (const h of HOOKS) {
    const r = h.lagOf?.(device, iface);
    if (r !== undefined) return r;
  }
  return undefined;
}

export function egressMember(device: Device, logical: NetInterface, frame: Frame): NetInterface | null | undefined {
  for (const h of HOOKS) {
    const r = h.egressMember?.(device, logical, frame);
    if (r !== undefined) return r;
  }
  return undefined;
}

export function allowBridgeEgress(ctx: SimContext, sw: Device, ingressId: string | null, egress: NetInterface, vid: number, frame: Frame): boolean {
  return HOOKS.every((h) => !h.allowEgress || h.allowEgress(ctx, sw, ingressId, egress, vid, frame));
}

export function floodVirtual(ctx: SimContext, sw: Device, ingressId: string | null, vid: number, frame: Frame): void {
  for (const h of HOOKS) h.flood?.(ctx, sw, ingressId, vid, frame);
}

export function forwardVirtual(ctx: SimContext, sw: Device, entryInterfaceId: string, vid: number, frame: Frame): boolean {
  for (const h of HOOKS) if (h.forwardVirtual?.(ctx, sw, entryInterfaceId, vid, frame)) return true;
  return false;
}

/**
 * A frame reaches the switch CPU. Marks its captures as trapped; returns false
 * if a hook (CoPP) dropped it.
 */
export function trapToCpu(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame): boolean {
  for (const h of HOOKS) {
    const r = h.toCpu?.(ctx, device, iface, frame) ?? true;
    if (r !== true) {
      ctx.emit({
        type: "FRAME_DROPPED",
        deviceId: device.id,
        deviceName: device.name,
        interfaceId: iface.id,
        interfaceName: iface.name,
        message: `${device.name} ${iface.name}: ${typeof r === "string" ? r : "dropped on ingress by CoPP policer (trap to CPU)"}`,
        osiLayers: [2, 3],
        frame,
      });
      return false;
    }
  }
  ctx.markTrapped(device.id, frame.id);
  return true;
}

/** Run l3Ingress hooks in order: the frame to continue with, or null if consumed. */
export function runL3Ingress(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame, vrf: string): Frame | null {
  let f = frame;
  for (const h of HOOKS) {
    const r = h.l3Ingress?.(ctx, device, ingress, f, vrf);
    if (r === null) return null;
    if (r) f = r;
  }
  return f;
}

export function hostIngressConsumed(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  return HOOKS.some((h) => h.hostIngress?.(ctx, device, ingress, frame));
}

export function isExtraLocalIp6(device: Device, ip: string): boolean {
  return HOOKS.some((h) => h.isLocalIp6?.(device, ip));
}

export function isExtraLocalMac(device: Device, iface: NetInterface, mac: string): boolean {
  return HOOKS.some((h) => h.isLocalMac?.(device, iface, mac));
}
