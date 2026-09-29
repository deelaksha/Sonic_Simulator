/**
 * DHCP relay modal behaviour. configure-if-view / configure-lag-view /
 * configure-vlan-view:
 *   ip dhcp-relay <server-ip> [<server-ip> ...]      add helper (server) address(es)
 *   no ip dhcp-relay <server-ip> [<server-ip> ...]   remove helper address(es)
 *
 * Delegates to the tested Click `config dhcp-relay add/del <iface> <ip>` so the
 * per-interface helper-address state is not duplicated.
 *
 * SCOPE: the Click module (lib/commands/sonic/dhcp.ts) only models IPv4 helper
 * (server) addresses. The other real KLISH `ip dhcp-relay ...` suboptions
 * (source-interface, link-select, max-hop-count, vrf-select, policy-action,
 * circuit-id, smart-relay) and the whole `ipv6 dhcp-relay ...` family have no
 * Click equivalent, so this handler returns null for them and lets the grammar
 * fallback report them as recognized-but-not-cloned. A `vrf <name>` suboption on
 * the address form is likewise not modelled and is ignored.
 */
import { err } from "../../types";
import { registerModal } from "../registry";

/** `ip dhcp-relay` suboptions the Click module does not model (skip → fall through). */
const UNSUPPORTED_SUBCMDS = new Set([
  "source-interface",
  "link-select",
  "max-hop-count",
  "vrf-select",
  "policy-action",
  "circuit-id",
  "smart-relay",
]);

registerModal({
  id: "dhcp",
  views: ["configure-if-view", "configure-lag-view", "configure-vlan-view"],
  keywords: ["ip"],
  run({ isNo, args, ifname, delegate }) {
    // Only the `ip dhcp-relay ...` family is ours; `ip address ...` etc. are not.
    if ((args[0] ?? "").toLowerCase() !== "dhcp-relay") return null;

    const rest = args.slice(1);
    // Non-address suboptions have no Click equivalent — let the grammar fallback
    // report them honestly rather than fabricating behaviour.
    if (UNSUPPORTED_SUBCMDS.has((rest[0] ?? "").toLowerCase())) return null;

    // Collect helper (server) addresses, ignoring an optional `vrf <name>`.
    const ips: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].toLowerCase() === "vrf") {
        i++; // skip the VRF name too (not modelled by Click)
        continue;
      }
      ips.push(rest[i]);
    }

    // Bare `no ip dhcp-relay` (clear all) is not expressible via Click — fall through.
    if (ips.length === 0) {
      if (isNo) return null;
      return { output: [err("% DHCP relay server address required.")] };
    }

    const name = ifname ?? "";
    const output = ips.flatMap((ip) => delegate(`config dhcp-relay ${isNo ? "del" : "add"} ${name} ${ip}`));
    return { output };
  },
});
