/**
 * KLISH `show dcbx statistics [interface <if>]` (enable-view).
 *
 *   show dcbx statistics [interface Ethernet <n>]   dcbx.xml:46-50 → show_dcbx_stats.j2
 *       (sonic_cli_dcbx get_openconfig_dcbx_dcbx_interfaces): one "DCBX Statistics" block per
 *       Ethernet port. The simulator's LLDP agent carries no DCBX TLVs, so every PFC / ETS
 *       TLV counter is 0 — what a port that has exchanged no DCBX TLVs reports.
 */
import { CommandContext, err } from "../../types";
import { registerModal } from "../registry";
import { ifArg, incomplete, lines, natCmp } from "./klish-show-util";

function statsBlock(ifname: string): string[] {
  const rows: [string, string][] = [
    ["Interface", ifname],
    ["Transmitted PFC", "0"], ["Received PFC", "0"], ["Err transmitted PFC", "0"], ["Err received PFC", "0"],
    ["Last PFC transmitted", "0 sec"], ["Last PFC received", "0 sec"],
    ["Transmitted ETS conf", "0"], ["Received ETS conf", "0 "], ["Err transmitted ETS conf", "0"], ["Err received ETS conf", "0"],
    ["Last ETS Conf transmitted", "0 sec"], ["Last ETS Conf received", "0 sec"],
    ["Transmitted ETS reco", "0"], ["Received ETS reco", "0"], ["Err transmitted ETS reco", "0"], ["Err received ETS reco", "0"],
    ["Last ETS Reco transmitted", "0 sec"], ["Last ETS Reco received", "0 sec"],
  ];
  return ["DCBX Statistics", "-".repeat(63), ...rows.map(([k, v]) => `${k.padEnd(31)}: ${v}`), " "];
}

const ethPorts = (ctx: CommandContext) =>
  ctx.device.interfaces.filter((i) => !i.management && !i.logical && /^Eth/.test(i.name)).map((i) => i.name).sort(natCmp);

registerModal({
  id: "dcbx-stats-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] !== "dcbx" || a[1] !== "statistics") return null;
    let ports = ethPorts(ctx);
    if (a[2] === "interface") {
      const p = ifArg(args, 3);
      if (!p) return incomplete();
      ports = ports.filter((n) => n.toLowerCase() === p.name.toLowerCase());
      if (!ports.length) return { output: [err(`%Error: Interface ${p.name} not found`)] };
    }
    return lines(ports.flatMap(statsBlock));
  },
});
