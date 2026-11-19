/**
 * QoS bandwidth daemon: drives the flow-level model (./qos-model.ts) on wall
 * time. A device holding iperf3 flows (features["qos-flows"]) is due every
 * TICK_MS; its tick advances the WHOLE network's model to now (flows from
 * different senders share egress queues), so whichever sender ticks first does
 * the work and the others find nothing pending at the same instant.
 */
import { registerDaemon } from "../control/daemon";
import { peekFeatureState } from "../models/feature-state";
import { FlowStore, TICK_MS, accountTick } from "./qos-model";

registerDaemon({
  id: "qos",
  nextDue(device) {
    const st = peekFeatureState<FlowStore>(device, "qos-flows");
    if (!st?.flows.length) return undefined;
    return Math.min(...st.flows.map((f) => Math.max(f.startMs, f.lastMs) + TICK_MS));
  },
  tick(ctx, _device, nowMs) {
    return accountTick(ctx.state, nowMs);
  },
});
