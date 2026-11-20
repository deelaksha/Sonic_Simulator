/**
 * Buffer / watermark / PG / queue-group Click `show` commands.
 *
 * Sources (sonic-buildimage/src/sonic-utilities):
 *   show buffer configuration [-vv]      show/main.py:2382-2412 → mmuconfig -l (CONFIG_DB)
 *   show buffer information              show/main.py:2414-2421 → buffershow -l (= mmuconfig, STATE_DB)
 *   show mmu [-vv]                       show/main.py:2360-2379 → mmuconfig -l
 *                                        layout scripts/mmuconfig MmuConfig.list: "Pool: <name>" /
 *                                        "Profile: <name>" + headerless tabulate + blank line
 *   show buffer_pool [persistent-]watermark   show/main.py:1043-1082 → watermarkstat [-p] -t buffer_pool
 *   show headroom-pool [persistent-]watermark show/main.py:1085-1124 → watermarkstat [-p] -t headroom_pool
 *   show priority-group watermark|persistent-watermark headroom|shared
 *                                        show/main.py:945-1040 → watermarkstat [-p] -t pg_headroom|pg_shared
 *   show priority-group drop counters    show/main.py:986-998 → scripts/pg-drop -c show
 *   show queue watermark|persistent-watermark unicast|multicast|all
 *                                        show/main.py:825-942 → watermarkstat [-p] -t q_shared_uni|multi|all
 *   show queue wredcounters [<if>]       show/main.py:792-822 → scripts/wredstat (header :44)
 *   show watermark telemetry interval    show/main.py:721-737 → scripts/watermarkcfg --show-interval
 *   show ecn                             show/main.py:2335-2346 → ecnconfig -l (WRED_PROFILE)
 *   show policer [name]                  show/main.py:2319-2332 → acl-loader show policer (main.py:1011-1026)
 *   bare groups queue / priority-group / buffer / buffer_pool / headroom-pool / pfcwd /
 *   dropcounters / watermark print the Click group help (none has invoke_without_command).
 *
 * The real tree has NO priority-group watermark all|unicast|multicast and no
 * priority-group telemetry: telemetry interval lives under `show watermark`.
 *
 * Data: buffer pools/profiles are the SONiC-VM t1 defaults shared with the KLISH
 * renderer (sonic-cli/features/qos-buffer-show.ts); queue watermarks/WRED drops
 * come from the flow model (features["qos-queues"]); WRED profiles from the QoS
 * store via the CONFIG_DB projection. Ingress PG occupancy/drops and headroom are
 * not modelled (flows only queue at egress), so those read 0 as on the VS SAI.
 */
import { CommandContext, OutputLine, line, err } from "../types";
import { SonicCmd, SonicFeatureModule, clickGroup, positional } from "./types";
import { Device } from "../../models/device";
import { peekFeatureState } from "../../models/feature-state";
import { QueueCounters } from "../../protocols/qos-model";
import { frontPorts } from "../../sonicdb/config-db";
import { projectQosConfig } from "../../sonicdb/qos-copp-db";
import { Tables } from "../../sonicdb/schema";
import { POOLS, PROFILES, poolWatermarks } from "../sonic-cli/features/qos-buffer-show";
import { cpGet } from "../sonic-cli/config-plane";
import { natCompare, tabulate } from "./counters";
import { showWatermark } from "./qos-rate";

const lines = (t: string[]) => t.map((s) => line(s));
const ports = (dev: Device) => frontPorts(dev).map((p) => p.name).sort(natCompare);

// ---------------------------------------------------------------- mmuconfig -l

/** tabulate(rows) with no headers: no padding, numeric-only columns right aligned. */
function bare(rows: string[][]): string[] {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  const num = w.map((_, c) => rows.every((r) => /^-?\d+$/.test(r[c])));
  const dash = w.map((n) => "-".repeat(n)).join("  ");
  return [dash, ...rows.map((r) => r.map((v, c) => (num[c] ? v.padStart(w[c]) : v.padEnd(w[c]))).join("  ").trimEnd()), dash];
}

/**
 * Field order follows the SONiC-VM buffers_defaults_t1.j2 insertion order (size,type,mode /
 * pool,size,<th>); profile pool references are plain pool names as db_migrator leaves them.
 * buffershow reads STATE_DB, which bufferorch fills with the same applied tables here.
 */
function mmuList(verbose: boolean): OutputLine[] {
  const out: string[] = [];
  for (const [name, p] of Object.entries(POOLS)) out.push(`Pool: ${name}`, ...bare([["size", String(p.size)], ["type", p.type], ["mode", p.mode]]), "");
  if (verbose) out.push(`Total pools: ${Object.keys(POOLS).length}`, "", "");
  for (const [name, p] of Object.entries(PROFILES)) {
    const rows = [["pool", p.pool], ["size", String(p.size)]];
    if (p.dynamic !== undefined) rows.push(["dynamic_th", String(p.dynamic)]);
    if (p.static !== undefined) rows.push(["static_th", String(p.static)]);
    out.push(`Profile: ${name}`, ...bare(rows), "");
  }
  if (verbose) out.push(`Total profiles: ${Object.keys(PROFILES).length}`);
  return lines(out);
}

const verboseFlag = (a: string[]) => a.includes("-vv") || a.includes("--verbose");

// ---------------------------------------------------------------- watermarkstat

const PG_HDR = ["Port", ...Array.from({ length: 8 }, (_, i) => `PG${i}`)];

/** Ingress PG watermarks: the VS SAI exposes PG0-7 per port; ingress occupancy is not modelled → 0. */
function pgWatermark(dev: Device, kind: "headroom" | "shared"): OutputLine[] {
  const msg = kind === "headroom" ? "Ingress headroom per PG:" : "Ingress shared pool occupancy per PG:";
  return lines([msg, ...tabulate(PG_HDR, ports(dev).map((p) => [p, ...Array(8).fill(0)]))]);
}

/** buffer_pool: natsorted pools; headroom_pool: only *ingress_lossless* pools, XOFF headroom not modelled → 0. */
function poolWatermark(dev: Device, headroom: boolean): OutputLine[] {
  const live = new Map(poolWatermarks(dev).map((r) => [r.pool, r.total]));
  const names = Object.keys(POOLS).sort(natCompare).filter((n) => !headroom || n.includes("ingress_lossless"));
  const rows = names.map((n) => [n, headroom ? 0 : live.get(n) ?? 0]);
  return lines([headroom ? "Headroom pool maximum occupancy:" : "Shared pool maximum occupancy:", ...tabulate(["Pool", "Bytes"], rows)]);
}

/**
 * Queue watermarks reuse qos-rate's renderer. The model keeps one max-since-boot watermark
 * per queue, so persistent and user watermarks read the same. VS queues are UC/MC only, so
 * the ALL map is empty (watermarkstat build_header → stderr "Object map is empty!").
 */
function queueWatermark(ctx: CommandContext, kind: string): OutputLine[] {
  if (kind === "all") return [err("Object map is empty!")];
  return showWatermark([kind], ctx);
}

// ---------------------------------------------------------------- pg-drop / wredstat

/** pg-drop -c show. Drops happen at egress queues in the model, so ingress PG drops are 0. */
function pgDrop(dev: Device): OutputLine[] {
  const poll = peekFeatureState<{ types: Record<string, { enabled: boolean }> }>(dev, "counterpoll")?.types["pg-drop"];
  if (poll && !poll.enabled) return [line("Warning: PG counters are disabled. Use 'counterpoll pg-drop enable' to enable polling")];
  return lines(["Ingress PG dropped packets:", ...tabulate(PG_HDR, ports(dev).map((p) => [p, ...Array(8).fill(0)]))]);
}

const WRED_HDR = ["Port", "TxQ", "WredDrp/pkts", "WredDrp/bytes", "EcnMarked/pkts", "EcnMarked/bytes"];

/**
 * wredstat: one block per port (natsorted, so CPU first), queues natsorted UC0-7, MC8-15.
 * WredDrp/pkts is the model's live WRED drop count; WRED drop bytes and ECN marking are not
 * tracked and read 0.
 */
function wredBlock(dev: Device, port: string): string[] {
  const qc = peekFeatureState<QueueCounters>(dev, "qos-queues") ?? {};
  const rows: (string | number)[][] = port === "CPU"
    ? Array.from({ length: 8 }, (_, q) => [port, `MC${q}`, 0, 0, 0, 0])
    : Array.from({ length: 16 }, (_, q) => [port, q < 8 ? `UC${q}` : `MC${q}`, q < 8 ? qc[port]?.[q]?.wredDropPkts ?? 0 : 0, 0, 0, 0]);
  return [...tabulate(WRED_HDR, rows), ""];
}

function wredCounters(dev: Device, args: string[]): OutputLine[] {
  const want = positional(args)[0];
  const all = ["CPU", ...ports(dev)].sort(natCompare);
  if (want && !all.includes(want)) return [line(`Port does not exist! ${want}`)];
  return lines((want ? [want] : all).flatMap((p) => wredBlock(dev, p)));
}

// ---------------------------------------------------------------- ecnconfig -l / acl-loader show policer

/** One "Profile: <name>" block per CONFIG_DB WRED_PROFILE row (nothing when there are none). */
function ecnList(dev: Device): OutputLine[] {
  const t: Tables = {};
  projectQosConfig(dev, t);
  return lines(Object.entries(t.WRED_PROFILE ?? {}).flatMap(([name, row]) => [`Profile: ${name}`, ...bare(Object.entries(row).map(([f, v]) => [f, String(v)])), ""]));
}

/** The simulator has no POLICER table, so acl-loader prints only the header. */
function policerList(): OutputLine[] {
  return lines(tabulate(["Name", "Type", "Mode", "CIR", "CBS"], [], "left"));
}

/** watermarkcfg --show-interval: WATERMARK_TABLE|TELEMETRY_INTERVAL, default 120 s. */
function telemetryInterval(dev: Device): OutputLine[] {
  const v = cpGet(dev, "watermark")?.telemetryInterval;
  return lines(["", v !== undefined ? `Telemetry interval: ${v} second(s)` : "Telemetry interval 120 second(s)", ""]);
}

// ---------------------------------------------------------------- registration

const show: SonicCmd[] = [
  clickGroup(["buffer"], "Show buffer information", [["configuration", "show buffer configuration"], ["information", "show buffer information"]]),
  { path: ["buffer", "configuration"], summary: "show buffer configuration", run: (a) => ({ output: mmuList(verboseFlag(a)) }) },
  { path: ["buffer", "information"], summary: "show buffer information", run: () => ({ output: mmuList(false) }) },
  { path: ["mmu"], summary: "Show mmu configuration", run: (a) => ({ output: mmuList(verboseFlag(a)) }) },

  clickGroup(["buffer_pool"], "Show details of the buffer pools", [["persistent-watermark", "Show persistent WM for buffer pools"], ["watermark", "Show user WM for buffer pools"]]),
  { path: ["buffer_pool", "watermark"], summary: "Show user WM for buffer pools", run: (_a, ctx) => ({ output: poolWatermark(ctx.device, false) }) },
  { path: ["buffer_pool", "persistent-watermark"], summary: "Show persistent WM for buffer pools", run: (_a, ctx) => ({ output: poolWatermark(ctx.device, false) }) },

  clickGroup(["headroom-pool"], "Show details of headroom pool", [["persistent-watermark", "Show persistent WM for headroom pool"], ["watermark", "Show user WM for headroom pool"]]),
  { path: ["headroom-pool", "watermark"], summary: "Show user WM for headroom pool", run: (_a, ctx) => ({ output: poolWatermark(ctx.device, true) }) },
  { path: ["headroom-pool", "persistent-watermark"], summary: "Show persistent WM for headroom pool", run: (_a, ctx) => ({ output: poolWatermark(ctx.device, true) }) },

  clickGroup(["priority-group"], "Show details of the PGs", [["drop", "Show priority-group"], ["persistent-watermark", "Show priority-group persistent WM"], ["watermark", "Show priority-group user WM"]]),
  clickGroup(["priority-group", "drop"], "Show priority-group", [["counters", "Show dropped packets for priority-group"]]),
  { path: ["priority-group", "drop", "counters"], summary: "Show dropped packets for priority-group", run: (_a, ctx) => ({ output: pgDrop(ctx.device) }) },
  clickGroup(["priority-group", "watermark"], "Show priority-group user WM", [["headroom", "Show user headroom WM for pg"], ["shared", "Show user shared WM for pg"]]),
  { path: ["priority-group", "watermark", "headroom"], summary: "Show user headroom WM for pg", run: (_a, ctx) => ({ output: pgWatermark(ctx.device, "headroom") }) },
  { path: ["priority-group", "watermark", "shared"], summary: "Show user shared WM for pg", run: (_a, ctx) => ({ output: pgWatermark(ctx.device, "shared") }) },
  clickGroup(["priority-group", "persistent-watermark"], "Show priority-group persistent WM", [["headroom", "Show persistent headroom WM for pg"], ["shared", "Show persistent shared WM for pg"]]),
  { path: ["priority-group", "persistent-watermark", "headroom"], summary: "Show persistent headroom WM for pg", run: (_a, ctx) => ({ output: pgWatermark(ctx.device, "headroom") }) },
  { path: ["priority-group", "persistent-watermark", "shared"], summary: "Show persistent shared WM for pg", run: (_a, ctx) => ({ output: pgWatermark(ctx.device, "shared") }) },

  clickGroup(["queue"], "Show details of the queues", [
    ["counters", "Show queue counters"], ["persistent-watermark", "Show persistent WM for queues"],
    ["watermark", "Show user WM for queues"], ["wredcounters", "Show queue wredcounters"],
  ]),
  { path: ["queue", "wredcounters"], summary: "Show queue wredcounters", run: (a, ctx) => ({ output: wredCounters(ctx.device, a) }) },
  clickGroup(["queue", "watermark"], "Show user WM for queues", [["all", "Show user WM for all queues"], ["multicast", "Show user WM for multicast queues"], ["unicast", "Show user WM for unicast queues"]]),
  clickGroup(["queue", "persistent-watermark"], "Show persistent WM for queues", [["all", "Show persistent WM for all queues"], ["multicast", "Show persistent WM for multicast queues"], ["unicast", "Show persistent WM for unicast queues"]]),
  ...["watermark", "persistent-watermark"].flatMap((g) =>
    ["unicast", "multicast", "all"].map((k): SonicCmd => ({ path: ["queue", g, k], summary: `Show ${g === "watermark" ? "user" : "persistent"} WM for ${k} queues`, run: (_a, ctx) => ({ output: queueWatermark(ctx, k) }) })),
  ),

  clickGroup(["watermark"], "Show details of watermark", [["telemetry", "Show watermark telemetry info"]]),
  clickGroup(["watermark", "telemetry"], "Show watermark telemetry info", [["interval", "Show telemetry interval"]]),
  { path: ["watermark", "telemetry", "interval"], summary: "Show telemetry interval", run: (_a, ctx) => ({ output: telemetryInterval(ctx.device) }) },

  clickGroup(["pfcwd"], "Show details of the pfc watchdog", [["config", "Show pfc watchdog config"], ["stats", "Show pfc watchdog stats"]]),
  clickGroup(["dropcounters"], "Show drop counter related information", [["capabilities", "Show device drop counter capabilities"], ["configuration", "Show current drop counter configuration"], ["counts", "Show drop counts"]]),
  { path: ["ecn"], summary: "Show ECN configuration", run: (_a, ctx) => ({ output: ecnList(ctx.device) }) },
  { path: ["policer"], summary: "Show existing policers", run: () => ({ output: policerList() }) },
];

export const buffersModule: SonicFeatureModule = {
  id: "buffers",
  config: [],
  show,
};
