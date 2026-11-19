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
 *
 * Symmetric IRB (L3 VNI; zebra_vxlan.c zl3vni_*, bgp_evpn.c install_evpn_route_entry_in_vrf)
 *   config  a VRF with a VNI (VRF|Vrf-red vni 50000) whose VLAN map gives the L3 VNI's
 *           VLAN; that VLAN's SVI is bound to the VRF and its MAC is the router MAC.
 *   local   neighbours (ARP entries) of an L2 VNI's SVI whose MAC is local become
 *           type-2 MAC+IP routes; when the SVI's VRF has an L3 VNI the route carries
 *           label 2 = L3 VNI, the VRF's RT and Rmac (bgp_evpn.c:1107-1180
 *           build_evpn_route_extcomm: ET, L2 RT, L3 RT, Rmac). With `advertise ipv4
 *           unicast` in the VRF's BGP instance every connected subnet of the VRF is a
 *           type-5 route (label = L3 VNI, ET + L3 RT + Rmac, GW IP 0).
 *   import  type-2 MAC+IP / type-5 whose RT matches an L3 VNI → IP/32 resp. prefix
 *           routes in the VRF, `B>* … via <VTEP>, Vlan<L3> onlink` (distance 20 eBGP,
 *           200 iBGP; equal routes from several VTEPs are ECMP); the VTEP gets a
 *           neighbour entry (VTEP IP → remote router MAC on the L3 SVI) and the RMAC an
 *           FDB entry behind vtep:<ip> — zebra's zl3vni_remote_nh_add / rmac_add
 *           (neigh + fdb with extern_learn). Routing a packet to such a route therefore
 *           sends it into the L3 VLAN with dst = remote RMAC, the bridge hands it to
 *           the tunnel and it is encapsulated with the L3 VNI; the remote VTEP decaps
 *           into its L3 VLAN, the frame (dst = its router MAC) is punted to the L3 SVI
 *           and routed in the VRF. One L3 VNI per remote VTEP neighbour entry.
 *   L3 VNIs get no type-3 and no flooding; type-2/3 import uses the L2 VNIs only.
 *
 * ARP suppression (SUPPRESS_VLAN_NEIGH, Linux br_do_proxy_suppress_arp + zebra remote
 * neighbours): remote type-2 MAC+IP routes fill a per-VLAN neighbour table; an ARP
 * request for such an IP on a suppressed VLAN is answered by the leaf with the remote
 * MAC and not flooded to remote VTEPs (local ports still see the broadcast — the
 * bridge skips only the neigh_suppress VXLAN port). Requests for an anycast gateway
 * address (lib/protocols/sag.ts) are never tunnelled.
 *
 * Multihoming: lib/protocols/evpn-mh.ts (type-1/type-4 built here, DF + split
 * horizon there, aliasing in forwardVirtual).
 */
import { fdbAgingTime } from "./macaging-daemon";
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
import { PMSI_INGRESS_REPLICATION, ecDfElection, ecDfOf, ecEncap, ecEsImportRt, ecEsiLabel, ecIsRt, ecMacMobility, ecMacMobilitySeq, ecRouterMac, ecRouterMacOf, ecRt, ecRtLocalAdmin } from "./evpn-wire";
import { VxlanConfig, isL3Vni, l2Maps, vlanForVni, vniForVlan, vxlanConfig } from "./vxlan";
import { vrfOf } from "../models/vrf";
import { addStaticArp, buildArpReply, deleteArp, isPermanent } from "./arp";
import { sviFor, switchInject } from "./switch";
import { sagGateway } from "./sag";
import { EsPeer, LocalEs, aliasVteps, localEss, setEsPeers } from "./evpn-mh";

export const VXLAN_PORT = 4789;
export const VXLAN_OVERHEAD = 50;
export const UNDERLAY_MTU = 9100;
const TTL = 64;

export interface RemoteMac {
  vtep: string;
  vni: number;
  vid: number;
  seq: number;
  /** Ethernet segment the MAC sits on (multihoming), lower-case ESI. */
  esi?: string;
}

/** A remote host learnt from a type-2 MAC+IP route (ARP suppression, show evpn arp-cache). */
export interface RemoteNeigh {
  mac: string;
  vtep: string;
  vni: number;
  vid: number;
}

/** An L3 VNI and its VRF / SVI (zebra struct zebra_l3vni). */
export interface L3Vni {
  vrf: string;
  vni: number;
  vid: number;
  svi?: NetInterface;
  /** VLAN map, SVI up and bound to the VRF. */
  up: boolean;
  /** Router MAC (the SVI's MAC), lower-case. */
  rmac: string;
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
  /** Remote neighbours: "vid|IP" → MAC + VTEP (type-2 MAC+IP). */
  neighs: Record<string, RemoteNeigh>;
  /** L3 VNI RMAC table: "vrf|VTEP" → router MAC (zebra zl3vni rmac_table). */
  rmacs: Record<string, string>;
  /** VRF routes installed from EVPN: "vrf|prefix/len|VTEP" → install time. */
  vrfRoutes: Record<string, number>;
  /** Next-hop neighbour entries installed on L3 SVIs: VTEP → { rmac, svi id }. */
  nhs: Record<string, { rmac: string; sviId: string }>;
  /** ARP requests answered by ARP suppression instead of being flooded. */
  suppressed: number;
}

export function peekVxlanRuntime(device: Device): VxlanRt | undefined {
  return peekFeatureState<VxlanRt>(device, "vxlan-rt");
}

function runtime(device: Device): VxlanRt {
  const rt = featureState<VxlanRt>(device, "vxlan-rt", () => ({ lastSeen: {}, seq: {}, advSig: "", vteps: {}, macs: {}, tunnels: {}, drops: 0, neighs: {}, rmacs: {}, vrfRoutes: {}, nhs: {}, suppressed: 0 }));
  rt.neighs ??= {};
  rt.rmacs ??= {};
  rt.vrfRoutes ??= {};
  rt.nhs ??= {};
  rt.suppressed ??= 0;
  return rt;
}

/** The switch's L3 VNIs (VRF ↔ VNI maps whose VNI has a VLAN map). */
export function l3Vnis(device: Device, cfg: VxlanConfig): L3Vni[] {
  return [...cfg.vrfMaps]
    .sort((a, b) => a.vni - b.vni)
    .map((m) => {
      const vid = vlanForVni(cfg, m.vni);
      const svi = vid !== undefined ? sviFor(device, vid) : undefined;
      return { vrf: m.vrf, vni: m.vni, vid: vid ?? 0, svi, up: !!svi && vrfOf(device, svi) === m.vrf, rmac: svi ? normalizeMac(svi.mac).toLowerCase() : "" };
    });
}

/** The L3 VNI of the VRF an L2 VNI's SVI is bound to (symmetric IRB), if up. */
export function l3ForVlan(device: Device, cfg: VxlanConfig, vid: number): L3Vni | undefined {
  const svi = sviFor(device, vid);
  return svi ? l3Vnis(device, cfg).find((l) => l.up && l.vrf === vrfOf(device, svi)) : undefined;
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
  const l2 = l2Maps(cfg);
  for (const e of device.macTable) {
    if (isVirtual(e.interfaceId)) continue;
    const vni = l2.find((m) => m.vlan === e.vlan)?.vni;
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
  const l3 = cfg.vrfMaps.find((m) => m.vni === vni);
  ctx.emit({ type: "FRAME_FORWARDED", deviceId: sw.id, deviceName: sw.name, message: `${sw.name}: VXLAN decap vni ${vni} from VTEP ${src} → Vlan${vid}${l3 ? ` (L3 VNI, routed in VRF ${l3.vrf})` : ""}`, osiLayers: [2, 3], frame: inner });
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
    if (!cfg || vni === undefined || isL3Vni(cfg, vni)) return;
    const arp = frame.arp;
    if (arp && arp.op === "request" && arp.senderIp !== arp.targetIp) {
      if (sagGateway(sw, vid, arp.targetIp)) return; // the anycast gateway answers locally
      if (cfg.suppress.includes(vid) && suppressArp(ctx, sw, vid, frame)) return;
    }
    for (const ip of floodList(peekVxlanRuntime(sw), vni)) encapsulate(ctx, sw, cfg, ip, vni, frame);
  },
  forwardVirtual(ctx, sw, entryId, vid, frame) {
    if (!isVirtual(entryId)) return false;
    const cfg = activeVtep(sw);
    const vni = cfg ? vniForVlan(cfg, vid) : undefined;
    if (!cfg || vni === undefined) return false;
    let remote = entryId.slice(5);
    // Aliasing: a MAC on a multihomed ES is reachable through every VTEP of the ES.
    const esi = peekVxlanRuntime(sw)?.macs[mkey(vid, frame.ethernet.dstMac)]?.esi;
    if (esi) {
      const set = [...new Set([remote, ...aliasVteps(sw, esi)])].sort();
      remote = set[entropyPort(frame) % set.length];
    }
    encapsulate(ctx, sw, cfg, remote, vni, frame);
    return true;
  },
});

/** Answer an ARP request from the remote neighbour table (br_do_proxy_suppress_arp). */
function suppressArp(ctx: SimContext, sw: Device, vid: number, frame: Frame): boolean {
  const rt = peekVxlanRuntime(sw);
  const arp = frame.arp!;
  const n = rt?.neighs[`${vid}|${arp.targetIp}`];
  if (!rt || !n) return false;
  rt.suppressed++;
  const reply = buildArpReply(n.mac, arp.targetIp, arp.senderMac, arp.senderIp);
  ctx.emit({ type: "ARP_REPLY", deviceId: sw.id, deviceName: sw.name, message: `${sw.name}: ARP suppression — ${arp.targetIp} is-at ${n.mac} (EVPN type-2 from VTEP ${n.vtep}), not flooded to remote VTEPs`, osiLayers: [2], frame: reply });
  switchInject(ctx, sw, vid, reply);
  return true;
}

// ---------------------------------------------------------------------------
// EVPN: local routes and import

/**
 * Auto RD index per instance: L2 VNIs (by VNI) get 2, 3, …, then the L3 VNIs' VRFs,
 * then the Ethernet segments (FRR allocates rd_id from one id space, bgp_evpn.c:6450;
 * index 1 is the default instance).
 */
function rdIndex(device: Device, cfg: VxlanConfig): Map<string, number> {
  const m = new Map<string, number>();
  let n = 2;
  for (const x of [...l2Maps(cfg)].sort((a, b) => a.vni - b.vni)) m.set(`vni:${x.vni}`, n++);
  for (const x of l3Vnis(device, cfg)) m.set(`vni:${x.vni}`, n++);
  for (const e of localEss(device)) m.set(`es:${e.esi}`, n++);
  return m;
}

/** Neighbours of an L2 VNI's SVI whose MAC is local (zebra local neigh → type-2 MAC+IP). */
function localNeighs(device: Device, vid: number, macs: { mac: string; port: string }[]): { ip: string; mac: string; port: string }[] {
  const svi = sviFor(device, vid);
  if (!svi) return [];
  const out: { ip: string; mac: string; port: string }[] = [];
  for (const a of device.arpTable) {
    if (a.interfaceId !== svi.id || a.state === "incomplete") continue;
    const l = macs.find((m) => m.mac === normalizeMac(a.mac));
    if (l) out.push({ ip: a.ip, mac: l.mac, port: l.port });
  }
  return out.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

/** Connected subnets of a VRF (what `advertise ipv4 unicast` turns into type-5). */
function vrfPrefixes(device: Device, l3: L3Vni): { dest: string; prefix: number }[] {
  const seen = new Set<string>();
  const out: { dest: string; prefix: number }[] = [];
  for (const r of device.routingTable) {
    if (r.type !== "connected" || (r.vrf ?? "default") !== l3.vrf || r.interfaceId === l3.svi?.id) continue;
    const iface = device.interfaces.find((i) => i.id === r.interfaceId);
    const k = `${r.destination}/${r.prefix}`;
    if (!iface || iface.operState !== "up" || seen.has(k)) continue;
    seen.add(k);
    out.push({ dest: r.destination, prefix: r.prefix });
  }
  return out.sort((a, b) => a.dest.localeCompare(b.dest, undefined, { numeric: true }) || a.prefix - b.prefix);
}

/** The ES port is a member of the VLAN (an ES-EVI exists for its VNI). */
function esInVlan(e: LocalEs, vid: number): boolean {
  const v = e.iface?.vlan;
  return !!v && (v.mode === "access" ? v.accessVlan === vid : v.allowedVlans.includes(vid));
}

function localRoutes(device: Device, localAs: number, rid: string): EvpnLocalRoute[] {
  const cfg = activeVtep(device);
  if (!cfg || !cfg.nvo || !ownsAddress(device, cfg.sourceIp)) return [];
  const rt = peekVxlanRuntime(device);
  const idx = rdIndex(device, cfg);
  const ess = localEss(device).filter((e) => e.up);
  const nh = cfg.sourceIp;
  const out: EvpnLocalRoute[] = [];
  const l2 = [...l2Maps(cfg)].sort((a, b) => a.vni - b.vni);
  const macs = localMacs(device, cfg);
  for (const m of l2) {
    const rd = `${rid}:${idx.get(`vni:${m.vni}`)}`;
    const base = [ecEncap(), ecRt(localAs, m.vni)];
    out.push({ route: { type: 3, rd, ethTag: 0, origIp: nh }, nextHop: nh, extComms: base, pmsi: { flags: 0, tunnelType: PMSI_INGRESS_REPLICATION, vni: m.vni, endpoint: nh } });
    const mine = macs.filter((x) => x.vni === m.vni);
    const esiOf = (port: string) => ess.find((e) => e.ifname === port)?.esi;
    const mm = (mac: string) => {
      const seq = rt?.seq[`${m.vni}|${mac}`] ?? 0;
      return seq ? [ecMacMobility(seq)] : [];
    };
    for (const l of mine) {
      const esi = esiOf(l.port);
      out.push({ route: { type: 2, rd, ethTag: 0, mac: l.mac.toLowerCase(), vni: m.vni, ...(esi ? { esi } : {}) }, nextHop: nh, extComms: [...base, ...mm(l.mac)] });
    }
    const l3 = l3ForVlan(device, cfg, m.vlan);
    const l3ec = l3 ? [ecRt(localAs, l3.vni), ecRouterMac(l3.rmac)] : [];
    for (const n of localNeighs(device, m.vlan, mine)) {
      const esi = esiOf(n.port);
      out.push({ route: { type: 2, rd, ethTag: 0, mac: n.mac.toLowerCase(), ip: n.ip, vni: m.vni, ...(l3 ? { vni2: l3.vni } : {}), ...(esi ? { esi } : {}) }, nextHop: nh, extComms: [...base, ...l3ec, ...mm(n.mac)] });
    }
    for (const e of ess) if (esInVlan(e, m.vlan)) out.push({ route: { type: 1, rd, ethTag: 0, esi: e.esi, vni: m.vni }, nextHop: nh, extComms: base }); // EAD per EVI
  }
  for (const l3 of l3Vnis(device, cfg)) {
    if (!l3.up || !cfg.advertiseIpv4.includes(l3.vrf) || !getBgpConfig(device, l3.vrf)) continue; // needs `router bgp <as> vrf <vrf>`
    const rd = `${rid}:${idx.get(`vni:${l3.vni}`)}`;
    const ec = [ecEncap(), ecRt(localAs, l3.vni), ecRouterMac(l3.rmac)];
    for (const p of vrfPrefixes(device, l3)) out.push({ route: { type: 5, rd, ethTag: 0, ip: p.dest, ipLen: p.prefix, vni: l3.vni }, nextHop: nh, extComms: ec });
  }
  for (const e of ess) {
    const rd = `${rid}:${idx.get(`es:${e.esi}`)}`;
    out.push({ route: { type: 4, rd, ethTag: 0, esi: e.esi, origIp: nh }, nextHop: nh, extComms: [ecEncap(), ecEsImportRt(e.esi), ecDfElection(e.dfPref)] });
    out.push({ route: { type: 1, rd, ethTag: 0xffffffff, esi: e.esi, vni: 0 }, nextHop: nh, extComms: [ecEncap(), ecEsiLabel(), ...l2.filter((m) => esInVlan(e, m.vlan)).map((m) => ecRt(localAs, m.vni))] }); // EAD per ES
  }
  return out;
}

interface Desired {
  vteps: Record<string, number[]>;
  macs: Record<string, RemoteMac>;
  neighs: Record<string, RemoteNeigh>;
  rmacs: Record<string, string>;
  /** "vrf|prefix/len" → next hops + distance. */
  routes: Map<string, { vrf: string; dest: string; prefix: number; nhs: Set<string>; distance: number; svi: NetInterface }>;
  es: Record<string, Record<string, EsPeer>>;
}

const emptyDesired = (): Desired => ({ vteps: {}, macs: {}, neighs: {}, rmacs: {}, routes: new Map(), es: {} });

function importRoutes(device: Device, cfg: VxlanConfig, best: EvpnPath[]): Desired {
  const d = emptyDesired();
  const l2 = l2Maps(cfg);
  const l3s = l3Vnis(device, cfg).filter((l) => l.up);
  const ess = localEss(device);
  const localMac = (mac: string) => device.macTable.some((e) => !isVirtual(e.interfaceId) && normalizeMac(e.mac) === normalizeMac(mac));
  for (const p of best) {
    if (p.peer === "0.0.0.0" || p.nextHop === cfg.sourceIp) continue;
    const r = p.route;
    const rtVnis = p.extComms.filter(ecIsRt).map(ecRtLocalAdmin);
    // Multihoming: type-4 (ES-Import RT = our ESI) and type-1 per ES.
    if (r.type === 4 && r.esi && r.origIp && ess.some((e) => e.esi === r.esi)) {
      const df = ecDfOf(p.extComms) ?? { alg: 2, pref: 32767 };
      const peer = ((d.es[r.esi] ??= {})[r.origIp] ??= { esr: false, ead: false, alg: df.alg, pref: df.pref });
      Object.assign(peer, { esr: true, alg: df.alg, pref: df.pref });
      continue;
    }
    if (r.type === 1 && r.esi && r.ethTag === 0xffffffff && l2.some((m) => rtVnis.includes(m.vni))) {
      ((d.es[r.esi] ??= {})[p.nextHop] ??= { esr: false, ead: false, alg: 2, pref: 32767 }).ead = true;
      continue;
    }
    for (const m of l2) {
      if (!rtVnis.includes(m.vni)) continue;
      if (r.type === 3 && r.origIp && (!p.pmsi || p.pmsi.tunnelType === PMSI_INGRESS_REPLICATION)) {
        const list = (d.vteps[r.origIp] ??= []);
        if (!list.includes(m.vni)) list.push(m.vni);
      } else if (r.type === 2 && r.mac) {
        d.macs[mkey(m.vlan, r.mac)] = { vtep: p.nextHop, vni: m.vni, vid: m.vlan, seq: ecMacMobilitySeq(p.extComms), ...(r.esi ? { esi: r.esi } : {}) };
        if (r.ip) d.neighs[`${m.vlan}|${r.ip}`] = { mac: normalizeMac(r.mac), vtep: p.nextHop, vni: m.vni, vid: m.vlan };
      }
    }
    // Symmetric IRB: MAC+IP and prefix routes into the VRF.
    const rmac = ecRouterMacOf(p.extComms);
    const pfx = r.type === 2 && r.ip && !localMac(r.mac ?? "") ? { dest: r.ip, prefix: 32 } : r.type === 5 && r.ip ? { dest: r.ip, prefix: r.ipLen ?? 32 } : undefined;
    if (!rmac || !pfx) continue;
    for (const l3 of l3s) {
      if (!rtVnis.includes(l3.vni)) continue;
      d.rmacs[`${l3.vrf}|${p.nextHop}`] = rmac;
      const k = `${l3.vrf}|${pfx.dest}/${pfx.prefix}`;
      const e = d.routes.get(k) ?? { vrf: l3.vrf, dest: pfx.dest, prefix: pfx.prefix, nhs: new Set<string>(), distance: p.ebgp ? 20 : 200, svi: l3.svi! };
      e.nhs.add(p.nextHop);
      d.routes.set(k, e);
    }
  }
  // Router MACs live in the L3 VNI's VLAN behind the VTEP (zebra rmac → fdb extern_learn).
  for (const [k, rmac] of Object.entries(d.rmacs)) {
    const [vrf, vtep] = k.split("|");
    const l3 = l3s.find((l) => l.vrf === vrf)!;
    d.macs[mkey(l3.vid, rmac)] = { vtep, vni: l3.vni, vid: l3.vid, seq: 0 };
  }
  return d;
}

/** Program FDB, neighbour entries and VRF routes (fdbsyncd / zebra → kernel → orchagent). */
function program(device: Device, rt: VxlanRt, d: Desired, now: number): void {
  const ess = localEss(device).filter((e) => e.up && e.iface);
  for (const [k, old] of Object.entries(rt.macs)) {
    if (d.macs[k]) continue; // still present (a VTEP change is applied below)
    const [vid, mac] = [old.vid, k.split("|")[1]];
    device.macTable = device.macTable.filter((e) => !(e.vlan === vid && normalizeMac(e.mac) === mac && e.interfaceId === `vtep:${old.vtep}`));
  }
  for (const [k, r] of Object.entries(d.macs)) {
    const mac = k.split("|")[1];
    const e = device.macTable.find((x) => x.vlan === r.vid && normalizeMac(x.mac) === mac);
    const esPort = r.esi ? ess.find((x) => x.esi === r.esi)?.iface : undefined;
    const target = esPort ? esPort.id : `vtep:${r.vtep}`; // a MAC on a local ES uses the local ES port
    if (e && !isVirtual(e.interfaceId)) {
      if (esPort) continue;
      // MAC mobility: the remote copy wins only with a higher sequence number.
      if (r.seq <= (rt.seq[`${r.vni}|${mac}`] ?? 0)) continue;
      e.interfaceId = target;
    } else if (e) e.interfaceId = target;
    else device.macTable.push({ mac, interfaceId: target, vlan: r.vid });
  }
  // Next-hop neighbours: VTEP IP → remote router MAC on the L3 SVI.
  const wantNh: Record<string, { rmac: string; sviId: string }> = {};
  for (const e of d.routes.values()) for (const nh of e.nhs) if (d.rmacs[`${e.vrf}|${nh}`]) wantNh[nh] ??= { rmac: normalizeMac(d.rmacs[`${e.vrf}|${nh}`]), sviId: e.svi.id };
  for (const [ip, old] of Object.entries(rt.nhs)) {
    const w = wantNh[ip];
    if (w && w.rmac === old.rmac && w.sviId === old.sviId) continue;
    if (device.arpTable.some((a) => a.ip === ip && a.interfaceId === old.sviId) && isPermanent(device, ip)) deleteArp(device, ip);
  }
  for (const [ip, w] of Object.entries(wantNh)) {
    const cur = device.arpTable.find((a) => a.ip === ip);
    if (!cur || normalizeMac(cur.mac) !== w.rmac || cur.interfaceId !== w.sviId) addStaticArp(device, ip, w.rmac, w.sviId, now);
  }
  // VRF routes: B>* prefix via VTEP, Vlan<L3> onlink.
  const mine = new Set(Object.keys(rt.vrfRoutes));
  device.routingTable = device.routingTable.filter((r) => !(r.type === "bgp" && mine.has(`${r.vrf ?? "default"}|${r.destination}/${r.prefix}|${r.nextHop}`)));
  const installed: Record<string, number> = {};
  for (const e of [...d.routes.values()].sort((a, b) => (a.vrf + a.dest).localeCompare(b.vrf + b.dest))) {
    for (const nh of [...e.nhs].sort()) {
      const k = `${e.vrf}|${e.dest}/${e.prefix}|${nh}`;
      installed[k] = rt.vrfRoutes[k] ?? now;
      device.routingTable.push({ destination: e.dest, prefix: e.prefix, nextHop: nh, interfaceId: e.svi.id, type: "bgp", metric: 0, distance: e.distance, vrf: e.vrf, installedAtMs: installed[k] });
    }
  }
  for (const ip of Object.keys(rt.tunnels)) if (!d.vteps[ip] && !Object.values(d.macs).some((m) => m.vtep === ip)) delete rt.tunnels[ip];
  rt.vteps = d.vteps;
  rt.macs = d.macs;
  rt.neighs = d.neighs;
  rt.rmacs = d.rmacs;
  rt.vrfRoutes = installed;
  rt.nhs = wantNh;
  setEsPeers(device, d.es);
}

function ribChanged(ctx: SimContext, device: Device, best: EvpnPath[]): void {
  const cfg = activeVtep(device);
  const rt = peekVxlanRuntime(device) ?? (cfg ? runtime(device) : undefined);
  if (!rt) return;
  const d = cfg && evpnActive(device, cfg) ? importRoutes(device, cfg, best) : emptyDesired();
  program(device, runtime(device), d, Math.floor(ctx.wallNow()));
}

setEvpnProvider({
  localRoutes: (device, cfg, rid) => localRoutes(device, cfg.localAs!, rid),
  ribChanged,
  ownsRoute: (device, r) => r.type === "bgp" && !!peekVxlanRuntime(device)?.vrfRoutes?.[`${r.vrf ?? "default"}|${r.destination}/${r.prefix}|${r.nextHop}`],
});

// ---------------------------------------------------------------------------
// daemon: local MAC changes, aging, tunnel-learned entries

function localSig(device: Device, cfg: VxlanConfig, rt: VxlanRt): string {
  const macs = localMacs(device, cfg).map((l) => `${l.vid}|${l.mac}|${rt.seq[`${l.vni}|${l.mac}`] ?? 0}`);
  // Everything the local routes and the VRF import depend on (neighbours, SVIs, ES state …).
  const routes = localRoutes(device, 0, "0.0.0.0").map((r) => JSON.stringify([r.route, r.extComms]));
  const l3 = l3Vnis(device, cfg).map((l) => `${l.vni}|${l.up}|${l.rmac}`);
  return JSON.stringify([cfg, evpnActive(device, cfg), ownsAddress(device, cfg.sourceIp), macs, routes, l3]);
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
    const aging = fdbAgingTime(device) * 1000;
    if (!aging) continue;
    const t = seen + aging;
    if (due === undefined || t < due) due = t;
  }
  return due;
}

function nextDue(device: Device, now: number): number | undefined {
  const cfg = activeVtep(device);
  const rt = peekVxlanRuntime(device);
  if (!cfg) return rt && (Object.keys(rt.macs).length || Object.keys(rt.vteps).length || Object.keys(rt.vrfRoutes ?? {}).length || rt.advSig) ? now : undefined;
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
      program(device, runtime(device), emptyDesired(), now);
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
    else if (fdbAgingTime(device) > 0 && now - rt.lastSeen[k] >= fdbAgingTime(device) * 1000) {
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
  const ess = localEss(device);
  for (const l of localMacs(device, cfg)) {
    const sk = `${l.vni}|${l.mac}`;
    seqLive.add(sk);
    const remote = rt.macs[mkey(l.vid, l.mac)];
    if (remote?.esi && ess.some((e) => e.ifname === l.port && e.esi === remote.esi)) continue; // same ES: not a move
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
