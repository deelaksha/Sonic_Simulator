/**
 * Queue / PFC counters produced by the flow-level bandwidth model
 * (lib/protocols/qos-model.ts), rendered like sonic-utilities:
 *
 *   show queue counters [<if>|CPU]   scripts/queuestat:43 std_header
 *                                    (Port TxQ Counter/pkts Counter/bytes Drop/pkts
 *                                    Drop/bytes), cnstat_print :280-345 — one
 *                                    "For namespace :" block per port, rows UC0-UC7
 *                                    then MC8-MC15, tabulate 'simple', right aligned,
 *                                    no thousands separators.
 *   show queue watermark [unicast|multicast]
 *                                    scripts/watermarkstat:208 "Egress shared pool
 *                                    occupancy per unicast queue:" Port UC0..UC7 (bytes)
 *   show pfc counters [<if>]         scripts/pfcstat:44-46 Port Rx / Port Tx PFC0-7,
 *                                    format_number_with_comma (:147-154)
 *   config interface speed <if> <mbps>
 *                                    sonic-utilities `config interface speed`; changes
 *                                    the port speed the model uses as link capacity
 *                                    (min of both ends).
 *
 * The CPU port renders features["cpu-queues"] (contract with the CPU/CoPP
 * daemon: Record<"0".."7", {pkts, bytes, dropPkts, dropBytes}>) as MC0-MC7, the
 * queue type Broadcom reports for CPU queues. Multicast queues MC8-MC15 stay 0:
 * flows are unicast.
 */
import { CommandContext, CommandResult, OutputLine, err, line, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { Device, interfaceByName, isSwitch } from "../../models/device";
import { NetInterface } from "../../models/interface";
import { peekFeatureState } from "../../models/feature-state";
import { PfcCounters, QueueCounter, QueueCounters, emptyQueue } from "../../protocols/qos-model";

type Cell = string | number;

/** python-tabulate tablefmt='simple', every column right aligned. */
export function tabulate(rows: Cell[][], header: string[]): OutputLine[] {
  const cells = rows.map((r) => r.map(String));
  const w = header.map((h, c) => Math.max(h.length, ...cells.map((r) => r[c].length)));
  const fmt = (r: string[]) => r.map((x, c) => x.padStart(w[c])).join("  ");
  return [line(fmt(header)), line(w.map((n) => "-".repeat(n)).join("  ")), ...cells.map((r) => line(fmt(r)))];
}

const comma = (n: number) => Math.floor(n).toLocaleString("en-US");

function frontPanel(dev: Device): NetInterface[] {
  return dev.interfaces.filter((i) => !i.management && !i.logical);
}

/** Accept "Ethernet0", "Ethernet 0", "interface Ethernet 0". */
function ifArg(args: string[]): string | undefined {
  const p = positional(args).filter((a) => a.toLowerCase() !== "interface");
  if (!p.length) return undefined;
  if (p.length >= 2 && /^\d+$/.test(p[1])) return `${p[0]}${p[1]}`;
  return p[0];
}

function requireSwitch(ctx: CommandContext): OutputLine[] | null {
  return isSwitch(ctx.device.type) ? null : [err("This command is only available on a SONiC switch")];
}

function queueRows(port: string, qs: QueueCounter[] | undefined): Cell[][] {
  const rows: Cell[][] = [];
  for (let q = 0; q < 8; q++) {
    const c = qs?.[q] ?? emptyQueue();
    rows.push([port, `UC${q}`, c.pkts, c.bytes, c.dropPkts, c.dropBytes]);
  }
  for (let q = 8; q < 16; q++) rows.push([port, `MC${q}`, 0, 0, 0, 0]);
  return rows;
}

const QUEUE_HDR = ["Port", "TxQ", "Counter/pkts", "Counter/bytes", "Drop/pkts", "Drop/bytes"];

function showQueueCounters(args: string[], ctx: CommandContext): OutputLine[] {
  const bad = requireSwitch(ctx);
  if (bad) return bad;
  const want = ifArg(args);
  const out: OutputLine[] = [];
  const block = (rows: Cell[][]) => out.push(line("For namespace :"), ...tabulate(rows, QUEUE_HDR), line(""));
  if (want === "CPU") {
    const cpu = peekFeatureState<Record<string, { pkts: number; bytes: number; dropPkts: number; dropBytes: number }>>(ctx.device, "cpu-queues") ?? {};
    const rows: Cell[][] = [];
    const top = Math.max(7, ...Object.keys(cpu).map(Number).filter(Number.isFinite));
    for (let q = 0; q <= top; q++) {
      const c = cpu[String(q)] ?? { pkts: 0, bytes: 0, dropPkts: 0, dropBytes: 0 };
      rows.push(["CPU", `MC${q}`, c.pkts, c.bytes, c.dropPkts, c.dropBytes]);
    }
    block(rows);
    return out;
  }
  const qc = peekFeatureState<QueueCounters>(ctx.device, "qos-queues") ?? {};
  const ports = frontPanel(ctx.device).filter((i) => !want || i.name === want);
  if (want && !ports.length) return [line(`Port doesn't exist! ${want}`)];
  for (const p of ports) block(queueRows(p.name, qc[p.name]));
  return out;
}

function showWatermark(args: string[], ctx: CommandContext): OutputLine[] {
  const bad = requireSwitch(ctx);
  if (bad) return bad;
  const kind = (positional(args)[0] ?? "unicast").toLowerCase();
  const qc = peekFeatureState<QueueCounters>(ctx.device, "qos-queues") ?? {};
  if (kind === "multicast") {
    const hdr = ["Port", ...Array.from({ length: 8 }, (_, i) => `MC${i + 8}`)];
    return [line("Egress shared pool occupancy per multicast queue:"), ...tabulate(frontPanel(ctx.device).map((p) => [p.name, ...Array(8).fill(0)]), hdr)];
  }
  if (kind !== "unicast") return [err("Usage: show queue watermark [unicast|multicast]")];
  const hdr = ["Port", ...Array.from({ length: 8 }, (_, i) => `UC${i}`)];
  const rows = frontPanel(ctx.device).map((p) => [p.name, ...Array.from({ length: 8 }, (_, q) => qc[p.name]?.[q]?.wm ?? 0)]);
  return [line("Egress shared pool occupancy per unicast queue:"), ...tabulate(rows, hdr)];
}

function showPfcCounters(args: string[], ctx: CommandContext): OutputLine[] {
  const bad = requireSwitch(ctx);
  if (bad) return bad;
  const want = ifArg(args);
  const pc = peekFeatureState<PfcCounters>(ctx.device, "qos-pfc") ?? {};
  const ports = frontPanel(ctx.device).filter((i) => !want || i.name === want);
  const pri = Array.from({ length: 8 }, (_, i) => `PFC${i}`);
  const z = [0, 0, 0, 0, 0, 0, 0, 0];
  return [
    ...tabulate(ports.map((p) => [p.name, ...(pc[p.name]?.rx ?? z).map(comma)]), ["Port Rx", ...pri]),
    line(""),
    ...tabulate(ports.map((p) => [p.name, ...(pc[p.name]?.tx ?? z).map(comma)]), ["Port Tx", ...pri]),
  ];
}

const SPEEDS = [10, 100, 1000, 10000, 25000, 40000, 50000, 100000, 200000, 400000];

const config: SonicCmd[] = [
  {
    path: ["interface", "speed"],
    summary: "Set a port speed in Mb/s (link capacity in the bandwidth model)",
    run(args, ctx): CommandResult {
      const [name, tok] = positional(args);
      if (!name || !tok) return { output: [err("Usage: config interface speed <interface_name> <speed>")] };
      const iface = interfaceByName(ctx.device, name);
      if (!iface || iface.management || iface.logical) return { output: [err(`Error: Interface name ${name} is invalid. Please enter a valid interface name!!`)] };
      const mbps = Number(tok);
      if (!SPEEDS.includes(mbps)) return { output: [err(`Error: Invalid speed specified: ${tok}. Valid speeds: ${SPEEDS.join(",")}`)] };
      iface.speed = mbps;
      return { output: [muted(`${name}: speed ${mbps}`)] };
    },
  },
];

const show: SonicCmd[] = [
  { path: ["queue", "counters"], summary: "Per-queue packet/byte/drop counters [<if>|CPU]", run: (a, ctx) => ({ output: showQueueCounters(a, ctx) }) },
  { path: ["queue", "watermark"], summary: "Queue buffer watermarks (bytes) [unicast|multicast]", run: (a, ctx) => ({ output: showWatermark(a, ctx) }) },
  { path: ["pfc", "counters"], summary: "PFC pause frames received/sent per priority", run: (a, ctx) => ({ output: showPfcCounters(a, ctx) }) },
];

export const qosrateModule: SonicFeatureModule = { id: "qos-rate", config, show };
