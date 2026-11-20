/**
 * Link state tracking on the KLISH groups of features/link_track.ts
 * ("cp_link_track": `link state track <group>` + `timeout`, interfaces bound
 * with `link state track <group> upstream|downstream`; CONFIG_DB
 * LINK_STATE_TRACKING / INTF_TRACKING, sonic-yang-models
 * sonic-link-state-tracking.yang).
 *
 * When every upstream interface of a group is down, the group's downstream
 * interfaces are brought down so the hosts behind them fail over (their link
 * drops: oper down on both ends of the cable; the admin state and running
 * config are untouched). When an upstream comes back, the downstream ports are
 * restored after the group timeout — "Recovery timeout before downstream
 * interfaces are brought up", default 60 s, range 1-1800
 * (sonic-link-state-tracking.yang leaf timeout). Each transition is logged.
 *
 * `downstream all-evpn-es` adds every EVPN-MH Ethernet-segment PortChannel
 * (lib/protocols/evpn-mh.ts localEss) to the bound downstream interfaces.
 * Simulator choices: `threshold` and `downstream all-mclag` are stored but not
 * evaluated.
 */
import { registerDaemon } from "../control/daemon";
import { logEvent } from "../control/syslog";
import { cpList } from "../commands/sonic-cli/config-plane";
import { Device, findInterface, interfaceByName } from "../models/device";
import { NetInterface } from "../models/interface";
import { featureState, peekFeatureState } from "../models/feature-state";
import { getPeer, refreshLink } from "../models/topology";
import { rebuildConnectedRoutes } from "../models/factory";
import { SimContext } from "../engine/context";
import { lagConfigs } from "./lacp-daemon";
import { localEss } from "./evpn-mh";

export const DEFAULT_LST_TIMEOUT = 60; // sonic-link-state-tracking.yang

interface GroupCfg {
  name: string;
  timeout?: number;
  downstream?: string;
  upstreamIfs?: string[];
  downstreamIfs?: string[];
}

interface GroupOper {
  down: boolean;
  /** Upstream came back at this time; downstream restored after the timeout. */
  upSince?: number;
}

export interface LinkTrackState {
  groups: Record<string, GroupOper>;
}

export function peekLinkTrack(device: Device): LinkTrackState | undefined {
  return peekFeatureState<LinkTrackState>(device, "link-track");
}

const groups = (device: Device) => cpList(device, "link_track", "groups") as unknown as GroupCfg[];
const isUp = (i: NetInterface | undefined) => !!i && i.adminState === "up" && i.operState === "up";

function carrierDown(ctx: SimContext, device: Device, iface: NetInterface): void {
  iface.operState = "down";
  const peer = getPeer(ctx.state, device.id, iface.id);
  const peerDev = peer && ctx.state.devices[peer.endpoint.deviceId];
  const peerIf = peerDev && findInterface(peerDev, peer.endpoint.interfaceId);
  if (peerIf) {
    peerIf.operState = "down";
    rebuildConnectedRoutes(peerDev!);
  }
}

/** Ports whose carrier is dropped for a downstream interface: a PortChannel goes down through its members. */
function carrierPorts(device: Device, i: NetInterface): NetInterface[] {
  const lag = i.logical ? lagConfigs(device).find((c) => c.name === i.name) : undefined;
  if (!lag) return [i];
  return lag.members.map((n) => interfaceByName(device, n)).filter((m): m is NetInterface => !!m);
}

function tick(ctx: SimContext, device: Device, now: number): boolean {
  const st = featureState<LinkTrackState>(device, "link-track", () => ({ groups: {} }));
  let changed = false;
  for (const g of groups(device)) {
    const ups = (g.upstreamIfs ?? []).map((n) => interfaceByName(device, n));
    if (!ups.length) continue;
    // `downstream all-evpn-es`: every EVPN multihoming Ethernet-segment PortChannel is a
    // downstream interface, so the CE's LACP moves off a leaf that lost its fabric uplinks.
    const esIfs = g.downstream === "all-evpn-es" ? localEss(device).map((e) => e.ifname) : [];
    const downs = [...new Set([...(g.downstreamIfs ?? []), ...esIfs])].map((n) => interfaceByName(device, n)).filter((i): i is NetInterface => !!i);
    const op = (st.groups[g.name] ??= { down: false });
    const anyUp = ups.some(isUp);
    if (!anyUp && !op.down) {
      op.down = true;
      delete op.upSince;
      for (const d of downs.flatMap((i) => carrierPorts(device, i))) carrierDown(ctx, device, d);
      rebuildConnectedRoutes(device);
      logEvent(device, now, "NOTICE", "lstmgrd", `Link state tracking group ${g.name}: all upstream interfaces down, bringing down ${downs.map((d) => d.name).join(",") || "no"} downstream interfaces`);
      changed = true;
    } else if (op.down && anyUp) {
      if (op.upSince === undefined) {
        op.upSince = now;
        changed = true;
      }
      if (now >= op.upSince + (g.timeout ?? DEFAULT_LST_TIMEOUT) * 1000) {
        op.down = false;
        delete op.upSince;
        for (const d of downs.flatMap((i) => carrierPorts(device, i))) for (const id of refreshLink(ctx.state, device.id, d.id)) rebuildConnectedRoutes(ctx.state.devices[id]);
        logEvent(device, now, "NOTICE", "lstmgrd", `Link state tracking group ${g.name}: upstream up, bringing up ${downs.map((d) => d.name).join(",") || "no"} downstream interfaces`);
        changed = true;
      }
    } else if (op.down && op.upSince !== undefined) {
      delete op.upSince; // upstream failed again before the timeout
      changed = true;
    }
  }
  return changed;
}

/** Due when a group's upstream state disagrees with what was applied, or its recovery timer ends. */
function nextDue(device: Device, now: number): number | undefined {
  let due: number | undefined;
  const at = (t: number) => (due = due === undefined ? t : Math.min(due, t));
  for (const g of groups(device)) {
    const ups = (g.upstreamIfs ?? []).map((n) => interfaceByName(device, n));
    if (!ups.length) continue;
    const op = peekLinkTrack(device)?.groups[g.name] ?? { down: false };
    const anyUp = ups.some(isUp);
    if (!anyUp && (!op.down || op.upSince !== undefined)) at(now);
    else if (op.down && anyUp) at(op.upSince === undefined ? now : op.upSince + (g.timeout ?? DEFAULT_LST_TIMEOUT) * 1000);
  }
  return due;
}

registerDaemon({ id: "link-track", nextDue, tick });
