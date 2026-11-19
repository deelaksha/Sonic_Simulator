/**
 * Err-disable: a protection feature (UDLD here) shuts a port operationally
 * when it detects a fault; `errdisable recovery cause <cause>` +
 * `errdisable recovery interval <s>` (features/errdisable.ts, klish-xml/
 * errdisable.xml: default 300 s, range 30-65535) re-enable it automatically.
 *
 * An err-disabled port keeps its admin state (no `shutdown` appears in the
 * running config) but loses carrier: oper down on both ends of the cable, so
 * the peer sees the link drop as with a real PHY shutdown. Recovery
 * recomputes carrier from admin state (lib/models/topology.ts refreshLink).
 * Without recovery enabled for its cause, the port stays down until the
 * operator bounces it (`shutdown` / `no shutdown`).
 *
 * The syslog wording is the simulator's (no source for the message text).
 */
import { registerDaemon } from "../control/daemon";
import { logEvent } from "../control/syslog";
import { cpGet, cpList } from "../commands/sonic-cli/config-plane";
import { Device, findInterface, interfaceByName } from "../models/device";
import { NetInterface } from "../models/interface";
import { featureState, peekFeatureState } from "../models/feature-state";
import { getPeer, refreshLink } from "../models/topology";
import { rebuildConnectedRoutes } from "../models/factory";
import { SimContext } from "../engine/context";

export type ErrCause = "udld" | "bpduguard" | "link-flap" | "coa";
export const DEFAULT_RECOVERY_INTERVAL = 300; // errdisable.xml example / features/errdisable.ts

interface ErrPort {
  cause: ErrCause;
  since: number;
}

export interface ErrdisableState {
  ports: Record<string, ErrPort>;
}

export function errdisabledPorts(device: Device): Record<string, ErrPort> {
  return peekFeatureState<ErrdisableState>(device, "errdisable")?.ports ?? {};
}

export const isErrdisabled = (device: Device, port: string) => errdisabledPorts(device)[port] !== undefined;

function recoveryInterval(device: Device): number {
  return (cpGet(device, "errdisable")?.interval as number | undefined) ?? DEFAULT_RECOVERY_INTERVAL;
}

const recoveryOn = (device: Device, cause: ErrCause) => cpList(device, "errdisable", "causes").some((c) => c.cause === cause);

/** Put a port into err-disabled state (oper down, carrier lost on both ends). */
export function errdisablePort(ctx: SimContext, device: Device, iface: NetInterface, cause: ErrCause, nowMs: number): void {
  if (isErrdisabled(device, iface.name)) return;
  featureState<ErrdisableState>(device, "errdisable", () => ({ ports: {} })).ports[iface.name] = { cause, since: nowMs };
  iface.operState = "down";
  const peer = getPeer(ctx.state, device.id, iface.id);
  const peerDev = peer && ctx.state.devices[peer.endpoint.deviceId];
  const peerIf = peerDev && findInterface(peerDev, peer.endpoint.interfaceId);
  if (peerIf) {
    peerIf.operState = "down";
    rebuildConnectedRoutes(peerDev!);
  }
  rebuildConnectedRoutes(device);
  logEvent(device, nowMs, "WARNING", "errdisable", `${cause} error detected on ${iface.name}, putting ${iface.name} in err-disable state`);
}

/** Clear err-disable and restore carrier (recovery timer or operator action). */
export function recoverPort(ctx: SimContext, device: Device, iface: NetInterface, nowMs: number): void {
  const st = peekFeatureState<ErrdisableState>(device, "errdisable");
  const e = st?.ports[iface.name];
  if (!st || !e) return;
  delete st.ports[iface.name];
  for (const id of refreshLink(ctx.state, device.id, iface.id)) rebuildConnectedRoutes(ctx.state.devices[id]);
  logEvent(device, nowMs, "NOTICE", "errdisable", `Attempting to recover from ${e.cause} err-disable state on ${iface.name}`);
}

function dueAt(device: Device): number | undefined {
  let due: number | undefined;
  for (const e of Object.values(errdisabledPorts(device))) {
    if (!recoveryOn(device, e.cause)) continue;
    const t = e.since + recoveryInterval(device) * 1000;
    if (due === undefined || t < due) due = t;
  }
  return due;
}

registerDaemon({
  id: "errdisable",
  nextDue: (device) => dueAt(device),
  tick(ctx, device, now) {
    let changed = false;
    for (const [name, e] of Object.entries(errdisabledPorts(device))) {
      if (!recoveryOn(device, e.cause) || now < e.since + recoveryInterval(device) * 1000) continue;
      const iface = interfaceByName(device, name);
      if (iface) recoverPort(ctx, device, iface, now);
      changed = true;
    }
    return changed;
  },
});
