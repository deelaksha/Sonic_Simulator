/**
 * VXLAN VTEP data plane (RFC 7348) + EVPN VNI glue (the work SONiC splits between
 * vxlanmgrd, vxlanorch, fdbsyncd and zebra), as a DataPlaneHook, a ControlDaemon
 * and bgpd's EvpnProvider.
 *
 * Data plane
 *   encap   A frame flooded in a VNI-mapped VLAN (broadcast / unknown unicast /
 *           multicast) is head-end replicated to every remote VTEP in the VNI's
 *           flood list; a frame whose MAC entry points at "vtep:<ip>" is sent to
 *           that VTEP. Frames that came from a tunnel are never flooded back into
 *           tunnels (split horizon). The inner frame is sent untagged (802.1Q tag
 *           stripped — the VNI identifies the segment; the bridge re-tags it on
 *           local trunk egress after decap). Outer packet: Ethernet / IPv4 (TTL 64,
 *           DF; vxlanorch.cpp:352 sets no encap TTL, so the platform/kernel default
 *           applies) / UDP sport = hash of the inner flow in 49152-65535, dport 4789,
 *           checksum 0 (RFC 7348 §5) / VXLAN header 8 bytes: flags 0x08 (I), VNI.
 *           Overhead 50 bytes (14 + 20 + 8 + 8); inner frames whose IP packet
 *           would exceed the underlay MTU (9100, SONiC's default port MTU) minus 50
 *           are dropped.
 *   decap   UDP/4789 addressed to the VTEP source IP: VNI → VLAN (VXLAN_TUNNEL_MAP),
 *           inner bytes parsed back into a frame and handed to the bridge as if it
 *           arrived on the virtual port "vtep:<outer source IP>". Unknown VNI →
 *           dropped.
 *
 * Control plane (EVPN, with `advertise-all-vni` and a VXLAN_EVPN_NVO)
 *   local   Every VNI originates a type-3 IMET route (PMSI: ingress replication,
 *           label = VNI, endpoint = VTEP IP) and a type-2 MAC route per MAC the
 *           bridge learned on a local port in the mapped VLAN. RD RouterId:N with
 *           N = 2, 3, … per VNI (bgp_evpn.c:6450; index 1 is the default instance),
 *           RT (AS & 0xFFFF):VNI (bgp_evpn.c:627), ext. communities [ET:8, RT, MM].
 *   remote  Best paths whose RT local-admin field equals a local VNI are imported
 *           (FRR masks the AS of auto RTs so eBGP leaves interoperate,
 *           bgp_evpn.c:3713-3780): type-3 → the VNI's flood list (vxlanorch
 *           EVPN_REMOTE_VNI, tunnel "EVPN_<ip>" with tnl_src EVPN), type-2 → a MAC
 *           entry on "vtep:<next hop>" (fdbsyncd VXLAN_FDB_TABLE, type dynamic).
 *   learning  vxlanmgr turns learning off on the VXLAN netdev (vxlanmgr.cpp:144-147,
 *           :998): entries the bridge learned on a tunnel port that no EVPN route
 *           backs are flushed on the next tick.
 *   mobility  A MAC learned locally while a remote route for it exists is
 *           advertised with MAC Mobility seq = remote seq + 1; a remote route with
 *           a higher seq than ours takes the MAC away from the local port
 *           (RFC 7432 §15). Equal sequence numbers: the local entry is kept
 *           (simplified tie-break).
 *   aging   Local MACs in VNI-mapped VLANs age out after 600 s without traffic
 *           (SONiC default fdb_aging_time) and their type-2 is withdrawn. Aging is
 *           modelled only for VNI-mapped VLANs on a VTEP (the base bridge has none).
 */
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame, cloneFrame } from "../models/packet";
import { normalizeMac } from "../models/mac";
import { featureState, peekFeatureState } from "../models/feature-state";
import { SimContext } from "../engine/context";
import { registerDaemon } from "../control/daemon";
import { registerDataPlaneHook } from "../control/hooks";
import { IPPROTO, ipv4Packet, l4Payload, ownsAddress } from "../control/packet";
import { ipOutput } from "./ipv4";
import { bridgeInput } from "./switch";
import { DOT1Q_BYTES } from "./ethernet";
import { frameToBytes, wireLength } from "../sflow/wire";
import { bytesToFrame } from "../packetgen/frame";
import { formatPacket } from "../commands/tcpdump";
import { getBgpConfig } from "./bgp";
import { EvpnLocalRoute, EvpnPath, evpnRefresh, setEvpnProvider } from "./bgp-daemon";
import { PMSI_INGRESS_REPLICATION, ecEncap, ecIsRt, ecMacMobility, ecMacMobilitySeq, ecRt, ecRtLocalAdmin } from "./evpn-wire";
import { VxlanConfig, vlanForVni, vniForVlan, vxlanConfig } from "./vxlan";

export const VXLAN_PORT = 4789;
export const VXLAN_OVERHEAD = 50;
export const UNDERLAY_MTU = 9100;
export const FDB_AGING_MS = 600_000;
const TTL = 64;

export interface RemoteMac {
  vtep: string;
  vni: number;
  vid: number;
  seq: number;
}

export interface TunnelStats {
  createdMs: number;
  txPkts: number;
  txBytes: number;
  rxPkts: number;
  rxBytes: number;
}

export interface VxlanRt {
  /** "vid|MAC" → last frame seen from that MAC on a local port. */
  lastSeen: Record<string, number>;
  /** "vni|MAC" → MAC Mobility sequence of our own type-2. */
  seq: Record<string, number>;
  /** Signature of the local routes last handed to bgpd. */
  advSig: string;
  /** Imported type-3s: remote VTEP IP → VNIs (the flood lists). */
  vteps: Record<string, number[]>;
  /** Imported type-2s: "vid|MAC" → remote VTEP. */
  macs: Record<string, RemoteMac>;
  tunnels: Record<string, TunnelStats>;
  drops: number;
}

export function peekVxlanRuntime(device: Device): VxlanRt | undefined {
  return peekFeatureState<VxlanRt>(device, "vxlan-rt");
}

function runtime(device: Device): VxlanRt {
  return featureState<VxlanRt>(device, "vxlan-rt", () => ({ lastSeen: {}, seq: {}, advSig: "", vteps: {}, macs: {}, tunnels: {}, drops: 0 }));
}

/** A switch acting as a VTEP: VXLAN_TUNNEL with a usable source IP. */
function activeVtep(device: Device): VxlanConfig | undefined {
  if (!isSwitch(device.type) || device.state === "down") return undefined;
  const cfg = vxlanConfig(device);
  return cfg && cfg.sourceIp ? cfg : undefined;
}

/** EVPN drives the VTEP: NVO configured and `advertise-all-vni` in bgpd. */
function evpnActive(device: Device, cfg: VxlanConfig): boolean {
  return !!cfg.nvo && !!getBgpConfig(device)?.advertiseAllVni;
}

const isVirtual = (id: string) => id.startsWith("vtep:");
const mkey = (vid: number, mac: string) => `${vid}|${normalizeMac(mac)}`;

/** MACs the bridge learned on local ports in VNI-mapped VLANs. */
function localMacs(device: Device, cfg: VxlanConfig): { vid: number; vni: number; mac: string; port: string }[] {
  const out: { vid: number; vni: number; mac: string; port: string }[] = [];
  for (const e of device.macTable) {
    if (isVirtual(e.interfaceId)) continue;
    const vni = vniForVlan(cfg, e.vlan);
    const port = device.interfaces.find((i) => i.id === e.interfaceId);
    if (vni === undefined || !port) continue;
    out.push({ vid: e.vlan, vni, mac: normalizeMac(e.mac), port: port.name });
  }
  return out.sort((a, b) => a.vid - b.vid || a.mac.localeCompare(b.mac));
}

// ---------------------------------------------------------------------------
// encapsulation / decapsulation

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** RFC 7348 §5: source port from a hash of the inner headers, dynamic range. */
function entropyPort(inner: Frame): number {
  const ip = inner.ipv4;
  const l4 = inner.udp ?? inner.tcp;
  const flow = `${inner.ethernet.srcMac}|${inner.ethernet.dstMac}|${ip?.srcIp ?? ""}|${ip?.dstIp ?? ""}|${ip?.protocol ?? inner.ethernet.etherType}|${l4?.srcPort ?? ""}|${l4?.dstPort ?? ""}`;
  return 49152 + (hash32(flow) % 16384);
}

export function vxlanHeader(vni: number): number[] {
  return [0x08, 0, 0, 0, (vni >> 16) & 0xff, (vni >> 8) & 0xff, vni & 0xff, 0];
}

function tunnel(rt: VxlanRt, ip: string, now: number): TunnelStats {
  return (rt.tunnels[ip] ??= { createdMs: now, txPkts: 0, txBytes: 0, rxPkts: 0, rxBytes: 0 });
}

function drop(ctx: SimContext, sw: Device, frame: Frame, why: string): void {
  const rt = peekVxlanRuntime(sw);
  if (rt) rt.drops++;
  ctx.emit({ type: "FRAME_DROPPED", deviceId: sw.id, deviceName: sw.name, message: `${sw.name}: VXLAN ${why}`, osiLayers: [2, 3], frame });
}

function encapsulate(ctx: SimContext, sw: Device, cfg: VxlanConfig, remote: string, vni: number, frame: Frame): void {
  const inner = cloneFrame(frame);
  if (inner.vlan) {
    delete inner.vlan; // the VNI identifies the segment; the inner frame travels untagged
    inner.meta.sizeBytes = Math.max(64, inner.meta.sizeBytes - DOT1Q_BYTES);
  }
  const innerBytes = Array.from(frameToBytes(inner));
  const ipLen = innerBytes.length - 14;
  if (inner.ipv4 && ipLen + VXLAN_OVERHEAD > UNDERLAY_MTU) return drop(ctx, sw, frame, `encap to ${remote}: inner packet ${ipLen} B exceeds MTU ${UNDERLAY_MTU} - ${VXLAN_OVERHEAD}`);
  const payload = [...vxlanHeader(vni), ...innerBytes];
  const sport = entropyPort(inner);
  const udpLen = 8 + payload.length;
  const udp = [sport >> 8, sport & 0xff, VXLAN_PORT >> 8, VXLAN_PORT & 0xff, udpLen >> 8, udpLen & 0xff, 0, 0, ...payload]; // checksum 0 (RFC 7348 §5)
  const rawL3 = ipv4Packet({ src: cfg.sourceIp, dst: remote, proto: IPPROTO.UDP, ttl: TTL, payload: udp });
  const summary = `VXLAN vni ${vni} ${cfg.sourceIp} → ${remote} [${inner.meta.summary}]`;
  const r = ipOutput(ctx, sw, { srcIp: cfg.sourceIp, dstIp: remote, ttl: TTL, protocol: "UDP", identification: 0, udp: { srcPort: sport, dstPort: VXLAN_PORT, length: udpLen }, rawL3, upperBytes: 0, summary });
  if (!r.ok) return drop(ctx, sw, frame, `encap to ${remote} failed (${r.reason})`);
  const st = tunnel(runtime(sw), remote, Math.floor(ctx.wallNow()));
  st.txPkts++;
  st.txBytes += rawL3.length + 14;
  ctx.emit({ type: "FRAME_FORWARDED", deviceId: sw.id, deviceName: sw.name, message: `${sw.name}: VXLAN encap vni ${vni} → VTEP ${remote} (UDP ${sport} > 4789, +${VXLAN_OVERHEAD} B)`, osiLayers: [2, 3], frame: inner });
}

function decapsulate(ctx: SimContext, sw: Device, cfg: VxlanConfig, frame: Frame): void {
  const body = l4Payload(frame);
  const src = frame.ipv4!.srcIp;
  if (!body || body.length < 8 + 14 || !(body[0] & 0x08)) return drop(ctx, sw, frame, `from ${src}: malformed header`);
  const vni = (body[4] << 16) | (body[5] << 8) | body[6];
  const vid = vlanForVni(cfg, vni);
  if (vid === undefined) return drop(ctx, sw, frame, `from ${src}: VNI ${vni} not mapped`);
  let inner: Frame;
  try {
    inner = bytesToFrame(body.slice(8), "");
  } catch {
    return drop(ctx, sw, frame, `from ${src}: bad inner frame`);
  }
  inner.meta.summary = innerSummary(inner);
  const st = tunnel(runtime(sw), src, Math.floor(ctx.wallNow()));
  st.rxPkts++;
  st.rxBytes += wireLength(frame);
  ctx.emit({ type: "FRAME_FORWARDED", deviceId: sw.id, deviceName: sw.name, message: `${sw.name}: VXLAN decap vni ${vni} from VTEP ${src} → Vlan${vid}`, osiLayers: [2, 3], frame: inner });
  bridgeInput(ctx, sw, `vtep:${src}`, vid, inner);
}

function innerSummary(f: Frame): string {
  if (f.arp) return f.arp.op === "request" ? `ARP who-has ${f.arp.targetIp} tell ${f.arp.senderIp}` : `ARP ${f.arp.senderIp} is-at ${f.arp.senderMac}`;
  if (f.icmp && f.ipv4) return `ICMP ${f.icmp.type} ${f.ipv4.srcIp} → ${f.ipv4.dstIp} id ${f.icmp.identifier} seq ${f.icmp.sequence}`;
  if (f.ipv4) return `IPv4 ${f.ipv4.srcIp} → ${f.ipv4.dstIp}`;
  return `${f.ethernet.srcMac} → ${f.ethernet.dstMac}`;
}

/** Remote VTEPs in a VNI's flood list (imported type-3 routes). */
export function floodList(rt: VxlanRt | undefined, vni: number): string[] {
  return Object.entries(rt?.vteps ?? {})
    .filter(([, vnis]) => vnis.includes(vni))
    .map(([ip]) => ip)
    .sort();
}

/** VLAN id a frame belongs to on an ingress port (mirrors switch.ts classifyIngress). */
function ingressVid(iface: NetInterface, frame: Frame): number {
  if (iface.vlan.mode === "access") return iface.vlan.accessVlan;
  return frame.vlan?.vlanId ?? iface.vlan.nativeVlan;
}

registerDataPlaneHook({
  id: "vxlan",
  portIngress(ctx, device, iface, frame) {
    // FDB activity for aging: only on VTEPs (no state is created elsewhere).
    const rt = peekVxlanRuntime(device);
    if (rt && isSwitch(device.type) && !iface.logical && !iface.ipv4.length) rt.lastSeen[mkey(ingressVid(iface, frame), frame.ethernet.srcMac)] = Math.floor(ctx.wallNow());
    return true;
  },
  flood(ctx, sw, ingressId, vid, frame) {
    if (ingressId && isVirtual(ingressId)) return; // split horizon: never tunnel → tunnel
    const cfg = activeVtep(sw);
    const vni = cfg ? vniForVlan(cfg, vid) : undefined;
    if (!cfg || vni === undefined) return;
    for (const ip of floodList(peekVxlanRuntime(sw), vni)) encapsulate(ctx, sw, cfg, ip, vni, frame);
  },
  forwardVirtual(ctx, sw, entryId, vid, frame) {
    if (!isVirtual(entryId)) return false;
    const cfg = activeVtep(sw);
    const vni = cfg ? vniForVlan(cfg, vid) : undefined;
    if (!cfg || vni === undefined) return false;
    encapsulate(ctx, sw, cfg, entryId.slice(5), vni, frame);
    return true;
  },
});

// ---------------------------------------------------------------------------
// EVPN: local routes and import

function vniRd(cfg: VxlanConfig, rid: string, vni: number): string {
  const sorted = [...cfg.maps].sort((a, b) => a.vni - b.vni);
  return `${rid}:${2 + sorted.findIndex((m) => m.vni === vni)}`;
}

function localRoutes(device: Device, localAs: number, rid: string): EvpnLocalRoute[] {
  const cfg = activeVtep(device);
  if (!cfg || !cfg.nvo || !ownsAddress(device, cfg.sourceIp)) return [];
  const rt = peekVxlanRuntime(device);
  const out: EvpnLocalRoute[] = [];
  for (const m of [...cfg.maps].sort((a, b) => a.vni - b.vni)) {
    const rd = vniRd(cfg, rid, m.vni);
    const base = [ecEncap(), ecRt(localAs, m.vni)];
    out.push({ route: { type: 3, rd, ethTag: 0, origIp: cfg.sourceIp }, nextHop: cfg.sourceIp, extComms: base, pmsi: { flags: 0, tunnelType: PMSI_INGRESS_REPLICATION, vni: m.vni, endpoint: cfg.sourceIp } });
    for (const l of localMacs(device, cfg).filter((x) => x.vni === m.vni)) {
      const seq = rt?.seq[`${m.vni}|${l.mac}`] ?? 0;
      out.push({ route: { type: 2, rd, ethTag: 0, mac: l.mac.toLowerCase(), vni: m.vni }, nextHop: cfg.sourceIp, extComms: seq ? [...base, ecMacMobility(seq)] : base });
    }
  }
  return out;
}

function ribChanged(_ctx: SimContext, device: Device, best: EvpnPath[]): void {
  const cfg = activeVtep(device);
  const rt = peekVxlanRuntime(device) ?? (cfg ? runtime(device) : undefined);
  if (!rt) return;
  const vteps: Record<string, number[]> = {};
  const macs: Record<string, RemoteMac> = {};
  if (cfg && evpnActive(device, cfg)) {
    for (const p of best) {
      if (p.peer === "0.0.0.0" || p.nextHop === cfg.sourceIp) continue;
      const rtVnis = p.extComms.filter(ecIsRt).map(ecRtLocalAdmin);
      for (const m of cfg.maps) {
        if (!rtVnis.includes(m.vni)) continue;
        if (p.route.type === 3 && p.route.origIp && (!p.pmsi || p.pmsi.tunnelType === PMSI_INGRESS_REPLICATION)) {
          const list = (vteps[p.route.origIp] ??= []);
          if (!list.includes(m.vni)) list.push(m.vni);
        } else if (p.route.type === 2 && p.route.mac) {
          macs[mkey(m.vlan, p.route.mac)] = { vtep: p.nextHop, vni: m.vni, vid: m.vlan, seq: ecMacMobilitySeq(p.extComms) };
        }
      }
    }
  }
  // Program the FDB (fdbsyncd → VXLAN_FDB_TABLE → fdborch).
  for (const [k, old] of Object.entries(rt.macs)) {
    if (macs[k]) continue; // still present (a VTEP change is applied below)
    const [vid, mac] = [old.vid, k.split("|")[1]];
    device.macTable = device.macTable.filter((e) => !(e.vlan === vid && normalizeMac(e.mac) === mac && e.interfaceId === `vtep:${old.vtep}`));
  }
  for (const [k, r] of Object.entries(macs)) {
    const mac = k.split("|")[1];
    const e = device.macTable.find((x) => x.vlan === r.vid && normalizeMac(x.mac) === mac);
    if (e && !isVirtual(e.interfaceId)) {
      // MAC mobility: the remote copy wins only with a higher sequence number.
      if (r.seq <= (rt.seq[`${r.vni}|${mac}`] ?? 0)) continue;
      e.interfaceId = `vtep:${r.vtep}`;
    } else if (e) e.interfaceId = `vtep:${r.vtep}`;
    else device.macTable.push({ mac, interfaceId: `vtep:${r.vtep}`, vlan: r.vid });
  }
  for (const ip of Object.keys(rt.tunnels)) if (!vteps[ip] && !Object.values(macs).some((m) => m.vtep === ip)) delete rt.tunnels[ip];
  rt.vteps = vteps;
  rt.macs = macs;
}

setEvpnProvider({
  localRoutes: (device, cfg, rid) => localRoutes(device, cfg.localAs!, rid),
  ribChanged,
});

// ---------------------------------------------------------------------------
// daemon: local MAC changes, aging, tunnel-learned entries

function localSig(device: Device, cfg: VxlanConfig, rt: VxlanRt): string {
  const macs = localMacs(device, cfg).map((l) => `${l.vid}|${l.mac}|${rt.seq[`${l.vni}|${l.mac}`] ?? 0}`);
  return JSON.stringify([cfg, evpnActive(device, cfg), ownsAddress(device, cfg.sourceIp), macs]);
}

/** Bridge entries on a tunnel port that no EVPN route backs (data-plane learned). */
function unbacked(device: Device, cfg: VxlanConfig, rt: VxlanRt): boolean {
  if (!evpnActive(device, cfg)) return false;
  return device.macTable.some((e) => isVirtual(e.interfaceId) && vniForVlan(cfg, e.vlan) !== undefined && rt.macs[mkey(e.vlan, e.mac)]?.vtep !== e.interfaceId.slice(5));
}

function nextAging(device: Device, cfg: VxlanConfig, rt: VxlanRt): number | undefined {
  let due: number | undefined;
  for (const l of localMacs(device, cfg)) {
    const seen = rt.lastSeen[mkey(l.vid, l.mac)];
    if (seen === undefined) return 0; // first sight: stamp it now
    const t = seen + FDB_AGING_MS;
    if (due === undefined || t < due) due = t;
  }
  return due;
}

function nextDue(device: Device, now: number): number | undefined {
  const cfg = activeVtep(device);
  const rt = peekVxlanRuntime(device);
  if (!cfg) return rt && (Object.keys(rt.macs).length || Object.keys(rt.vteps).length || rt.advSig) ? now : undefined;
  if (!rt || rt.advSig !== localSig(device, cfg, rt) || unbacked(device, cfg, rt)) return now;
  const a = nextAging(device, cfg, rt);
  return a === undefined ? undefined : Math.max(a, 0) <= now ? now : a;
}

function tick(ctx: SimContext, device: Device, now: number): boolean {
  const cfg = activeVtep(device);
  if (!cfg) {
    const rt = peekVxlanRuntime(device);
    if (rt) {
      device.macTable = device.macTable.filter((e) => !isVirtual(e.interfaceId));
      rt.vteps = {};
      rt.macs = {};
      rt.tunnels = {};
      rt.advSig = "";
    }
    evpnRefresh(ctx, device, now);
    return true;
  }
  const rt = runtime(device);
  // Aging of local MACs in VNI-mapped VLANs.
  const live = new Set<string>();
  for (const l of localMacs(device, cfg)) {
    const k = mkey(l.vid, l.mac);
    live.add(k);
    if (rt.lastSeen[k] === undefined) rt.lastSeen[k] = now;
    else if (now - rt.lastSeen[k] >= FDB_AGING_MS) {
      device.macTable = device.macTable.filter((e) => !(e.vlan === l.vid && normalizeMac(e.mac) === l.mac && !isVirtual(e.interfaceId)));
      delete rt.lastSeen[k];
      live.delete(k);
    }
  }
  for (const k of Object.keys(rt.lastSeen)) if (!live.has(k)) delete rt.lastSeen[k];
  // Learning is off on the VXLAN port: drop tunnel entries EVPN does not back.
  if (evpnActive(device, cfg)) {
    device.macTable = device.macTable.filter((e) => {
      if (!isVirtual(e.interfaceId) || vniForVlan(cfg, e.vlan) === undefined) return true;
      return rt.macs[mkey(e.vlan, e.mac)]?.vtep === e.interfaceId.slice(5);
    });
  }
  // MAC mobility sequence numbers for local MACs.
  const seqLive = new Set<string>();
  for (const l of localMacs(device, cfg)) {
    const sk = `${l.vni}|${l.mac}`;
    seqLive.add(sk);
    const remote = rt.macs[mkey(l.vid, l.mac)];
    if (remote && (rt.seq[sk] ?? 0) <= remote.seq) rt.seq[sk] = remote.seq + 1; // moved here from a remote VTEP
  }
  for (const k of Object.keys(rt.seq)) if (!seqLive.has(k)) delete rt.seq[k];
  rt.advSig = localSig(device, cfg, rt);
  evpnRefresh(ctx, device, now);
  return true;
}

registerDaemon({
  id: "vxlan",
  nextDue,
  tick,
  receiveL3(ctx, device, _ingress, frame) {
    if (!frame.udp || frame.udp.dstPort !== VXLAN_PORT || !frame.rawL3) return false;
    const cfg = activeVtep(device);
    if (!cfg || frame.ipv4!.dstIp !== cfg.sourceIp) return false;
    decapsulate(ctx, device, cfg, frame);
    return true;
  },
  describe(frame, verbose) {
    if (!frame.udp || frame.udp.dstPort !== VXLAN_PORT) return undefined;
    const body = l4Payload(frame);
    if (!body || body.length < 8) return undefined;
    const vni = (body[4] << 16) | (body[5] << 8) | body[6];
    // tcpdump print-vxlan.c: header line, then the inner Ethernet frame (link header shown).
    let inner = "";
    try {
      const f = bytesToFrame(body.slice(8), "");
      f.meta.summary = innerSummary(f);
      inner = formatPacket(f, { showEther: true, verbose }).join("\n");
    } catch {
      inner = "[|ether]";
    }
    return `VXLAN, flags [I] (0x${body[0].toString(16).padStart(2, "0")}), vni ${vni}\n${inner}`;
  },
});
