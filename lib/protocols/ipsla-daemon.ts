/**
 * IP SLA probe engine + SLA-tracked static routes.
 *
 * Config: the IP_SLA instances stored by lib/commands/sonic-cli/features/ipsla.ts
 * (features.cp_ipsla) and the tracked static routes `ip route <prefix> <nh>
 * track <sla-id> [<distance>]` (features.ipsla_routes). Behaviour and show
 * layout follow the device's KLISH ipsla.xml (data/device-capture/klish-xml/
 * ipsla.xml: summary/detail/history examples) and route_static.xml (`track`
 * "Track gateway with SLA", route preference 1-255).
 *
 *   - Every `frequency` seconds an instance sends one probe: an ICMP echo
 *     request (icmp-echo) or a TCP SYN (tcp-connect; SYN-ACK = success, answered
 *     with RST; RST or silence = failure). Replies within `timeout` succeed —
 *     the simulated network answers synchronously, so a reply is never late.
 *   - State: Down until the first success; one success → Up; `threshold`
 *     consecutive failures → Down. Each transition counts, is kept in the
 *     history ("State changed to: Up") and logged to syslog.
 *   - A tracked static route is in the routing table only while its SLA is Up;
 *     a route with a higher distance to the same prefix ("floating static")
 *     takes over while it is withdrawn.
 *
 * Assumptions (no SONiC source in the tree): defaults frequency 60 s, timeout
 * 5 s, threshold 5, request-data-size 28; syslog tag "ipsla#ipslad".
 */
import { registerDaemon } from "../control/daemon";
import { logEvent } from "../control/syslog";
import { Device, interfaceByName } from "../models/device";
import { primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { longestPrefixMatch, Route } from "../models/route";
import { networkAddress } from "../models/ip";
import { vrfOf, DEFAULT_VRF } from "../models/vrf";
import { findInterface } from "../models/device";
import { SimContext } from "../engine/context";
import { cpList } from "../commands/sonic-cli/config-plane";
import { ipOutput } from "./ipv4";
import { sendIpv4 } from "../control/packet";

export const SLA_DEFAULTS = { frequency: 60, timeout: 5, threshold: 5, size: 28 };
const SYSLOG_TAG = "ipsla#ipslad";

export interface SlaRun {
  /** config signature; a changed operation restarts the instance */
  sig: string;
  state: "Up" | "Down";
  transitions: number;
  lastChangeMs?: number;
  nextMs: number;
  fails: number;
  seq: number;
  /** icmp: echo requests / replies / errors; tcp: connect requests / successes / errors */
  req: number;
  ok: number;
  err: number;
  history: { atMs: number; event: string }[];
}

export interface TrackedRoute {
  prefix: string; // network address
  len: number;
  nexthop: string;
  track: number;
  distance?: number;
  vrf?: string;
}

type Inst = Record<string, unknown>;

const runs = (d: Device) => featureState<Record<string, SlaRun>>(d, "_ipsla", () => ({}));
export const peekSlaRuns = (d: Device) => peekFeatureState<Record<string, SlaRun>>(d, "_ipsla");
export const trackedRoutes = (d: Device) => featureState<{ routes: TrackedRoute[] }>(d, "ipsla_routes", () => ({ routes: [] })).routes;

/** `no ip route <p> <nh>` without `track`: forget the tracking too, so a later probe success doesn't re-install it. */
export function forgetTracked(d: Device, prefix: string, len: number, nexthop: string, vrf?: string): void {
  const st = peekFeatureState<{ routes: TrackedRoute[] }>(d, "ipsla_routes");
  if (st) st.routes = st.routes.filter((x) => !(x.prefix === prefix && x.len === len && x.nexthop === nexthop && x.vrf === vrf));
}

const num = (v: unknown, dflt: number) => (v === undefined || v === "" ? dflt : Number(v));
const sigOf = (i: Inst) => [i.type, i.icmp_dst, i.tcp_dst, i.tcp_dst_port, i.frequency].join("|");
const instances = (d: Device) => cpList(d, "ipsla", "instances").filter((i) => i.type === "ICMP-echo" || i.type === "TCP-connect");

/** The probe in flight (the engine delivers the reply before ipOutput returns). */
let pending: { deviceId: string; icmpId?: number; seq?: number; dst?: string; sport?: number; dport?: number; got?: "ok" | "err"; synAck?: Frame } | null = null;

function sourceFor(device: Device, inst: Inst, dst: string, vrf: string, prefix: "icmp" | "tcp"): string | undefined {
  const src = inst[`${prefix}_src_ip`];
  if (src) return String(src);
  const ifn = inst[`${prefix}_src_if`];
  if (ifn) {
    const i = interfaceByName(device, String(ifn));
    return i ? primaryIpv4(i)?.address : undefined;
  }
  const m = longestPrefixMatch(device.routingTable, dst, vrf);
  const egress = m ? findInterface(device, m.route.interfaceId) : undefined;
  return egress ? primaryIpv4(egress)?.address : undefined;
}

function probe(ctx: SimContext, device: Device, inst: Inst, run: SlaRun): boolean {
  const id = Number(inst.id);
  run.seq += 1;
  run.req += 1;
  const tcp = inst.type === "TCP-connect";
  const dst = String(tcp ? inst.tcp_dst : inst.icmp_dst);
  const vrf = String((tcp ? inst.tcp_vrf : inst.icmp_vrf) ?? DEFAULT_VRF);
  const src = sourceFor(device, inst, dst, vrf, tcp ? "tcp" : "icmp");
  if (!src) return false;
  if (!tcp) {
    const icmpId = 0x5100 + id;
    pending = { deviceId: device.id, icmpId, seq: run.seq };
    ipOutput(ctx, device, {
      vrf,
      srcIp: src,
      dstIp: dst,
      ttl: num(inst.icmp_ttl, 0) || 64,
      protocol: "ICMP",
      identification: icmpId,
      icmp: { type: "echo-request", code: 0, identifier: icmpId, sequence: run.seq },
      upperBytes: 8 + num(inst.icmp_size, SLA_DEFAULTS.size),
      summary: `ICMP echo request id ${icmpId} seq ${run.seq} (ip sla ${id})`,
    });
  } else {
    const sport = num(inst.tcp_src_port, 50000 + id);
    const dport = Number(inst.tcp_dst_port);
    const isn = (id * 7919 + run.seq * 104729) >>> 0;
    pending = { deviceId: device.id, dst, sport, dport };
    sendIpv4(ctx, device, { src, dst, ttl: num(inst.tcp_ttl, 0) || 64, tcp: { srcPort: sport, dstPort: dport, seq: isn, ack: 0, flags: ["SYN"], window: 64240 }, payload: [], summary: `TCP SYN ${sport} → ${dport} (ip sla ${id})` });
    const synAck = pending?.synAck;
    if (synAck?.tcp) {
      // Connect succeeded: tear it down (RST, as a connect-only prober does).
      sendIpv4(ctx, device, { src, dst, tcp: { srcPort: sport, dstPort: dport, seq: synAck.tcp.ack, ack: 0, flags: ["RST"], window: 0 }, payload: [], summary: `TCP RST ${sport} → ${dport} (ip sla ${id})` });
    }
  }
  const ok = pending?.got === "ok";
  pending = null;
  return ok;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri Sep 25 22:54:36 2020" (ipsla.xml history example). */
export function slaTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
}

/** "00:06:41 ago" */
export function slaAgo(fromMs: number | undefined, nowMs: number): string {
  if (fromMs === undefined) return "-";
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  return `${p2(Math.floor(s / 3600))}:${p2(Math.floor((s % 3600) / 60))}:${p2(s % 60)} ago`;
}

function transition(device: Device, id: string, run: SlaRun, state: "Up" | "Down", nowMs: number): void {
  run.state = state;
  run.transitions += 1;
  run.lastChangeMs = nowMs;
  run.history.unshift({ atMs: nowMs, event: `State changed to: ${state}` });
  logEvent(device, nowMs, state === "Up" ? "NOTICE" : "WARNING", SYSLOG_TAG, `IP SLA ${id} state changed to: ${state}`);
}

const sameRoute = (x: Route, r: TrackedRoute) =>
  x.type === "static" &&
  x.destination === r.prefix &&
  x.prefix === r.len &&
  x.nextHop === r.nexthop &&
  (x.vrf ?? DEFAULT_VRF) === (r.vrf ?? DEFAULT_VRF) &&
  (x.distance ?? 1) === (r.distance ?? 1);

/** Add a static route the way `config route add` does (egress = interface on the next hop's subnet), with a distance. */
export function installStatic(device: Device, r: Omit<TrackedRoute, "track">, nowMs: number): boolean {
  const vrf = r.vrf ?? DEFAULT_VRF;
  if (device.routingTable.some((x) => sameRoute(x, { ...r, track: 0 }))) return true;
  const egress = device.interfaces.find(
    (i) => vrfOf(device, i) === vrf && i.ipv4.some((a) => networkAddress(a.address, a.prefix) === networkAddress(r.nexthop, a.prefix)),
  );
  if (!egress) return false;
  device.routingTable.push({
    destination: r.prefix,
    prefix: r.len,
    nextHop: r.nexthop,
    interfaceId: egress.id,
    type: "static",
    metric: 0,
    ...(r.distance !== undefined ? { distance: r.distance } : {}),
    installedAtMs: nowMs,
    ...(vrf !== DEFAULT_VRF ? { vrf } : {}),
  });
  return true;
}

export function removeStatic(device: Device, r: Omit<TrackedRoute, "track">): void {
  device.routingTable = device.routingTable.filter((x) => !sameRoute(x, { ...r, track: 0 }));
}

/** Tracked routes follow their SLA: installed while Up, withdrawn otherwise. Returns true on change. */
export function reconcileTracked(device: Device, nowMs: number): boolean {
  const st = peekFeatureState<{ routes: TrackedRoute[] }>(device, "ipsla_routes");
  if (!st?.routes.length) return false;
  const rs = peekSlaRuns(device) ?? {};
  let changed = false;
  for (const r of st.routes) {
    const up = rs[String(r.track)]?.state === "Up";
    const has = device.routingTable.some((x) => sameRoute(x, r));
    if (up && !has) changed = installStatic(device, r, nowMs) || changed;
    if (!up && has) {
      removeStatic(device, r);
      changed = true;
    }
  }
  return changed;
}

registerDaemon({
  id: "ipslad",
  nextDue(device, nowMs) {
    const insts = instances(device);
    const rs = peekSlaRuns(device);
    if (!insts.length && !rs) return undefined;
    if (rs && Object.keys(rs).some((id) => !insts.some((i) => String(i.id) === id))) return nowMs; // removed instance
    let due: number | undefined;
    for (const i of insts) {
      const r = rs?.[String(i.id)];
      const t = !r || r.sig !== sigOf(i) ? nowMs : r.nextMs;
      if (due === undefined || t < due) due = t;
    }
    return due;
  },
  tick(ctx, device, nowMs) {
    const rs = runs(device);
    const insts = instances(device);
    for (const id of Object.keys(rs)) if (!insts.some((i) => String(i.id) === id)) delete rs[id];
    for (const inst of insts) {
      const id = String(inst.id);
      let run = rs[id];
      if (!run || run.sig !== sigOf(inst)) {
        run = rs[id] = { sig: sigOf(inst), state: "Down", transitions: 0, nextMs: nowMs, fails: 0, seq: 0, req: 0, ok: 0, err: 0, history: [{ atMs: nowMs, event: "Started" }] };
      }
      if (run.nextMs > nowMs) continue;
      run.nextMs = nowMs + num(inst.frequency, SLA_DEFAULTS.frequency) * 1000;
      if (probe(ctx, device, inst, run)) {
        run.ok += 1;
        run.fails = 0;
        if (run.state !== "Up") transition(device, id, run, "Up", nowMs);
      } else {
        run.err += 1;
        run.fails += 1;
        if (run.state === "Up" && run.fails >= num(inst.threshold, SLA_DEFAULTS.threshold)) transition(device, id, run, "Down", nowMs);
      }
    }
    reconcileTracked(device, nowMs);
    return true;
  },
  receiveL3(_ctx, device, _ingress, frame) {
    const p = pending;
    if (!p || p.deviceId !== device.id) return false;
    if (p.icmpId !== undefined && frame.icmp?.type === "echo-reply" && frame.icmp.identifier === p.icmpId && frame.icmp.sequence === p.seq) {
      p.got = "ok";
      return true;
    }
    const t = frame.tcp;
    if (p.sport !== undefined && t && frame.ipv4?.srcIp === p.dst && t.srcPort === p.dport && t.dstPort === p.sport) {
      if (t.flags.includes("RST")) p.got = "err";
      else if (t.flags.includes("SYN") && t.flags.includes("ACK")) {
        p.got = "ok";
        p.synAck = frame;
      }
      return true;
    }
    return false;
  },
});
