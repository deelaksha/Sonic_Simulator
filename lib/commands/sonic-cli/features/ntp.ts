/**
 * NTP modal behaviour. configure-view (from data/device-capture/klish-xml/ntp.xml):
 *   ntp server <ip>                        add an NTP server
 *   no ntp server <ip>                     delete an NTP server
 *   ntp source-interface <type> <id>       set the NTP source interface
 *   no ntp source-interface [<type> <id>]  clear the NTP source interface
 *   ntp vrf <mgmt|default|name>            set the NTP VRF
 *   no ntp vrf                             clear the NTP VRF
 * Delegates to the tested Click `config ntp add/del/source-interface/vrf`.
 *
 * The real KLISH grammar also has `ntp authenticate`, `ntp authentication-key`,
 * `ntp trusted-key`, and the `ntp server ... key/minpoll/maxpoll/prefer` options,
 * for which the Click module has no equivalent — those fall through (return null)
 * so the grammar fallback reports them as recognized-but-not-cloned.
 */
import { err } from "../../types";
import { registerModal } from "../registry";

registerModal({
  id: "ntp",
  views: ["configure-view"],
  keywords: ["ntp"],
  run({ isNo, args, delegate }) {
    const sub = args[0]?.toLowerCase();

    if (sub === "server") {
      const addr = args[1];
      if (!addr) return { output: [err("% NTP server address required.")] };
      return { output: delegate(`config ntp ${isNo ? "del" : "add"} ${addr}`) };
    }

    if (sub === "source-interface") {
      if (isNo) return { output: delegate("config ntp source-interface del") };
      const iface = args.slice(1).join(" ");
      if (!iface) return { output: [err("% NTP source-interface requires an interface.")] };
      return { output: delegate(`config ntp source-interface ${iface}`) };
    }

    if (sub === "vrf") {
      if (isNo) return { output: delegate("config ntp vrf del") };
      const name = args[1];
      if (!name) return { output: [err("% NTP vrf requires a name.")] };
      return { output: delegate(`config ntp vrf ${name}`) };
    }

    // authenticate / authentication-key / trusted-key (and the server
    // key/minpoll/maxpoll/prefer options) have no Click equivalent — fall
    // through so the grammar fallback handles them.
    return null;
  },
});
