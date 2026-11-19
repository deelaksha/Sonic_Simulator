/**
 * mroute — SONiC `show ip mroute` (KLISH), rendered from the running multicast
 * routing state (lib/protocols/pim-daemon.ts via lib/protocols/mcast-show.ts):
 *
 *   sonic# show ip mroute [vrf {<vrf-name> | all}] [<grp-addr> [<src-addr>]]
 *   sonic# show ip mroute [vrf {<vrf-name> | all}] summary
 *
 * Layout from data/device-capture/klish-xml/mroute.xml (EXAMPLE): one row per
 * installed (S,G) route, extra outgoing interfaces on continuation lines; the
 * summary counts (S, G) routes installed/total. Multicast routing runs in the
 * default VRF only, so other VRFs show an empty table.
 *
 * `clear ip mroute` is an operational reset and is not wired here: the core
 * sonic-cli routes only `show` to modal handlers.
 */
import { line, err } from "../../types";
import { registerModal } from "../registry";
import { klishMrouteRows } from "../../../protocols/mcast-show";

// Column header verbatim from the real `show ip mroute` output (mroute.xml EXAMPLE).
const COLS = "  Source          Group           Input         Output        Uptime";

registerModal({
  id: "mroute-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "mroute") return null; // not ours

    // [vrf {<vrf-name> | all}]
    let rest = args.slice(2);
    let vrf = "default";
    if (rest[0]?.toLowerCase() === "vrf") {
      if (!rest[1]) return { output: [err("% VRF name required.")] };
      vrf = rest[1];
      rest = rest.slice(2);
    }
    const summary = rest.some((t) => t.toLowerCase() === "summary");
    const [grp, src] = rest.filter((t) => /^\d{1,3}(\.\d{1,3}){3}$/.test(t));
    const routes = vrf === "default" || vrf === "all"
      ? klishMrouteRows(ctx.device, Date.now()).filter((r) => (!grp || r.group === grp) && (!src || src === "0.0.0.0" || r.source === src))
      : [];

    if (summary) {
      const n = routes.length;
      return {
        output: [
          line(`IP multicast routing table summary for VRF: ${vrf}`),
          line("Mroute Type      Installed/Total"),
          line(`(S, G)           ${n}/${n}`),
        ],
      };
    }

    const out = [
      line(`IP multicast routing table for VRF: ${vrf}`),
      line("* -> indicates installed route"),
      line(""),
      line(COLS),
    ];
    for (const r of routes) {
      r.outputs.forEach((o, i) =>
        out.push(line(i === 0 ? `* ${r.source.padEnd(16)}${r.group.padEnd(16)}${r.input.padEnd(14)}${o.padEnd(14)}${r.uptime}` : `${" ".repeat(48)}${o.padEnd(14)}${r.uptime}`)),
      );
    }
    return { output: out };
  },
});
