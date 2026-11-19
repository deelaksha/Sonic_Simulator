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
import { echoPayload, ICMP_ECHO_TOTAL } from "./icmp";
import { ipOutput } from "./ipv4";
import { sviFor, switchInject } from "./switch";

export interface SagGateway {
  vid: number;
  ip: string;
  prefix: number;
  mac: string;
  svi: NetInterface;
}

type Row = Record<string, string>;

/** Anycast gateways in force on a switch (global MAC set, IPv4 SAG enabled, SVI up). */
export function sagGateways(device: Device): SagGateway[] {
  if (!isSwitch(device.type) || device.state === "down") return [];
  const st = peekFeatureState<Record<string, unknown>>(device, "cp_sag");
  const mac = st?.gwmac as string | undefined;
  if (!st || !mac || st["ipv4-enable"] === "disable") return [];
  const out: SagGateway[] = [];
  for (const g of ((st.gateways as Row[] | undefined) ?? []).filter(Boolean)) {
    if (g.family !== "IPv4") continue;
    const vid = Number(/^Vlan(\d+)$/.exec(g.iface)?.[1]);
    const svi = Number.isInteger(vid) ? sviFor(device, vid) : undefined;
    const [ip, len] = g.addr.split("/");
    if (svi) out.push({ vid, ip, prefix: Number(len), mac: normalizeMac(mac), svi });
  }
  return out;
}

/** The anycast gateway owning `ip` on VLAN `vid`, if any. */
export function sagGateway(device: Device, vid: number, ip: string): SagGateway | undefined {
  return sagGateways(device).find((g) => g.vid === vid && g.ip === ip);
}

const isSagMac = (device: Device, svi: NetInterface, mac: string) => sagGateways(device).some((g) => g.svi.id === svi.id && g.mac === normalizeMac(mac));

function answerArp(ctx: SimContext, sw: Device, g: SagGateway, frame: Frame): void {
  const arp = frame.arp!;
  learnArp(sw, arp.senderIp, arp.senderMac, g.svi.id, { now: ctx.wallNow(), state: "stale" });
  const reply = buildArpReply(g.mac, g.ip, arp.senderMac, arp.senderIp);
  ctx.emit({ type: "ARP_REPLY", deviceId: sw.id, deviceName: sw.name, interfaceId: g.svi.id, interfaceName: g.svi.name, message: `${sw.name}: anycast gateway ${g.ip} is-at ${g.mac} → ${arp.senderIp}`, osiLayers: [2], frame: reply });
  switchInject(ctx, sw, g.vid, reply);
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
  flood(ctx, sw, ingressId, vid, frame) {
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
    if (g.svi.ipv4.some((a) => cidrContains(networkAddress(g.ip, g.prefix), g.prefix, a.address))) continue;
    const dest = networkAddress(g.ip, g.prefix);
    const vrf = vrfOf(device, g.svi);
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
      device.routingTable.push({ destination: dest, prefix: g.prefix, nextHop: null, interfaceId: g.svi.id, type: "connected", metric: 0, ...(vrf !== DEFAULT_VRF ? { vrf } : {}) });
    }
    return add.length > 0;
  },
});
