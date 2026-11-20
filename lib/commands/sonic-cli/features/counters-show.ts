/**
 * KLISH counters / FDB-aging handlers.
 *
 * enable-view
 *   show interface counters              portstat table — the target switch's KLISH prints the
 *                                        same layout as Click (device-capture show-outputs/
 *                                        show_interface_counters.txt)
 *   show interface counters rate         renderer/templates/show_intf_counters_rate.j2
 *   show interface dropcounters          renderer/templates/show_intf_dropcounters.j2
 *   show mac address-table aging-time    device klish-xml/mac.xml:29-31 (show_mac_aging_time.j2 is
 *                                        not in the source tree; rendered as "Aging-Time: N seconds")
 *   show mac address-table count         mac.xml:34-42 (show_mac_count.j2 not in the tree; layout
 *                                        is a best effort)
 *   clear counters [interface [all|Ethernet <id>|Ethernet<id>|rif]]
 *                                        clear_interface_counters.xml / device clear_counters.xml;
 *                                        the confirm prompt of sonic_cli_clear_interface.py:55-63 is
 *                                        answered implicitly (no interactive input here)
 *   clear mac address-table dynamic all  clear_mac_address_table.xml (flush dynamic FDB)
 * configure-view
 *   [no] mac address-table aging-time <0-1000000>   mac.xml:274-276, ptype MAC_AGE_TIMER
 *                                                   (sonic_types.xml:688)
 */
import { OutputLine, err, line } from "../../types";
import { registerModal } from "../registry";
import { cpStoreLine } from "../config-plane";
import { clearCounters, natCompare, renderPortstat } from "../../sonic/counters";
import { counterPorts, peekCounters } from "../../../protocols/counters-daemon";
import { portDiscards } from "../../../control/drops";
import { DEFAULT_FDB_AGING_SEC, FDB_AGING_MAX, fdbAgingTime, flushDynamicFdb, setFdbAgingTime } from "../../../protocols/macaging-daemon";

const L = (s: string | number, w: number) => String(s).padEnd(w);
/** Jinja `|round(2)` then `%s` of a float: Python repr ("0.0", "1.25"). */
const pyRound = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? r.toFixed(1) : String(r);
};

/** "Ethernet 4" / "Ethernet4" → "Ethernet4". */
function joinIf(args: string[]): string | undefined {
  if (!args.length) return undefined;
  if (/^\d+$/.test(args[1] ?? "")) return args[0] + args[1];
  return args[0];
}

function rateTable(args: string[], device: Parameters<typeof counterPorts>[0]): OutputLine[] {
  const only = joinIf(args);
  const rates = peekCounters(device)?.ports ?? {};
  const out: OutputLine[] = [
    line("-".repeat(187)),
    line(L("Interface", 15) + L("Rate interval", 15) + L("RX_MBPS", 22) + L("RX_MbPS", 22) + L("RX_PPS", 22) + L("RX_UTIL", 16) + L("TX_MBPS", 22) + L("TX_MbPS", 22) + L("TX_PPS", 22) + L("TX_UTIL", 16)),
    line(L("", 15) + L("(seconds)", 15) + L("(MB/s)", 22) + L("(Mb/s)", 22) + L("(Pkts/s)", 22) + L("(%)", 16) + L("(MB/s)", 22) + L("(Mb/s)", 22) + L("(Pkts/s)", 22) + L("(%)", 16)),
    line("-".repeat(187)),
  ];
  for (const i of counterPorts(device).slice().sort((a, b) => natCompare(a.name, b.name))) {
    if (only && i.name !== only) continue;
    const r = rates[i.name];
    const util = (bps = 0) => pyRound((bps / ((i.speed * 1e6) / 8)) * 100);
    out.push(
      line(
        L(i.name, 15) + L("10", 15) + L(pyRound((r?.rxBps ?? 0) / 1e6), 22) + L(pyRound(((r?.rxBps ?? 0) * 8) / 1e6), 22) + L(pyRound(r?.rxPps ?? 0), 22) +
          L(util(r?.rxBps), 16) + L(pyRound((r?.txBps ?? 0) / 1e6), 22) + L(pyRound(((r?.txBps ?? 0) * 8) / 1e6), 22) + L(pyRound(r?.txPps ?? 0), 22) + L(util(r?.txBps), 16),
      ),
    );
  }
  return out;
}

function dropTable(args: string[], device: Parameters<typeof counterPorts>[0]): OutputLine[] {
  const only = joinIf(args);
  const out: OutputLine[] = [
    line("-".repeat(157)),
    line(L("Interface", 15) + L("STATE", 10) + L("RX_ERR", 22) + L("RX_DROPS", 22) + L("TX_ERR", 22) + L("TX_DROPS", 22) + " " + " ".repeat(22)),
    line("-".repeat(157)),
  ];
  for (const i of counterPorts(device).slice().sort((a, b) => natCompare(a.name, b.name))) {
    if (only && i.name !== only) continue;
    const d = portDiscards(device, i.name);
    // template: 'D' when oper-status is DOWN, else 'U' (admin state is not shown)
    out.push(line(L(i.name, 15) + L(i.operState === "up" ? "U" : "D", 10) + L(0, 22) + L(d.rx, 22) + L(0, 22) + L(d.tx, 22) + " " + " ".repeat(22)));
  }
  return out;
}

registerModal({
  id: "counters-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] === "interface" && a[1] === "counters") {
      if (a[2] === "rate") return { output: rateTable(args.slice(3), ctx.device) };
      if (a[2] === undefined) return { output: renderPortstat(ctx.device, { noBanner: true }) };
      if (/^(ethernet|eth)$/.test(a[2]) && a.length === 3) return { output: renderPortstat(ctx.device, { noBanner: true }) }; // all Ethernet
      if (/^(ethernet|eth)/.test(a[2])) return { output: renderPortstat(ctx.device, { noBanner: true, intf: joinIf(args.slice(2)) }) };
      return null;
    }
    if (a[0] === "interface" && a[1] === "dropcounters") return { output: dropTable(args.slice(2), ctx.device) };
    if (a[0] === "mac" && a[1] === "address-table" && a[2] === "aging-time") {
      return { output: [line(`Aging-Time: ${fdbAgingTime(ctx.device)} seconds`)] };
    }
    if (a[0] === "mac" && a[1] === "address-table" && a[2] === "count") {
      // `count Vlan <id>` / `count Vlan<id>` (mac.xml:34-42) counts that VLAN's entries.
      const vid = /^vlan(\d*)$/i.exec(args[3] ?? "") ? Number(/^vlan(\d*)$/i.exec(args[3])![1] || args[4]) : undefined;
      const t = ctx.device.macTable.filter((e) => vid === undefined || e.vlan === vid);
      const stat = t.filter((e) => e.static || e.interfaceId.startsWith("vtep:")).length;
      return {
        output: [
          line(`MAC Entries for ${vid === undefined ? "all vlans" : `Vlan${vid}`} :  ${t.length}`),
          line(`Dynamic Address Count :  ${t.length - stat}`),
          line(`Static Address (User-defined) Count :  ${stat}`),
          line(`Total MAC Addresses in Use: ${t.length}`),
        ],
      };
    }
    return null;
  },
});

// exec: `clear counters ...`, `clear mac address-table dynamic all`
registerModal({
  id: "counters-clear",
  views: ["enable-view"],
  keywords: ["clear"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] === "counters") {
      if (a[1] !== undefined && a[1] !== "interface") return null;
      const sel = args.slice(2);
      if (sel[0]?.toLowerCase() === "rif") return { output: [] };
      const ifn = sel.length && sel[0].toLowerCase() !== "all" ? joinIf(sel) : undefined;
      if (ifn && !counterPorts(ctx.device).some((i) => i.name === ifn)) return { output: [err(`% Error: Interface ${ifn} not found`)] };
      clearCounters(ctx.device, ifn);
      return { output: [] };
    }
    if (a[0] === "mac" && a[1] === "address-table" && a[2] === "dynamic" && a[3] === "all") {
      flushDynamicFdb(ctx.device);
      return { output: [] };
    }
    return null;
  },
});

// configure-view: `[no] mac address-table aging-time <0-1000000>`
registerModal({
  id: "fdb-aging",
  views: ["configure-view"],
  keywords: ["mac"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "address-table" || args[1]?.toLowerCase() !== "aging-time") return null;
    cpStoreLine(ctx.device, "config", "no mac address-table aging-time", true);
    if (isNo) {
      setFdbAgingTime(ctx.device, DEFAULT_FDB_AGING_SEC);
      return { output: [] };
    }
    const tok = args[2];
    if (tok === undefined || !/^\d+$/.test(tok) || Number(tok) > FDB_AGING_MAX) {
      return { output: [err(`% Error: Invalid value. Valid range is 0..${FDB_AGING_MAX}`)] };
    }
    setFdbAgingTime(ctx.device, Number(tok));
    cpStoreLine(ctx.device, "config", `mac address-table aging-time ${tok}`, false);
    return { output: [] };
  },
});
