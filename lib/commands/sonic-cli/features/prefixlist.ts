/**
 * Prefix-list modal behaviour. configure-view (KLISH ip_prefix.xml):
 *   ip prefix-list <name> seq <n> permit|deny <cidr> [ge <x>] [le <y>]        add an IPv4 entry
 *   no ip prefix-list <name> [seq <n> permit|deny <cidr> [ge <x>] [le <y>]]   delete one entry / whole list
 * e.g. `ip prefix-list AGTPL4 seq 5 permit 10.0.0.0/8 ge 24 le 28`.
 *
 * Delegates to the tested Click `config [no] ip prefix-list ...`
 * (lib/commands/sonic/prefixlist.ts), which owns ALL validation (seq mandatory,
 * ge/le 0..32, len<=ge<=le, same-seq conflict) and CONFIG_DB state — nothing is
 * duplicated or re-validated here.
 *
 * `[no] ipv6 prefix-list ...` (same grammar, IPv6 prefixes) delegates to the Click
 * `config [no] ipv6 prefix-list ...`; BGP IPv6 unicast policy reads those lists.
 */
import { registerModal } from "../registry";

registerModal({
  id: "prefixlist",
  views: ["configure-view"],
  keywords: ["ip", "ipv6"],
  run({ head, isNo, args, delegate }) {
    // Only claim `[no] ip|ipv6 prefix-list ...`; other `ip ...` commands are not ours.
    if (args[0]?.toLowerCase() !== "prefix-list") return null;
    // args already carry `prefix-list <name> seq ...`; rebuild the exact Click line
    // and let the Click module validate + mutate the simulated CONFIG_DB.
    return { output: delegate(`config ${isNo ? "no " : ""}${head} ${args.join(" ")}`) };
  },
});
