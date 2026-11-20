/**
 * KLISH `show spanning-tree` sub-displays (stp.xml:81-215) that the base stp-show
 * handler leaves to us:
 *
 *   show spanning-tree counters [Vlan <id>]        per-port BPDU Tx/Rx (stp-daemon counters)
 *   show spanning-tree bpdu-guard                  ports with `spanning-tree bpduguard`
 *   show spanning-tree inconsistentports [Vlan N]  root/loop-guard blocked ports
 *   show spanning-tree mst [...]                   MST views (mode must be mst)
 *
 * Layouts follow the PVST show templates of sonic-utilities (statistics, bpdu_guard,
 * root_guard) that the KLISH show_stp_*.j2 renderers mirror; the renderers themselves
 * are not in the source tree. The lab runs one RSTP instance, so per-VLAN tables list
 * the VLAN's member ports of that instance and no port is ever guard-inconsistent.
 */
import { OutputLine, line, err } from "../../types";
import { registerModal, runModalHandlers } from "../registry";
import { cpGet, cpList } from "../config-plane";
import { Device } from "../../../models/device";
import { listVlans, vlanMembers } from "../../../models/vlan-ops";
import { natCompare } from "../../sonic/counters";
import { stpCounters } from "../../../protocols/stp-daemon";
import { errdisabledPorts } from "../../../protocols/errdisable";

const L = (ss: string[]): { output: OutputLine[] } => ({ output: ss.map((s) => line(s)) });

/** `[Vlan <id>]` → selected VLAN ids (all configured when absent); null = malformed. */
function vlanSel(d: Device, toks: string[]): number[] | null {
  if (!toks.length) return listVlans(d).map((v) => v.id).sort((a, b) => a - b);
  const m = /^vlan(\d*)$/i.exec(toks[0]);
  if (!m) return null;
  const id = Number(m[1] || toks[1]);
  if (!Number.isInteger(id) || toks.length > (m[1] ? 1 : 2)) return null;
  return [id];
}

const l2Ports = (d: Device, vid: number) =>
  vlanMembers(d, vid)
    .map((m) => m.port)
    .filter((p) => p.startsWith("Ethernet") || p.startsWith("PortChannel"))
    .sort(natCompare);

function counters(d: Device, vids: number[]): string[] {
  const c = stpCounters(d);
  const out: string[] = [];
  for (const v of vids) {
    out.push(`VLAN ${v} - STP instance 0`, "-".repeat(68), "PortNum".padEnd(18) + "BPDU Tx".padEnd(15) + "BPDU Rx".padEnd(15) + "TCN Tx".padEnd(11) + "TCN Rx");
    for (const p of l2Ports(d, v)) out.push(p.padEnd(18) + String(c[p]?.tx ?? 0).padEnd(15) + String(c[p]?.rx ?? 0).padEnd(15) + "0".padEnd(11) + "0");
    out.push("");
  }
  return out;
}

function bpduGuard(d: Device): string[] {
  const out = ["PortNum".padEnd(19) + "Shutdown".padEnd(14) + "Port Shut", "".padEnd(19) + "Configured".padEnd(14) + "due to BPDU guard", "-".repeat(49)];
  const rows = cpList(d, "stp", "interfaces").filter((r) => r.bpduguard === true);
  rows.sort((a, b) => natCompare(String(a.ifname), String(b.ifname)));
  for (const r of rows) out.push(String(r.ifname).padEnd(19) + (r.bpduguard_shutdown ? "Yes" : "No").padEnd(14) + (r.bpduguard_shutdown ? (errdisabledPorts(d)[String(r.ifname)]?.cause === "bpduguard" ? "Yes" : "No") : "NA"));
  return out;
}

function inconsistent(d: Device): string[] {
  const t = (cpGet(d, "stp")?.rootguard_timeout as number | undefined) ?? 30;
  return [`Root guard timeout: ${t} secs`, "", "Port".padEnd(13) + "VLAN".padEnd(7) + "Current State", "-".repeat(43)];
}

registerModal({
  id: "stp-extra-show",
  views: ["enable-view"],
  keywords: ["show"],
  run(a) {
    const { args, ctx } = a;
    if (args[0]?.toLowerCase() !== "spanning-tree") return null;
    const sub = args[1]?.toLowerCase();
    const d = ctx.device;
    if (sub === "counters") {
      const v = vlanSel(d, args.slice(2));
      return v ? L(counters(d, v)) : null;
    }
    if (sub === "bpdu-guard") return args.length === 2 ? L(bpduGuard(d)) : null;
    if (sub === "inconsistentports") return vlanSel(d, args.slice(2)) ? L(inconsistent(d)) : null;
    if (sub === "mst") {
      if ((cpGet(d, "stp")?.mode as string | undefined) !== "mst") return { output: [err("% Error: Spanning-tree mode is not MST")] };
      // One CIST instance: the same port table as `show spanning-tree`.
      const base = runModalHandlers({ ...a, args: ["spanning-tree"] });
      return { output: [line("#######  MST0    Vlans mapped : 1-4094"), ...(base?.output ?? [])] };
    }
    return null;
  },
});
