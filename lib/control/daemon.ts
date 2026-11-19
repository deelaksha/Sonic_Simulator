/**
 * Control-plane daemon framework. Every running protocol (ARP aging, LLDP, BFD,
 * OSPF, BGP, SNMP) is a ControlDaemon registered here; the engine and store call
 * into this registry instead of into individual protocols, so protocols are
 * added without touching the forwarding engine.
 *
 *   tick       wall-clock driven work: send Hellos/keepalives, expire timers.
 *              Called only when nextDue() says something is due.
 *   receiveL2  link-local control frames (dst 01:80:C2:00:00:0X, e.g. LLDP).
 *              802.1D bridges never forward these.
 *   receiveL3  IPv4 packets delivered to the device's own IP stack (unicast to
 *              one of its addresses, broadcast, or multicast).
 *   describe   tcpdump text for the protocol's packets.
 *
 * Daemon state lives in device.config.features (serializable, part of the lab).
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { NetworkState } from "../models/topology";
import { SimContext } from "../engine/context";
import { isBroadcast, isMulticast } from "../models/mac";

export interface ControlDaemon {
  id: string;
  /** Earliest wall-clock ms this daemon needs a tick on this device (undefined = idle). */
  nextDue?(device: Device, nowMs: number): number | undefined;
  /** Do the due work. Return true when daemon state changed without sending packets. */
  tick?(ctx: SimContext, device: Device, nowMs: number): boolean | void;
  receiveL2?(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean;
  receiveL3?(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean;
  /** tcpdump text for this protocol's packet (after "IP src > dst: " for IP). */
  describe?(frame: Frame, verbose: boolean): string | undefined;
}

const DAEMONS: ControlDaemon[] = [];

export function registerDaemon(d: ControlDaemon): void {
  const i = DAEMONS.findIndex((x) => x.id === d.id);
  if (i >= 0) DAEMONS[i] = d;
  else DAEMONS.push(d);
}

export function controlDaemons(): readonly ControlDaemon[] {
  return DAEMONS;
}

/** IEEE 802.1D reserved link-local group (01:80:C2:00:00:00-0F): never bridged. */
export function isLinkLocalControl(mac: string): boolean {
  // IEEE 802.1D reserved range, plus the Cisco UDLD/CDP address (never bridged).
  return /^01:80:C2:00:00:0[0-9A-F]$/i.test(mac) || /^01:00:0C:CC:CC:CC$/i.test(mac);
}

export function dispatchL2(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  for (const d of DAEMONS) if (d.receiveL2?.(ctx, device, ingress, frame)) return true;
  return false;
}

/** Offer an IPv4 packet that reached the device's IP stack to the daemons. */
export function dispatchL3(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  if (!frame.ipv4) return false;
  const dst = frame.ethernet.dstMac;
  if (dst.toUpperCase() !== ingress.mac.toUpperCase() && !isBroadcast(dst) && !isMulticast(dst)) return false;
  for (const d of DAEMONS) if (d.receiveL3?.(ctx, device, ingress, frame)) return true;
  return false;
}

export function describeControl(frame: Frame, verbose: boolean): string | undefined {
  for (const d of DAEMONS) {
    const s = d.describe?.(frame, verbose);
    if (s) return s;
  }
  return undefined;
}

/** Earliest due time across all daemons and devices (undefined = nothing scheduled). */
export function nextControlDue(state: NetworkState, nowMs: number): number | undefined {
  let due: number | undefined;
  for (const device of Object.values(state.devices)) {
    for (const d of DAEMONS) {
      const t = d.nextDue?.(device, nowMs);
      if (t !== undefined && (due === undefined || t < due)) due = t;
    }
  }
  return due;
}

/** Run every due daemon on every device. Returns true if anything changed. */
export function runControlTick(ctx: SimContext, state: NetworkState, nowMs: number): boolean {
  let changed = false;
  for (const device of Object.values(state.devices)) {
    if (device.state === "down") continue;
    for (const d of DAEMONS) {
      if (!d.tick) continue;
      const t = d.nextDue?.(device, nowMs);
      if (t === undefined || t > nowMs) continue;
      if (d.tick(ctx, device, nowMs)) changed = true;
    }
  }
  return changed;
}
