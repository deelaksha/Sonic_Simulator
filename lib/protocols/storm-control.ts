/**
 * Storm control (BUM rate limiting) — orchagent PolicerOrch::handlePortStorm
 * ControlTable (sonic-swss orchagent/policerorch.cpp:175-340) on the
 * PORT_STORM_CONTROL rows "<port>|<storm_type>" {kbps} that KLISH
 * `storm-control` (features/storm_control.ts) and Click `config interface
 * storm-control add` (commands/sonic/storm-control.ts) store in "cp_storm_control".
 *
 * Per port and type orchagent creates a policer "_<port>_<type>" (:199-200):
 * meter type BYTES (:210-213), mode STORM_CONTROL (:215-218), red action DROP
 * (:220-223), CIR = kbps * 1000 / 8 bytes/s (:231-238), bound with
 *   broadcast          SAI_PORT_ATTR_BROADCAST_STORM_CONTROL_POLICER_ID (:258-260)
 *   unknown-unicast    SAI_PORT_ATTR_FLOOD_STORM_CONTROL_POLICER_ID     (:262-264)
 *   unknown-multicast  SAI_PORT_ATTR_MULTICAST_STORM_CONTROL_POLICER_ID (:266-268)
 * so it meters frames ENTERING the port. Here each policer is a token bucket
 * (bytes) refilled at CIR on the wall clock; a frame that finds too
 * few tokens is dropped on ingress (engine FRAME_DROPPED → drop reason
 * STORM_CONTROL in lib/control/drops.ts) and counted per port/type.
 *
 * Simulator choices: SONiC programs no CBS (only CIR is set), so the bucket
 * depth is max(CIR x 100 ms, 1522 bytes); "unknown" multicast = every
 * non-broadcast group address (no L2 multicast table is modelled); unknown
 * unicast = a destination MAC not in the FDB for the frame's VLAN and not the
 * switch's own.
 */
import { registerDataPlaneHook } from "../control/hooks";
import { cpList } from "../commands/sonic-cli/config-plane";
import { Device, isSwitch } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { isBroadcast, isMulticast, normalizeMac } from "../models/mac";

export type StormType = "broadcast" | "unknown-unicast" | "unknown-multicast";

interface Bucket {
  tokens: number;
  last: number;
}

export interface StormState {
  buckets: Record<string, Bucket>;
  /** "<port>|<type>" → frames dropped by that policer. */
  drops: Record<string, number>;
}

const MIN_CBS = 1522;

export function peekStormState(device: Device): StormState | undefined {
  return peekFeatureState<StormState>(device, "storm-control");
}

/** Configured CIR (kbps) of one port/type, or undefined. */
function rateKbps(device: Device, port: string, type: StormType): number | undefined {
  const e = cpList(device, "storm_control", "ports").find((x) => x.iface === port && x.type === type);
  return e ? Number(e.kbps) : undefined;
}

/** Which storm policer a frame entering `iface` is metered by (undefined = none). */
export function stormTypeOf(device: Device, iface: NetInterface, frame: Frame): StormType | undefined {
  const dst = frame.ethernet.dstMac;
  if (isBroadcast(dst)) return "broadcast";
  if (isMulticast(dst)) return "unknown-multicast";
  const mac = normalizeMac(dst);
  if (device.interfaces.some((i) => normalizeMac(i.mac) === mac)) return undefined;
  const vid = frame.vlan?.vlanId ?? (iface.vlan.mode === "access" ? iface.vlan.accessVlan : iface.vlan.nativeVlan);
  return device.macTable.some((e) => normalizeMac(e.mac) === mac && e.vlan === vid) ? undefined : "unknown-unicast";
}

registerDataPlaneHook({
  id: "storm-control",
  portIngress(ctx, device, iface, frame) {
    if (!isSwitch(device.type) || iface.management || !device.config.features?.cp_storm_control) return true;
    const type = stormTypeOf(device, iface, frame);
    const kbps = type && rateKbps(device, iface.name, type);
    if (kbps === undefined || !type) return true;
    const cir = (kbps * 1000) / 8; // bytes/s (policerorch.cpp:236)
    const cbs = Math.max(cir / 10, MIN_CBS);
    const st = featureState<StormState>(device, "storm-control", () => ({ buckets: {}, drops: {} }));
    const key = `${iface.name}|${type}`;
    // Metered on the wall-clock instant the traffic was injected (the run's base):
    // the per-hop latency the engine adds while one run recurses is not an
    // inter-packet gap.
    const now = ctx.wallNow() - ctx.now();
    const b = (st.buckets[key] ??= { tokens: cbs, last: now });
    b.tokens = Math.min(cbs, b.tokens + (Math.max(0, now - b.last) * cir) / 1000);
    b.last = now;
    if (b.tokens >= frame.meta.sizeBytes) {
      b.tokens -= frame.meta.sizeBytes;
      return true;
    }
    st.drops[key] = (st.drops[key] ?? 0) + 1;
    return false;
  },
});
