/**
 * Spanning Tree Protocol (STP / RSTP — IEEE 802.1D / 802.1w) Control & Data Plane.
 *
 * Implements real L2 loop resolution:
 *   - Bridge ID: priority (default 32768) + base system MAC
 *   - Root Bridge Election: switch with lowest Bridge ID wins
 *   - Shortest Path Cost computation (Dijkstra) from Root Bridge
 *   - Port Roles: Root Port (RP), Designated Port (DP), Alternate Port (AP)
 *   - Port States: FORWARDING vs BLOCKING
 *   - Periodic BPDU transmission to 01:80:C2:00:00:00
 *   - Data frame dropping on BLOCKING ports to eliminate broadcast storms
 */
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { NetworkState, Connection } from "../models/topology";
import { SimContext } from "../engine/context";
import { ControlDaemon, registerDaemon } from "../control/daemon";
import { normalizeMac } from "../models/mac";
import { featureState, peekFeatureState } from "../models/feature-state";
import { lagOf } from "../control/hooks";
import { cpGet, cpList } from "../commands/sonic-cli/config-plane";
import { errdisablePort } from "./errdisable";
import { flushDynamicFdb } from "./macaging-daemon";
import { logEvent } from "../control/syslog";

/** Per-port BPDU counters (stpd STP_PORT_TABLE bpdu_sent / bpdu_received) for `show spanning-tree counters`. */
export type StpCounters = Record<string, { tx: number; rx: number }>;
export const stpCounters = (d: Device): StpCounters => peekFeatureState<StpCounters>(d, "stp_counters") ?? {};
function bumpBpdu(d: Device, ifname: string, dir: "tx" | "rx"): void {
  const c = featureState<StpCounters>(d, "stp_counters", () => ({}));
  (c[ifname] ??= { tx: 0, rx: 0 })[dir]++;
}

export const STP_MULTICAST_MAC = "01:80:C2:00:00:00";
export const DEFAULT_STP_PRIORITY = 32768;
export const DEFAULT_PORT_COST = 20000; // 1Gbps default (IEEE 802.1D-1998 / 802.1w)
export const HELLO_TIME_SECS = 2;
export const MAX_AGE_SECS = 20;
export const FORWARD_DELAY_SECS = 15;

export type StpPortRole = "Root" | "Designated" | "Alternate" | "Disabled";
export type StpPortState = "FORWARDING" | "BLOCKING" | "LEARNING";

export interface StpPortOper {
  interfaceId: string;
  interfaceName: string;
  role: StpPortRole;
  state: StpPortState;
  cost: number;
  priority: number;
  portNumber: number;
  peerDeviceId?: string;
  peerInterfaceId?: string;
}

export interface StpBridgeOper {
  deviceId: string;
  bridgeId: string;
  priority: number;
  mac: string;
  rootBridgeId: string;
  isRoot: boolean;
  rootPathCost: number;
  rootPortId?: string;
  helloTime: number;
  maxAge: number;
  forwardDelay: number;
  ports: Record<string, StpPortOper>;
}

/** Get the configured or default STP priority for a switch (KLISH / Click `spanning-tree priority` → cp_stp). */
export function getStpPriority(dev: Device): number {
  const p = (dev.config.features?.stp as { priority?: number } | undefined)?.priority ?? cpGet(dev, "stp")?.priority;
  return typeof p === "number" && p >= 0 ? p : DEFAULT_STP_PRIORITY;
}

/** Per-interface `spanning-tree …` config row (cp_stp.interfaces). */
const stpIntf = (dev: Device, name: string) => cpList(dev, "stp", "interfaces").find((r) => r.ifname === name);

const isUp = (i: NetInterface) => i.adminState === "up" && i.operState === "up";

/** A bridge port STP runs on: a switchport that is not a LAG member, or a PortChannel; never routed/mgmt. */
function isStpPort(sw: Device, i: NetInterface): boolean {
  if (i.management || i.ipv4.length > 0) return false;
  if (i.logical) return /^PortChannel\d+$/.test(i.name);
  return lagOf(sw, i) === undefined;
}

/** STP port a cabled interface belongs to: itself, or its PortChannel while the member is aggregated. */
function stpPortOf(sw: Device, i: NetInterface): NetInterface | undefined {
  if (i.management || i.logical || i.ipv4.length > 0) return undefined;
  const lag = lagOf(sw, i);
  if (lag === undefined) return i;
  return lag && isStpPort(sw, lag) ? lag : undefined;
}

/** Format Bridge ID as <priority>.<mac> in lower-case hex. */
export function formatBridgeId(priority: number, mac: string): string {
  return `${priority}.${normalizeMac(mac)}`;
}

/** Compare two bridge IDs (<priority>.<mac>). Returns < 0 if a < b. */
export function compareBridgeIds(a: string, b: string): number {
  const [pAStr, macA] = a.split(".");
  const [pBStr, macB] = b.split(".");
  const pA = Number(pAStr);
  const pB = Number(pBStr);
  if (pA !== pB) return pA - pB;
  return macA.localeCompare(macB);
}

/** Helper to find the base MAC of a device. */
export function getBaseMac(dev: Device): string {
  const phys = dev.interfaces.find((i) => !i.logical && !i.management);
  return phys ? normalizeMac(phys.mac) : "00:00:00:00:00:01";
}

/**
 * Compute the authoritative Spanning Tree topology for the network.
 * Returns a map of deviceId -> StpBridgeOper for all switches.
 */
export function computeStp(state: NetworkState): Record<string, StpBridgeOper> {
  const switches = Object.values(state.devices).filter((d) => isSwitch(d.type) && d.state !== "down");
  const result: Record<string, StpBridgeOper> = {};

  if (switches.length === 0) return result;

  // 1. Initialize bridge info for each switch
  for (const sw of switches) {
    const priority = getStpPriority(sw);
    const mac = getBaseMac(sw);
    const bridgeId = formatBridgeId(priority, mac);

    const ports: Record<string, StpPortOper> = {};
    let portNum = 1;
    // Physical ports first (numbering unchanged), then PortChannels.
    for (const iface of [...sw.interfaces.filter((i) => !i.logical), ...sw.interfaces.filter((i) => i.logical)]) {
      if (iface.management || (iface.logical && !isStpPort(sw, iface))) continue;
      const num = portNum++;
      if (!isStpPort(sw, iface)) continue; // LAG member / routed port: not a bridge port
      const adminUp = iface.adminState === "up";
      const cost = stpIntf(sw, iface.name)?.cost;
      ports[iface.id] = {
        interfaceId: iface.id,
        interfaceName: iface.name,
        role: adminUp ? "Designated" : "Disabled",
        state: adminUp ? "FORWARDING" : "BLOCKING",
        cost: typeof cost === "number" ? cost : DEFAULT_PORT_COST,
        priority: 128,
        portNumber: num,
      };
    }

    result[sw.id] = {
      deviceId: sw.id,
      bridgeId,
      priority,
      mac,
      rootBridgeId: bridgeId,
      isRoot: true,
      rootPathCost: 0,
      rootPortId: undefined,
      helloTime: HELLO_TIME_SECS,
      maxAge: MAX_AGE_SECS,
      forwardDelay: FORWARD_DELAY_SECS,
      ports,
    };
  }

  // 2. Discover active switch-to-switch links
  interface SwitchLink {
    swAId: string;
    ifAId: string;
    swBId: string;
    ifBId: string;
    costA: number;
    costB: number;
  }
  const switchLinks: SwitchLink[] = [];
  const seen = new Set<string>();

  for (const conn of state.connections) {
    if (conn.state !== "up") continue;
    const devA = state.devices[conn.a.deviceId];
    const devB = state.devices[conn.b.deviceId];
    if (!devA || !devB) continue;
    if (!isSwitch(devA.type) || !isSwitch(devB.type)) continue;

    const cabA = devA.interfaces.find((i) => i.id === conn.a.interfaceId);
    const cabB = devB.interfaces.find((i) => i.id === conn.b.interfaceId);
    if (!cabA || !cabB || !isUp(cabA) || !isUp(cabB)) continue; // err-disabled / LST-downed links carry no BPDUs
    // LAG members map to their PortChannel: the bundle is one STP port and one link.
    const ifA = stpPortOf(devA, cabA);
    const ifB = stpPortOf(devB, cabB);
    if (!ifA || !ifB || !isUp(ifA) || !isUp(ifB)) continue;
    const key = `${devA.id}/${ifA.id}|${devB.id}/${ifB.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Record peer info on ports
    if (result[devA.id]?.ports[ifA.id]) {
      result[devA.id].ports[ifA.id].peerDeviceId = devB.id;
      result[devA.id].ports[ifA.id].peerInterfaceId = ifB.id;
    }
    if (result[devB.id]?.ports[ifB.id]) {
      result[devB.id].ports[ifB.id].peerDeviceId = devA.id;
      result[devB.id].ports[ifB.id].peerInterfaceId = ifA.id;
    }

    switchLinks.push({
      swAId: devA.id,
      ifAId: ifA.id,
      swBId: devB.id,
      ifBId: ifB.id,
      costA: result[devA.id]?.ports[ifA.id]?.cost ?? DEFAULT_PORT_COST,
      costB: result[devB.id]?.ports[ifB.id]?.cost ?? DEFAULT_PORT_COST,
    });
  }

  // 3. Find connected components of switches
  const visited = new Set<string>();
  for (const sw of switches) {
    if (visited.has(sw.id)) continue;

    // BFS to find all switches in this component
    const component: string[] = [];
    const queue = [sw.id];
    visited.add(sw.id);

    while (queue.length > 0) {
      const cur = queue.shift()!;
      component.push(cur);
      for (const link of switchLinks) {
        if (link.swAId === cur && !visited.has(link.swBId)) {
          visited.add(link.swBId);
          queue.push(link.swBId);
        } else if (link.swBId === cur && !visited.has(link.swAId)) {
          visited.add(link.swAId);
          queue.push(link.swAId);
        }
      }
    }

    // 4. Elect Root Bridge for this component (lowest Bridge ID)
    let rootSwId = component[0];
    for (let i = 1; i < component.length; i++) {
      const id = component[i];
      if (compareBridgeIds(result[id].bridgeId, result[rootSwId].bridgeId) < 0) {
        rootSwId = id;
      }
    }
    const rootBridgeId = result[rootSwId].bridgeId;

    // 5. Shortest path (Dijkstra) from root to all switches in component
    const dist: Record<string, number> = {};
    const bestRootPort: Record<string, { ifaceId: string; neighborBridgeId: string }> = {};

    for (const id of component) dist[id] = Infinity;
    dist[rootSwId] = 0;

    const unvisitedSwitches = new Set(component);
    while (unvisitedSwitches.size > 0) {
      let u: string | null = null;
      for (const candidate of unvisitedSwitches) {
        if (u === null || dist[candidate] < dist[u]) {
          u = candidate;
        }
      }
      if (u === null || dist[u] === Infinity) break;
      unvisitedSwitches.delete(u);

      for (const link of switchLinks) {
        let v: string | null = null;
        let ifU: string | null = null;
        let cost: number = DEFAULT_PORT_COST;
        if (link.swAId === u) {
          v = link.swBId;
          ifU = link.ifBId; // port on v that points towards u
          cost = link.costB;
        } else if (link.swBId === u) {
          v = link.swAId;
          ifU = link.ifAId; // port on v that points towards u
          cost = link.costA;
        }
        if (v && unvisitedSwitches.has(v) && ifU) {
          const newDist = dist[u] + cost;
          const uBridgeId = result[u].bridgeId;
          if (newDist < dist[v]) {
            dist[v] = newDist;
            bestRootPort[v] = { ifaceId: ifU, neighborBridgeId: uBridgeId };
          } else if (newDist === dist[v] && bestRootPort[v]) {
            // Tie-break: lowest neighbor bridge ID
            if (compareBridgeIds(uBridgeId, bestRootPort[v].neighborBridgeId) < 0) {
              bestRootPort[v] = { ifaceId: ifU, neighborBridgeId: uBridgeId };
            }
          }
        }
      }
    }

    // 6. Assign root path cost and root ports to non-root bridges
    for (const id of component) {
      const oper = result[id];
      oper.rootBridgeId = rootBridgeId;
      if (id === rootSwId) {
        oper.isRoot = true;
        oper.rootPathCost = 0;
        oper.rootPortId = undefined;
      } else {
        oper.isRoot = false;
        oper.rootPathCost = dist[id] !== Infinity ? dist[id] : 0;
        oper.rootPortId = bestRootPort[id]?.ifaceId;
        if (oper.rootPortId && oper.ports[oper.rootPortId]) {
          oper.ports[oper.rootPortId].role = "Root";
          oper.ports[oper.rootPortId].state = "FORWARDING";
        }
      }
    }

    // 7. For each switch-to-switch link, elect the Designated Port and Alternate Port
    for (const link of switchLinks) {
      if (!component.includes(link.swAId) || !component.includes(link.swBId)) continue;
      const operA = result[link.swAId];
      const operB = result[link.swBId];
      const portA = operA.ports[link.ifAId];
      const portB = operB.ports[link.ifBId];
      if (!portA || !portB) continue;

      // If either port is already the Root Port for its bridge, it stays Root / FORWARDING
      const aIsRP = operA.rootPortId === link.ifAId;
      const bIsRP = operB.rootPortId === link.ifBId;

      if (aIsRP && !bIsRP) {
        portA.role = "Root";
        portA.state = "FORWARDING";
        portB.role = "Designated";
        portB.state = "FORWARDING";
      } else if (bIsRP && !aIsRP) {
        portB.role = "Root";
        portB.state = "FORWARDING";
        portA.role = "Designated";
        portA.state = "FORWARDING";
      } else if (!aIsRP && !bIsRP) {
        // Neither port is a Root Port: redundant link! One must block!
        // Designated bridge election: lower root path cost wins DP
        let aWins = false;
        if (operA.rootPathCost < operB.rootPathCost) {
          aWins = true;
        } else if (operA.rootPathCost > operB.rootPathCost) {
          aWins = false;
        } else {
          // Tie-break: lower Bridge ID
          aWins = compareBridgeIds(operA.bridgeId, operB.bridgeId) < 0;
        }

        if (aWins) {
          portA.role = "Designated";
          portA.state = "FORWARDING";
          portB.role = "Alternate";
          portB.state = "BLOCKING";
        } else {
          portB.role = "Designated";
          portB.state = "FORWARDING";
          portA.role = "Alternate";
          portA.state = "BLOCKING";
        }
      }
    }
  }

  return result;
}

/** Get the operational STP status for a bridge. */
export function getStpBridgeOper(state: NetworkState, dev: Device): StpBridgeOper {
  const all = computeStp(state);
  return (
    all[dev.id] ?? {
      deviceId: dev.id,
      bridgeId: formatBridgeId(getStpPriority(dev), getBaseMac(dev)),
      priority: getStpPriority(dev),
      mac: getBaseMac(dev),
      rootBridgeId: formatBridgeId(getStpPriority(dev), getBaseMac(dev)),
      isRoot: true,
      rootPathCost: 0,
      helloTime: HELLO_TIME_SECS,
      maxAge: MAX_AGE_SECS,
      forwardDelay: FORWARD_DELAY_SECS,
      ports: {},
    }
  );
}

/** Get the STP forwarding/blocking state of a port. Returns FORWARDING if STP not active. */
export function getStpPortState(sw: Device, interfaceId: string, state?: NetworkState): StpPortState {
  if (!isSwitch(sw.type)) return "FORWARDING";
  if (!state) return "FORWARDING";
  const bridgeOper = getStpBridgeOper(state, sw);
  const p = bridgeOper.ports[interfaceId];
  return p ? p.state : "FORWARDING";
}

/** Build an IEEE 802.1D BPDU Configuration frame. */
export function buildBpduFrame(sw: Device, iface: NetInterface, oper: StpBridgeOper): Frame {
  const p = oper.ports[iface.id];
  const portId = p ? `${p.priority}.${p.portNumber}` : "128.1";
  return {
    id: `bpdu-${sw.id}-${iface.id}-${Date.now()}`,
    ethernet: {
      srcMac: iface.mac,
      dstMac: STP_MULTICAST_MAC,
      etherType: "Other",
      typeCode: 0x0026, // IEEE 802.3 length / LLC
    },
    stp: {
      protocolId: 0,
      version: 0,
      bpduType: 0,
      flags: 0,
      rootBridgeId: oper.rootBridgeId,
      rootPathCost: oper.rootPathCost,
      bridgeId: oper.bridgeId,
      portId,
      messageAge: 0,
      maxAge: oper.maxAge,
      helloTime: oper.helloTime,
      forwardDelay: oper.forwardDelay,
    },
    meta: {
      sizeBytes: 64,
      summary: `STP BPDU: root ${oper.rootBridgeId} cost ${oper.rootPathCost} bridge ${oper.bridgeId}`,
    },
  };
}

/**
 * BPDU guard (stp_mgr.c stpmgr_protect_process): a BPDU on a port with
 * `spanning-tree bpduguard port-shutdown` disables the port (err-disable cause
 * bpduguard, recovered by `errdisable recovery cause bpduguard`). Without
 * port-shutdown the BPDU is only ignored. Returns true when the port was shut.
 */
function bpduGuardTrips(ctx: SimContext, device: Device, iface: NetInterface, nowMs: number): boolean {
  const row = stpIntf(device, iface.name);
  if (row?.bpduguard !== true || row.bpduguard_shutdown !== true) return false;
  logEvent(device, nowMs, "WARNING", "stpd", `STP: BPDU received, interface ${iface.name} disabled due to BPDU guard trigger`);
  errdisablePort(ctx, device, iface, "bpduguard", nowMs);
  return true;
}

/**
 * STP Control-Plane Daemon.
 * Periodically emits BPDUs on Designated ports and receives BPDUs.
 */
export const stpDaemon: ControlDaemon = {
  id: "stp",
  nextDue(device: Device, nowMs: number): number | undefined {
    if (!isSwitch(device.type) || device.state === "down") return undefined;
    // Pure routed L3 switches with no L2 switchports do not run STP BPDUs
    const hasL2 = device.interfaces.some((i) => !i.management && !i.logical && i.ipv4.length === 0);
    if (!hasL2) return undefined;

    // Periodic hello every 2s
    const lastHello = (device.config.features as Record<string, unknown> | undefined)?._stpLastHello as number | undefined;
    if (lastHello === undefined) return nowMs; // never sent a hello yet: start now
    return lastHello + HELLO_TIME_SECS * 1000;
  },

  tick(ctx: SimContext, device: Device, nowMs: number): boolean {
    if (!isSwitch(device.type) || device.state === "down") return false;
    const hasL2 = device.interfaces.some((i) => !i.management && !i.logical && i.ipv4.length === 0);
    if (!hasL2) return false;

    const cfg = (device.config.features ??= {});
    cfg._stpLastHello = nowMs;

    const all = computeStp(ctx.state);
    const oper = all[device.id] ?? getStpBridgeOper(ctx.state, device);

    // Topology change (a port of this spanning tree changed state, a link joined or
    // left): flush the learned FDB, as stpd does on TC, so frames stop following
    // the old path.
    const sig = Object.values(all)
      .filter((b) => b.rootBridgeId === oper.rootBridgeId)
      .flatMap((b) => Object.values(b.ports).filter((p) => p.peerDeviceId).map((p) => `${b.deviceId}/${p.interfaceId}:${p.state}`))
      .sort()
      .join(",");
    if (cfg._stpTopoSig !== undefined && cfg._stpTopoSig !== sig && flushDynamicFdb(device) > 0) {
      logEvent(device, nowMs, "NOTICE", "stpd", "STP: topology change, flushing learned MAC addresses");
    }
    cfg._stpTopoSig = sig;

    // BPDUs are transmitted out of Designated bridge ports (switchports and PortChannels)
    for (const iface of device.interfaces) {
      if (!isUp(iface)) continue;
      const port = oper.ports[iface.id];
      if (!port) continue; // mgmt, routed, LAG member: not an STP port
      // BPDU guard: the bridge at the far end sends BPDUs on this link (every RSTP
      // port proposes on link-up, whatever role it settles in) → guard trips.
      if (port.peerDeviceId && bpduGuardTrips(ctx, device, iface, nowMs)) continue;
      if (port.role === "Designated" && port.state === "FORWARDING") {
        const bpdu = buildBpduFrame(device, iface, oper);
        ctx.emit({
          type: "STP_BPDU_SENT",
          deviceId: device.id,
          deviceName: device.name,
          interfaceId: iface.id,
          interfaceName: iface.name,
          message: `${device.name} ${iface.name}: sent STP BPDU (root ${oper.rootBridgeId}, cost ${oper.rootPathCost})`,
          osiLayers: [2],
          frame: bpdu,
        });
        ctx.transmit(device.id, iface.id, bpdu);
        bumpBpdu(device, iface.name, "tx");
      }
    }
    return true;
  },

  receiveL2(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
    if (!isSwitch(device.type)) return false;
    if (frame.ethernet.dstMac.toUpperCase() !== STP_MULTICAST_MAC && !frame.stp) return false;

    if (frame.stp) {
      bumpBpdu(device, ingress.name, "rx");
      if (bpduGuardTrips(ctx, device, lagOf(device, ingress) || ingress, ctx.wallNow())) return true;
      ctx.emit({
        type: "STP_BPDU_RECEIVED",
        deviceId: device.id,
        deviceName: device.name,
        interfaceId: ingress.id,
        interfaceName: ingress.name,
        message: `${device.name} ${ingress.name}: received STP BPDU from bridge ${frame.stp.bridgeId} (root ${frame.stp.rootBridgeId})`,
        osiLayers: [2],
        frame,
      });
    }
    return true; // Link-local BPDU consumed; never bridged
  },

  describe(frame: Frame): string | undefined {
    if (!frame.stp) return undefined;
    const s = frame.stp;
    return `STP 802.1d, Config, root-id ${s.rootBridgeId}, cost ${s.rootPathCost}, bridge-id ${s.bridgeId}`;
  },
};

// Register daemon with control-plane framework
registerDaemon(stpDaemon);
