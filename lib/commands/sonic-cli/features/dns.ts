/**
 * DNS modal behaviour. configure-view (KLISH `ip name-server`):
 *   ip name-server <ip> [vrf mgmt]     add a DNS nameserver
 *   no ip name-server <ip>             delete a DNS nameserver
 * Delegates to the tested Click `config dns nameserver add/del` so the resolver
 * config state (CONFIG_DB DNS_SERVER list) is not duplicated here.
 *
 * The `source-interface` variants (`[no] ip name-server source-interface ...`)
 * have NO Click equivalent, so this handler returns null for them and lets the
 * grammar-aware fallback report them as recognized-but-not-cloned.
 */
import { err, muted } from "../../types";
import { registerModal } from "../registry";

registerModal({
  id: "dns",
  views: ["configure-view"],
  keywords: ["ip"],
  run({ isNo, args, delegate }) {
    // Only claim `ip name-server ...`; anything else on `ip` is not ours.
    if (args[0]?.toLowerCase() !== "name-server") return null;

    const sub = args[1];
    // `[no] ip name-server source-interface ...` — no Click equivalent; fall through.
    if (sub?.toLowerCase() === "source-interface") return null;

    if (!sub) return { output: [err("% DNS nameserver IP address required.")] };

    const out = delegate(`config dns nameserver ${isNo ? "del" : "add"} ${sub}`);
    // `vrf mgmt` is accepted by real KLISH but the resolver VRF is not modelled.
    if (!isNo && args[2]?.toLowerCase() === "vrf") out.push(muted("(nameserver vrf is not modelled yet)"));
    return { output: out };
  },
});
