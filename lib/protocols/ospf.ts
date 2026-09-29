/**
 * OSPF engine (spec §24). A real-enough packet-plane slice:
 *   1. Routers send Hello packets (IP proto 89, multicast 224.0.0.5) out every
 *      OSPF-enabled interface. Adjacencies are recorded by ACTUAL delivery over
 *      the switch/flood path, so neighborship reflects real L2 connectivity.
 *   2. Bidirectional Hellos → Full adjacency.
 *   3. SPF (shortest-path, hop metric) over the adjacency graph installs routes to
 *      every other router's advertised networks, so ping across routers works.
 *
 * Simplified vs. a full RFC 2328 implementation: no DR/BDR election, no explicit
 * DBD/LSR/LSU/LSAck exchange or LSDB aging, and the metric is hop-count. The
 * teachable core — Hello→adjacency (real packets) and SPF-derived routes that
 * make forwarding work — is genuine. Documented in docs/ROADMAP / SONIC_FEATURES.
 */
import { Device, findInterface, isRouter } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame, OspfNetworkLsa } from "../models/packet";
import { networkAddress, cidrContains } from "../models/ip";
import { SimContext } from "../engine/context";
import { buildFrame } from "./ethernet";

export const OSPF_MULTICAST_IP = "224.0.0.5";
export const OSPF_MULTICAST_MAC = "01:00:5E:00:00:05";
const OSPF_HELLO_BYTES = 44;
const OSPF_LSU_BYTES = 60;

export interface OspfNeighbor {
  routerId: string;
  ip: string;
  interfaceId: string;
  area: string;
  state: "init" | "2way" | "full";
}

interface OspfConfig {
  routerId?: string;
  networks?: { network: string; area: string }[];
  areas?: { id: string; type?: string }[];
  neighbors?: OspfNeighbor[];
}

interface OspfIface {
  iface: NetInterface;
  ip: string;
  area: string;
  connNet: string;
  connPrefix: number;
}

export function getOspfConfig(device: Device): OspfConfig | undefined {
  const cfg = device.config.features?.ospf as OspfConfig | undefined;
  if (!cfg || !cfg.networks || cfg.networks.length === 0) return undefined;
  if (!cfg.neighbors) cfg.neighbors = [];
  return cfg;
}

export function routerIdOf(device: Device, cfg: OspfConfig): string {
  if (cfg.routerId) return cfg.routerId;
  const ips = device.interfaces.flatMap((i) => i.ipv4.map((a) => a.address));
  return ips.length ? ips.sort().reverse()[0] : device.name;
}

function parseStmt(s: string): { net: string; plen: number } | null {
  const i = s.indexOf("/");
  if (i < 0) return null;
  const plen = Number(s.slice(i + 1));
  return { net: s.slice(0, i), plen };
}

/** Interfaces enabled for OSPF (their IP is covered by a `network … area` stmt). */
export function ospfInterfaces(device: Device, cfg: OspfConfig): OspfIface[] {
  const out: OspfIface[] = [];
  for (const iface of device.interfaces) {
    const ip = primaryIpv4(iface);
    if (!ip) continue;
    for (const stmt of cfg.networks ?? []) {
      const p = parseStmt(stmt.network);
      if (p && cidrContains(p.net, p.plen, ip.address)) {
        out.push({
          iface,
          ip: ip.address,
          area: stmt.area,
          connNet: networkAddress(ip.address, ip.prefix),
          connPrefix: ip.prefix,
        });
        break;
      }
    }
  }
  return out;
}

function advertisedNetworks(device: Device, cfg: OspfConfig): OspfNetworkLsa[] {
  const seen = new Set<string>();
  const out: OspfNetworkLsa[] = [];
  for (const oi of ospfInterfaces(device, cfg)) {
    const key = `${oi.connNet}/${oi.connPrefix}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ network: oi.connNet, prefix: oi.connPrefix, metric: 1 });
    }
  }
  return out;
}

/** Record a Hello arriving at a router (called from router receive). */
export function handleOspfFrame(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): void {
  const cfg = getOspfConfig(device);
  const ospf = frame.ospf;
  if (!cfg || !ospf || ospf.packetType !== "hello") return;
  const oi = ospfInterfaces(device, cfg).find((x) => x.iface.id === ingress.id);
  if (!oi || oi.area !== ospf.area) return; // not OSPF-enabled here / area mismatch
  const srcIp = frame.ipv4?.srcIp ?? "";
  const existing = cfg.neighbors!.find((n) => n.routerId === ospf.routerId && n.interfaceId === ingress.id);
  if (existing) {
    existing.ip = srcIp;
    existing.state = "init";
  } else {
    cfg.neighbors!.push({ routerId: ospf.routerId, ip: srcIp, interfaceId: ingress.id, area: oi.area, state: "init" });
  }
}

export interface OspfSummary {
  routers: number;
  adjacencies: number;
  routesInstalled: number;
}

/**
 * Converge OSPF across the whole domain: send Hellos, finalize adjacencies, run
 * SPF, install routes. Returns a summary. Mutates device neighbor lists +
 * routing tables (type "ospf").
 */
export function convergeOspfDomain(ctx: SimContext): OspfSummary {
  const routers = Object.values(ctx.state.devices).filter((d) => isRouter(d.type) && getOspfConfig(d));

  // 1. reset prior OSPF state
  for (const r of routers) {
    const cfg = getOspfConfig(r)!;
    cfg.neighbors = [];
    r.routingTable = r.routingTable.filter((rt) => rt.type !== "ospf");
  }

  // 2. send Hellos (real multicast frames → neighbors record via handleOspfFrame)
  for (const r of routers) {
    const cfg = getOspfConfig(r)!;
    const rid = routerIdOf(r, cfg);
    for (const oi of ospfInterfaces(r, cfg)) {
      if (oi.iface.operState !== "up") continue;
      ctx.emit({
        type: "OSPF_HELLO",
        deviceId: r.id,
        deviceName: r.name,
        interfaceId: oi.iface.id,
        interfaceName: oi.iface.name,
        message: `${r.name}: OSPF Hello out ${oi.iface.name} (area ${oi.area}, rid ${rid})`,
        osiLayers: [3],
      });
      const hello = buildFrame(
        {
          srcMac: oi.iface.mac,
          dstMac: OSPF_MULTICAST_MAC,
          etherType: "IPv4",
          payloadBytes: 20 + OSPF_HELLO_BYTES,
          summary: `OSPF Hello rid ${rid} area ${oi.area}`,
        },
        {
          ipv4: { srcIp: oi.ip, dstIp: OSPF_MULTICAST_IP, ttl: 1, protocol: "OSPF", identification: 0 },
          ospf: { packetType: "hello", routerId: rid, area: oi.area },
        },
      );
      ctx.transmit(r.id, oi.iface.id, hello);
    }
  }

  // 3. finalize adjacencies (bidirectional Hello → Full)
  const byRid = new Map<string, Device>();
  for (const r of routers) byRid.set(routerIdOf(r, getOspfConfig(r)!), r);

  let adjacencies = 0;
  for (const r of routers) {
    const cfg = getOspfConfig(r)!;
    const rid = routerIdOf(r, cfg);
    for (const n of cfg.neighbors!) {
      const peer = byRid.get(n.routerId);
      if (peer && getOspfConfig(peer)!.neighbors!.some((pn) => pn.routerId === rid)) {
        if (n.state !== "full") {
          n.state = "full";
          ctx.emit({
            type: "OSPF_NEIGHBOR",
            deviceId: r.id,
            deviceName: r.name,
            interfaceId: n.interfaceId,
            interfaceName: findInterface(r, n.interfaceId)?.name,
            message: `${r.name}: OSPF neighbor ${n.routerId} (${n.ip}) → Full`,
            osiLayers: [3],
          });
          adjacencies++;
        }
      }
    }
  }

  // 4. SPF (BFS, hop metric) per router; install routes to remote advertised nets
  let routesInstalled = 0;
  for (const s of routers) {
    const cfgS = getOspfConfig(s)!;
    const ridS = routerIdOf(s, cfgS);

    // firstHop[targetRid] = { viaIp, egress } (S's next hop toward that router)
    const firstHop = new Map<string, { viaIp: string; egress: string }>();
    const dist = new Map<string, number>([[ridS, 0]]);
    const queue: string[] = [ridS];
    while (queue.length) {
      const curRid = queue.shift()!;
      const cur = byRid.get(curRid);
      if (!cur) continue;
      for (const n of getOspfConfig(cur)!.neighbors!.filter((x) => x.state === "full")) {
        if (dist.has(n.routerId)) continue;
        dist.set(n.routerId, (dist.get(curRid) ?? 0) + 1);
        firstHop.set(
          n.routerId,
          curRid === ridS ? { viaIp: n.ip, egress: n.interfaceId } : firstHop.get(curRid)!,
        );
        queue.push(n.routerId);
      }
    }

    const connected = new Set(
      s.routingTable.filter((r) => r.type === "connected").map((r) => `${r.destination}/${r.prefix}`),
    );
    for (const [ridT, d] of dist) {
      if (ridT === ridS) continue;
      const t = byRid.get(ridT);
      const fh = firstHop.get(ridT);
      if (!t || !fh) continue;
      for (const adv of advertisedNetworks(t, getOspfConfig(t)!)) {
        const key = `${adv.network}/${adv.prefix}`;
        if (connected.has(key)) continue;
        const existing = s.routingTable.find(
          (r) => r.type === "ospf" && r.destination === adv.network && r.prefix === adv.prefix,
        );
        if (existing) {
          if (existing.metric <= d) continue;
          existing.nextHop = fh.viaIp;
          existing.interfaceId = fh.egress;
          existing.metric = d;
        } else {
          s.routingTable.push({
            destination: adv.network,
            prefix: adv.prefix,
            nextHop: fh.viaIp,
            interfaceId: fh.egress,
            type: "ospf",
            metric: d,
          });
          ctx.emit({
            type: "OSPF_ROUTE",
            deviceId: s.id,
            deviceName: s.name,
            message: `${s.name}: OSPF route ${adv.network}/${adv.prefix} via ${fh.viaIp} (cost ${d})`,
            osiLayers: [3],
          });
          routesInstalled++;
        }
      }
    }
  }

  return { routers: routers.length, adjacencies, routesInstalled };
}
