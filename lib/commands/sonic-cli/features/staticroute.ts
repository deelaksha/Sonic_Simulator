/**
 * Static-route modal behaviour. configure-view (KLISH route_static.xml):
 *   ip route <prefix> <next-hop-addr>          add an IPv4 static route (default VRF)
 *   no ip route <prefix> <next-hop-addr>       delete it
 * e.g. `ip route 100.1.1.0/24 192.168.200.1`.
 *
 * Delegates to the tested Click `config route add/del prefix <cidr> nexthop <ip>`
 * (lib/commands/sonic/staticroute.ts) so forwarding behaviour is not duplicated.
 *
 *   ipv6 route [vrf <name>] <prefix> <next-hop-addr>   (KLISH route_static.xml ipv6
 *                                              form) → the same Click command, IPv6 branch
 *
 * The single next-hop-ADDRESS form is wired, in the default VRF or with
 * `ip route vrf <name> <prefix> <next-hop>`. `blackhole`,
 * next-hop `interface`, and tag/weight/pref/track options have no Click
 * equivalent, so those fall through (return null).
 */
import { registerModal } from "../registry";
import { forgetTracked } from "../../../protocols/ipsla-daemon";
import { networkAddress } from "../../../models/ip";

registerModal({
  id: "staticroute",
  views: ["configure-view"],
  keywords: ["ip", "ipv6"],
  run({ head, isNo, args, ctx, delegate }) {
    if ((head !== "ip" && head !== "ipv6") || args[0]?.toLowerCase() !== "route") return null;
    // Tokens after "route". The Click form is exactly <prefix> <next-hop-addr>.
    let rest = args.slice(1);
    let vrf = "";
    let vrfName: string | undefined;
    if (rest[0]?.toLowerCase() === "vrf" && rest[1]) {
      vrfName = rest[1];
      vrf = `vrf ${rest[1]} `;
      rest = rest.slice(2);
    }
    if (rest.length !== 2) return null; // interface / tag / weight / pref / track: not modelled
    const [prefix, nexthop] = rest;
    if (!prefix.includes("/") || nexthop.toLowerCase() === "blackhole") return null; // blackhole: not modelled
    if ((head === "ipv6") !== prefix.includes(":")) return null; // family mismatch: grammar error
    if (isNo && head === "ip") {
      const [addr, len] = prefix.split("/");
      forgetTracked(ctx.device, networkAddress(addr, Number(len)), Number(len), nexthop, vrfName);
    }
    return { output: delegate(`config route ${isNo ? "del" : "add"} prefix ${vrf}${prefix} nexthop ${nexthop}`) };
  },
});
