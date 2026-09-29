/**
 * Static-route modal behaviour. configure-view (KLISH route_static.xml):
 *   ip route <prefix> <next-hop-addr>          add an IPv4 static route (default VRF)
 *   no ip route <prefix> <next-hop-addr>       delete it
 * e.g. `ip route 100.1.1.0/24 192.168.200.1`.
 *
 * Delegates to the tested Click `config route add/del prefix <cidr> nexthop <ip>`
 * (lib/commands/sonic/staticroute.ts) so forwarding behaviour is not duplicated.
 *
 * Only the default-VRF, single next-hop-ADDRESS form is wired — that is all the
 * Click module supports. The grammar's `ip route vrf ...`, `ip route vrf mgmt`,
 * `ipv6 route ...`, `blackhole`, next-hop `interface`, and tag/weight/pref/track
 * options have no Click equivalent, so those fall through (return null).
 */
import { registerModal } from "../registry";

registerModal({
  id: "staticroute",
  views: ["configure-view"],
  keywords: ["ip"],
  run({ head, isNo, args, delegate }) {
    if (head !== "ip" || args[0]?.toLowerCase() !== "route") return null;
    // Tokens after "route". The Click form is exactly <prefix> <next-hop-addr>.
    const rest = args.slice(1);
    if (rest.length !== 2) return null; // vrf / interface / tag / weight / pref / track: not modelled
    const [prefix, nexthop] = rest;
    if (!prefix.includes("/") || nexthop.toLowerCase() === "blackhole") return null; // blackhole: not modelled
    return { output: delegate(`config route ${isNo ? "del" : "add"} prefix ${prefix} nexthop ${nexthop}`) };
  },
});
