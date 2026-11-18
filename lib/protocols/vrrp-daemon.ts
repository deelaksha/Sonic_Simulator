/**
 * VRRP daemon — a model of FRR vrrpd (src/sonic-frr/frr/vrrpd), the VRRP
 * implementation SONiC ships (frrcfgd renders CONFIG_DB VRRP rows into vrrpd
 * config; vrrpmgr creates the macvlan carrying the virtual MAC). IPv4 only.
 *
 * Per instance (interface, VRID) the RFC 5798 FSM runs with vrrpd's exact rules:
 *   Startup (vrrp.c:1546-1617): priority 255 / address owner → Master at once;
 *     otherwise Backup with Master_Adver_Interval = Advertisement_Interval and
 *     the Master_Down_Timer armed for Master_Down_Interval.
 *   Timers (vrrp_recalculate_timers, vrrp.c:87-96): see vrrpTimers() in vrrp.ts.
 *   Master: an advertisement every Advertisement_Interval (vrrp_adver_timer_expire,
 *     vrrp.c:1487-1510).
 *   Backup → Master when the Master_Down_Timer expires (vrrp.c:1515-1527).
 *   Becoming Master sends an advertisement and a gratuitous ARP for every VIP
 *     from the virtual MAC (vrrp_change_state_master, vrrp.c:1363-1405;
 *     vrrp_arp.c:62-99: ARP request, sender = target = VIP, target MAC ff:ff..).
 *   Receive (vrrp_recv_advertisement, vrrp.c:835-975):
 *     Master: prio 0 → send an advertisement now and re-arm the Adver_Timer;
 *             higher prio (or equal prio and higher source IP) → Backup.
 *     Backup: prio 0 → Master_Down_Timer = Skew_Time;
 *             !preempt or prio ≥ own → re-arm Master_Down_Timer (v3 learns the
 *             Master's interval); preempt and lower prio → discard (so a
 *             higher-priority Backup takes over when its timer expires).
 *   Validation (vrrp_pkt_parse, vrrp_packet.c:186-310): TTL 255, version equal
 *     to ours, checksum, type 1, v2 auth type 0; an address owner drops adverts;
 *     v2 requires the sender's interval to equal ours.
 *   Shutdown (vrrp_shutdown, vrrp.c:1621-1670) — interface down, `shutdown`, or
 *     the instance deleted — a Master first sends an advertisement with
 *     priority 0 (Backups then take over after Skew_Time), then → Initialize.
 *
 * Wire: VRRPv3 by default (version default 3), v2 when configured; advertisements
 * leave from the virtual MAC (vrrpd sends on the macvlan) to 01:00:5E:00:00:12.
 * Runtime state: device.config.features["vrrpd"].
 *
 * Timers fire on the first 100 ms control tick at/after their deadline
 * (nextDue reports the exact deadline), so an event can be late by < 100 ms.
 * Not modelled: IPv6 (vrrp6), multiple VIPs per group, accept-mode off,
 * autoconfiguration, VRF-scoped instances.
 */
import { Device } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { featureState, peekFeatureState } from "../models/feature-state";
import { ipToInt } from "../models/ip";
import { BROADCAST_MAC } from "../models/mac";
import { registerDaemon } from "../control/daemon";
import { registerDataPlaneHook } from "../control/hooks";
import { ipv4Packet, ipPayload, multicastMac } from "../control/packet";
import { buildFrame } from "./ethernet";
import { buildArpRequest } from "./arp";
import { decodeVrrp, encodeVrrp, tcpdumpVrrp } from "./vrrp-packet";
import {
  VrrpInstance, VrrpRuntime, VrrpdState, VRRP_RT, VRRP_GROUP, VRRP_PROTO,
  instancesOf, vrrpKey, vrrpMac, liveIface, effectivePriority, isOwner, vrrpTimers,
  advIntervalCs, versionOf, preemptOf, isMasterVMacOn,
} from "./vrrp";

const CS = 10; // ms per centisecond
const rt = (device: Device) => featureState<VrrpdState>(device, VRRP_RT, () => ({ routers: {} }));

function sendAdvert(ctx: SimContext, device: Device, iface: NetInterface, inst: VrrpInstance, r: VrrpRuntime, priority: number): void {
  const src = primaryIpv4(iface)?.address;
  if (!src || !inst.vip) return;
  const version = versionOf(inst);
  const payload = encodeVrrp({ version, vrid: inst.vrid, priority, intervalCs: advIntervalCs(inst), addrs: [inst.vip], src });
  const rawL3 = ipv4Packet({ src, dst: VRRP_GROUP, proto: VRRP_PROTO, ttl: 255, tos: 0xc0, payload });
  const frame: Frame = buildFrame(
    { srcMac: vrrpMac(inst.vrid), dstMac: multicastMac(VRRP_GROUP), etherType: "IPv4", payloadBytes: rawL3.length, summary: `VRRPv${version} Advertisement vrid ${inst.vrid} prio ${priority}` },
    { ipv4: { srcIp: src, dstIp: VRRP_GROUP, ttl: 255, protocol: "OTHER", protocolNumber: VRRP_PROTO, identification: 0 } },
  );
  frame.rawL3 = rawL3;
  ctx.transmit(device.id, iface.id, frame);
  r.adverTx++;
}

function sendGarp(ctx: SimContext, device: Device, iface: NetInterface, inst: VrrpInstance, r: VrrpRuntime): void {
  const vmac = vrrpMac(inst.vrid);
  const garp = buildArpRequest(vmac, inst.vip!, inst.vip!);
  garp.arp!.targetMac = BROADCAST_MAC;
  ctx.transmit(device.id, iface.id, garp);
  r.garpTx++;
}

function changeState(ctx: SimContext, device: Device, iface: NetInterface | undefined, inst: VrrpInstance, r: VrrpRuntime, to: VrrpRuntime["state"]): void {
  if (r.state === to) return;
  const from = r.state;
  r.state = to;
  r.transitions++;
  if (to === "Backup") r.advertAt = undefined;
  if (to === "Initialize") {
    r.masterAdverInterval = 0;
    r.advertAt = r.masterDownAt = r.masterIp = undefined;
  }
  if (to === "Master" || from === "Master") {
    ctx.emit({
      type: to === "Master" ? "VRRP_MASTER" : "VRRP_FAILOVER",
      deviceId: device.id, deviceName: device.name, interfaceId: iface?.id, interfaceName: inst.iface,
      message: `${device.name}: VRRP ${inst.iface} vrid ${inst.vrid} ${from} -> ${to}`, osiLayers: [3],
    });
  }
  if (to === "Master" && iface) {
    r.masterIp = primaryIpv4(iface)?.address;
    sendAdvert(ctx, device, iface, inst, r, effectivePriority(iface, inst));
    sendGarp(ctx, device, iface, inst, r);
  }
}

/** vrrp_startup (vrrp.c:1546-1617). */
function startup(ctx: SimContext, device: Device, iface: NetInterface, inst: VrrpInstance, r: VrrpRuntime, now: number): void {
  const adv = advIntervalCs(inst);
  if (effectivePriority(iface, inst) === 255) {
    r.advertAt = now + adv * CS;
    changeState(ctx, device, iface, inst, r, "Master");
  } else {
    r.masterAdverInterval = adv;
    r.masterDownAt = now + vrrpTimers(inst, adv).mdi * CS;
    changeState(ctx, device, iface, inst, r, "Backup");
  }
}

/** vrrp_shutdown (vrrp.c:1621-1670): a Master announces priority 0 before leaving. */
function shutdown(ctx: SimContext, device: Device, inst: VrrpInstance, r: VrrpRuntime): void {
  const iface = device.interfaces.find((i) => i.name === inst.iface);
  if (r.state === "Master" && iface) sendAdvert(ctx, device, iface, inst, r, 0);
  changeState(ctx, device, iface, inst, r, "Initialize");
}

function nextDue(device: Device, now: number): number | undefined {
  if (device.state === "down") return undefined;
  const cfg = instancesOf(device);
  const routers = peekFeatureState<VrrpdState>(device, VRRP_RT)?.routers ?? {};
  let due: number | undefined;
  const at = (t: number | undefined) => {
    if (t !== undefined && (due === undefined || t < due)) due = t;
  };
  for (const inst of cfg) {
    const r = routers[vrrpKey(inst.iface, inst.vrid)];
    const live = !!liveIface(device, inst);
    if (live !== (!!r && r.state !== "Initialize")) return now; // start up / shut down
    if (r?.state === "Master") at(r.advertAt);
    if (r?.state === "Backup") at(r.masterDownAt);
  }
  for (const key of Object.keys(routers)) if (!cfg.some((i) => vrrpKey(i.iface, i.vrid) === key)) return now; // deleted
  return due;
}

function tick(ctx: SimContext, device: Device, now: number): boolean {
  const cfg = instancesOf(device);
  const st = rt(device);
  let changed = false;
  // Instances removed from the config: shut down (priority 0 if Master), then forget.
  for (const [key, r] of Object.entries(st.routers)) {
    if (cfg.some((i) => vrrpKey(i.iface, i.vrid) === key)) continue;
    shutdown(ctx, device, r.last, r);
    delete st.routers[key];
    changed = true;
  }
  for (const inst of cfg) {
    const key = vrrpKey(inst.iface, inst.vrid);
    const iface = liveIface(device, inst);
    let r = st.routers[key];
    if (!iface) {
      if (r && r.state !== "Initialize") {
        shutdown(ctx, device, inst, r);
        changed = true;
      }
      if (r) r.last = { ...inst };
      continue;
    }
    if (!r) r = st.routers[key] = { state: "Initialize", masterAdverInterval: 0, adverTx: 0, adverRx: 0, garpTx: 0, transitions: 0, last: { ...inst } };
    r.last = { ...inst };
    if (r.state === "Initialize") {
      startup(ctx, device, iface, inst, r, now);
      changed = true;
    } else if (r.state === "Master" && r.advertAt !== undefined && now >= r.advertAt) {
      sendAdvert(ctx, device, iface, inst, r, effectivePriority(iface, inst));
      const adv = advIntervalCs(inst) * CS;
      r.advertAt = r.advertAt + adv > now ? r.advertAt + adv : now + adv;
      changed = true;
    } else if (r.state === "Backup" && r.masterDownAt !== undefined && now >= r.masterDownAt) {
      r.masterDownAt = undefined;
      r.advertAt = now + advIntervalCs(inst) * CS;
      changeState(ctx, device, iface, inst, r, "Master");
      changed = true;
    }
  }
  return changed;
}

function receiveL3(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const ip = frame.ipv4;
  if (!ip || ip.dstIp !== VRRP_GROUP || ip.protocolNumber !== VRRP_PROTO) return false;
  const bytes = ipPayload(frame);
  const inst = instancesOf(device).find((i) => i.iface === ingress.name && bytes && i.vrid === bytes[1]);
  const r = inst && peekFeatureState<VrrpdState>(device, VRRP_RT)?.routers[vrrpKey(inst.iface, inst.vrid)];
  if (!bytes || !inst || !r || r.state === "Initialize" || !liveIface(device, inst)) return true; // no socket: dropped
  const pkt = decodeVrrp(bytes, ip.srcIp);
  if (!pkt || ip.ttl !== 255 || pkt.version !== versionOf(inst) || !pkt.checksumOk || pkt.type !== 1) return true;
  if (pkt.version === 2 && pkt.authType !== 0) return true;
  if (isOwner(ingress, inst)) return true;
  if (pkt.version === 2 && pkt.adverInt !== Math.max(Math.floor(advIntervalCs(inst) / 100), 1)) return true;

  const now = ctx.wallNow();
  r.adverRx++;
  const myPrio = effectivePriority(ingress, inst);
  const mySrc = primaryIpv4(ingress)!.address;
  if (r.state === "Master") {
    if (pkt.priority === 0) {
      sendAdvert(ctx, device, ingress, inst, r, myPrio);
      r.advertAt = now + advIntervalCs(inst) * CS;
    } else if (pkt.priority > myPrio || (pkt.priority === myPrio && ipToInt(ip.srcIp) > ipToInt(mySrc))) {
      if (pkt.version === 3) r.masterAdverInterval = pkt.adverInt;
      r.masterDownAt = now + vrrpTimers(inst, r.masterAdverInterval).mdi * CS;
      changeState(ctx, device, ingress, inst, r, "Backup");
      r.masterIp = ip.srcIp;
    }
  } else if (pkt.priority === 0) {
    r.masterDownAt = now + vrrpTimers(inst, r.masterAdverInterval).skew * CS;
  } else if (!preemptOf(inst) || pkt.priority >= myPrio) {
    if (pkt.version === 3) r.masterAdverInterval = pkt.adverInt;
    r.masterDownAt = now + vrrpTimers(inst, r.masterAdverInterval).mdi * CS;
    r.masterIp = ip.srcIp;
  }
  return true;
}

function describe(frame: Frame, verbose: boolean): string | undefined {
  if (frame.ipv4?.protocolNumber !== VRRP_PROTO) return undefined;
  const p = ipPayload(frame);
  return p ? tcpdumpVrrp(p, frame.ipv4.ttl, verbose) : undefined;
}

registerDaemon({ id: "vrrp", nextDue, tick, receiveL3, describe });

// SVIs / routed ports accept frames to the virtual MAC only where this box is Master.
registerDataPlaneHook({ id: "vrrp", isLocalMac: (device, iface, mac) => isMasterVMacOn(device, iface, mac) });
