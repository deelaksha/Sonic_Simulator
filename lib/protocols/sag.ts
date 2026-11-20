/**
 * Static Anycast Gateway (SAG) data plane: every leaf answers for the same
 * gateway IP + MAC on a VLAN, so a host keeps its default gateway (and its ARP
 * entry for it) wherever it moves in the EVPN fabric.
 *
 * Config is what the KLISH SAG commands store (lib/commands/sonic-cli/features/sag.ts,
 * klish-xml/sag.xml → CONFIG_DB SAG_GLOBAL + SAG_INTF): the global anycast MAC
 * (`ip anycast-mac-address`), the IPv4 admin state (`ip anycast-address enable|disable`,
 * default enable) and per-VLAN `ip anycast-address A.B.C.D/M`. The SONiC SAG manager
 * source is not in the tree, so the behaviour follows the documented model
 * (show_ip_interfaces_sonic.j2 lists the address with flag "A-Anycast IP"):
 *
 *   ARP     a request for the anycast IP arriving on a local port of the VLAN is
 *           answered with the anycast MAC (and the requester is learnt as a STALE
 *           neighbour, as the kernel does for a request to its own address); the
 *           request is never tunnelled to remote VTEPs (lib/protocols/vxlan-daemon.ts
 *           asks sagGateway()).
 *   frames  the anycast MAC is a local MAC of the SVI (isLocalMac): frames to it are
 *           routed in the SVI's VRF exactly like frames to the SVI's own MAC; an ICMP
 *           echo to the anycast IP is answered from it.
 *   route   the anycast subnet is a connected route of the SVI (installed while the
 *           SVI has no address of its own in that subnet).
 *   IPv6    `ipv6 anycast-address X:X::X/M` (with `ipv6 anycast-address enable|disable`)
 *           does the same with Neighbor Discovery: a Neighbor Solicitation for the
 *           gateway from a local port is answered with a solicited NA carrying the
 *           anycast MAC (and never tunnelled), frames to the anycast MAC are routed,
 *           an ICMPv6 echo to the gateway is answered, and the /M is connected.
 *
 * The SVI should still have an address of its own for the switch's own ARP requests
 * (the simulator's ARP source is the SVI's primary IPv4); with an anycast-only SVI the
 * leaf learns hosts only from their ARP requests for the gateway.
 */
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame, cloneFrame } from "../models/packet";
import { normalizeMac } from "../models/mac";
import { cidrContains, networkAddress } from "../models/ip";
import { peekFeatureState } from "../models/feature-state";
import { vrfOf, DEFAULT_VRF } from "../models/vrf";
import { SimContext } from "../engine/context";
import { registerDataPlaneHook } from "../control/hooks";
import { registerDaemon } from "../control/daemon";
import { buildArpReply, learnArp } from "./arp";
import { IPV6_HEADER_BYTES, learnNdp, multicastMac6 } from "./ipv6";
import { buildFrame } from "./ethernet";
import { contains6, isLinkLocal6, networkAddress6, normalizeIpv6 } from "../models/ipv6";
import { echoPayload, ICMP_ECHO_TOTAL } from "./icmp";
import { ipOutput } from "./ipv4";
import { sviFor, switchInject } from "./switch";

export interface SagGateway {
  vid: number;
  ip: string;
  prefix: number;
  mac: string;
  svi: NetInterface;
  /** `ipv6 anycast-address` gateway (Neighbor Discovery instead of ARP). */
  v6?: boolean;
}

type Row = Record<string, string>;

/**
 * Anycast gateways in force on a switch (global MAC set, SVI up): IPv4 ones while
 * `ip anycast-address` is enabled, IPv6 ones while `ipv6 anycast-address` is enabled
 * (both default enable).
 */
export function sagGateways(device: Device): SagGateway[] {
  if (!isSwitch(device.type) || device.state === "down") return [];
  const st = peekFeatureState<Record<string, unknown>>(device, "cp_sag");
  const mac = st?.gwmac as string | undefined;
  if (!st || !mac) return [];
  const out: SagGateway[] = [];
  for (const g of ((st.gateways as Row[] | undefined) ?? []).filter(Boolean)) {
    const v6 = g.family === "IPv6";
    if (st[v6 ? "ipv6-enable" : "ipv4-enable"] === "disable") continue;
    const vid = Number(/^Vlan(\d+)$/.exec(g.iface)?.[1]);
    const svi = Number.isInteger(vid) ? sviFor(device, vid) : undefined;
    const [addr, len] = g.addr.split("/");
    const ip = v6 ? normalizeIpv6(addr) : addr;
    if (svi) out.push({ vid, ip, prefix: Number(len), mac: normalizeMac(mac), svi, ...(v6 ? { v6 } : {}) });
  }
  return out;
}

/** The anycast gateway owning `ip` (either family) on VLAN `vid`, if any. */
export function sagGateway(device: Device, vid: number, ip: string): SagGateway | undefined {
  const key = ip.includes(":") ? normalizeIpv6(ip) : ip;
  return sagGateways(device).find((g) => g.vid === vid && g.ip === key);
}

const isSagMac = (device: Device, svi: NetInterface, mac: string) => sagGateways(device).some((g) => g.svi.id === svi.id && g.mac === normalizeMac(mac));

function answerArp(ctx: SimContext, sw: Device, g: SagGateway, frame: Frame): void {
  const arp = frame.arp!;
  learnArp(sw, arp.senderIp, arp.senderMac, g.svi.id, { now: ctx.wallNow(), state: "stale" });
  const reply = buildArpReply(g.mac, g.ip, arp.senderMac, arp.senderIp);
  ctx.emit({ type: "ARP_REPLY", deviceId: sw.id, deviceName: sw.name, interfaceId: g.svi.id, interfaceName: g.svi.name, message: `${sw.name}: anycast gateway ${g.ip} is-at ${g.mac} → ${arp.senderIp}`, osiLayers: [2], frame: reply });
  switchInject(ctx, sw, g.vid, reply);
}

/** Neighbor Solicitation for an IPv6 anycast gateway: solicited NA with the anycast MAC. */
function answerNs(ctx: SimContext, sw: Device, g: SagGateway, frame: Frame): void {
  const ip6 = frame.ipv6!;
  const ns = frame.icmp6!;
  if (ns.linkLayerAddr && ip6.srcIp !== "::") learnNdp(sw, ip6.srcIp, ns.linkLayerAddr, g.svi.id);
  const unspec = ip6.srcIp === "::"; // DAD probe: answer to all-nodes (RFC 4861 7.2.4)
  const dst = unspec ? "ff02::1" : ip6.srcIp;
  const na = buildFrame(
    { srcMac: g.mac, dstMac: unspec ? multicastMac6(dst) : frame.ethernet.srcMac, etherType: "IPv6", payloadBytes: IPV6_HEADER_BYTES + 32, summary: `NDP Neighbor Advertisement ${g.ip} is-at ${g.mac}` },
    { ipv6: { srcIp: g.ip, dstIp: dst, hopLimit: 255, nextHeader: "ICMPv6" }, icmp6: { type: "neighbor-advertisement", code: 0, targetAddr: g.ip, linkLayerAddr: g.mac } },
  );
  ctx.emit({ type: "NDP_ADVERTISEMENT", deviceId: sw.id, deviceName: sw.name, interfaceId: g.svi.id, interfaceName: g.svi.name, message: `${sw.name}: anycast gateway ${g.ip} is-at ${g.mac} → ${dst}`, osiLayers: [3], frame: na });
  switchInject(ctx, sw, g.vid, na);
}

function answerEcho(ctx: SimContext, sw: Device, g: SagGateway, frame: Frame): void {
  const ip = frame.ipv4!;
  const icmp = frame.icmp!;
  ipOutput(ctx, sw, {
    srcIp: g.ip,
    dstIp: ip.srcIp,
    ttl: 64,
    protocol: "ICMP",
    identification: icmp.identifier,
    icmp: echoPayload("echo-reply", icmp.identifier, icmp.sequence),
    upperBytes: ICMP_ECHO_TOTAL,
    summary: `ICMP echo reply id ${icmp.identifier} seq ${icmp.sequence}`,
    vrf: vrfOf(sw, g.svi),
  });
}

registerDataPlaneHook({
  id: "sag",
  isLocalMac(device, iface, mac) {
    return isSagMac(device, iface, mac);
  },
  // Echo to an IPv6 anycast gateway is answered from it (routerReceiveV6 local delivery).
  isLocalIp6(device, ip) {
    const key = normalizeIpv6(ip);
    return sagGateways(device).some((g) => g.v6 && g.ip === key);
  },
  flood(ctx, sw, ingressId, vid, frame) {
    const ns = frame.icmp6;
    if (ns?.type === "neighbor-solicitation" && ns.targetAddr && !ingressId?.startsWith("vtep:")) {
      const g = sagGateway(sw, vid, ns.targetAddr);
      if (g?.v6) answerNs(ctx, sw, g, frame);
      return;
    }
    const arp = frame.arp;
    if (!arp || arp.op !== "request" || arp.senderIp === arp.targetIp || (ingressId && ingressId.startsWith("vtep:"))) return;
    const g = sagGateway(sw, vid, arp.targetIp);
    if (g) answerArp(ctx, sw, g, frame);
  },
  l3Ingress(ctx, device, ingress, frame) {
    if (!isSagMac(device, ingress, frame.ethernet.dstMac)) return undefined;
    const g = sagGateways(device).find((x) => x.svi.id === ingress.id && x.ip === frame.ipv4!.dstIp);
    if (g && frame.icmp?.type === "echo-request") {
      answerEcho(ctx, device, g, frame);
      return null;
    }
    // Routed like a frame to the SVI's own MAC.
    const f = cloneFrame(frame);
    f.ethernet = { ...f.ethernet, dstMac: ingress.mac };
    return f;
  },
});

// ---------------------------------------------------------------------------
// connected route of the anycast subnet

function missingRoutes(device: Device): { g: SagGateway; dest: string; vrf: string }[] {
  const out: { g: SagGateway; dest: string; vrf: string }[] = [];
  for (const g of sagGateways(device)) {
    const vrf = vrfOf(device, g.svi);
    if (g.v6) {
      const dest = networkAddress6(g.ip, g.prefix);
      if (g.svi.ipv6.some((a) => !isLinkLocal6(a.address) && contains6(dest, g.prefix, a.address))) continue;
      const has = (device.routingTable6 ?? []).some((r) => r.type === "connected" && r.destination === dest && r.prefix === g.prefix && r.interfaceId === g.svi.id && (r.vrf ?? DEFAULT_VRF) === vrf);
      if (!has) out.push({ g, dest, vrf });
      continue;
    }
    if (g.svi.ipv4.some((a) => cidrContains(networkAddress(g.ip, g.prefix), g.prefix, a.address))) continue;
    const dest = networkAddress(g.ip, g.prefix);
    const has = device.routingTable.some((r) => r.type === "connected" && r.destination === dest && r.prefix === g.prefix && r.interfaceId === g.svi.id && (r.vrf ?? DEFAULT_VRF) === vrf);
    if (!has) out.push({ g, dest, vrf });
  }
  return out;
}

registerDaemon({
  id: "sag",
  nextDue(device, now) {
    return missingRoutes(device).length ? now : undefined;
  },
  tick(_ctx, device) {
    const add = missingRoutes(device);
    for (const { g, dest, vrf } of add) {
      const r = { destination: dest, prefix: g.prefix, nextHop: null, interfaceId: g.svi.id, type: "connected" as const, metric: 0, ...(vrf !== DEFAULT_VRF ? { vrf } : {}) };
      if (g.v6) (device.routingTable6 ??= []).push(r);
      else device.routingTable.push(r);
    }
    return add.length > 0;
  },
});
