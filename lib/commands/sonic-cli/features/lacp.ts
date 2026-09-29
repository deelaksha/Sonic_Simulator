/**
 * LACP / PortChannel modal behaviour. PortChannel MEMBERSHIP is configured from
 * the physical interface view (configure-if-view), matching real KLISH:
 *
 *   sonic(config-if-Ethernet0)# channel-group <id>   -> join PortChannel<id>
 *   sonic(config-if-Ethernet0)# no channel-group     -> leave its PortChannel
 *
 * Delegates to the tested Click `config portchannel member add/del`; behaviour and
 * output are not duplicated or faked. `no channel-group` carries no id in KLISH, so
 * the owning PortChannel is looked up from the stored feature state.
 *
 * NOT wired here (see the structured "skipped"/"notes"):
 *  - `interface PortChannel <id>` / `no interface PortChannel <id>` (create/delete +
 *    the configure-lag-view sub-mode with min-links/fallback). The core engine owns
 *    the `interface` keyword in configure-view and rejects `interface PortChannel N`
 *    because a PortChannel is never in device.interfaces, so configure-lag-view is
 *    unreachable via a modal handler. PortChannels are created via Click
 *    `config portchannel add`, and the Click module exposes no post-create min-links/
 *    fallback update path.
 *  - `portchannel graceful-shutdown` (configure-view) — no Click support.
 */
import { err } from "../../types";
import { registerModal } from "../registry";
import { peekFeatureState } from "../../../models/feature-state";

interface LacpState {
  portchannels: { name: string; members: string[] }[];
}

registerModal({
  id: "lacp",
  views: ["configure-if-view"],
  keywords: ["channel-group"],
  run({ ctx, ifname, isNo, args, delegate }) {
    const iface = ifname ?? "";
    if (isNo) {
      const owner = peekFeatureState<LacpState>(ctx.device, "lacp")?.portchannels.find((p) => p.members.includes(iface));
      if (!owner) return { output: [err(`% ${iface} is not a member of any PortChannel.`)] };
      return { output: delegate(`config portchannel member del ${owner.name} ${iface}`) };
    }
    const id = args[0];
    if (!id) return { output: [err("% PortChannel number required.")] };
    return { output: delegate(`config portchannel member add PortChannel${id} ${iface}`) };
  },
});
