/**
 * Protocol plugin contract (spec §47).
 *
 * MVP-1 implements Ethernet / ARP / IPv4 / ICMP as concrete modules under
 * lib/protocols/* that operate through SimContext. That is deliberately simpler
 * than a full plugin bus while the protocol count is small. This interface fixes
 * the shape those modules will migrate to as more protocols (TCP, DNS, DHCP,
 * NTP, NAT, STP, LACP, ...) are added, so new protocols can register
 * independently. See docs/ROADMAP.md.
 */
import { Device } from "../models/device";
import { Frame } from "../models/packet";
import { SimContext } from "./context";

export interface ProtocolEngine {
  readonly name: string;

  /** Called once when the engine is attached to a simulation context. */
  initialize?(ctx: SimContext): void;

  /**
   * Process a frame arriving at `device` on `interfaceId`. Implementations use
   * the context to emit events and transmit further frames.
   */
  processPacket(ctx: SimContext, packet: Frame, device: Device, interfaceId: string): void;

  /** Expose protocol-specific per-device state (tables, sockets, ...). */
  getState?(deviceId: string): unknown;

  /** Reset any accumulated engine state. */
  reset?(): void;
}
