/**
 * ARP/ND modal behaviour. The Click arpnd module (lib/commands/sonic/arpnd.ts)
 * only exposes `config arp add <ip> <mac> <iface>` (static entry) and
 * `config arp clear` (wipe all), so the static-ARP entry command is the only
 * KLISH config command with a tested Click equivalent to delegate to.
 *
 * Wired (ipv4.xml, VIEW configure-if-view / configure-vlan-view /
 * configure-lag-view — the interface config modes the lab can enter):
 *   ip arp <A.B.C.D> <MAC>     add a static ARP entry on the current interface
 *       -> config arp add <ip> <mac> <iface>
 *
 * Deliberately NOT wired (no Click equivalent — see structured "skipped"):
 *   - no ip arp <ip> <mac>   : arpnd Click has no per-entry delete (only
 *                              `config arp clear`, which wipes everything), so
 *                              we don't fake it; it falls through.
 *   - configure-view globals (ip arp timeout, ip/ipv6 drop-neighbor aging-time,
 *     ip reserve local-neigh, {ip,ipv6} unreach-remote-neighbor-block) — no
 *     NEIGH_GLOBAL model / Click command.
 *   - ipv6 nd ... RA config (configure-if/vlan/lag) — FRR ND RA not modelled.
 */
import { err } from "../../types";
import { registerModal } from "../registry";

registerModal({
  id: "arpnd",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["ip"],
  run({ isNo, args, ifname, delegate }) {
    // Only claim "ip arp ..." (static ARP). Any other "ip ..." is not ours.
    if (args[0]?.toLowerCase() !== "arp") return null;
    // No per-entry ARP delete exists in the Click arpnd module — don't fake it.
    if (isNo) return null;
    const ip = args[1];
    const mac = args[2];
    if (!ip || !mac) return { output: [err("% Usage: ip arp <ip-address> <mac-address>")] };
    return { output: delegate(`config arp add ${ip} ${mac} ${ifname ?? ""}`) };
  },
});
