/**
 * VRRP daemon — a model of FRR vrrpd (src/sonic-frr/frr/vrrpd), the VRRP
 * implementation SONiC ships (frrcfgd renders CONFIG_DB VRRP/VRRP6 rows into vrrpd
 * config; vrrpmgr creates the macvlan carrying the virtual MAC). IPv4 and IPv6.
 *
 * Per instance (interface, VRID) and address family the RFC 5798 FSM runs with
 * vrrpd's exact rules:
 *   Startup (vrrp.c:1546-1617): priority 255 / address owner → Master at once;
 *     otherwise Backup with Master_Adver_Interval = Advertisement_Interval and
 *     the Master_Down_Timer armed for Master_Down_Interval.
 *   Timers (vrrp_recalculate_timers, vrrp.c:87-96): see vrrpTimers() in vrrp.ts.
 *   Master: an advertisement every Advertisement_Interval (vrrp_adver_timer_expire,
 *     vrrp.c:1487-1510).
 *   Backup → Master when the Master_Down_Timer expires (vrrp.c:1515-1527).
 *   Becoming Master sends an advertisement and announces every VIP from the
 *     virtual MAC (vrrp_change_state_master, vrrp.c:1363-1405): IPv4 gratuitous
 *     ARP (vrrp_arp.c:62-99: ARP request, sender = target = VIP, target MAC ff:ff..),
 *     IPv6 unsolicited Neighbor Advertisement (vrrp_ndisc.c:56-134: to ff02::1 /
 *     33:33:00:00:00:01, source = the VIP, hop limit 255, flags Router|Override,
 *     target link-layer option = the vMAC).
 *   Receive (vrrp_recv_advertisement, vrrp.c:835-975):
 *     Master: prio 0 → send an advertisement now and re-arm the Adver_Timer;
 *             higher prio (or equal prio and higher source IP) → Backup.
 *     Backup: prio 0 → Master_Down_Timer = Skew_Time;
 *             !preempt or prio ≥ own → re-arm Master_Down_Timer (v3 learns the
 *             Master's interval); preempt and lower prio → discard (so a
 *             higher-priority Backup takes over when its timer expires).
 *   Validation (vrrp_pkt_parse, vrrp_packet.c:186-310): TTL / hop limit 255,
 *     version equal to ours, checksum, type 1, v2 auth type 0; an address owner
 *     drops adverts; v2 requires the sender's interval to equal ours.
 *   Shutdown (vrrp_shutdown, vrrp.c:1621-1670) — interface down, `shutdown`, or
 *     the instance deleted — a Master first sends an advertisement with
 *     priority 0 (Backups then take over after Skew_Time), then → Initialize.
 *
 * Wire: VRRPv3 by default (version default 3), v2 when configured (IPv4 only);
 * advertisements leave from the virtual MAC (vrrpd sends on the macvlan) to
 * 01:00:5E:00:00:12 (224.0.0.18) or 33:33:00:00:00:12 (ff02::12, from the macvlan's
 * link-local, vrrp.c:698-734). IPv6 adverts reach the daemon through the IPv6
 * stack's receiver registry (lib/protocols/ipv6.ts registerV6Receiver).
 *
 * Neighbor Discovery for an IPv6 VIP: in SONiC the Master's macvlan owns the VIP and
 * the kernel answers Neighbor Solicitations for it with the vMAC (solicited NA,
 * Router|Solicited|Override); a Backup's macvlan is protodown and stays silent
 * (vrrp.c:1412-1431). The IPv6 stack resolves NDP before its receiver registry,
 * so that answer is produced from a port-ingress hook here.
 *
 * Tracking (vrrp.ts trackPenalty) lowers the advertised priority while a tracked
 * interface is down; the FSM above then fails over exactly as for a lower
 * configured priority (with preempt on the peer).
 *
 * Feature: vrrpd runs in the bgp container (docker-fpm-frr supervisord.conf.j2:148).
 * `config feature state bgp disabled` sends SIGTERM: vrrp_fini destroys every
 * virtual router (vrrp_main.c:67-75, vrrp.c:2411), i.e. vrrp_shutdown — a Master
 * announces priority 0 — and all runtime is gone until the feature is re-enabled.
 * Runtime state: device.config.features["vrrpd"].
 *
 * Timers fire on the first 100 ms control tick at/after their deadline
 * (nextDue reports the exact deadline), so an event can be late by < 100 ms.
 * Not modelled: accept-mode off (vrrpd always accepts, vrrp.h:256), autoconfiguration,
 * VRF-scoped instances, ping to an IPv6 VIP (the IPv6 stack has no VIP ownership hook).
 */
import { Device, isSwitch } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { featureState, peekFeatureState } from "../models/feature-state";
import { ipToInt } from "../models/ip";
import { BROADCAST_MAC } from "../models/mac";
import { ipv6Bytes, normalizeIpv6, parseIpv6 } from "../models/ipv6";
import { registerDaemon } from "../control/daemon";
import { logEvent } from "../control/syslog";
import { lagOf, registerDataPlaneHook } from "../control/hooks";
import { ipv4Packet, ipPayload, multicastMac } from "../control/packet";
import { inetChecksum } from "../sflow/wire";
import { buildFrame } from "./ethernet";
import { buildArpRequest } from "./arp";
import { ip6Payload, ip6NextHeader, ipv6Packet, multicastMac6, registerV6Receiver } from "./ipv6";
import { featureEnabled } from "./cpu-features";
import { decodeVrrp, encodeVrrp, tcpdumpVrrp } from "./vrrp-packet";
import {
  VrrpInstance, VrrpRuntime, VrrpdState, VrrpFamily, VRRP_RT, VRRP_GROUP, VRRP_GROUP6, VRRP_PROTO,
  instancesOf, vrrpKey, vrrpMac, liveIface, liveMaster, effectivePriority, isOwner, vrrpTimers,
  advIntervalCs, versionOf, preemptOf, isMasterVMacOn, ownsVip6AsMaster, vrrpLinkLocal6,
} from "./vrrp";

const CS = 10; // ms per centisecond
const FAMS: VrrpFamily[] = ["v4", "v6"];
const FAM_STR = { v4: "IPv4", v6: "IPv6" } as const; // family2str
const rt = (device: Device) => featureState<VrrpdState>(device, VRRP_RT, () => ({ routers: {} }));

/** Source address of the family's advertisements (vrrp_bind_to_primary_connected, vrrp.c:692-734). */
function srcOf(device: Device, iface: NetInterface, inst: VrrpInstance, fam: VrrpFamily): string | undefined {
  return fam === "v4" ? primaryIpv4(iface)?.address : vrrpLinkLocal6(device, inst);
}

function sendAdvert(ctx: SimContext, device: Device, iface: NetInterface, inst: VrrpInstance, r: VrrpRuntime, priority: number, fam: VrrpFamily): void {
  const src = srcOf(device, iface, inst, fam);
  const addrs = fam === "v4" ? (inst.vip ? [inst.vip] : []) : inst.vips6 ?? [];
  if (!src || !addrs.length) return;
  const version = versionOf(inst);
  const payload = encodeVrrp({ version, vrid: inst.vrid, priority, intervalCs: advIntervalCs(inst), addrs, src });
  const summary = `VRRPv${version} Advertisement vrid ${inst.vrid} prio ${priority}`;
  let frame: Frame;
  if (fam === "v4") {
    const rawL3 = ipv4Packet({ src, dst: VRRP_GROUP, proto: VRRP_PROTO, ttl: 255, tos: 0xc0, payload });
    frame = buildFrame(
      { srcMac: vrrpMac(inst.vrid), dstMac: multicastMac(VRRP_GROUP), etherType: "IPv4", payloadBytes: rawL3.length, summary },
      { ipv4: { srcIp: src, dstIp: VRRP_GROUP, ttl: 255, protocol: "OTHER", protocolNumber: VRRP_PROTO, identification: 0 } },
    );
    frame.rawL3 = rawL3;
  } else {
    // Traffic class IPTOS_PREC_INTERNETCONTROL, hop limit 255 (vrrp.c:1225-1235).
    const rawL3 = ipv6Packet({ src, dst: VRRP_GROUP6, nextHeader: VRRP_PROTO, hopLimit: 255, trafficClass: 0xc0, payload });
    frame = buildFrame(
      { srcMac: vrrpMac(inst.vrid, "v6"), dstMac: multicastMac6(VRRP_GROUP6), etherType: "IPv6", payloadBytes: rawL3.length, summary },
      { ipv6: { srcIp: src, dstIp: VRRP_GROUP6, hopLimit: 255, nextHeader: "OTHER" } },
    );
    frame.rawL3 = rawL3;
  }
  ctx.transmit(device.id, iface.id, frame);
  r.adverTx++;
}

/**
 * ICMPv6 Neighbor Advertisement for `target` from the vMAC: unsolicited (to all-nodes,
 * Router|Override, vrrp_ndisc.c:56-134) or the kernel's solicited answer
 * (Router|Solicited|Override) to `dst`/`dstMac`.
 */
function neighAdvert(vmac: string, target: string, dst: string, dstMac: string, solicited: boolean): Frame {
  const flags = 0x80 | (solicited ? 0x40 : 0) | 0x20;
  const icmp = [136, 0, 0, 0, flags, 0, 0, 0, ...ipv6Bytes(target), 2, 1, ...vmac.split(":").map((x) => parseInt(x, 16))];
  const l = icmp.length;
  const ck = inetChecksum([...ipv6Bytes(target), ...ipv6Bytes(dst), 0, 0, (l >> 8) & 0xff, l & 0xff, 0, 0, 0, 58, ...icmp]);
  icmp[2] = ck >> 8;
  icmp[3] = ck & 0xff;
  const rawL3 = ipv6Packet({ src: target, dst, nextHeader: 58, hopLimit: 255, payload: icmp });
  const frame = buildFrame(
    { srcMac: vmac, dstMac, etherType: "IPv6", payloadBytes: rawL3.length, summary: `NDP Neighbor Advertisement ${target} is-at ${vmac}${solicited ? "" : " (unsolicited)"}` },
    { ipv6: { srcIp: target, dstIp: dst, hopLimit: 255, nextHeader: "ICMPv6" }, icmp6: { type: "neighbor-advertisement", code: 0, targetAddr: target, linkLayerAddr: vmac } },
  );
  frame.rawL3 = rawL3;
  return frame;
}

/** Becoming Master: gratuitous ARP (v4) / unsolicited NA (v6) for every VIP. */
function announce(ctx: SimContext, device: Device, iface: NetInterface, inst: VrrpInstance, r: VrrpRuntime, fam: VrrpFamily): void {
  const vmac = vrrpMac(inst.vrid, fam);
  if (fam === "v4") {
    const garp = buildArpRequest(vmac, inst.vip!, inst.vip!);
    garp.arp!.targetMac = BROADCAST_MAC;
    ctx.transmit(device.id, iface.id, garp);
    r.garpTx++;
    return;
  }
  for (const vip of inst.vips6 ?? []) {
    ctx.transmit(device.id, iface.id, neighAdvert(vmac, vip, "ff02::1", multicastMac6("ff02::1"), false));
    r.garpTx++; // stats.una_tx_cnt — "Neigh. Adverts Tx (v6)"
  }
}

function changeState(ctx: SimContext, device: Device, iface: NetInterface | undefined, inst: VrrpInstance, r: VrrpRuntime, to: VrrpRuntime["state"], fam: VrrpFamily): void {
  if (r.state === to) return;
  const from = r.state;
  r.state = to;
  r.transitions++;
  logEvent(device, ctx.wallNow(), "INFO", "bgp#vrrpd", `[CORE] [VRID ${inst.vrid}] [${FAM_STR[fam]}] ${from} -> ${to}`); // vrrpd/vrrp.c:1476-1478
  if (to === "Backup") r.advertAt = undefined;
  if (to === "Initialize") {
    r.masterAdverInterval = 0;
    r.advertAt = r.masterDownAt = r.masterIp = undefined;
  }
  if (to === "Master" || from === "Master") {
    ctx.emit({
      type: to === "Master" ? "VRRP_MASTER" : "VRRP_FAILOVER",
      deviceId: device.id, deviceName: device.name, interfaceId: iface?.id, interfaceName: inst.iface,
      message: `${device.name}: VRRP${fam === "v6" ? "6" : ""} ${inst.iface} vrid ${inst.vrid} ${from} -> ${to}`, osiLayers: [3],
    });
  }
  if (to === "Master" && iface) {
    r.masterIp = srcOf(device, iface, inst, fam);
    sendAdvert(ctx, device, iface, inst, r, effectivePriority(device, iface, inst, fam), fam);
    announce(ctx, device, iface, inst, r, fam);
  }
}

/** vrrp_startup (vrrp.c:1546-1617). */
function startup(ctx: SimContext, device: Device, iface: NetInterface, inst: VrrpInstance, r: VrrpRuntime, now: number, fam: VrrpFamily): void {
  const adv = advIntervalCs(inst);
  if (effectivePriority(device, iface, inst, fam) === 255) {
    r.advertAt = now + adv * CS;
    changeState(ctx, device, iface, inst, r, "Master", fam);
  } else {
    r.masterAdverInterval = adv;
    r.masterDownAt = now + vrrpTimers(inst, adv).mdi * CS;
    changeState(ctx, device, iface, inst, r, "Backup", fam);
  }
}

/** vrrp_shutdown (vrrp.c:1621-1670): a Master announces priority 0 before leaving. */
function shutdown(ctx: SimContext, device: Device, inst: VrrpInstance, r: VrrpRuntime, fam: VrrpFamily): void {
  const iface = device.interfaces.find((i) => i.name === inst.iface);
  if (r.state === "Master" && iface) sendAdvert(ctx, device, iface, inst, r, 0, fam);
  changeState(ctx, device, iface, inst, r, "Initialize", fam);
}

const famOfKey = (key: string): VrrpFamily => (key.endsWith("|v6") ? "v6" : "v4");

function nextDue(device: Device, now: number): number | undefined {
  if (device.state === "down") return undefined;
  const routers = peekFeatureState<VrrpdState>(device, VRRP_RT)?.routers ?? {};
  if (!featureEnabled(device, "bgp")) return Object.keys(routers).length ? now : undefined; // vrrpd terminating
  const cfg = instancesOf(device);
  let due: number | undefined;
  const at = (t: number | undefined) => {
    if (t !== undefined && (due === undefined || t < due)) due = t;
  };
  for (const inst of cfg) {
    for (const fam of FAMS) {
      const r = routers[vrrpKey(inst.iface, inst.vrid, fam)];
      const live = !!liveIface(device, inst, fam);
      if (live !== (!!r && r.state !== "Initialize")) return now; // start up / shut down
      if (r?.state === "Master") at(r.advertAt);
      if (r?.state === "Backup") at(r.masterDownAt);
    }
  }
  for (const key of Object.keys(routers)) if (!cfg.some((i) => vrrpKey(i.iface, i.vrid, famOfKey(key)) === key)) return now; // deleted
  return due;
}

function tick(ctx: SimContext, device: Device, now: number): boolean {
  const st = rt(device);
  let changed = false;
  if (!featureEnabled(device, "bgp")) {
    // SIGTERM → vrrp_fini: every virtual router is shut down, then the process exits.
    for (const [key, r] of Object.entries(st.routers)) if (r.state !== "Initialize") shutdown(ctx, device, r.last, r, famOfKey(key));
    delete device.config.features![VRRP_RT];
    return true;
  }
  const cfg = instancesOf(device);
  // Instances (or a family of them) removed from the config: shut down, then forget.
  for (const [key, r] of Object.entries(st.routers)) {
    const fam = famOfKey(key);
    if (cfg.some((i) => vrrpKey(i.iface, i.vrid, fam) === key)) continue;
    shutdown(ctx, device, r.last, r, fam);
    delete st.routers[key];
    changed = true;
  }
  for (const inst of cfg) {
    for (const fam of FAMS) {
      const key = vrrpKey(inst.iface, inst.vrid, fam);
      const iface = liveIface(device, inst, fam);
      let r = st.routers[key];
      if (!iface) {
        if (r && r.state !== "Initialize") {
          shutdown(ctx, device, r.last, r, fam); // the advert carries the addresses it was running with
          changed = true;
        }
        if (r) r.last = { ...inst };
        continue;
      }
      if (!r) r = st.routers[key] = { state: "Initialize", masterAdverInterval: 0, adverTx: 0, adverRx: 0, garpTx: 0, transitions: 0, last: { ...inst } };
      r.last = { ...inst };
      if (r.state === "Initialize") {
        startup(ctx, device, iface, inst, r, now, fam);
        changed = true;
      } else if (r.state === "Master" && r.advertAt !== undefined && now >= r.advertAt) {
        sendAdvert(ctx, device, iface, inst, r, effectivePriority(device, iface, inst, fam), fam);
        const adv = advIntervalCs(inst) * CS;
        r.advertAt = r.advertAt + adv > now ? r.advertAt + adv : now + adv;
        changed = true;
      } else if (r.state === "Backup" && r.masterDownAt !== undefined && now >= r.masterDownAt) {
        r.masterDownAt = undefined;
        r.advertAt = now + advIntervalCs(inst) * CS;
        changeState(ctx, device, iface, inst, r, "Master", fam);
        changed = true;
      }
    }
  }
  return changed;
}

/** Compare two source addresses as unsigned integers (v4 or v6). */
function srcGreater(a: string, b: string): boolean {
  if (a.includes(":")) return (parseIpv6(a) ?? 0n) > (parseIpv6(b) ?? 0n);
  return ipToInt(a) > ipToInt(b);
}

/** vrrp_recv_advertisement after the socket-level checks (shared by both families). */
function onAdvert(ctx: SimContext, device: Device, ingress: NetInterface, bytes: Uint8Array, srcIp: string, ttl: number, fam: VrrpFamily): boolean {
  const inst = instancesOf(device).find((i) => i.iface === ingress.name && i.vrid === bytes[1]);
  const r = inst && peekFeatureState<VrrpdState>(device, VRRP_RT)?.routers[vrrpKey(inst.iface, inst.vrid, fam)];
  if (!inst || !r || r.state === "Initialize" || !liveIface(device, inst, fam)) return true; // no socket: dropped
  const pkt = decodeVrrp(bytes, srcIp);
  if (!pkt || ttl !== 255 || pkt.version !== versionOf(inst) || !pkt.checksumOk || pkt.type !== 1) return true;
  if (pkt.version === 2 && pkt.authType !== 0) return true;
  if (isOwner(ingress, inst, fam)) return true;
  if (pkt.version === 2 && pkt.adverInt !== Math.max(Math.floor(advIntervalCs(inst) / 100), 1)) return true;

  const now = ctx.wallNow();
  r.adverRx++;
  const myPrio = effectivePriority(device, ingress, inst, fam);
  const mySrc = srcOf(device, ingress, inst, fam)!;
  if (r.state === "Master") {
    if (pkt.priority === 0) {
      sendAdvert(ctx, device, ingress, inst, r, myPrio, fam);
      r.advertAt = now + advIntervalCs(inst) * CS;
    } else if (pkt.priority > myPrio || (pkt.priority === myPrio && srcGreater(srcIp, mySrc))) {
      if (pkt.version === 3) r.masterAdverInterval = pkt.adverInt;
      r.masterDownAt = now + vrrpTimers(inst, r.masterAdverInterval).mdi * CS;
      changeState(ctx, device, ingress, inst, r, "Backup", fam);
      r.masterIp = srcIp;
    }
  } else if (pkt.priority === 0) {
    r.masterDownAt = now + vrrpTimers(inst, r.masterAdverInterval).skew * CS;
  } else if (!preemptOf(inst) || pkt.priority >= myPrio) {
    if (pkt.version === 3) r.masterAdverInterval = pkt.adverInt;
    r.masterDownAt = now + vrrpTimers(inst, r.masterAdverInterval).mdi * CS;
    r.masterIp = srcIp;
  }
  return true;
}

function receiveL3(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const ip = frame.ipv4;
  if (!ip || ip.dstIp !== VRRP_GROUP || ip.protocolNumber !== VRRP_PROTO) return false;
  if (!featureEnabled(device, "bgp")) return true; // no vrrpd socket
  const bytes = ipPayload(frame);
  if (!bytes) return true;
  return onAdvert(ctx, device, ingress, bytes, ip.srcIp, ip.ttl, "v4");
}

/** IPv6 receiver (lib/protocols/ipv6.ts registry): advertisements to ff02::12. */
function receiveV6(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const ip6 = frame.ipv6;
  if (!ip6 || normalizeIpv6(ip6.dstIp) !== normalizeIpv6(VRRP_GROUP6) || ip6NextHeader(frame) !== VRRP_PROTO) return false;
  if (!featureEnabled(device, "bgp")) return true;
  const p = ip6Payload(frame);
  if (!p) return true;
  return onAdvert(ctx, device, ingress, Uint8Array.from(p), ip6.srcIp, ip6.hopLimit, "v6");
}

function describe(frame: Frame, verbose: boolean): string | undefined {
  if (frame.ipv4?.protocolNumber === VRRP_PROTO) {
    const p = ipPayload(frame);
    return p ? tcpdumpVrrp(p, frame.ipv4.ttl, verbose) : undefined;
  }
  if (frame.ipv6 && ip6NextHeader(frame) === VRRP_PROTO) {
    const p = ip6Payload(frame);
    return p ? tcpdumpVrrp(Uint8Array.from(p), frame.ipv6.hopLimit, verbose, true) : undefined;
  }
  return undefined;
}

registerDaemon({ id: "vrrp", nextDue, tick, receiveL3, describe });
registerV6Receiver("vrrp", receiveV6);

/** The L3 interface a frame arriving on `port` belongs to (routed port, LAG, or VLAN SVI). */
function l3Of(device: Device, port: NetInterface, frame: Frame): NetInterface | undefined {
  if (port.logical) return port;
  const lag = lagOf(device, port);
  const base = lag ?? port;
  if (!isSwitch(device.type) || base.ipv4.length || base.ipv6.length) return base;
  const vid = frame.vlan?.vlanId ?? (base.vlan.mode === "access" ? base.vlan.accessVlan : base.vlan.nativeVlan);
  return device.interfaces.find((i) => i.logical && i.name === `Vlan${vid}`) ?? base;
}

/** The Master's macvlan answers Neighbor Solicitations for its IPv6 VIPs with the vMAC. */
function answerVipNs(ctx: SimContext, device: Device, port: NetInterface, frame: Frame): void {
  const ns = frame.icmp6;
  if (ns?.type !== "neighbor-solicitation" || !ns.targetAddr || !frame.ipv6) return;
  const target = normalizeIpv6(ns.targetAddr);
  const l3 = l3Of(device, port, frame);
  if (!l3) return;
  const inst = instancesOf(device).find((i) => i.iface === l3.name && (i.vips6 ?? []).some((v) => normalizeIpv6(v) === target));
  if (!inst || !liveMaster(device, inst, "v6")) return;
  const src = frame.ipv6.srcIp;
  const unspec = normalizeIpv6(src) === "::";
  const vmac = vrrpMac(inst.vrid, "v6");
  ctx.transmit(device.id, l3.id, neighAdvert(vmac, ns.targetAddr, unspec ? "ff02::1" : src, unspec ? multicastMac6("ff02::1") : frame.ethernet.srcMac, !unspec));
}

registerDataPlaneHook({
  id: "vrrp",
  // SVIs / routed ports accept frames to a virtual MAC only where this box is Master.
  isLocalMac: (device, iface, mac) => isMasterVMacOn(device, iface, mac),
  isLocalIp6: (device, ip) => ownsVip6AsMaster(device, ip),
  portIngress(ctx, device, iface, frame) {
    if (frame.icmp6?.type === "neighbor-solicitation" && peekFeatureState<VrrpdState>(device, VRRP_RT)) answerVipNs(ctx, device, iface, frame);
    return true; // never drops
  },
});
