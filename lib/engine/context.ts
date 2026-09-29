/**
 * SimContext — the seam between the simulation orchestrator and the per-protocol
 * behavior modules (ARP, IPv4, ICMP, switching). Protocol modules depend only on
 * this interface, never on the concrete Simulation, which keeps them decoupled
 * and testable and mirrors the future ProtocolEngine plugin API (spec §47).
 */
import { NetworkState } from "../models/topology";
import { Frame } from "../models/packet";
import { EmitInput } from "./events";

export type CaptureDir = "rx" | "tx";

export interface SimContext {
  readonly state: NetworkState;

  /** Record a timeline event. */
  emit(e: EmitInput): void;

  /** Current simulated clock (ms). */
  now(): number;

  /** Advance the simulated clock. */
  advance(ms: number): void;

  /**
   * Send a frame OUT of an interface onto the wire. Finds the peer via the
   * topology and delivers it there. This is the one entry point for moving a
   * frame between devices; it may recurse (switch flood → hosts → replies).
   */
  transmit(deviceId: string, interfaceId: string, frame: Frame): void;

  /** Append a frame to an interface's capture buffer (for tcpdump, spec §19). */
  capture(deviceId: string, interfaceId: string, dir: CaptureDir, frame: Frame): void;

  /** Loop/recursion guard. Returns false once the step budget is exhausted. */
  step(): boolean;

  /** A host received an ICMP echo reply addressed to it (ping success signal). */
  recordEchoReply(deviceId: string, frame: Frame): void;

  /** A host received a UDP reply (NTP response, DHCP offer/ack) it was waiting for. */
  recordUdp(deviceId: string, frame: Frame): void;
}
