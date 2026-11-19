/**
 * Host side of IPv4 multicast — the Linux IGMP host (net/ipv4/igmp.c) behind
 * the `mcast` tool (lib/commands/mcast.ts).
 *
 *   join   ip_mc_join_group → igmp_group_added: an unsolicited report now and
 *          one retransmission (unsolicit_count = igmp_qrv 2) after the
 *          unsolicited-report interval (IGMPv2 10 s, IGMPv3 1 s).
 *   leave  IGMPv2: one Leave Group to 224.0.0.2, only if this host sent the last
 *          report for the group (im->reporter, igmp_group_dropped). IGMPv3: a
 *          CHANGE_TO_INCLUDE {} record to 224.0.0.22, sent twice.
 *   query  general query → a report per joined group after a delay in
 *          [0, Max Resp Time) (igmp_heard_query / igmp_mod_timer); a v2 query
 *          also puts the interface in IGMPv2 compatibility mode for the Older
 *          Version Querier Present timeout (RFC 3376 §8.12: robustness ×
 *          query interval + query response interval = 2×125+10 = 260 s).
 *   report another host's v1/v2 report for a group we joined cancels our
 *          pending report (igmp_heard_report: v2 report suppression).
 * Version: IGMPv3 unless an IGMPv1/v2 querier was heard (force_igmp_version 0).
 *
 * The NIC filter accepts a group's MAC (01:00:5e + low 23 bits) once joined;
 * every datagram delivered to a joined group is counted per group (packets,
 * bytes, last source) — `mcast show` / `mcast list`.
 */
import { Device } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { featureState, peekFeatureState } from "../models/feature-state";
import { registerDaemon } from "../control/daemon";
import { registerDataPlaneHook } from "../control/hooks";
import { multicastMac, ipv4Packet, udpSegment } from "../control/packet";
import { buildFrame } from "./ethernet";
import {
  ALL_HOSTS, ALL_ROUTERS, IGMPV3_ROUTERS, IPPROTO_IGMP, IPPROTO_PIM, V3_CHANGE_TO_EXCLUDE, V3_CHANGE_TO_INCLUDE, V3_MODE_IS_EXCLUDE,
  controlFrame, decodeIgmp, describeIgmp, encodeIgmp, hash32, ipProtoOf, isMulticastIp, l3Payload,
} from "./mcast-wire";

export const HOST_KEY = "_mcast-host";

/** RFC 3376 §8.12 Older Version Querier Present Timeout with default timers. */
const OLDER_QUERIER_MS = 260_000;
const UNSOLICITED_MS = { 2: 10_000, 3: 1_000 } as const;

export interface HostGroup {
  iface: string;
  group: string;
  sinceMs: number;
  /** This host sent the last report for the group (Linux im->reporter). */
  reporter: boolean;
  /** Pending report (unsolicited retransmission or query response). */
  reportAtMs?: number;
  retxLeft: number;
  rxPackets: number;
  rxBytes: number;
  lastSource?: string;
}

export interface HostMcast {
  groups: HostGroup[];
  /** iface → wall ms until which an IGMPv1/v2 querier is present (v2 compat mode). */
  v2Until: Record<string, number>;
  /** Pending IGMPv3 leave retransmissions. */
  v3Leaves: { iface: string; group: string; atMs: number }[];
  /** Datagrams sent by `mcast send`, per group. */
  tx: Record<string, number>;
}

export function hostMcast(device: Device): HostMcast {
  return featureState<HostMcast>(device, HOST_KEY, () => ({ groups: [], v2Until: {}, v3Leaves: [], tx: {} }));
}
export function peekHostMcast(device: Device): HostMcast | undefined {
  return peekFeatureState<HostMcast>(device, HOST_KEY);
}

const srcOf = (iface: NetInterface) => primaryIpv4(iface)?.address ?? "0.0.0.0";

function igmpVersion(st: HostMcast, iface: string, now: number): 2 | 3 {
  return (st.v2Until[iface] ?? 0) > now ? 2 : 3;
}

function sendIgmp(ctx: SimContext, device: Device, iface: NetInterface, dst: string, payload: number[], summary: string): void {
  const frame = controlFrame({ srcMac: iface.mac, dstMac: multicastMac(dst), src: srcOf(iface), dst, proto: IPPROTO_IGMP, ttl: 1, ra: true, payload, summary });
  ctx.transmit(device.id, iface.id, frame);
}

function sendReport(ctx: SimContext, device: Device, iface: NetInterface, groups: string[], v3Type: number): void {
  const st = hostMcast(device);
  if (igmpVersion(st, iface.name, ctx.wallNow()) === 2) {
    for (const g of groups) sendIgmp(ctx, device, iface, g, encodeIgmp({ kind: "report", version: 2, group: g }), `IGMPv2 report ${g}`);
  } else {
    const payload = encodeIgmp({ kind: "v3report", records: groups.map((g) => ({ type: v3Type, group: g, sources: [] })) });
    sendIgmp(ctx, device, iface, IGMPV3_ROUTERS, payload, `IGMPv3 report ${groups.join(",")}`);
  }
  for (const g of st.groups) if (g.iface === iface.name && groups.includes(g.group)) g.reporter = true;
}

/** Join a group on an interface: unsolicited report now + one retransmission. */
export function hostJoin(ctx: SimContext, device: Device, iface: NetInterface, group: string): string | undefined {
  const st = hostMcast(device);
  if (st.groups.some((g) => g.iface === iface.name && g.group === group)) return `${group} already joined on ${iface.name}`;
  const now = ctx.wallNow();
  const v = igmpVersion(st, iface.name, now);
  st.groups.push({ iface: iface.name, group, sinceMs: now, reporter: true, retxLeft: 1, reportAtMs: now + UNSOLICITED_MS[v], rxPackets: 0, rxBytes: 0 });
  st.v3Leaves = st.v3Leaves.filter((l) => !(l.iface === iface.name && l.group === group));
  sendReport(ctx, device, iface, [group], V3_CHANGE_TO_EXCLUDE);
  return undefined;
}

/** Leave a group: IGMPv2 Leave to 224.0.0.2 (if last reporter) or IGMPv3 TO_IN {}. */
export function hostLeave(ctx: SimContext, device: Device, iface: NetInterface, group: string): string | undefined {
  const st = hostMcast(device);
  const g = st.groups.find((x) => x.iface === iface.name && x.group === group);
  if (!g) return `${group} is not joined on ${iface.name}`;
  st.groups = st.groups.filter((x) => x !== g);
  const now = ctx.wallNow();
  if (igmpVersion(st, iface.name, now) === 2) {
    if (g.reporter) sendIgmp(ctx, device, iface, ALL_ROUTERS, encodeIgmp({ kind: "leave", group }), `IGMPv2 leave ${group}`);
  } else {
    sendReport(ctx, device, iface, [group], V3_CHANGE_TO_INCLUDE);
    st.v3Leaves.push({ iface: iface.name, group, atMs: now + UNSOLICITED_MS[3] });
  }
  return undefined;
}

export interface SendOpts {
  count: number;
  ttl: number;
  port: number;
  size: number;
  intervalMs: number;
}

/** Send UDP datagrams to a group (the socket's IP_MULTICAST_IF / IP_MULTICAST_TTL). */
export function hostSend(ctx: SimContext, device: Device, iface: NetInterface, group: string, o: SendOpts): void {
  const st = hostMcast(device);
  const src = srcOf(iface);
  for (let i = 0; i < o.count; i++) {
    if (i > 0) ctx.advance(o.intervalMs);
    ctx.resetSteps();
    const seq = (st.tx[group] ?? 0) + 1;
    st.tx[group] = seq;
    const payload = [(seq >>> 24) & 0xff, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff, ...new Array(Math.max(0, o.size - 4)).fill(0)];
    const sport = 40000 + (hash32(device.id) % 20000);
    const rawL3 = ipv4Packet({ src, dst: group, proto: 17, ttl: o.ttl, id: seq & 0xffff, payload: udpSegment(src, group, sport, o.port, payload) });
    const frame: Frame = buildFrame(
      { srcMac: iface.mac, dstMac: multicastMac(group), etherType: "IPv4", payloadBytes: rawL3.length, summary: `UDP ${src} → ${group}:${o.port} seq ${seq}` },
      { ipv4: { srcIp: src, dstIp: group, ttl: o.ttl, protocol: "UDP", identification: seq & 0xffff }, udp: { srcPort: sport, dstPort: o.port, length: 8 + payload.length } },
    );
    frame.rawL3 = rawL3;
    ctx.emit({
      type: "IP_PACKET_CREATED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: iface.id,
      interfaceName: iface.name,
      message: `${device.name}: multicast datagram ${src} → ${group} (ttl ${o.ttl}) out ${iface.name}`,
      osiLayers: [3, 4],
      frame,
    });
    ctx.transmit(device.id, iface.id, frame);
  }
}

/** Groups the NIC accepts on an interface: 224.0.0.1 always, plus joined groups. */
export function hostGroupsOn(device: Device, iface: string): string[] {
  return [...(peekHostMcast(device)?.groups.filter((g) => g.iface === iface).map((g) => g.group) ?? []), ALL_HOSTS];
}

function onIgmp(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const pl = l3Payload(frame);
  const m = pl && decodeIgmp(pl);
  if (!m) return;
  const st = peekHostMcast(device);
  const now = ctx.wallNow();
  if (m.kind === "query") {
    if (m.version !== 3) hostMcast(device).v2Until[ingress.name] = now + OLDER_QUERIER_MS;
    if (!st) return;
    const maxMs = Math.max(100, m.maxRespDs * 100);
    for (const g of st.groups) {
      if (g.iface !== ingress.name || (m.group !== "0.0.0.0" && m.group !== g.group)) continue;
      // igmp_mod_timer: (re)arm only if the new delay is earlier than a pending one.
      const at = now + (hash32(`${device.id}|${g.group}|${now}`) % maxMs);
      if (g.reportAtMs === undefined || at < g.reportAtMs) g.reportAtMs = at;
      g.retxLeft = 0;
    }
    return;
  }
  if (m.kind === "report" && st) {
    // v1/v2 report suppression: another member answered for this group.
    for (const g of st.groups) {
      if (g.iface === ingress.name && g.group === m.group && g.retxLeft === 0) {
        g.reportAtMs = undefined;
        g.reporter = false;
      }
    }
  }
}

registerDataPlaneHook({
  id: "mcast-host",
  hostIngress(ctx, device, ingress, frame) {
    const ip = frame.ipv4;
    if (!ip || !isMulticastIp(ip.dstIp)) return false;
    const proto = ipProtoOf(frame);
    if (proto === IPPROTO_IGMP) {
      onIgmp(ctx, device, ingress, frame);
      return true;
    }
    if (proto === IPPROTO_PIM) return true; // 224.0.0.13 is not in the host's filter
    const st = peekHostMcast(device);
    const g = st?.groups.find((x) => x.iface === ingress.name && x.group === ip.dstIp);
    if (!g) return false; // NIC/IP filter drops groups nobody joined
    g.rxPackets += 1;
    g.rxBytes += frame.udp ? frame.udp.length - 8 : 0;
    g.lastSource = ip.srcIp;
    ctx.emit({
      type: "UDP_DATAGRAM",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: ingress.id,
      interfaceName: ingress.name,
      message: `${device.name}: received multicast ${ip.srcIp} → ${ip.dstIp} (member of ${ip.dstIp} on ${ingress.name})`,
      osiLayers: [3, 4],
      frame,
    });
    return true;
  },
});

registerDaemon({
  id: "mcast-host",
  nextDue(device) {
    const st = peekHostMcast(device);
    if (!st) return undefined;
    let due: number | undefined;
    for (const g of st.groups) if (g.reportAtMs !== undefined && (due === undefined || g.reportAtMs < due)) due = g.reportAtMs;
    for (const l of st.v3Leaves) if (due === undefined || l.atMs < due) due = l.atMs;
    return due;
  },
  tick(ctx, device, now) {
    const st = hostMcast(device);
    let changed = false;
    for (const g of st.groups) {
      if (g.reportAtMs === undefined || g.reportAtMs > now) continue;
      const iface = device.interfaces.find((i) => i.name === g.iface);
      changed = true;
      if (g.retxLeft > 0) {
        g.retxLeft -= 1;
        g.reportAtMs = g.retxLeft > 0 ? now + UNSOLICITED_MS[igmpVersion(st, g.iface, now)] : undefined;
        if (iface) sendReport(ctx, device, iface, [g.group], V3_CHANGE_TO_EXCLUDE);
      } else {
        g.reportAtMs = undefined;
        if (iface) sendReport(ctx, device, iface, [g.group], V3_MODE_IS_EXCLUDE);
      }
    }
    const due = st.v3Leaves.filter((l) => l.atMs <= now);
    st.v3Leaves = st.v3Leaves.filter((l) => l.atMs > now);
    for (const l of due) {
      const iface = device.interfaces.find((i) => i.name === l.iface);
      if (iface) sendReport(ctx, device, iface, [l.group], V3_CHANGE_TO_INCLUDE);
      changed = true;
    }
    return changed;
  },
  describe(frame) {
    if (ipProtoOf(frame) !== IPPROTO_IGMP) return undefined;
    const pl = l3Payload(frame);
    const m = pl && decodeIgmp(pl);
    return m ? describeIgmp(m) : undefined;
  },
});

/** `ip maddr show` layout (iproute2 ip/ipmaddr.c print_mlist). */
export function renderMaddr(device: Device, only?: string): string[] {
  const out: string[] = [];
  device.interfaces
    .filter((i) => !only || i.name === only)
    .forEach((i, idx) => {
      const groups = hostGroupsOn(device, i.name);
      out.push(`${idx + 2}:\t${i.name}`);
      for (const g of groups) out.push(`\tlink  ${multicastMac(g).toLowerCase()}`);
      for (const g of groups) out.push(`\tinet  ${g}`);
    });
  return out;
}
