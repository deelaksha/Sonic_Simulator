/**
 * KLISH `show Vlan` (enable_mode.xml:34-42: `show <vlan-if-name>|Vlan [count]`,
 * ACTION sonic_cli_vlan get_sonic_vlan_sonic_vlan … show_vlan.j2).
 *
 *   show Vlan              every VLAN, one row per member
 *   show Vlan <id>         one VLAN ("Vlan 10" / "Vlan10"); "VLAN Vlan<id> not found"
 *   show Vlan count        "Total Number of Vlan Configured :N" + id ranges
 *
 * Layout: real device capture (mc-lag/…/01_Pre-Test_Snapshot/snapshot_SW1.txt:75-81):
 *   Q: A - Access (Untagged), T - Tagged
 *   NUM       Status      Q Ports
 *   ------------------------------------------
 *   Vlan100   Up          T  PortChannel10
 * Members/status follow sonic_cli_vlan.py:585-692 (Ethernet/PortChannel access →
 * A, trunk → T; status Up when the VLAN has members, else the SVI oper state).
 * The count form follows show_vlan.j2:3-7 + format_vlan_ranges (sonic_cli_vlan.py:74).
 */
import { OutputLine, line } from "../../types";
import { registerModal } from "../registry";
import { Device, interfaceByName } from "../../../models/device";
import { listVlans, vlanMembers } from "../../../models/vlan-ops";
import { natCompare } from "../../sonic/counters";

/** format_vlan_ranges: [1,2,3,5] → "1 to 3 5". */
function vlanRanges(ids: number[]): string {
  const s = [...ids].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? String(s[i]) : `${s[i]} to ${s[j]}`);
    i = j + 1;
  }
  return out.join(" ");
}

function members(d: Device, id: number) {
  return vlanMembers(d, id)
    .filter((m) => /^(Ethernet|PortChannel)\d+$/.test(m.port))
    .sort((a, b) => natCompare(a.port, b.port));
}

export function renderShowVlan(d: Device, only?: number): OutputLine[] {
  let vlans = listVlans(d).slice().sort((a, b) => a.id - b.id);
  if (only !== undefined) {
    vlans = vlans.filter((v) => v.id === only);
    if (!vlans.length) return [line(`VLAN Vlan${only} not found`)];
  } else if (!vlans.length) return [line("No VLANs configured")];
  const out: OutputLine[] = [
    line("Q: A - Access (Untagged), T - Tagged"),
    line("NUM".padEnd(10) + "Status".padEnd(12) + "Q Ports".padEnd(20)),
    line("-".repeat(42)),
  ];
  for (const v of vlans) {
    const ms = members(d, v.id);
    const svi = interfaceByName(d, `Vlan${v.id}`);
    const status = ms.length || svi?.operState === "up" ? "Up" : "Down";
    const name = `Vlan${v.id}`.padEnd(10) + status.padEnd(12);
    if (!ms.length) out.push(line(name + "".padEnd(20)));
    for (const m of ms) out.push(line(`${name}${m.tagged ? "T" : "A"}  ${m.port.padEnd(17)}`));
  }
  return out;
}

registerModal({
  id: "vlan-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const m = /^vlan(\d*)$/i.exec(args[0] ?? "");
    // KLISH keyword is "Vlan" (capital V); lower-case `show vlan` stays with the Click layer.
    if (!m || !args[0].startsWith("V")) return null;
    const rest = args.slice(1);
    if (!m[1] && rest[0]?.toLowerCase() === "count" && rest.length === 1) {
      const ids = listVlans(ctx.device).map((v) => v.id);
      const out = [line(`Total Number of Vlan Configured :${ids.length}`)];
      if (ids.length) out.push(line(`VLANs Configured :${vlanRanges(ids)}`));
      return { output: out };
    }
    const idTok = m[1] || rest[0];
    if (idTok === undefined) return { output: renderShowVlan(ctx.device) };
    if (!/^\d+$/.test(idTok) || rest.length > (m[1] ? 0 : 1)) return null;
    return { output: renderShowVlan(ctx.device, Number(idTok)) };
  },
});
