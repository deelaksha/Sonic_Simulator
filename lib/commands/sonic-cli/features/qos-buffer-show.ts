/**
 * KLISH QoS / buffer / hardware `show` commands, rendered with the real renderer
 * templates' layout (Broadcom Enterprise SONiC sonic-mgmt-framework CLI
 * renderer/templates/*.j2; syntax + template choice from the ACTION scripts in
 * data/device-capture/klish-xml/*.xml):
 *
 *   show queue counters [interface <if> [queue <n>] | interface CPU [queue <n>]]
 *                                   qos_counter.xml:15  show_qos_queue_counters.j2 /
 *                                   show_qos_interface_all_queue_counters.j2 / …_queue_counters.j2
 *   show queue wred-ecn counters [interface <if>]       show_qos_*queue_wred_ecn_counters.j2
 *   show queue watermark|persistent-watermark [percentage] unicast|multicast|CPU [interface <if>]
 *                                   show_qos_{uc,mc,interface_cpu}_[persistent_]watermark[_percent].j2
 *   show priority-group watermark|persistent-watermark [percentage] headroom|shared [interface <if>]
 *                                   qos_counter.xml:321 show_qos_[interface_]pg_*.j2
 *   show buffer pool | profile | interface <if> priority-group|queue|cable-length
 *                                   qos_buffer.xml:27-66 show_qos_buffer.j2
 *   show buffer-pool watermark|persistent-watermark [percentage] [interface <if>]
 *   show device watermark|persistent-watermark
 *                                   threshold.xml:118,142 show_buffer_pool_stats_{bytes,percentage}.j2,
 *                                   sonic_cli_threshold.py rpc_sonic_buffer_pool_get_buffer_pool_wm_stats
 *   show priority-flow-control [watchdog]               qos_pfc.xml:18 show_qos_pfc_watchdog.j2
 *   show service-policy Switch|CtrlPlane [type …]        flow_based_services.xml:293 show_service_policy.j2
 *   show hardware tcam allocation [<feature>] [ingress|egress]  hardware.xml:186 show_tcam_allocation.j2
 *
 * Data: per-queue counters / watermarks of the flow-level bandwidth model
 * (features["qos-queues"], lib/protocols/qos-model.ts), CPU queues of the CoPP
 * path (features["cpu-queues"], cpu-daemon.ts), the virtual-switch HwSKU buffer
 * defaults (sonic-buildimage device/virtual/x86_64-kvm_x86_64-r0/SONiC-VM/
 * buffers_defaults_t1.j2 + files/build_templates/buffers_config.j2:254-283),
 * PFC watchdog config (features["pfc"]), FBS bindings and the CoPP trap groups.
 * Ingress priority-group occupancy is not modelled (flows only queue at egress),
 * so PG watermarks read 0.
 */
import { OutputLine, line, err } from "../../types";
import { registerModal } from "../registry";
import { cpList, cpRunningLines } from "../config-plane";
import { Device } from "../../../models/device";
import { NetInterface } from "../../../models/interface";
import { peekFeatureState } from "../../../models/feature-state";
import { QueueCounters, QueueCounter, emptyQueue } from "../../../protocols/qos-model";
import { CpuQueues, peekCoppRuntime } from "../../../protocols/cpu-daemon";
import { DEFAULT_GROUPS } from "../../../protocols/cpu-traps";
import { renderServicePolicy } from "../../../protocols/pbr";
import { ifArg, L } from "./sysfmt";

const CPU_QUEUES = 48;
const lines = (t: string[]) => t.map((s) => line(s));

const frontPanel = (dev: Device): NetInterface[] => dev.interfaces.filter((i) => !i.management && !i.logical && i.name.startsWith("Ethernet"));

// ---------------------------------------------------------------- buffer defaults (SONiC-VM t1)

export const POOLS: Record<string, { size: number; type: string; mode: string }> = {
  ingress_lossless_pool: { size: 12766208, type: "ingress", mode: "dynamic" },
  egress_lossless_pool: { size: 12766208, type: "egress", mode: "static" },
  egress_lossy_pool: { size: 7326924, type: "egress", mode: "dynamic" },
};
export const PROFILES: Record<string, { pool: string; size: number; static?: number; dynamic?: number }> = {
  ingress_lossy_profile: { pool: "ingress_lossless_pool", size: 0, dynamic: 3 },
  egress_lossless_profile: { pool: "egress_lossless_pool", size: 0, static: 12766208 },
  egress_lossy_profile: { pool: "egress_lossy_pool", size: 1518, dynamic: 3 },
};
const BUFFER_PG: [string, string][] = [["0", "ingress_lossy_profile"]];
const BUFFER_QUEUE: [string, string][] = [["0-2", "egress_lossy_profile"], ["3-4", "egress_lossless_profile"], ["5-6", "egress_lossy_profile"]];

const kv = (k: string, v: unknown) => `   ${L(k, 25)} : ${v}`;

function bufferPools(): string[] {
  return Object.keys(POOLS).sort().flatMap((n) => [`${n}:`, kv("size", POOLS[n].size), kv("type", POOLS[n].type), kv("mode", POOLS[n].mode)]);
}

function bufferProfiles(): string[] {
  return Object.keys(PROFILES).sort().flatMap((n) => {
    const p = PROFILES[n];
    return [`${n}:`, kv("pool", p.pool), kv("size", p.size),
      ...(p.static !== undefined ? [kv("static-threshold", p.static)] : []),
      ...(p.dynamic !== undefined ? [kv("dynamic-threshold", p.dynamic)] : [])];
  });
}

function bufferInterface(dev: Device, ports: string[], kind: string): string[] {
  if (kind === "cable-length") return [`${L("Interface", 16)}Cable-length`, ...ports.map((p) => `${L(p, 16)}0m`)];
  const map = kind === "priority-group" ? BUFFER_PG : BUFFER_QUEUE;
  return [`${L("Interface", 16)}${L(kind === "priority-group" ? "priority-group" : "queue", 16)}Profile`,
    ...ports.flatMap((p) => map.map(([ids, prof]) => `${L(p, 16)}${L(ids, 16)}${prof}`.trimEnd()))];
}

// ---------------------------------------------------------------- queue counters

const queues = (dev: Device) => peekFeatureState<QueueCounters>(dev, "qos-queues") ?? {};
const cpuQueues = (dev: Device) => peekFeatureState<CpuQueues>(dev, "cpu-queues") ?? {};

interface QRow { name: string; pkts: number; bytes: number; dropPkts: number; dropBytes: number; wredDrops: number; wm: number }

function portQueueRows(dev: Device, port: string): QRow[] {
  const qs = queues(dev)[port];
  const rows: QRow[] = [];
  for (let q = 0; q < 8; q++) {
    const c: QueueCounter = qs?.[q] ?? emptyQueue();
    rows.push({ name: `UC${q}`, pkts: c.pkts, bytes: c.bytes, dropPkts: c.dropPkts, dropBytes: c.dropBytes, wredDrops: c.wredDropPkts, wm: c.wm });
  }
  for (let q = 8; q < 16; q++) rows.push({ name: `MC${q}`, pkts: 0, bytes: 0, dropPkts: 0, dropBytes: 0, wredDrops: 0, wm: 0 });
  return rows;
}

function cpuQueueRows(dev: Device): QRow[] {
  const cq = cpuQueues(dev);
  return Array.from({ length: CPU_QUEUES }, (_, q) => {
    const c = cq[String(q)] ?? { pkts: 0, bytes: 0, dropPkts: 0, dropBytes: 0 };
    return { name: `MC${q}`, pkts: c.pkts, bytes: c.bytes, dropPkts: c.dropPkts, dropBytes: c.dropBytes, wredDrops: 0, wm: 0 };
  });
}

const ctrCols = (r: QRow) => `${L(r.pkts, 22)}${L(r.bytes, 22)}${L("0/s", 22)}${L("0/s", 22)}${L("0/s", 22)}${L(r.dropPkts, 22)}${r.dropBytes}`;
const CTR_HDR = `${L("Counter/pkts", 22)}${L("Counter/bytes", 22)}${L("Rate/PPS", 22)}${L("Rate/BPS", 22)}${L("Rate/bPS", 22)}${L("Drop/pkts", 22)}Drop/bytes`;

function queueCountersAll(dev: Device): string[] {
  const d = "-".repeat(161);
  return [d, `${L("Port", 12)}${L("TxQ", 5)}${CTR_HDR}`, d,
    ...frontPanel(dev).flatMap((p) => portQueueRows(dev, p.name).map((r) => `${L(p.name, 12)}${L(r.name, 5)}${ctrCols(r)}`))];
}

function queueCountersOne(rows: QRow[]): string[] {
  const d = "-".repeat(rows.length === 1 ? 150 : 149);
  return [d, `${L("TxQ", 5)}${CTR_HDR}`, d, ...rows.map((r) => `${L(r.name, 5)}${ctrCols(r)}`)];
}

function wredAll(dev: Device, ports: string[], withPort: boolean): string[] {
  const d = "-".repeat(withPort ? 109 : 79);
  const hdr = `${L("TxQ", 5)}${L("WRED Drops/Pkts", 22)}${L("ECN Marked/Pkts", 22)}ECN Marked/Bytes`;
  return [d, withPort ? `${L("Port", 12)}${hdr}` : hdr, d,
    ...ports.flatMap((p) => portQueueRows(dev, p).filter((r) => r.name.startsWith("UC")).map((r) => `${withPort ? L(p, 12) : ""}${L(r.name, 5)}${L(r.wredDrops, 22)}${L(0, 22)}0`))];
}

// ---------------------------------------------------------------- watermarks

/** Grid layout of show_qos_{uc,mc}_* (with Port column) / show_qos_interface_{uc,mc}_* (without). */
function grid(title: string, cols: string[], rows: [string, (number | string)[]][], withPort: boolean): string[] {
  const dash = (withPort ? "-".repeat(12) : "") + "-".repeat(10 * cols.length);
  return [title, "", dash, (withPort ? L("Port", 12) : "") + cols.map((c) => L(c, 10)).join("").trimEnd(), dash,
    ...rows.map(([p, v]) => ((withPort ? L(p, 12) : "") + v.map((x) => L(x, 10)).join("")).trimEnd())];
}

const pct = (bytes: number, pool: number) => Math.round((bytes * 100) / pool);

function queueWatermark(dev: Device, k: string[], args: string[]): string[] | null {
  const persistent = k[1] === "persistent-watermark";
  const percent = k[2] === "percentage";
  const kind = percent ? k[3] : k[2];
  const ii = k.indexOf("interface");
  const iface = ii >= 0 ? ifArg(args.slice(ii + 1)).name : undefined;
  const lossy = POOLS.egress_lossy_pool.size;
  if (kind === "cpu" || iface === "CPU") {
    const title = percent
      ? `Egress shared pool ${persistent ? "persistent " : ""}watermark occupancy per CPU queue:`
      : "Egress queue watermark per CPU queue:";
    const d = "-".repeat(67);
    return [title, d, `${L("TxQ", 10)}${percent ? "Percentage" : "Bytes"}`, d, ...cpuQueueRows(dev).map((r) => `${L(`CPU${r.name.slice(2)}`, 10)}${percent ? pct(r.wm, lossy) : r.wm}`)];
  }
  if (kind !== "unicast" && kind !== "multicast") return null;
  const uc = kind === "unicast";
  const word = uc ? "unicast" : "multicast";
  let title: string;
  if (iface) {
    title = percent
      ? uc && !persistent ? "Egress queue watermark percent per unicast queue:" : `Egress shared pool ${persistent ? "persistent " : ""}watermark occupancy per ${word} queue:`
      : `Egress queue ${persistent ? "persistent " : ""}watermark per ${word} queue:`;
  } else {
    title = percent || (persistent && uc)
      ? `Egress shared pool ${persistent ? "persistent " : ""}watermark occupancy per ${word} queue:`
      : `Egress queue ${persistent ? "persistent " : ""}watermark per ${word} queue:`;
  }
  const ports = iface ? frontPanel(dev).filter((p) => p.name === iface) : frontPanel(dev);
  if (iface && !ports.length) return [];
  const pick = (r: QRow[]) => r.filter((x) => x.name.startsWith(uc ? "UC" : "MC"));
  const cols = pick(portQueueRows(dev, ports[0]?.name ?? "")).map((r) => r.name);
  const rows: [string, number[]][] = ports.map((p) => [p.name, pick(portQueueRows(dev, p.name)).map((r) => (percent ? pct(r.wm, lossy) : r.wm))]);
  return grid(title, cols, rows, !iface);
}

function pgWatermark(dev: Device, k: string[], args: string[]): string[] | null {
  const persistent = k[1] === "persistent-watermark";
  const kind = k[2] === "percentage" ? k[3] : k[2];
  if (kind !== "headroom" && kind !== "shared") return null;
  const ii = k.indexOf("interface");
  const iface = ii >= 0 ? ifArg(args.slice(ii + 1)).name : undefined;
  const title = kind === "headroom" ? `Ingress headroom ${persistent ? "persistent " : ""}watermark per PG:` : `Ingress shared pool ${persistent ? "persistent " : ""}watermark per PG:`;
  const cols = Array.from({ length: 8 }, (_, i) => `PG${i}`);
  const ports = iface ? frontPanel(dev).filter((p) => p.name === iface) : frontPanel(dev);
  if (iface && !ports.length) return [];
  const d = "-".repeat(iface ? 79 : 89);
  return [title, d, (iface ? "" : L("Port", 12)) + cols.map((c) => L(c, 10)).join("").trimEnd(), d,
    ...ports.map((p) => ((iface ? "" : L(p.name, 12)) + cols.map(() => L(0, 10)).join("")).trimEnd())];
}

/** Egress pool occupancy watermark: sum over ports of each port's peak unicast queue. */
export function poolWatermarks(dev: Device, port?: string): { pool: string; total: number; um: number }[] {
  const qs = queues(dev);
  const ports = frontPanel(dev).map((p) => p.name).filter((p) => !port || p === port);
  const lossy = ports.reduce((n, p) => n + Math.max(0, ...(qs[p] ?? []).map((q) => q.wm)), 0);
  return Object.keys(POOLS).sort().map((pool) => ({ pool, total: pool === "egress_lossy_pool" ? lossy : 0, um: port && pool === "egress_lossy_pool" ? lossy : 0 }));
}

function bufferPoolWatermark(dev: Device, k: string[], args: string[]): string[] {
  const percent = k.includes("percentage");
  const ii = k.indexOf("interface");
  const port = ii >= 0 ? ifArg(args.slice(ii + 1)).name : undefined;
  const rows = poolWatermarks(dev, port);
  const isPort = port !== undefined;
  const [h1, h2] = percent ? ["Percent (Total)", isPort ? "Percent (Unicast)" : "Percent (Multicast)"] : ["Bytes (Total)", isPort ? "Bytes (Unicast)" : "Bytes (Multicast)"];
  const w = percent ? 22 : 18;
  const d = "-".repeat((percent ? 69 : 63) + (isPort ? 0 : 2));
  const val = (pool: string, v: number) => (percent ? pct(v, POOLS[pool].size) : v);
  return [d, `${L("Pool", 30)}${L(h1, w)}${h2}`, d, ...rows.map((r) => `${L(r.pool, 30)}${L(val(r.pool, r.total), w)}${val(r.pool, r.um)}`)];
}

function deviceWatermark(dev: Device): string[] {
  const bytes = poolWatermarks(dev).reduce((n, r) => n + r.total, 0);
  const total = Object.values(POOLS).reduce((n, p) => n + p.size, 0);
  return [`Utilization (Bytes)   : ${bytes}`, `Utilization (Percent) : ${pct(bytes, total)}`];
}

// ---------------------------------------------------------------- PFC watchdog

function pfcWatchdog(dev: Device): string[] {
  const poll = peekFeatureState<{ pfcwd?: { pollInterval?: number } }>(dev, "pfc")?.pfcwd?.pollInterval;
  const cp = cpRunningLines(dev).map((l) => /^priority-flow-control watchdog counter-poll (enable|disable)/.exec(l.line.trim())).filter(Boolean).pop();
  return [" ", "Watchdog Summary", "----------------",
    `${L("Polling Interval:", 20)}: ${poll ?? "Not Configured (default 100ms)"}`,
    `${L("Flex Counters:", 20)}: ${cp ? `${cp[1]}d` : "Not Available"}`, " "];
}

// ---------------------------------------------------------------- service-policy CtrlPlane

/** copp-system-policy bound to CtrlPlane: one flow per CoPP trap group (copp_cfg.j2), policer + counters from the CoPP path. */
function ctrlPlanePolicy(dev: Device): string[] {
  const rt = peekCoppRuntime(dev);
  const out = ["CtrlPlane", "  Policy copp-system-policy type copp at ingress", "  Description: "];
  const groups = Object.entries(DEFAULT_GROUPS).filter(([n]) => n !== "default").sort((a, b) => (b[1].trapPriority ?? 0) - (a[1].trapPriority ?? 0));
  for (const [name, g] of groups) {
    const c = rt?.groups[name];
    out.push(`    Flow copp-system-${name} at priority ${g.trapPriority ?? 0} (Active)`, "      Description: ",
      `      set-trap-queue ${g.queue}`,
      `      police: cir ${g.cir ?? 0} cbs ${g.cbs ?? 0} pir 0 pbs 0 (Active)`,
      `        type ${g.meterType} mode color-blind`,
      `        operational cir ${g.cir ?? 0} cbs ${g.cbs ?? 0} pir 0 pbs 0`,
      `        green ${c ? c.pkts : 0} packets ${c ? c.bytes : 0} bytes action forward`,
      "        yellow 0 packets 0 bytes action forward",
      `        red ${c ? c.dropPkts : 0} packets ${c ? c.dropBytes : 0} bytes action drop`,
      `      Packet matches: ${c ? c.pkts + c.dropPkts : 0} frames ${c ? c.bytes + c.dropBytes : 0} bytes`);
  }
  return out;
}

// ---------------------------------------------------------------- TCAM allocation

const TCAM_FEATURES = ["mac-acl", "ip-acl", "ipv6-acl", "forwarding-fbs", "qos-fbs", "monitoring-fbs"];

/** show_tcam_allocation.j2: configured key-profile vs. the one enforced at boot (config takes effect after save + reboot). */
function tcamAllocation(dev: Device, k: string[]): string[] {
  const feats = TCAM_FEATURES.filter((f) => !k.some((t) => TCAM_FEATURES.includes(t)) || k.includes(f));
  const stages = ["ingress", "egress"].filter((s) => !k.includes("ingress") && !k.includes("egress") || k.includes(s));
  const cfg = cpList(dev, "hardware", "tcam");
  const d = "-".repeat(91);
  const out: string[] = [];
  for (const st of stages) {
    out.push(`${st.charAt(0).toUpperCase()}${st.slice(1)}:`, d, `${L("Feature", 17)}${L(" ", 17)}Key-Profile`, `${L(" ", 17)}${L("Configured", 32)}Current`, d);
    for (const f of feats) {
      const c = cfg.find((x) => x.feature === f && x.stage === st);
      const conf = c ? String(c.profile) : "-";
      const cur = "-";
      out.push(`${L(f, 17)}${L(conf, 32)}${cur !== conf ? `${cur}*` : cur}`.trimEnd());
    }
    out.push(d);
  }
  out.push("* Indicates configured and current/enforced key-profile are different.",
    "  Please save the config and reboot to enforce the configured key-profile, if current",
    "  key-profile is different.");
  return out;
}

// ---------------------------------------------------------------- dispatcher

registerModal({
  id: "qos-buffer-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const dev = ctx.device;
    const k = args.map((t) => t.toLowerCase());
    const pipe = k.indexOf("|");
    if (pipe >= 0) {
      k.length = pipe;
      args = args.slice(0, pipe);
    }
    const out = (t: string[]) => ({ output: lines(t) });

    if (k[0] === "queue") {
      if (k[1] === "counters") {
        if (k[2] === undefined) return out(queueCountersAll(dev));
        if (k[2] !== "interface") return null; // Click form `show queue counters Ethernet2` → sonic-utilities layer
        const { name, used } = ifArg(args.slice(3));
        const qi = 3 + used;
        const qid = k[qi] === "queue" ? k[qi + 1] : undefined;
        if (name === "CPU") {
          const rows = cpuQueueRows(dev);
          return out(queueCountersOne(qid !== undefined ? rows.filter((r) => r.name === `MC${qid}`) : rows));
        }
        if (!frontPanel(dev).some((p) => p.name === name)) return { output: [err(`%Error: Interface ${name ?? ""} not found`)] };
        const rows = portQueueRows(dev, name!);
        return out(queueCountersOne(qid !== undefined ? rows.filter((r) => r.name.slice(2) === qid) : rows));
      }
      if (k[1] === "wred-ecn" && k[2] === "counters") {
        if (k[3] !== "interface") return out(wredAll(dev, frontPanel(dev).map((p) => p.name), true));
        const name = ifArg(args.slice(4)).name ?? "";
        return out(frontPanel(dev).some((p) => p.name === name) ? wredAll(dev, [name], false) : []);
      }
      if (k[1] === "watermark" || k[1] === "persistent-watermark") {
        const r = queueWatermark(dev, k, args);
        return r ? out(r) : null;
      }
      return null;
    }
    if (k[0] === "priority-group" && (k[1] === "watermark" || k[1] === "persistent-watermark")) {
      const r = pgWatermark(dev, k, args);
      return r ? out(r) : null;
    }
    if (k[0] === "buffer") {
      if (k[1] === "pool") return out(bufferPools());
      if (k[1] === "profile") return out(bufferProfiles());
      if (k[1] === "interface") {
        const { name, used } = ifArg(args.slice(2));
        const kind = k[2 + used];
        if (kind !== "priority-group" && kind !== "queue" && kind !== "cable-length") return null;
        const ports = name?.toLowerCase().endsWith("all") ? frontPanel(dev).map((p) => p.name) : frontPanel(dev).filter((p) => p.name === name).map((p) => p.name);
        return out(ports.length ? bufferInterface(dev, ports, kind) : []);
      }
      return null;
    }
    if (k[0] === "buffer-pool" && (k[1] === "watermark" || k[1] === "persistent-watermark")) return out(bufferPoolWatermark(dev, k, args));
    if (k[0] === "device" && (k[1] === "watermark" || k[1] === "persistent-watermark")) return out(deviceWatermark(dev));
    if (k[0] === "priority-flow-control" && (k[1] === undefined || k[1] === "watchdog")) return out(pfcWatchdog(dev));
    if (k[0] === "service-policy" && (k[1] === "switch" || k[1] === "ctrlplane")) {
      if (k[1] === "ctrlplane") return out(ctrlPlanePolicy(dev));
      const ti = k.indexOf("type");
      return out(renderServicePolicy(dev, { iface: "Switch", type: ti >= 0 ? k[ti + 1] : undefined }));
    }
    if (k[0] === "hardware" && k[1] === "tcam" && k[2] === "allocation") return out(tcamAllocation(dev, k.slice(3)));
    return null;
  },
});
