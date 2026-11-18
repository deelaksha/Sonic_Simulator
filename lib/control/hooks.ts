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

export function isExtraLocalMac(device: Device, iface: NetInterface, mac: string): boolean {
  return HOOKS.some((h) => h.isLocalMac?.(device, iface, mac));
}
