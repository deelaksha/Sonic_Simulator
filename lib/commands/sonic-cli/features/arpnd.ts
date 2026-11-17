/**
 * ARP/ND modal (KLISH) behaviour. Sources: sonic-mgmt-framework/CLI
 * clitree/cli-xml/ipv4.xml, clitree/cli-xml/interface.xml:1120-1146,
 * actioner/sonic-cli-neigh.py, renderer/templates/show_arp.j2.
 *
 * configure-if/vlan/lag-view:
 *   ip arp <A.B.C.D> <MAC>       static (PERMANENT) entry → config arp add <ip> <mac> <iface>
 *   ip arp timeout <25-65535>    per-interface ARP aging = base_reachable_time
 *   no ip arp timeout            back to the system default (interface.xml:1123-1146,
 *                                sonic-swss cfgmgr/intfmgr.cpp:678-720)
 *   no ip arp <ip> <mac>         not wired: the Click module has no per-entry delete.
 * enable-view:
 *   show ip arp [<ip> | mac-address <mac>]       show_arp.j2 over the live table
 *   show ip arp interface <type> <id>            (eth0 is shown as Management0,
 *                                                 sonic-cli-neigh.py:134-137)
 *   clear ip arp [<ip>]                          flush dynamic entries, statics stay
 *   clear ip arp interface <type> <id>           (ipv4.xml:205-243; message from
 *                                                 sonic-cli-neigh.py:552)
 *   `show` reaches enable-view handlers today; exec-mode `clear` needs the core
 *   dispatcher to consult enable-view handlers for "clear" (see report).
 */
import { err, line } from "../../types";
import { registerModal } from "../registry";
import { featureState } from "../../../models/feature-state";
import { ArpRuntime, ARP_RT, deleteArp, isPermanent } from "../../../protocols/arp";
import { flushDynamicArp, nativeIf, renderShowIpArp } from "../../sonic/arpnd";

const TIMEOUT = { min: 25, max: 65535 }; // ptype RANGE_25_65535 (interface.xml:1137)

registerModal({
  id: "arpnd",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view"],
  keywords: ["ip"],
  run({ ctx, isNo, args, ifname, delegate }) {
    // Only claim "ip arp ..." (static ARP / timeout). Any other "ip ..." is not ours.
    if (args[0]?.toLowerCase() !== "arp") return null;
    if (args[1]?.toLowerCase() === "timeout") {
      const rt = featureState<ArpRuntime>(ctx.device, ARP_RT, () => ({ nb: {}, ifs: {}, timeouts: {} }));
      rt.timeouts ??= {};
      if (!ifname) return { output: [err("% Error: interface context required")] };
      if (isNo) {
        delete rt.timeouts[ifname];
        return { output: [] };
      }
      const tok = args[2];
      const n = tok && /^\d+$/.test(tok) ? Number(tok) : NaN;
      if (!(n >= TIMEOUT.min && n <= TIMEOUT.max)) return { output: [err("% Error: Invalid input detected")] };
      rt.timeouts[ifname] = n;
      return { output: [] };
    }
    // No per-entry ARP delete exists in the Click arpnd module — don't fake it.
    if (isNo) return null;
    const ip = args[1];
    const mac = args[2];
    if (!ip || !mac) return { output: [err("% Usage: ip arp <ip-address> <mac-address>")] };
    return { output: delegate(`config arp add ${ip} ${mac} ${ifname ?? ""}`) };
  },
});

registerModal({
  id: "arpnd-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ ctx, args }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "arp") return null;
    if (args.slice(2).some((a) => /^(summary|vrf)$/i.test(a))) return null; // not modelled
    return { output: renderShowIpArp(ctx, args.slice(2)) };
  },
});

registerModal({
  id: "arpnd-clear",
  views: ["enable-view"],
  keywords: ["clear"],
  run({ ctx, args }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "arp") return null;
    const rest = args.slice(2);
    if (rest[0]?.toLowerCase() === "interface") {
      const ifn = nativeIf(rest.slice(1, 3));
      if (!ifn) return { output: [err("% Error: Invalid interface")] };
      flushDynamicArp(ctx.device, ifn);
    } else if (rest[0]) {
      if (rest[0].toLowerCase() === "vrf") return null; // VRFs not modelled
      if (!isPermanent(ctx.device, rest[0])) deleteArp(ctx.device, rest[0]);
    } else {
      flushDynamicArp(ctx.device);
    }
    return { output: [line("Dynamic ipv4 neighbors cleared successfully")] };
  },
});
