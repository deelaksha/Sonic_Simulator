/**
 * L3 services on the routed path (one l3Ingress hook so the stages keep the
 * order of the real pipeline) + NAT translation aging.
 *
 *   1. DNAT  (PREROUTING): return traffic / static DNAT to a translated address
 *   2. local delivery is left to the router (packet for the switch itself, TTL ≤ 1)
 *   3. PBR   FBS forwarding policy bound ingress picks egress + next hop
 *   4. SNAT  (POSTROUTING): source translation toward an outside zone, decided on
 *            the egress the packet will really take (policy or routing table)
 *   5. PBR-selected packets are forwarded here (consumed); everything else
 *      continues through the router's normal forwarding with the rewritten frame
 *
 * Translations: lib/protocols/nat.ts. Policies: lib/protocols/pbr.ts.
 */
import { registerDaemon } from "../control/daemon";
import { registerDataPlaneHook } from "../control/hooks";
import { findInterface } from "../models/device";
import { Frame } from "../models/packet";
import { normalizeMac } from "../models/mac";
import { longestPrefixMatch } from "../models/route";
import { ownsIpInVrf } from "../models/vrf";
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { SimContext } from "../engine/context";
import { natEnabled, natInbound, natOutbound, natExpire, natNextExpiry, NatResult } from "./nat";
import { pbrDecide, pbrForward } from "./pbr";
import { ecmpFlowHash } from "./loadshare-hash";

function emitNat(ctx: SimContext, device: Device, iface: NetInterface, r: NatResult): void {
  ctx.emit({
    type: "ROUTE_MATCH",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: iface.id,
    interfaceName: iface.name,
    message: `${device.name}: NAT ${r.text}${r.text.includes("(icmp") ? " — ICMP is translated by the kernel (slow path), not the ASIC" : ""}`,
    osiLayers: [3, 4],
    frame: r.frame,
  });
}

/** The egress interface ipOutput's route lookup will choose (same ECMP hash). */
function routedEgress(device: Device, f: Frame, vrf: string): NetInterface | undefined {
  const ip = f.ipv4!;
  const l4 = f.tcp ?? f.udp;
  const flow = ecmpFlowHash(device, ip.srcIp, ip.dstIp, ip.protocolNumber ?? ip.protocol, l4?.srcPort ?? 0, l4?.dstPort ?? 0);
  const m = longestPrefixMatch(device.routingTable, ip.dstIp, vrf, flow);
  return m ? findInterface(device, m.route.interfaceId) : undefined;
}

registerDataPlaneHook({
  id: "l3-services",
  l3Ingress(ctx, device, ingress, frame, vrf) {
    if (!frame.ipv4 || normalizeMac(frame.ethernet.dstMac) !== normalizeMac(ingress.mac)) return undefined;
    const now = ctx.wallNow();
    let f = frame;
    let changed = false;

    const dnat = natInbound(device, f, ingress, now);
    if (dnat) {
      emitNat(ctx, device, ingress, dnat);
      f = dnat.frame;
      changed = true;
    }
    if (ownsIpInVrf(device, f.ipv4!.dstIp, vrf) || f.ipv4!.ttl <= 1) return changed ? f : undefined;

    const pbr = pbrDecide(device, ingress, f, vrf);
    if (pbr?.kind === "drop") {
      ctx.emit({
        type: "FRAME_DROPPED",
        deviceId: device.id,
        deviceName: device.name,
        interfaceId: ingress.id,
        interfaceName: ingress.name,
        message: `${device.name}: service-policy ${pbr.policy} flow ${pbr.classifier}: set interface null — dropped`,
        osiLayers: [3],
        frame: f,
      });
      return null;
    }

    const egress = !natEnabled(device) ? undefined : pbr ? pbr.egress : routedEgress(device, f, vrf);
    if (egress) {
      const snat = natOutbound(device, f, ingress, egress, now);
      if (snat) {
        emitNat(ctx, device, egress, snat);
        f = snat.frame;
        changed = true;
      }
    }
    if (pbr) {
      pbrForward(ctx, device, ingress, f, pbr);
      return null;
    }
    return changed ? f : undefined;
  },
});

registerDaemon({
  id: "natd",
  nextDue: (device) => natNextExpiry(device),
  tick: (_ctx, device, nowMs) => natExpire(device, nowMs),
});
