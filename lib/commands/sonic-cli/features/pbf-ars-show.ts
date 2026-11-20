/**
 * KLISH `show pbf …` and `show ars …` (enable-view).
 *
 *   show pbf                                         flow_based_services.xml:467 — container (no ACTION)
 *   show pbf next-hop-group [<name> | type ip|ipv6]  :468-478 → show_pbf_next_hop_group.j2
 *   show pbf next-hop-group status                   :480 — container
 *   show pbf next-hop-group status interface <if> | Switch [...]   :481-510 → show_pbf_next_hop_group_status.j2
 *   show pbf replication-group [...] / status ...    :512-554 → show_pbf_replication_group*.j2
 *   show ars                                         ars.xml:2078 — container
 *   show ars profile|port-profile|object [<name>] | bind [profile|port-profile|object] |
 *        nhg-statistics [<id>] | port-quality [Ethernet <n>]     ars.xml:2079-2204 → show_ars_*.j2
 *
 * PBF next-hop / replication groups and ARS profiles/objects are entered as
 * sub-modes the simulator does not persist (no FBS group or ARS model), so the
 * switch has none: every one of these templates loops over an empty response (or
 * is guarded by `{% if '<container>' in json_output %}`) and prints nothing —
 * the real output of a switch without PBF groups / ARS configuration.
 */
import { registerModal } from "../registry";
import { ifArg, incomplete, noAction } from "./klish-show-util";

const empty = () => ({ output: [] });

registerModal({
  id: "pbf-ars-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args }) {
    const a = args.map((x) => x.toLowerCase());

    if (a[0] === "pbf") {
      if (a[1] !== "next-hop-group" && a[1] !== "replication-group") return a[1] === undefined ? noAction() : null;
      if (a[2] === "type" && a[3] !== "ip" && a[3] !== "ipv6") return incomplete();
      if (a[2] !== "status") return empty();
      if (a[3] === "switch") return empty();
      if (a[3] === "interface") return ifArg(args, 4) ? empty() : incomplete();
      return incomplete();
    }

    if (a[0] === "ars") {
      switch (a[1]) {
        case undefined:
          return noAction();
        case "profile":
        case "port-profile":
        case "object":
        case "nhg-statistics":
        case "port-quality":
          return empty();
        case "bind":
          return a[2] === undefined || ["profile", "port-profile", "object"].includes(a[2]) ? empty() : null;
        default:
          return null;
      }
    }
    return null;
  },
});
