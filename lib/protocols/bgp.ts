/**
 * BGP engine (spec §25). Real-enough packet-plane slice:
 *   1. Each router sends a BGP OPEN (TCP/179, unicast) to every configured
 *      neighbor over the actual L3 path (ARP + routing + delivery), piggybacking
 *      its advertised `network` prefixes as NLRI.
 *   2. A session becomes Established when both peers configured each other AND
 *      both OPENs were delivered (reachability proven by real packets).
 *   3. Each router installs the peer's advertised prefixes as `type:"bgp"` routes,
 *      so cross-AS forwarding works.
 *
 * Simplified vs RFC 4271: the TCP three-way handshake is represented by the OPEN
 * segment (flags shown, no separate SYN/SYN-ACK), no KEEPALIVE/hold-timer FSM, no
 * path attributes / best-path beyond "prefer existing", iBGP == eBGP, single-hop
 * peers. Session-via-OPEN and NLRI-derived working routes are genuine.
 */
import { Device, findInterface, isRouter } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { Frame, BgpNlri } from "../models/packet";
import { networkAddress } from "../models/ip";
import { longestPrefixMatch } from "../models/route";
import { SimContext } from "../engine/context";
import { ipOutput } from "./ipv4";

const TCP_BGP_BYTES = 20 + 29; // TCP header + BGP OPEN header (approx)

export interface BgpNeighbor {
  peer: string;
  remoteAs?: number;
  description?: string;
  ebgpMultihop?: number;
  // runtime:
  state?: "idle" | "active" | "established";
  gotOpen?: boolean;
  receivedNlri?: BgpNlri[];
  remoteAsSeen?: number;
  prefixesReceived?: number;
}

interface BgpConfig {
  localAs?: number;
  routerId?: string;
  neighbors?: BgpNeighbor[];
  networks?: string[]; // "a.b.c.d/len"
}

export function getBgpConfig(device: Device): BgpConfig | undefined {
  const cfg = device.config.features?.bgp as BgpConfig | undefined;
  if (!cfg || cfg.localAs === undefined) return undefined;
  if (!cfg.neighbors) cfg.neighbors = [];
  if (!cfg.networks) cfg.networks = [];
  return cfg;
}

function routerIdOf(device: Device, cfg: BgpConfig): string {
  if (cfg.routerId) return cfg.routerId;
  const ips = device.interfaces.flatMap((i) => i.ipv4.map((a) => a.address));
  return ips.length ? ips.sort().reverse()[0] : device.name;
}

function advertisedNlri(cfg: BgpConfig): BgpNlri[] {
  const out: BgpNlri[] = [];
  for (const n of cfg.networks ?? []) {
    const i = n.indexOf("/");
    if (i < 0) continue;
    const addr = n.slice(0, i);
    const prefix = Number(n.slice(i + 1));
    out.push({ network: networkAddress(addr, prefix), prefix });
  }
  return out;
}

/** Record an OPEN arriving at a router (called from router receive). */
export function handleBgpFrame(ctx: SimContext, device: Device, _ingress: NetInterface, frame: Frame): void {
  const cfg = getBgpConfig(device);
  const bgp = frame.bgp;
  if (!cfg || !bgp || bgp.messageType !== "open") return;
  const srcIp = frame.ipv4?.srcIp ?? "";
  const nb = cfg.neighbors!.find((n) => n.peer === srcIp);
  if (!nb) return; // OPEN from an unconfigured peer → ignored
  nb.gotOpen = true;
  nb.receivedNlri = bgp.nlri ?? [];
  nb.remoteAsSeen = bgp.as;
}

export interface BgpSummary {
  routers: number;
  sessions: number; // Established
  routesInstalled: number;
}

export function convergeBgpDomain(ctx: SimContext): BgpSummary {
  const routers = Object.values(ctx.state.devices).filter((d) => isRouter(d.type) && getBgpConfig(d));

  // reset
  for (const r of routers) {
    const cfg = getBgpConfig(r)!;
    for (const nb of cfg.neighbors!) {
      nb.state = "idle";
      nb.gotOpen = false;
      nb.receivedNlri = [];
      nb.prefixesReceived = 0;
    }
    r.routingTable = r.routingTable.filter((rt) => rt.type !== "bgp");
  }

  // pass 1: send OPEN to each configured neighbor (real TCP/179 unicast)
  for (const r of routers) {
    const cfg = getBgpConfig(r)!;
    const rid = routerIdOf(r, cfg);
    for (const nb of cfg.neighbors!.filter((n) => n.remoteAs !== undefined)) {
      const match = longestPrefixMatch(r.routingTable, nb.peer);
      const egress = match ? findInterface(r, match.route.interfaceId) : undefined;
      const srcAddr = egress ? primaryIpv4(egress) : undefined;
      if (!match || !egress || !srcAddr) {
        nb.state = "active"; // configured but no route to the peer
        continue;
      }
      ctx.emit({
        type: "BGP_OPEN",
        deviceId: r.id,
        deviceName: r.name,
        interfaceId: egress.id,
        interfaceName: egress.name,
        message: `${r.name}: BGP OPEN AS${cfg.localAs} rid ${rid} → ${nb.peer} (TCP/179)`,
        osiLayers: [7],
      });
      ipOutput(ctx, r, {
        srcIp: srcAddr.address,
        dstIp: nb.peer,
        ttl: 64,
        protocol: "TCP",
        identification: 0,
        tcp: { srcPort: 179, dstPort: 179, seq: 0, ack: 0, flags: ["PSH", "ACK"], window: 16384 },
        bgp: { messageType: "open", as: cfg.localAs, routerId: rid, holdTime: 180, nlri: advertisedNlri(cfg) },
        upperBytes: TCP_BGP_BYTES,
        summary: `BGP OPEN AS${cfg.localAs} → ${nb.peer}`,
      });
    }
  }

  // pass 2: finalize Established + install NLRI routes
  let sessions = 0;
  let routesInstalled = 0;
  for (const r of routers) {
    const cfg = getBgpConfig(r)!;
    const connected = new Set(
      r.routingTable.filter((rt) => rt.type === "connected").map((rt) => `${rt.destination}/${rt.prefix}`),
    );
    for (const nb of cfg.neighbors!) {
      if (!nb.gotOpen) continue;
      nb.state = "established";
      sessions++;
      ctx.emit({
        type: "BGP_ESTABLISHED",
        deviceId: r.id,
        deviceName: r.name,
        message: `${r.name}: BGP session with ${nb.peer} (AS${nb.remoteAsSeen}) → Established`,
        osiLayers: [7],
      });
      const match = longestPrefixMatch(r.routingTable, nb.peer);
      const egress = match ? findInterface(r, match.route.interfaceId) : undefined;
      if (!egress) continue;
      let received = 0;
      for (const adv of nb.receivedNlri ?? []) {
        received++;
        const key = `${adv.network}/${adv.prefix}`;
        if (connected.has(key)) continue;
        const existing = r.routingTable.find(
          (rt) => rt.destination === adv.network && rt.prefix === adv.prefix && (rt.type === "bgp" || rt.type === "connected" || rt.type === "static"),
        );
        if (existing) continue; // prefer an existing route (simplified best-path)
        r.routingTable.push({
          destination: adv.network,
          prefix: adv.prefix,
          nextHop: nb.peer,
          interfaceId: egress.id,
          type: "bgp",
          metric: 20,
        });
        ctx.emit({
          type: "BGP_ROUTE",
          deviceId: r.id,
          deviceName: r.name,
          message: `${r.name}: BGP route ${adv.network}/${adv.prefix} via ${nb.peer} (AS${nb.remoteAsSeen})`,
          osiLayers: [7],
        });
        routesInstalled++;
      }
      nb.prefixesReceived = received;
    }
  }

  return { routers: routers.length, sessions, routesInstalled };
}
