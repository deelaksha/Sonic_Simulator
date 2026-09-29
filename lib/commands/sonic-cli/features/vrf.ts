/**
 * VRF modal behaviour. Maps the real KLISH VRF config commands onto the tested
 * Click `config vrf ...` set, so no engine behaviour is duplicated.
 *
 * configure-view (grammar: vrf.xml):
 *   ip vrf <name>            create VRF          -> config vrf add <name>
 *   ip vrf mgmt              create mgmt VRF     -> config vrf add mgmt
 *   no ip vrf <name>         delete VRF          -> config vrf del <name>
 *   no ip vrf mgmt           delete mgmt VRF     -> config vrf del mgmt
 *
 * configure-if-view / -vlan-view / -lag-view (interface binding):
 *   ip vrf forwarding <name>       bind if -> config vrf member add <name> <if>
 *   no ip vrf forwarding <name>    unbind  -> config vrf member del <name> <if>
 *
 * The `head` here is always "ip"; the leading "no" is stripped by the engine and
 * surfaced via `isNo`. Anything that is not `ip vrf ...` returns null so other
 * handlers (e.g. interface `ip address`) and the grammar fallback still run.
 *
 * Skipped (Click has no equivalent): the `nht resolve-via-default` sub-option on
 * `ip vrf` / `no ip vrf`, and the entire `ipv6 vrf` / `no ipv6 vrf` family (those
 * exist only to toggle nht). Loopback / sub-interface / range if-views are not
 * reachable through this engine's interface modes, so only the physical, SVI and
 * LAG if-views are served.
 */
import { err, muted } from "../../types";
import { registerModal } from "../registry";

registerModal({
  id: "vrf",
  views: ["configure-view", "configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["ip"],
  run({ view, isNo, args, ifname, delegate }) {
    // Only handle `ip vrf ...`; let `ip address`/`ip route`/etc fall through.
    if (args[0]?.toLowerCase() !== "vrf") return null;

    if (view === "configure-view") {
      const name = args[1];
      if (!name) return { output: [err("% VRF name required.")] };
      // `ip vrf <name> nht resolve-via-default` has no Click equivalent.
      if (args[2]) {
        return { output: [muted(`(ip vrf ${name} ${args.slice(2).join(" ")}: nht resolve-via-default is not modelled in this lab)`)] };
      }
      return { output: delegate(`config vrf ${isNo ? "del" : "add"} ${name}`) };
    }

    // Interface views: `ip vrf forwarding <name>`.
    if (args[1]?.toLowerCase() !== "forwarding") return null;
    const vrfName = args[2];
    if (!vrfName) return { output: [err("% VRF name required.")] };
    return { output: delegate(`config vrf member ${isNo ? "del" : "add"} ${vrfName} ${ifname ?? ""}`) };
  },
});
