/**
 * OSPF entry points kept for the engine (lib/engine/simulation.ts runOspf) and
 * the router receive path (lib/protocols/router.ts). The protocol itself is the
 * control-plane daemon in ospf-daemon.ts (real packets, timers, LSDB, SPF).
 *
 *   convergeOspfDomain  — `ospf converge` / sim.runOspf(): converges every
 *                         OSPF speaker at the current instant (immediate Hello
 *                         rounds, Wait timers expired) and reports a summary.
 *   handleOspfFrame     — legacy hook for frames carrying the old abstract
 *                         `frame.ospf` layer. OSPF packets are now real bytes
 *                         handled by the daemon via dispatchL3 (which runs
 *                         first in routerReceive), so this is a no-op.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { convergeOspf } from "./ospf-daemon";

export { OSPF_ALL_SPF as OSPF_MULTICAST_IP } from "./ospf-wire";
export const OSPF_MULTICAST_MAC = "01:00:5E:00:00:05";

export interface OspfSummary {
  routers: number;
  adjacencies: number;
  routesInstalled: number;
}

export function handleOspfFrame(_ctx: SimContext, _device: Device, _ingress: NetInterface, _frame: Frame): void {}

export function convergeOspfDomain(ctx: SimContext): OspfSummary {
  return convergeOspf(ctx);
}
