/**
 * FBS forwarding policies (policy-based routing): a `type forwarding`
 * policy-map bound `service-policy type forwarding in` on an interface overrides
 * the routing table for the flows its classifiers match. Config is the FBS
 * state owned by lib/commands/sonic/fbs.ts (features.fbs); this module
 * classifies routed packets, picks the next hop, forwards, counts matches and
 * renders the KLISH shows.
 *
 * Grounded in (sonic-buildimage/src/sonic-mgmt-framework/CLI):
 *   clitree/cli-xml/qos_fbs.xml        class-map / policy-map / class / match / set grammar
 *   renderer/templates/show_classifier.j2           `show class-map`
 *   renderer/templates/show_policy.j2               `show policy-map` ("Applied to")
 *   renderer/templates/show_service_policy.j2       `show service-policy interface|policy-map`
 *       ("Flow <c> at priority <p> (Active)", "set ip next-hop <ip> priority <p>",
 *        "Packet matches: <n> frames <b> bytes")
 *   renderer/templates/show_service_policy_summary.j2
 *   actioner/sonic_cli_qos_acl.py:1667,902 ip protocol / host formatting
 *
 * Semantics: flows are evaluated highest priority first and the first match
 * wins. Among the matched flow's `set ip next-hop` / `set interface` actions the
 * highest-priority one that is usable (next hop on the subnet of an up interface
 * in the VRF; interface up) is selected; if none is, `set interface null` drops
 * the packet, otherwise it is routed normally (routing table fallback). A
 * matched flow without forwarding actions is routed normally.
 */
import { Device, interfaceByName } from "../models/device";
import { NetInterface, ownsIp } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { cidrContains, sameSubnet } from "../models/ip";
import { longestPrefixMatch } from "../models/route";
import { vrfOf } from "../models/vrf";
import { SimContext } from "../engine/context";
import type { FbsClassifier, FbsFlow, FbsFlowAction, FbsPolicy, FbsState } from "../commands/sonic/fbs";
import { buildFrame, ETH_HEADER_BYTES, ETH_FCS_BYTES, DOT1Q_BYTES } from "./ethernet";
import { resolveArp } from "./arp";
import { IPV4_HEADER_BYTES } from "./ipv4";

const IPPROTO: Record<string, number> = { ICMP: 1, TCP: 6, UDP: 17, OSPF: 89 };

interface Counter {
  pkts: number;
  bytes: number;
}

/** "<policy>|<interface>|<stage>|<classifier>" → matched packets/bytes (flow state matched-packets). */
type FbsCounters = Record<string, Counter>;

const counterKey = (policy: string, iface: string, stage: string, cls: string) => `${policy}|${iface}|${stage}|${cls}`;

export const peekFbs = (d: Device) => peekFeatureState<FbsState>(d, "fbs");

function protoNumber(f: Frame): number {
  const ip = f.ipv4!;
  return ip.protocol === "OTHER" ? ip.protocolNumber ?? -1 : IPPROTO[ip.protocol];
}

function portIn(port: number | undefined, spec: string): boolean {
  if (port === undefined) return false;
  const [a, b] = spec.split("-").map(Number);
  return b === undefined ? port === a : port >= a && port <= b;
}

/** Every match criterion of a `match-type fields match-all` classifier must hold. */
export function classifierMatches(c: FbsClassifier, f: Frame): boolean {
  if (!f.ipv4) return false;
  const l4 = f.tcp ?? f.udp;
  return c.matches.every((m) => {
    switch (m.field) {
      case "src-ip":
      case "dst-ip": {
        const [net, len] = m.value.split("/");
        return cidrContains(net, Number(len), m.field === "src-ip" ? f.ipv4!.srcIp : f.ipv4!.dstIp);
      }
      case "ip-protocol":
        return protoNumber(f) === Number(m.value);
      case "dscp":
        return (f.ipv4!.dscp ?? 0) === Number(m.value);
      case "pcp":
        return (f.vlan?.priority ?? 0) === Number(m.value);
      case "vlan":
        return f.vlan?.vlanId === Number(m.value);
      case "src-port":
        return portIn(l4?.srcPort, m.value);
      case "dst-port":
        return portIn(l4?.dstPort, m.value);
    }
  });
}

/** Flows highest priority first (fbs.txt evaluation order). */
function byPriority(p: FbsPolicy): FbsFlow[] {
  return [...p.flows].sort((a, b) => b.priority - a.priority || a.classifier.localeCompare(b.classifier));
}

export interface PbrDecision {
  kind: "forward" | "drop";
  policy: string;
  classifier: string;
  egress?: NetInterface;
  nextHop?: string;
  /** the selected action as rendered in show ("ip next-hop 10.0.13.2 priority 10") */
  via?: string;
}

const isUp = (i: NetInterface) => i.adminState === "up" && i.operState === "up";

/** Highest-priority usable forwarding action of a matched flow. */
function select(device: Device, f: FbsFlow, frame: Frame, vrf: string): { egress: NetInterface; nextHop: string; action: FbsFlowAction } | "drop" | undefined {
  const cands = f.actions
    .filter((a) => (a.name === "set-ip-nexthop" || a.name === "set-interface") && a.target !== "null")
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (y.a.priority ?? 0) - (x.a.priority ?? 0) || x.i - y.i)
    .map((x) => x.a);
  for (const a of cands) {
    if (a.name === "set-ip-nexthop") {
      const nhVrf = a.vrf ?? vrf;
      const egress = device.interfaces.find(
        (i) => isUp(i) && vrfOf(device, i) === nhVrf && !ownsIp(i, a.target!) && i.ipv4.some((x) => sameSubnet(x.address, a.target!, x.prefix)),
      );
      if (egress) return { egress, nextHop: a.target!, action: a };
    } else {
      const egress = interfaceByName(device, a.target!);
      if (!egress || !isUp(egress)) continue;
      // On-link destination, else the next hop of a route through that interface.
      const onLink = egress.ipv4.some((x) => sameSubnet(x.address, frame.ipv4!.dstIp, x.prefix));
      const via = onLink ? null : longestPrefixMatch(device.routingTable.filter((r) => r.interfaceId === egress.id), frame.ipv4!.dstIp, vrfOf(device, egress));
      return { egress, nextHop: via?.nextHopIp ?? frame.ipv4!.dstIp, action: a };
    }
  }
  return f.actions.some((a) => a.name === "set-interface" && a.target === "null") ? "drop" : undefined;
}

/**
 * Classify a routed packet against the forwarding policy bound ingress on
 * `ingress`. undefined = no policy decision (route normally).
 */
export function pbrDecide(device: Device, ingress: NetInterface, frame: Frame, vrf: string): PbrDecision | undefined {
  const st = peekFbs(device);
  if (!st || !frame.ipv4) return undefined;
  for (const b of st.bindings) {
    if (b.iface !== ingress.name || b.direction !== "in") continue;
    const p = st.policies.find((x) => x.name === b.policy && x.type === "forwarding");
    if (!p) continue;
    for (const f of byPriority(p)) {
      const c = st.classifiers.find((x) => x.name === f.classifier);
      if (!c || !classifierMatches(c, frame)) continue;
      const counters = featureState<FbsCounters>(device, "_fbs", () => ({}));
      const k = counterKey(p.name, ingress.name, "ingress", f.classifier);
      const ctr = (counters[k] ??= { pkts: 0, bytes: 0 });
      ctr.pkts += 1;
      ctr.bytes += frame.meta.sizeBytes;
      const s = select(device, f, frame, vrf);
      if (s === "drop") return { kind: "drop", policy: p.name, classifier: f.classifier };
      if (!s) return undefined;
      return { kind: "forward", policy: p.name, classifier: f.classifier, egress: s.egress, nextHop: s.nextHop, via: actionText(s.action, "next-hop") };
    }
  }
  return undefined;
}

/** Forward a packet out of the policy-selected interface / next hop (the router's TTL / rewrite steps). */
export function pbrForward(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame, d: PbrDecision): void {
  const ip = frame.ipv4!;
  const egress = d.egress!;
  const newTtl = ip.ttl - 1;
  ctx.emit({
    type: "TTL_DECREMENT",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: decrement TTL ${ip.ttl} → ${newTtl}`,
    osiLayers: [3],
  });
  ctx.emit({
    type: "ROUTE_MATCH",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: egress.id,
    interfaceName: egress.name,
    message: `${device.name}: service-policy ${d.policy} flow ${d.classifier} on ${ingress.name}: set ${d.via} → via ${d.nextHop} dev ${egress.name} (routing table bypassed)`,
    osiLayers: [3, 4],
  });
  const mac = resolveArp(ctx, device, egress, d.nextHop!);
  if (!mac) {
    ctx.emit({
      type: "FRAME_DROPPED",
      deviceId: device.id,
      deviceName: device.name,
      interfaceId: egress.id,
      interfaceName: egress.name,
      message: `${device.name}: could not forward to ${ip.dstIp} (arp-failed for policy next hop ${d.nextHop})`,
      osiLayers: [3],
      frame,
    });
    return;
  }
  const upper = Math.max(0, frame.meta.sizeBytes - ETH_HEADER_BYTES - ETH_FCS_BYTES - (frame.vlan ? DOT1Q_BYTES : 0) - IPV4_HEADER_BYTES);
  const out = buildFrame(
    { srcMac: egress.mac, dstMac: mac, etherType: "IPv4", payloadBytes: frame.rawL3 ? frame.rawL3.length : IPV4_HEADER_BYTES + upper, summary: frame.meta.summary },
    { ipv4: { ...ip, ttl: newTtl }, icmp: frame.icmp, udp: frame.udp, ntp: frame.ntp, dhcp: frame.dhcp, dns: frame.dns, tcp: frame.tcp, bgp: frame.bgp },
  );
  if (frame.rawL3) out.rawL3 = frame.rawL3;
  out.meta.forwarded = true;
  ctx.emit({
    type: "IP_PACKET_CREATED",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: egress.id,
    interfaceName: egress.name,
    message: `${device.name}: created IP packet ${ip.srcIp} → ${ip.dstIp} (${ip.protocol}, ttl ${newTtl})`,
    osiLayers: [3],
    frame: out,
  });
  ctx.transmit(device.id, egress.id, out);
}

// ---------------------------------------------------------------------------
// KLISH show renderers
// ---------------------------------------------------------------------------

const isForwarding = (a: FbsFlowAction) => a.name === "set-ip-nexthop" || a.name === "set-interface";

/** show_policy.j2 says "ip nexthop", show_service_policy.j2 "ip next-hop". */
function actionText(a: FbsFlowAction, nh: "nexthop" | "next-hop"): string {
  const prio = a.priority !== undefined ? ` priority ${a.priority}` : "";
  if (a.name === "set-ip-nexthop") return `ip ${nh} ${a.target}${a.vrf ? ` vrf ${a.vrf}` : ""}${prio}`;
  if (a.name === "set-interface") return `interface ${a.target}${a.target === "null" ? "" : prio}`;
  return `${a.name} ${a.detail}`;
}

/** sonic_cli_qos_acl.py:1667 ip_protocol_to_user_fmt. */
const protoText = (v: string) => ({ "6": "tcp", "17": "udp", "1": "icmp", "58": "icmpv6" })[v] ?? v;
/** sonic_cli_qos_acl.py:902 convert_ip_addr_to_user_fmt. */
const addrText = (v: string) => (v.endsWith("/32") ? `host ${v.slice(0, -3)}` : v);

const MATCH_ORDER = ["vlan", "pcp", "ip-protocol", "src-ip", "dst-ip", "dscp", "src-port", "dst-port"];

/** show_classifier.j2 */
export function renderClassMaps(device: Device, only?: string): string[] {
  const st = peekFbs(device);
  const list = (st?.classifiers ?? []).filter((c) => !only || c.name === only);
  if (!list.length) return only ? [`% Error: Classifier ${only} not found`] : [];
  const out: string[] = [];
  list.forEach((c, i) => {
    if (i) out.push("");
    out.push(`Class-map ${c.name} match-type fields`, `  Description: ${c.description ?? ""}`, "  Match:");
    for (const field of MATCH_ORDER) {
      const m = c.matches.find((x) => x.field === field);
      if (!m) continue;
      const v = field === "ip-protocol" ? `ip protocol ${protoText(m.value)}` : field === "src-ip" || field === "dst-ip" ? `${field} ${addrText(m.value)}` : `${field} ${m.value}`;
      out.push(`    ${v}`);
    }
    out.push("  Referenced in flows:");
    for (const p of st!.policies) {
      const f = p.flows.find((x) => x.classifier === c.name);
      if (f) out.push(`    policy ${p.name} at priority ${f.priority}`);
    }
  });
  return out;
}

/** show_policy.j2 */
export function renderPolicyMaps(device: Device, only?: string, type?: string): string[] {
  const st = peekFbs(device);
  const list = (st?.policies ?? []).filter((p) => (!only || p.name === only) && (!type || p.type === type));
  if (!list.length) return ["No policies found"];
  const out: string[] = [];
  list.forEach((p, i) => {
    if (i) out.push("");
    out.push(`Policy ${p.name} Type ${p.type}`, `  Description: ${p.description ?? ""}`);
    for (const f of byPriority(p)) {
      out.push(`  Flow ${f.classifier} at priority ${f.priority}`, `    Description: ${f.description ?? ""}`);
      for (const a of f.actions) out.push(`    ${isForwarding(a) ? `set ${actionText(a, "nexthop")}` : `${a.name} ${a.detail}`}`);
    }
    const applied = st!.bindings.filter((b) => b.policy === p.name);
    if (applied.length) {
      out.push("  Applied to:");
      for (const b of applied) out.push(`    ${b.iface} at ${b.direction === "in" ? "Ingress" : "Egress"}`);
    }
  });
  return out;
}

/** show_service_policy.j2 for the bindings selected by interface / policy / type. */
export function renderServicePolicy(device: Device, sel: { iface?: string; policy?: string; type?: string }): string[] {
  const st = peekFbs(device);
  const counters = peekFeatureState<FbsCounters>(device, "_fbs") ?? {};
  const binds = (st?.bindings ?? []).filter(
    (b) => (!sel.iface || b.iface === sel.iface) && (!sel.policy || b.policy === sel.policy) && (!sel.type || st!.policies.find((p) => p.name === b.policy)?.type === sel.type),
  );
  const out: string[] = [];
  for (const iface of [...new Set(binds.map((b) => b.iface))]) {
    out.push(iface);
    for (const b of binds.filter((x) => x.iface === iface)) {
      const p = st!.policies.find((x) => x.name === b.policy);
      if (!p) continue;
      const stage = b.direction === "in" ? "ingress" : "egress";
      out.push(`  Policy ${p.name} type ${p.type} at ${stage}`, `  Description: ${p.description ?? ""}`);
      for (const f of byPriority(p)) {
        out.push(`    Flow ${f.classifier} at priority ${f.priority} (Active)`, `      Description: ${f.description ?? ""}`);
        for (const a of f.actions) {
          if (isForwarding(a)) out.push(`      set ${actionText(a, "next-hop")}`);
          else if (a.name === "police") out.push(`      police: ${a.detail} (Active)`);
          else out.push(`      ${a.name} ${a.detail}`);
        }
        const c = counters[counterKey(p.name, iface, stage, f.classifier)];
        out.push(`      Packet matches: ${c?.pkts ?? 0} frames ${c?.bytes ?? 0} bytes`);
      }
    }
  }
  return out;
}

/** show_service_policy_summary.j2 */
export function renderServicePolicySummary(device: Device, iface?: string): string[] {
  const st = peekFbs(device);
  const binds = (st?.bindings ?? []).filter((b) => !iface || b.iface === iface);
  const out: string[] = [];
  for (const i of [...new Set(binds.map((b) => b.iface))]) {
    out.push(i);
    for (const b of binds.filter((x) => x.iface === i)) {
      const type = st!.policies.find((p) => p.name === b.policy)?.type ?? "qos";
      out.push(`    ${type} policy ${b.policy} at ${b.direction === "in" ? "ingress" : "egress"}`);
    }
  }
  return out;
}

/** `clear counters service-policy [interface <if> | policy-map <name>]`. */
export function clearServicePolicyCounters(device: Device, sel: { iface?: string; policy?: string }): void {
  const counters = peekFeatureState<FbsCounters>(device, "_fbs");
  if (!counters) return;
  for (const k of Object.keys(counters)) {
    const [policy, iface] = k.split("|");
    if ((!sel.iface || sel.iface === iface) && (!sel.policy || sel.policy === policy)) delete counters[k];
  }
}
