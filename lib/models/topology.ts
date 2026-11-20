/**
 * Topology + whole-network state (spec §34, §61). This is the single source of
 * truth: the store, terminal, engine, and UI all read/write this shape.
 */
import { Device, findInterface } from "./device";

export type LinkState = "up" | "down";

export interface Endpoint {
  deviceId: string;
  interfaceId: string;
}

export interface Connection {
  id: string;
  a: Endpoint;
  b: Endpoint;
  state: LinkState;
  /** Cable colour chosen by the learner (CSS colour); unset = automatic by what it connects. */
  color?: string;
}

export interface NetworkState {
  devices: Record<string, Device>;
  connections: Connection[];
  /** Last-elected VRRP master per VIP (deviceId) — lets the engine emit an
   *  explicit VRRP_FAILOVER event the moment the master changes. */
  vrrpMaster?: Record<string, string>;
}

export function emptyNetwork(): NetworkState {
  return { devices: {}, connections: [] };
}

/** Find the connection touching a given endpoint, if any. */
export function connectionFor(
  state: NetworkState,
  deviceId: string,
  interfaceId: string,
): Connection | undefined {
  return state.connections.find(
    (c) =>
      (c.a.deviceId === deviceId && c.a.interfaceId === interfaceId) ||
      (c.b.deviceId === deviceId && c.b.interfaceId === interfaceId),
  );
}

/** Resolve the interface on the other end of the cable, if the link is up. */
export function getPeer(
  state: NetworkState,
  deviceId: string,
  interfaceId: string,
): { endpoint: Endpoint; connection: Connection } | null {
  const conn = connectionFor(state, deviceId, interfaceId);
  if (!conn) return null;
  const isA = conn.a.deviceId === deviceId && conn.a.interfaceId === interfaceId;
  const endpoint = isA ? conn.b : conn.a;
  return { endpoint, connection: conn };
}

/** Recompute an interface's operational state from admin state + link presence. */
function refreshOperState(state: NetworkState, deviceId: string, interfaceId: string): void {
  const dev = state.devices[deviceId];
  const iface = dev && findInterface(dev, interfaceId);
  if (!iface) return;
  const conn = connectionFor(state, deviceId, interfaceId);
  // Carrier needs both ends enabled: shutting one side takes the link down on both.
  const peerEp = conn && (conn.a.deviceId === deviceId && conn.a.interfaceId === interfaceId ? conn.b : conn.a);
  const peerDev = peerEp && state.devices[peerEp.deviceId];
  const peer = peerDev && findInterface(peerDev, peerEp!.interfaceId);
  iface.operState = conn && conn.state === "up" && iface.adminState === "up" && (!peer || peer.adminState === "up") ? "up" : "down";
}

/** Recompute carrier on both ends of the cable attached to an interface. */
export function refreshLink(state: NetworkState, deviceId: string, interfaceId: string): string[] {
  const conn = connectionFor(state, deviceId, interfaceId);
  if (!conn) {
    refreshOperState(state, deviceId, interfaceId);
    return [deviceId];
  }
  refreshOperState(state, conn.a.deviceId, conn.a.interfaceId);
  refreshOperState(state, conn.b.deviceId, conn.b.interfaceId);
  return [conn.a.deviceId, conn.b.deviceId];
}

/**
 * Create a cable between two interfaces, updating the denormalized
 * `connectedTo` caches and both interfaces' operational state.
 */
export function linkInterfaces(
  state: NetworkState,
  a: Endpoint,
  b: Endpoint,
): Connection {
  const conn: Connection = {
    id: `${a.deviceId}:${a.interfaceId}--${b.deviceId}:${b.interfaceId}`,
    a,
    b,
    state: "up",
  };
  state.connections.push(conn);

  const ifA = findInterface(state.devices[a.deviceId], a.interfaceId);
  if (ifA) ifA.connectedTo = { deviceId: b.deviceId, interfaceId: b.interfaceId };
  const ifB = findInterface(state.devices[b.deviceId], b.interfaceId);
  if (ifB) ifB.connectedTo = { deviceId: a.deviceId, interfaceId: a.interfaceId };

  refreshOperState(state, a.deviceId, a.interfaceId);
  refreshOperState(state, b.deviceId, b.interfaceId);
  return conn;
}

/** Remove a cable by connection id and update endpoint state. */
export function unlinkConnection(state: NetworkState, connectionId: string): void {
  const conn = state.connections.find((c) => c.id === connectionId);
  if (!conn) return;
  state.connections = state.connections.filter((c) => c.id !== connectionId);
  for (const ep of [conn.a, conn.b]) {
    const iface = findInterface(state.devices[ep.deviceId], ep.interfaceId);
    if (iface) {
      iface.connectedTo = undefined;
      refreshOperState(state, ep.deviceId, ep.interfaceId);
    }
  }
}
