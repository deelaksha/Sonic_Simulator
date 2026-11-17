/**
 * Contract between BFD and its clients (OSPF, BGP, static routes) — as in FRR,
 * where bfdd serves sessions requested by ospfd/bgpd over zebra. Clients ask for
 * a session to a peer and poll its state every tick; when it goes from "up" to
 * "down" they tear their adjacency/session down immediately instead of waiting
 * for their own dead/hold timers.
 *
 * The BFD daemon (lib/protocols/bfd/) installs the implementation with
 * setBfdImpl(); until then every query answers undefined (no BFD).
 */
import { Device } from "../models/device";

export type BfdState = "admin-down" | "down" | "init" | "up";
export type BfdClient = "bgp" | "ospf" | "static";

export interface BfdSessionKey {
  peer: string;
  /** Source address; default = the address of the egress interface. */
  local?: string;
  /** Single-hop sessions are bound to an interface. */
  iface?: string;
  multihop?: boolean;
}

export interface BfdApi {
  /** Create (or take a reference on) a session for a client. Idempotent per client. */
  register(device: Device, key: BfdSessionKey, client: BfdClient): void;
  /** Drop a client's reference; the session is removed when unused and not configured. */
  unregister(device: Device, peer: string, client: BfdClient): void;
  state(device: Device, peer: string): BfdState | undefined;
}

const NONE: BfdApi = {
  register() {},
  unregister() {},
  state() {
    return undefined;
  },
};

let impl: BfdApi = NONE;

export function setBfdImpl(api: BfdApi): void {
  impl = api;
}

export function bfd(): BfdApi {
  return impl;
}
