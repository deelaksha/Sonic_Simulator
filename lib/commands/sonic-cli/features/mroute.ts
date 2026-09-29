/**
 * mroute — CONFIG-PLANE (show-only) SONiC feature.
 *
 *   sonic# show ip mroute [vrf {<vrf-name> | all}]
 *   sonic# show ip mroute [vrf {<vrf-name> | all}] summary
 *
 * The real box's `mroute` module (data/device-capture/klish-xml/mroute.xml) is
 * show/clear only: it has NO configure-view / configure-if-view / sub-view config
 * commands. The IP multicast routing table is RUNTIME state populated by the
 * multicast routing data-plane (PIM/IGMP), which this simulator does not model —
 * so we never fabricate routes, neighbours or uptimes. We render the real table
 * FORMAT with the honest, empty set of routes read from the config-plane store
 * (which no config command populates on this box).
 *
 * `clear ip mroute` is an operational reset and is not wired here: the core
 * sonic-cli routes only `show` to modal handlers, and editing the core is out of
 * scope for a single feature file.
 */
import { line, err } from "../../types";
import { registerModal } from "../registry";
import { cpList } from "../config-plane";

type Mroute = { source: string; group: string; input: string; output: string; uptime: string };

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

    // No multicast data-plane in the sim => the store is empty (no config command
    // populates it, and runtime routes are never fabricated).
    const routes = cpList(ctx.device, "mroute", "routes") as Mroute[];

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
      out.push(
        line(`* ${r.source.padEnd(16)}${r.group.padEnd(16)}${r.input.padEnd(14)}${r.output.padEnd(14)}${r.uptime}`),
      );
    }
    return { output: out };
  },
});
