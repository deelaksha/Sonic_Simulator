/**
 * IGMP snooping on SONiC switches (sonic-swss l2mcorch + the L2MC daemon),
 * driven by the stored KLISH config (CFG_L2MC_TABLE, written by
 * lib/commands/sonic-cli/features/igmp_snooping.ts: `ip igmp snooping …` in
 * the VLAN interface view).
 *
 * Per snooping-enabled VLAN (RFC 4541 behaviour, which l2mcd implements):
 *   - IGMP packets entering a bridge port are trapped and snooped (portIngress):
 *       report (v1/v2, v3 TO_EX/IS_EX)  → port joins the group's outgoing list,
 *                                        aged after the Group Membership
 *                                        Interval = 2 × query-interval + max-response
 *       leave (v2, v3 TO_IN {})         → fast-leave: port removed now; otherwise
 *                                        aged after 2 × last-member-query-interval
 *       query / PIM hello               → the port is a (dynamic) mrouter port
 *   - flooding of IPv4 multicast inside the VLAN is restricted (allowEgress):
 *       224.0.0.0/24 control traffic and queries → every port (RFC 4541 §2.1.2)
 *       reports / leaves                         → mrouter ports only
 *       a known group                            → member ports + mrouter ports
 *       an unknown group                         → mrouter ports only
 *   - `ip igmp snooping querier`: when no other querier is heard, the switch
 *     sends General Queries (version per `ip igmp snooping version`) every
 *     query-interval from the SVI address (0.0.0.0 without one); a query from a
 *     lower address wins the election (RFC 2236 §3) for the other-querier-
 *     present interval (2 × qi + mrt/2).
 * Static groups (`static-group … interface …`) and static mrouter ports never age.
 */
import { Device } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { featureState, peekFeatureState } from "../models/feature-state";
import { registerDaemon } from "../control/daemon";
import { lagOf, registerDataPlaneHook } from "../control/hooks";
import { cpList } from "../commands/sonic-cli/config-plane";
import { multicastMac } from "../control/packet";
import { sviFor, switchInject } from "./switch";
import {
  ALL_HOSTS, IPPROTO_IGMP, IPPROTO_PIM, V3_CHANGE_TO_EXCLUDE, V3_MODE_IS_EXCLUDE, V3_CHANGE_TO_INCLUDE, V3_MODE_IS_INCLUDE,
  controlFrame, decodeIgmp, encodeIgmp, ipCmp, ipProtoOf, isLinkLocalGroup, isMulticastIp, l3Payload,
} from "./mcast-wire";

export const SNOOP_KEY = "_l2mc";

export interface SnoopVlanCfg {
  vlan: string;
  querier?: boolean;
  fastLeave?: boolean;
  queryInterval?: number;
  lastMemberQueryInterval?: number;
  maxResponseTime?: number;
  version?: number;
  mrouters?: string[];
  staticGroups?: { group: string; intf: string }[];
}

interface Member {
  port: string;
  expiresMs: number;
}
interface SnoopVlanState {
  groups: { group: string; ports: Member[] }[];
  mrouters: Member[];
  /** Snooping querier: next General Query, and until when another querier owns the VLAN. */
  nextQueryMs?: number;
  otherQuerierUntil?: number;
  otherQuerier?: string;
}
export interface SnoopState {
  vlans: Record<string, SnoopVlanState>;
}

export function snoopConfig(device: Device, vid: number): SnoopVlanCfg | undefined {
  return (cpList(device, "igmp_snooping", "vlans") as unknown as SnoopVlanCfg[]).find((v) => v.vlan === `Vlan${vid}`);
}
function allSnoopConfigs(device: Device): SnoopVlanCfg[] {
  return cpList(device, "igmp_snooping", "vlans") as unknown as SnoopVlanCfg[];
}
const vidOf = (c: SnoopVlanCfg) => Number(c.vlan.replace(/^Vlan/i, ""));
const qiMs = (c: SnoopVlanCfg) => (c.queryInterval ?? 125) * 1000;
const mrtMs = (c: SnoopVlanCfg) => (c.maxResponseTime ?? 10) * 1000;
const gmiMs = (c: SnoopVlanCfg) => 2 * qiMs(c) + mrtMs(c);
const otherQuerierMs = (c: SnoopVlanCfg) => 2 * qiMs(c) + mrtMs(c) / 2;

function snoopState(device: Device): SnoopState {
  return featureState<SnoopState>(device, SNOOP_KEY, () => ({ vlans: {} }));
}
function vlanState(device: Device, vid: number): SnoopVlanState {
  const st = snoopState(device);
  return (st.vlans[String(vid)] ??= { groups: [], mrouters: [] });
}
function peekVlan(device: Device, vid: number): SnoopVlanState | undefined {
  return peekFeatureState<SnoopState>(device, SNOOP_KEY)?.vlans[String(vid)];
}

/** Bridge port name a frame entered on (LAG members map to their PortChannel). */
function bridgePortName(device: Device, iface: NetInterface): string {
  return lagOf(device, iface)?.name ?? iface.name;
}

function ingressVid(iface: NetInterface, frame: Frame): number {
  if (iface.vlan.mode === "access") return iface.vlan.accessVlan;
  return frame.vlan?.vlanId ?? iface.vlan.nativeVlan;
}

function upsert(list: Member[], port: string, expiresMs: number): void {
  const m = list.find((x) => x.port === port);
  if (m) m.expiresMs = Math.max(m.expiresMs, expiresMs);
  else list.push({ port, expiresMs });
}

function joinGroup(vs: SnoopVlanState, group: string, port: string, expiresMs: number): void {
  if (isLinkLocalGroup(group)) return;
  let g = vs.groups.find((x) => x.group === group);
  if (!g) vs.groups.push((g = { group, ports: [] }));
  const m = g.ports.find((x) => x.port === port);
  if (m) m.expiresMs = expiresMs;
  else g.ports.push({ port, expiresMs });
}

function leaveGroup(cfg: SnoopVlanCfg, vs: SnoopVlanState, group: string, port: string, now: number): void {
  const g = vs.groups.find((x) => x.group === group);
  const m = g?.ports.find((x) => x.port === port);
  if (!g || !m) return;
  if (cfg.fastLeave) g.ports = g.ports.filter((x) => x !== m);
  else m.expiresMs = Math.min(m.expiresMs, now + 2 * (cfg.lastMemberQueryInterval ?? 1000));
  if (!g.ports.length) vs.groups = vs.groups.filter((x) => x !== g);
}

function snoop(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame): void {
  const proto = ipProtoOf(frame);
  if (proto !== IPPROTO_IGMP && proto !== IPPROTO_PIM) return;
  const vid = ingressVid(iface, frame);
  const cfg = snoopConfig(device, vid);
  if (!cfg) return;
  const now = ctx.wallNow();
  const vs = vlanState(device, vid);
  const port = bridgePortName(device, iface);
  if (proto === IPPROTO_PIM) {
    upsert(vs.mrouters, port, now + otherQuerierMs(cfg));
    return;
  }
  const pl = l3Payload(frame);
  const m = pl && decodeIgmp(pl);
  if (!m) return;
  switch (m.kind) {
    case "query": {
      upsert(vs.mrouters, port, now + otherQuerierMs(cfg));
      const mine = sviFor(device, vid);
      const myIp = (mine && primaryIpv4(mine)?.address) ?? "0.0.0.0";
      if (cfg.querier && (myIp === "0.0.0.0" || ipCmp(frame.ipv4!.srcIp, myIp) < 0)) {
        vs.otherQuerierUntil = now + otherQuerierMs(cfg);
        vs.otherQuerier = frame.ipv4!.srcIp;
      }
      break;
    }
    case "report":
      joinGroup(vs, m.group, port, now + gmiMs(cfg));
      break;
    case "leave":
      leaveGroup(cfg, vs, m.group, port, now);
      break;
    case "v3report":
      for (const r of m.records) {
        const toInclude = (r.type === V3_CHANGE_TO_INCLUDE || r.type === V3_MODE_IS_INCLUDE) && r.sources.length === 0;
        if (toInclude) leaveGroup(cfg, vs, r.group, port, now);
        else if (r.type === V3_CHANGE_TO_EXCLUDE || r.type === V3_MODE_IS_EXCLUDE || r.sources.length) joinGroup(vs, r.group, port, now + gmiMs(cfg));
      }
      break;
  }
}

/** Mrouter ports of a VLAN: configured + learned (unexpired). */
export function mrouterPorts(device: Device, vid: number, now: number): string[] {
  const cfg = snoopConfig(device, vid);
  const learned = (peekVlan(device, vid)?.mrouters ?? []).filter((m) => m.expiresMs > now).map((m) => m.port);
  return [...new Set([...(cfg?.mrouters ?? []), ...learned])];
}

/** Group → outgoing ports (static + learned), as `show ip igmp snooping groups` lists them. */
export function snoopGroups(device: Device, vid: number, now: number): { source: string; group: string; ports: string[] }[] {
  const cfg = snoopConfig(device, vid);
  const map = new Map<string, Set<string>>();
  for (const s of cfg?.staticGroups ?? []) (map.get(s.group) ?? map.set(s.group, new Set()).get(s.group)!).add(s.intf);
  for (const g of peekVlan(device, vid)?.groups ?? []) {
    for (const p of g.ports) if (p.expiresMs > now) (map.get(g.group) ?? map.set(g.group, new Set()).get(g.group)!).add(p.port);
  }
  return [...map.entries()]
    .filter(([, ports]) => ports.size > 0)
    .sort(([a], [b]) => ipCmp(a, b))
    .map(([group, ports]) => ({ source: "*", group, ports: [...ports].sort(portCmp) }));
}

const portCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function allowEgress(ctx: SimContext, sw: Device, egress: NetInterface, vid: number, frame: Frame): boolean {
  const ip = frame.ipv4;
  if (!ip || !isMulticastIp(ip.dstIp)) return true;
  const cfg = snoopConfig(sw, vid);
  if (!cfg) return true;
  const now = ctx.wallNow();
  const port = egress.name;
  const isMrouter = () => mrouterPorts(sw, vid, now).includes(port);
  if (ipProtoOf(frame) === IPPROTO_IGMP) {
    const pl = l3Payload(frame);
    const m = pl && decodeIgmp(pl);
    if (m?.kind === "query") return true;
    return isMrouter(); // reports and leaves go only towards the routers
  }
  if (isLinkLocalGroup(ip.dstIp)) return true;
  const g = snoopGroups(sw, vid, now).find((x) => x.group === ip.dstIp);
  return (g?.ports.includes(port) ?? false) || isMrouter();
}

registerDataPlaneHook({
  id: "igmp-snooping",
  portIngress(ctx, device, iface, frame) {
    if (device.type === "switch" && frame.ipv4 && !iface.management && iface.ipv4.length === 0) snoop(ctx, device, iface, frame);
    return true;
  },
  allowEgress(ctx, sw, _ingressId, egress, vid, frame) {
    return allowEgress(ctx, sw, egress, vid, frame);
  },
});

/** Snooping querier: General Query into the VLAN (from the SVI address, or 0.0.0.0). */
function sendQuery(ctx: SimContext, sw: Device, cfg: SnoopVlanCfg): void {
  const vid = vidOf(cfg);
  const svi = sviFor(sw, vid);
  const src = (svi && primaryIpv4(svi)?.address) ?? "0.0.0.0";
  const v = cfg.version ?? 2;
  const payload = encodeIgmp({ kind: "query", version: v === 3 ? 3 : v === 1 ? 1 : 2, maxRespDs: (cfg.maxResponseTime ?? 10) * 10, group: "0.0.0.0", qqic: cfg.queryInterval ?? 125 });
  const srcMac = svi?.mac ?? sw.interfaces[0].mac;
  const frame = controlFrame({ srcMac, dstMac: multicastMac(ALL_HOSTS), src, dst: ALL_HOSTS, proto: IPPROTO_IGMP, ttl: 1, ra: true, payload, summary: `IGMPv${v} general query (snooping querier Vlan${vid})` });
  switchInject(ctx, sw, vid, frame);
}

function expire(vs: SnoopVlanState, now: number): boolean {
  let changed = false;
  for (const g of vs.groups) {
    const n = g.ports.length;
    g.ports = g.ports.filter((p) => p.expiresMs > now);
    changed ||= g.ports.length !== n;
  }
  const ng = vs.groups.length;
  vs.groups = vs.groups.filter((g) => g.ports.length > 0);
  const nm = vs.mrouters.length;
  vs.mrouters = vs.mrouters.filter((m) => m.expiresMs > now);
  return changed || ng !== vs.groups.length || nm !== vs.mrouters.length;
}

registerDaemon({
  id: "igmp-snooping",
  nextDue(device) {
    if (device.type !== "switch" || device.state === "down") return undefined;
    let due: number | undefined;
    const min = (t: number | undefined) => {
      if (t !== undefined && (due === undefined || t < due)) due = t;
    };
    for (const cfg of allSnoopConfigs(device)) {
      const vs = peekVlan(device, vidOf(cfg));
      if (cfg.querier) min(vs?.nextQueryMs ?? 0);
      for (const g of vs?.groups ?? []) for (const p of g.ports) min(p.expiresMs);
      for (const m of vs?.mrouters ?? []) min(m.expiresMs);
    }
    return due;
  },
  tick(ctx, device, now) {
    let changed = false;
    for (const cfg of allSnoopConfigs(device)) {
      const vid = vidOf(cfg);
      const vs = vlanState(device, vid);
      changed = expire(vs, now) || changed;
      if (!cfg.querier) continue;
      if (vs.nextQueryMs === undefined || vs.nextQueryMs <= now) {
        vs.nextQueryMs = now + qiMs(cfg);
        changed = true;
        if ((vs.otherQuerierUntil ?? 0) <= now) sendQuery(ctx, device, cfg);
      }
    }
    return changed;
  },
});

