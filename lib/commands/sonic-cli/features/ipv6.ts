/**
 * IPv6 modal behaviour. The only KLISH IPv6 config command backed by a tested
 * Click command is the interface address assignment, present in every L3
 * interface sub-view (configure-if-view / configure-vlan-view / configure-lag-view):
 *   ipv6 address <X:X::X/M>      → config interface ipv6 add <ifname> <addr>
 *   no ipv6 address <X:X::X/M>   → config interface ipv6 del <ifname> <addr>
 * All other `ipv6 ...` forms in these views (enable, address autoconfig, nd-proxy,
 * neighbor, nd dad) have no Click backing yet, so we return null and let the core
 * grammar fallback report them as recognized-but-not-cloned. See the "skipped"
 * list in the task notes.
 */
import { registerModal } from "../registry";

registerModal({
  id: "ipv6",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["ipv6"],
  run({ isNo, args, ifname, delegate }) {
    // Only `ipv6 address <addr>` is backed by Click. `ipv6 address autoconfig`
    // is a distinct, unsupported command — fall through for both non-address
    // subcommands and the autoconfig keyword.
    if (args[0]?.toLowerCase() !== "address") return null;
    if (args[1]?.toLowerCase() === "autoconfig") return null;
    const name = ifname ?? "";
    return { output: delegate(`config interface ipv6 ${isNo ? "del" : "add"} ${name} ${args[1] ?? ""}`) };
  },
});
