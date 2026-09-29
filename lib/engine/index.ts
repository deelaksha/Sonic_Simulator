/**
 * Public engine API. Everything outside the engine (store, commands, tests)
 * imports from here.
 */
export * from "./events";
export * from "./context";
export * from "./plugin";
export { Simulation } from "./simulation";
export type { PingReply, PingSummary, PingFailure, TraceHop, NtpSyncResult, DhcpResult, CaptureRecord } from "./simulation";
export type { OspfSummary } from "../protocols/ospf";
export type { BgpSummary } from "../protocols/bgp";
export { resetIds } from "./ids";

import { NetworkState } from "../models/topology";
import { Simulation, PingSummary, CaptureRecord } from "./simulation";
import { SimEvent } from "./events";

/**
 * Convenience wrapper: run a single ping against a network state and return the
 * summary plus the generated event stream and captures. Mutates `state`
 * (ARP/MAC learning, statistics) — that is the point (spec §61).
 */
export function simulatePing(
  state: NetworkState,
  srcDeviceId: string,
  dstIp: string,
  opts?: { count?: number; ttl?: number },
): { summary: PingSummary; events: SimEvent[]; captures: CaptureRecord[] } {
  const sim = new Simulation(state);
  const summary = sim.runPing(srcDeviceId, dstIp, opts);
  return { summary, events: sim.events, captures: sim.captures };
}
