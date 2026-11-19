/**
 * KLISH `show ip vrf [<vrf-name>]` (enable-view, data/device-capture/klish-xml/vrf.xml:12-40;
 * vrf-name defaults to "all"). Rendered with sonic-mgmt-framework
 * CLI/renderer/templates/show_vrf.j2: "VRF          Interfaces" header, then
 * "%-12s %s" for the first interface of each VRF and 13-space indented
 * continuation lines; "No VRFs configured" when nothing matches.
 * Reads the same VRF membership the Click `show vrf` uses (lib/commands/sonic/vrf.ts).
 */
import { line } from "../../types";
import { registerModal } from "../registry";
import { peekFeatureState } from "../../../models/feature-state";

interface VrfState {
  vrfs: { name: string; interfaces: string[] }[];
}

registerModal({
  id: "vrf-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "vrf") return null;
    const name = args[2] && args[2] !== "all" ? args[2] : undefined;
    const vrfs = (peekFeatureState<VrfState>(ctx.device, "vrf")?.vrfs ?? []).filter((v) => !name || v.name === name);
    if (!vrfs.length) return { output: [line("No VRFs configured")] };
    const rows = ["VRF          Interfaces", "--------     ------------"];
    for (const v of vrfs) {
      if (!v.interfaces.length) rows.push(v.name);
      v.interfaces.forEach((i, n) => rows.push(n === 0 ? `${v.name.padEnd(12)} ${i}` : `             ${i}`));
    }
    return { output: rows.map((r) => line(r)) };
  },
});
