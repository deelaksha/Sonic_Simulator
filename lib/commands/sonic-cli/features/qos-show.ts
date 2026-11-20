/**
 * KLISH `show qos …` (enable-view) with the 4.5 sonic-mgmt-framework layouts:
 *
 *   show qos                         qos_interface.xml:215 — `interface` is mandatory → incomplete
 *   show qos map                     qos_map_dscp.xml:113 — container
 *   show qos map dscp-tc|tc-queue|dot1p-tc|tc-pg|tc-dscp|tc-dot1p|pfc-priority-queue|pfc-priority-pg [<name>]
 *                                    show_qos_map_*.j2 ("DSCP-TC-MAP: <n>" between 28-dash rules)
 *   show qos scheduler-policy [<name>]   qos_scheduler.xml:156-163 → show_qos_scheduler_policies.j2 /
 *                                    show_qos_scheduler.j2
 *   show qos wred-policy [<name>]    wred.xml:13-21 → show_wred.j2
 *   show qos interface Ethernet <n>  qos_interface.xml:215-270 → sonic_cli_qos.py show_intf:
 *                                    show_qos_interface_config.j2 (scheduler policy, maps, pfc) +
 *                                    show_qos_interface_pfc_watchdog.j2
 *   show qos interface Ethernet <n> queue <q>       → show_qos_queue_config.j2
 *   show qos interface Ethernet <n> priority-flow-control statistics      → show_qos_interface_pfc_statistics.j2
 *   show qos interface Ethernet <n> queue <q> priority-flow-control watchdog-statistics
 *                                    → show_qos_interface_pfc_queue_statistics.j2
 *   show qos interface PortChannel <n> | Vlan <n>   → maps only;  show qos interface CPU → scheduler policy
 *
 * Interfaces are taken as KLISH writes them (`Ethernet 0` or `Ethernet0`). State: the
 * Click QoS module (feature "qos": DSCP-TC / TC-queue maps, scheduler + WRED policies,
 * per-port bindings) and PFC (feature "pfc": asymmetric, lossless priorities, watchdog).
 * Map kinds the simulator cannot configure (dot1p-tc, tc-pg, ...) have no entries, so
 * their templates print nothing. The simulated ASIC generates no PFC frames: PFC
 * counters are 0.
 */
import { CommandContext } from "../../types";
import { MODAL_HANDLERS, registerModal } from "../registry";
import { peekFeatureState } from "../../../models/feature-state";
import type { QosMap, QosState } from "../../sonic/qos";
import type { PfcState } from "../../sonic/qospfc";
import { ifArg, incomplete, lines, noAction } from "./klish-show-util";

const RULE = "-".repeat(28);
const MAPS: Record<string, { title: string; k: string; v: string; kw: number; get?: (s: QosState) => QosMap[] }> = {
  "dscp-tc": { title: "DSCP-TC-MAP", k: "DSCP", v: "TC", kw: 5, get: (s) => s.dscpTcMaps },
  "tc-queue": { title: "Traffic-Class-Queue-MAP", k: "TC", v: "Queue", kw: 5, get: (s) => s.tcQueueMaps },
  "dot1p-tc": { title: "DOT1P-TC-MAP", k: "DOT1P", v: "TC", kw: 7 },
  "tc-pg": { title: "Traffic-Class-Priority-Group-MAP", k: "TC", v: "PG", kw: 5 },
  "tc-dscp": { title: "Traffic-Class-DSCP-MAP", k: "TC", v: "DSCP", kw: 5 },
  "tc-dot1p": { title: "Traffic-Class-Dot1P-MAP", k: "TC", v: "DOT1P", kw: 5 },
  "pfc-priority-queue": { title: "PFC-Priority-Queue-MAP", k: "PFC Priority", v: "Queue", kw: 15 },
  "pfc-priority-pg": { title: "PFC-Priority-Priority-Group-MAP", k: "PFC Priority", v: "PG", kw: 15 },
};

const qos = (ctx: CommandContext) => peekFeatureState<QosState>(ctx.device, "qos");

function showMap(ctx: CommandContext, kind: string, name?: string): string[] {
  const m = MAPS[kind];
  const st = qos(ctx);
  const list = (st && m.get ? m.get(st) : []).filter((x) => !name || x.name === name).sort((x, y) => x.name.localeCompare(y.name));
  return list.flatMap((x) => [
    `${m.title}: ${x.name}`,
    RULE,
    `${m.k.padEnd(m.kw)}${m.v.padEnd(5)}`,
    RULE,
    ...[...x.entries].sort((p, q) => p.key - q.key).map((e) => `${String(e.key).padEnd(m.kw)}${String(e.value).padEnd(5)}`),
    RULE,
  ]);
}

function showSchedulers(ctx: CommandContext, name?: string): string[] {
  const all = [...(qos(ctx)?.schedulers ?? [])].sort((x, y) => x.name.localeCompare(y.name));
  const out: string[] = [];
  for (const p of all.filter((x) => !name || x.name === name)) {
    if (!name) out.push(` Scheduler Policy: ${p.name}`); // show_qos_scheduler.j2 (named form) has no title line
    for (const q of [...p.queues].sort((x, y) => x.queue - y.queue)) {
      out.push(`   Queue: ${q.queue}`, `              type: ${q.type}`);
      if (q.weight !== undefined) out.push(`              weight: ${q.weight}`);
    }
  }
  return out;
}

const ECN: Record<string, string> = { green: "ecn_green", yellow: "ecn_yellow", red: "ecn_red", "green,yellow": "ecn_green_yellow", "green,red": "ecn_green_red", "yellow,red": "ecn_yellow_red", "green,yellow,red": "ecn_all" };

function showWred(ctx: CommandContext, name?: string): string[] {
  const all = [...(qos(ctx)?.wredPolicies ?? [])].sort((x, y) => x.name.localeCompare(y.name));
  const out: string[] = [];
  for (const p of all.filter((x) => !name || x.name === name)) {
    out.push("-".repeat(51), `Policy                 : ${p.name}`, "-".repeat(51));
    const colors = ["green", "yellow", "red"].map((c) => p.colors.find((x) => x.color === c)).filter((x) => x !== undefined);
    const ecn = ECN[colors.map((c) => c.color).join(",")];
    if (ecn) out.push(`ecn                    : ${ecn}`);
    for (const c of colors) {
      const lbl = (s: string) => `${c.color}-${s}`.padEnd(23);
      out.push(`${lbl("min-threshold")}: ${String(c.min).padEnd(12)}KBytes`, `${lbl("max-threshold")}: ${String(c.max).padEnd(12)}KBytes`, `${lbl("drop-probability")}: ${String(c.prob).padEnd(12)}`);
    }
  }
  return out;
}

/** sonic_cli_qos.py show_intf for a physical port (and the maps-only forms for LAG/VLAN). */
function showIntf(ctx: CommandContext, port: string, physical: boolean): string[] {
  const st = qos(ctx);
  const b = st?.interfaces[port] ?? {};
  const out: string[] = [];
  if (physical && b.schedulerPolicy) out.push(`    scheduler policy: ${b.schedulerPolicy}`, "");
  if (b.dscpTc || b.tcQueue) {
    out.push("");
    if (b.dscpTc) out.push(`    dscp-tc-map: ${b.dscpTc}`);
    if (b.tcQueue) out.push(`    tc-queue-map: ${b.tcQueue}`);
  }
  if (!physical) return out;
  const pfc = peekFeatureState<PfcState>(ctx.device, "pfc");
  const pi = pfc?.interfaces[port];
  if (pi && (pi.asymmetric !== undefined || pi.priorities?.length)) {
    out.push("", `    pfc-asymmetric: ${pi.asymmetric ? "on" : "off"}`);
    if (pi.priorities?.length) out.push(`    pfc-priority  : ${[...pi.priorities].sort((x, y) => x - y).join(",")}`);
  }
  // show_port_pfc_watchdog (sonic_cli_qos_pfc.py:852-888): defaults off / N/A / 0 / 0.
  const wd = pfc?.pfcwd;
  const armed = !!wd?.started && (!wd.ports || wd.ports.includes("all") || wd.ports.includes(port));
  const det = armed && wd!.detectionTime !== undefined ? String(wd!.detectionTime) : "0";
  const rest = armed && wd!.restorationTime !== undefined ? String(wd!.restorationTime) : "0";
  const status = armed && det !== "0" && !!pi?.priorities?.length ? "on" : "off";
  const action = armed && det !== "0" ? wd!.action ?? "drop" : "N/A";
  out.push(
    "          PFC Watchdog",
    `${"            Status".padEnd(30)}: ${status}`,
    `${"            Action".padEnd(30)}: ${action}`,
    `${"            Detection Time".padEnd(30)}: ${det}ms`,
    `${"            Restoration Time".padEnd(30)}: ${rest === "0" ? "infinite(0ms)" : `${rest}ms`}`,
    " ",
  );
  return out;
}

const PFC_HDR = "Interface              PFC0           PFC1           PFC2           PFC3           PFC4           PFC5           PFC6           PFC7";
const PFC_RULE = "------------   ------------  -------------  -------------  -------------  -------------  -------------  -------------  -------------";

function pfcStats(port: string): string[] {
  const row = `${port.padEnd(12)}${" ".concat("0".padStart(14)).repeat(8)}`;
  return ["", " ", "Flow Control frames received", PFC_HDR, PFC_RULE, row, " ", "Flow Control frames transmitted", PFC_HDR, PFC_RULE, row, " "];
}

function pfcQueueStats(): string[] {
  return [
    "",
    " ",
    "PFC Watchdog Statistics",
    "                                      Storms                Transmitted                  Received                    TX Last                     RX Last",
    "Interface   Queue       Status  Detected  Restored        OK           Drop           OK           Drop           OK           Drop           OK           Drop",
    "----------- ----- ------------  --------  --------  ------------  ------------  ------------  ------------  ------------  ------------  ------------  ------------",
    "N/A".padStart(10).repeat(10),
    " ",
  ];
}

registerModal({
  id: "qos-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] !== "qos") return null;
    if (a[1] === undefined) return noAction();

    if (a[1] === "map") {
      if (a[2] === undefined) return noAction();
      if (!MAPS[a[2]] || args.length > 4) return null;
      return lines(showMap(ctx, a[2], args[3]));
    }
    if (a[1] === "scheduler-policy" && args.length <= 3) return lines(showSchedulers(ctx, args[2]));
    if (a[1] !== "interface") return null;

    if (a[2] === undefined) return incomplete();
    if (a[2] === "cpu") {
      const sp = qos(ctx)?.interfaces.CPU?.schedulerPolicy;
      return lines(sp ? [`    scheduler policy: ${sp}`, ""] : []);
    }
    const p = ifArg(args, 2);
    if (!p) return incomplete();
    const port = ctx.device.interfaces.find((i) => i.name.toLowerCase() === p.name.toLowerCase())?.name ?? p.name;
    const rest = a.slice(2 + p.used);
    if (!port.startsWith("Ethernet")) return rest.length ? null : lines(showIntf(ctx, port, false));
    if (rest.length === 0) return lines(showIntf(ctx, port, true));
    if (rest[0] === "priority-flow-control" && rest[1] === "statistics") return lines(pfcStats(port));
    if (rest[0] === "queue" && rest[1] !== undefined) {
      if (rest[2] === "priority-flow-control") return lines(pfcQueueStats());
      const wred = qos(ctx)?.interfaces[port]?.wredPolicy ?? "";
      const qs = rest[1] === "all" ? ["0", "1", "2", "3", "4", "5", "6", "7"] : [rest[1]];
      return lines(qs.flatMap((q) => [`interface queue ${q} config:`, `    WRED profile: ${wred}`]));
    }
    return null;
  },
});

// `show qos wred-policy`: KLISH `qos wred-policy` config lands in the Click QoS state (qos.ts is
// registered before wred.ts), but wred.ts's show handler — earlier in the list — reads only its
// own config-plane store. Run first and render the Click policies when there are any; otherwise
// fall through to wred.ts.
MODAL_HANDLERS.unshift({
  id: "qos-wred-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "qos" || args[1]?.toLowerCase() !== "wred-policy" || args.length > 3) return null;
    const rows = showWred(ctx, args[2]);
    return rows.length ? lines(rows) : null;
  },
});
