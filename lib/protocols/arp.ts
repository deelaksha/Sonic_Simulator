/**
 * ARP engine (spec §11). Real request/reply/cache behaviour modelled on the
 * Linux neighbour subsystem (net/ipv4/arp.c arp_process, net/core/neighbour.c):
 *
 *   - A request for one of our addresses creates/updates the sender's entry as
 *     STALE (neigh_event_ns); only a unicast reply to us makes it REACHABLE.
 *   - Other ARP (requests for someone else, gratuitous ARP, broadcast replies)
 *     only update an EXISTING entry, never create one: arp_accept=0 on SONiC
 *     (files/image_config/sysctl/sysctl-net.conf:8,20) and stock Linux.
 *   - An INCOMPLETE entry is created before the request goes out, so the reply
 *     finds it (that is what makes a solicited reply acceptable).
 *   - Using a STALE entry sends with the cached MAC and schedules a unicast probe
 *     after delay_first_probe_time (5 s); a reply makes it REACHABLE again, three
 *     unanswered probes (ucast_probes=3, retrans_time 1 s) delete it.
 *   - Static entries (`config arp add` / KLISH `ip arp`) are PERMANENT: ARP never
 *     changes them and aging / `clear` never removes them.
 *
 * Aging + gratuitous ARP run in the ARP daemon (./arp-daemon.ts). Per-entry
 * timers live in device.config.features["arp"] (the ArpEntry model has none).
 */
import { Device, ArpEntry, findInterface } from "../models/device";
import { NetInterface, ownsIp, primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { BROADCAST_MAC, NULL_MAC } from "../models/mac";
import { SimContext } from "../engine/context";
import { ownsVipAsMaster, masteredVips } from "./vrrp";
import { ArpTableRow } from "../engine/events";
import { buildFrame } from "./ethernet";
import { featureState, peekFeatureState } from "../models/feature-state";

/** Linux neigh defaults (Documentation/networking/ip-sysctl.rst). */
export const DELAY_FIRST_PROBE_MS = 5_000;
export const RETRANS_MS = 1_000;
export const UCAST_PROBES = 3;

/** Per-entry timing kept beside the ArpEntry (keyed by IP, like device.arpTable). */
export interface NeighTimer {
  /** Wall ms of the last state change / update (neigh->updated). */
  t: number;
  /** Last time the entry was used to send (neigh->used). */
  used?: number;
  /** Next unicast probe (entry in DELAY/PROBE). */
  probeAt?: number;
  probes?: number;
  /** Static entry (NUD_PERMANENT). */
  perm?: boolean;
}

export interface ArpRuntime {
  nb: Record<string, NeighTimer>;
  /** Per-interface "up|addresses" last seen by the daemon (gratuitous ARP + carrier flush). */
  ifs: Record<string, string>;
  /** Per-interface `ip arp timeout <25-65535>` in seconds (KLISH interface.xml:1123). */
  timeouts: Record<string, number>;
}

export const ARP_RT = "arp";

export function arpRuntime(device: Device): ArpRuntime {
  const rt = featureState<ArpRuntime>(device, ARP_RT, () => ({ nb: {}, ifs: {}, timeouts: {} }));
  rt.nb ??= {};
  rt.ifs ??= {};
  rt.timeouts ??= {};
  return rt;
}

export function peekArpRuntime(device: Device): ArpRuntime | undefined {
  return peekFeatureState<ArpRuntime>(device, ARP_RT);
}

export function isPermanent(device: Device, ip: string): boolean {
  return !!peekArpRuntime(device)?.nb?.[ip]?.perm;
}

/** Install a static (PERMANENT) neighbour, replacing any dynamic one. */
export function addStaticArp(device: Device, ip: string, mac: string, interfaceId: string, now: number): void {
  device.arpTable = device.arpTable.filter((e) => e.ip !== ip);
  device.arpTable.push({ ip, mac, interfaceId, state: "reachable" });
  arpRuntime(device).nb[ip] = { t: now, perm: true };
}

/** Remove a neighbour and its timer. */
export function deleteArp(device: Device, ip: string): void {
  device.arpTable = device.arpTable.filter((e) => e.ip !== ip);
  const rt = peekArpRuntime(device);
  if (rt?.nb) delete rt.nb[ip];
}

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

/** ARP request; `dstMac` other than broadcast makes it a unicast probe (target MAC stays zero). */
export function buildArpRequest(senderMac: string, senderIp: string, targetIp: string, dstMac: string = BROADCAST_MAC): Frame {
  return buildFrame(
    {
      srcMac: senderMac,
      dstMac,
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

export interface LearnOpts {
  /** Wall-clock ms (ctx.wallNow()). */
  now?: number;
  /** New NUD state (default reachable). */
  state?: "reachable" | "stale";
  /** Create the entry if it does not exist (default true). */
  create?: boolean;
}

/** Insert/update a neighbour cache entry (neigh_update). Returns true if new or changed. */
export function learnArp(device: Device, ip: string, mac: string, interfaceId: string, opts: LearnOpts = {}): boolean {
  const now = opts.now ?? 0;
  const state = opts.state ?? "reachable";
  const rt = arpRuntime(device);
  if (rt.nb[ip]?.perm) return false; // NUD_PERMANENT is never updated by ARP
  const existing = device.arpTable.find((e) => e.ip === ip);
  if (existing) {
    // A STALE update with the same lladdr keeps a valid entry's state (neigh_update).
    if (state === "stale" && existing.state !== "incomplete" && existing.mac === mac) return false;
    const changed = existing.mac !== mac || existing.state !== state || existing.interfaceId !== interfaceId;
    existing.mac = mac;
    existing.interfaceId = interfaceId;
    existing.state = state;
    rt.nb[ip] = { t: now, used: rt.nb[ip]?.used };
    return changed;
  }
  if (opts.create === false) return false;
  const entry: ArpEntry = { ip, mac, interfaceId, state };
  device.arpTable.push(entry);
  rt.nb[ip] = { t: now };
  return true;
}

function markIncomplete(device: Device, ip: string, interfaceId: string, now: number): void {
  const existing = device.arpTable.find((e) => e.ip === ip);
  if (existing) {
    existing.state = "incomplete";
    existing.mac = NULL_MAC;
    existing.interfaceId = interfaceId;
  } else {
    device.arpTable.push({ ip, mac: NULL_MAC, interfaceId, state: "incomplete" });
  }
  arpRuntime(device).nb[ip] = { t: now };
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
  const now = ctx.wallNow();

  const cached = device.arpTable.find((e) => e.ip === ip);
  if (cached && cached.state === "reachable") {
    const t = arpRuntime(device).nb[ip];
    if (t) t.used = now;
    return cached.mac;
  }
  if (cached && cached.state === "stale" && cached.mac !== NULL_MAC) {
    // STALE → DELAY: send with the cached address, probe it 5 s later.
    const rt = arpRuntime(device);
    const t = (rt.nb[ip] ??= { t: now });
    t.used = now;
    if (t.probeAt === undefined) {
      t.probeAt = now + DELAY_FIRST_PROBE_MS;
      t.probes = 0;
    }
    return cached.mac;
  }

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
  // The INCOMPLETE entry must exist before the reply arrives (arp_accept=0).
  markIncomplete(device, ip, iface.id, now);
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
    const t = arpRuntime(device).nb[ip];
    if (t) t.used = now;
    return resolved.mac;
  }

  return null;
}

/** Send one unicast probe for a STALE/DELAY entry (neigh_probe → arp_solicit). */
export function sendArpProbe(ctx: SimContext, device: Device, entry: ArpEntry): boolean {
  const iface = findInterface(device, entry.interfaceId);
  const src = iface && primaryIpv4(iface);
  if (!iface || !src) return false;
  ctx.transmit(device.id, iface.id, buildArpRequest(iface.mac, src.address, entry.ip, entry.mac));
  return true;
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
  const now = ctx.wallNow();

  const vrrpOwned = !device.interfaces.some((i) => ownsIp(i, arp.targetIp)) && ownsVipAsMaster(ctx.state, device, arp.targetIp);
  const owner = device.interfaces.find((i) => ownsIp(i, arp.targetIp));
  const forUs = arp.op === "request" && (!!owner || vrrpOwned);
  const garp = arp.senderIp === arp.targetIp;

  if (arp.senderIp !== "0.0.0.0") {
    if (forUs && !garp) {
      // neigh_event_ns: the requester becomes a STALE neighbour.
      learnArp(device, arp.senderIp, arp.senderMac, ingress.id, { now, state: "stale" });
    } else {
      const unicastReply = arp.op === "reply" && frame.ethernet.dstMac.toUpperCase() === ingress.mac.toUpperCase();
      learnArp(device, arp.senderIp, arp.senderMac, ingress.id, { now, state: unicastReply ? "reachable" : "stale", create: false });
    }
  }

  if (arp.op !== "request" || garp) return;

  // VRRP: the Master answers ARP for a virtual IP with the virtual MAC (Backups stay silent).
  if (vrrpOwned) {
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
