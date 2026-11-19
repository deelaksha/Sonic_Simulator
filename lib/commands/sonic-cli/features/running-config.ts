/**
 * KLISH `show running-configuration [<feature> ...]` (enable_mode.xml:44 →
 * sonic_cli_show_config.py show_all_config; per-feature forms from each
 * feature's cli-xml, e.g. bgp.xml:20, ospf.xml:5629, vrf.xml:59, nat.xml:147,
 * mclag.xml:384, interface.xml:103).
 *
 * Rendering lives in ../running-config/: every feature registers a section
 * (global blocks + per-interface lines) and this handler composes them.
 * Per-feature forms that a feature module already serves (sflow, snmp, pim,
 * igmp, spanning-tree, subinterface, evpn-mh, hardware) are registered earlier
 * and win; this handler is imported last.
 */
import { line } from "../../types";
import { registerModal } from "../registry";
import "../running-config/core";
import "../running-config/sections";
import { renderAll, renderSection, sectionFor, interfaceBlocks, joinBlocks, klishIfName } from "../running-config/render";
import { routeMapBlocks } from "../running-config/core";

registerModal({
  id: "running-config-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a0 = args[0]?.toLowerCase();
    if (a0 !== "running-configuration" && a0 !== "running-config") return null;
    const pipe = args.indexOf("|");
    const tokens = args.slice(1, pipe > 0 ? pipe : undefined);
    const kw = tokens.map((t) => t.toLowerCase());
    const dev = ctx.device;
    const out = (ls: string[]) => ({ output: ls.map((t) => line(t)) });
    if (!kw.length) return out(renderAll(dev));

    const hit = sectionFor(kw);
    if (hit) {
      // route-map [<name> [<seq>]] (routemap.xml:21)
      if (hit.section.id === "route-map" && hit.rest.length) return out(joinBlocks(routeMapBlocks(dev, tokens[1], tokens[2] ? Number(tokens[2]) : undefined)));
      return out(renderSection(dev, hit.section));
    }
    // interface [<type> [<id>]] (interface.xml:103-136): full interface blocks.
    if (kw[0] === "interface") {
      const want = tokens.slice(1).join("");
      const match = (n: string) => !want || n.toLowerCase() === want.toLowerCase() || (!/\d/.test(want) && n.toLowerCase().startsWith(want.toLowerCase()));
      return out(joinBlocks(interfaceBlocks(dev, undefined, (i) => match(klishIfName(i)))));
    }
    return null;
  },
});
