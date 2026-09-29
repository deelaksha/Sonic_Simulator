/**
 * Threshold — CONFIG-PLANE clone (store + show, no engine backend).
 *
 *   sonic(config)# threshold device <1-100>                         device level
 *   sonic(config)# threshold buffer-pool <pool> shared|multicast <1-100>
 *   sonic(conf-if-EthernetN)# threshold priority-group <0-7> shared|headroom <1-100>
 *   sonic(conf-if-EthernetN)# threshold queue <0-7> unicast|multicast <1-100>
 *   sonic(conf-if-EthernetN)# threshold buffer-pool <pool> shared|unicast <1-100>
 *   sonic(config)# no threshold device | no threshold buffer-pool <pool> <type> ...
 *   sonic# show threshold [device|buffer-pool|priority-group|queue|breaches]
 *
 * Mirrors CONFIG_DB THRESHOLD_DEVICE_TABLE / THRESHOLD_BUFFERPOOL_TABLE /
 * THRESHOLD_TABLE / THRESHOLD_BUFFERPOOL_INTERFACE_TABLE on the real box: we store
 * exactly what was configured and render it back on show. The runtime effect —
 * buffers actually breaching a configured threshold and the resulting breach
 * events / watermark counters — is a data-plane behaviour this simulator does not
 * model, so `show threshold breaches` never fabricates operational data.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpGet, cpList } from "../config-plane";
import { Device } from "../../../models/device";

const ID = "threshold";

// PERCENT_1: threshold value is a percentage, valid 1-100.
function pct(s: string | undefined): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}
// RANGE_0_7: priority-group / queue index.
function idx(s: string | undefined): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 7 ? n : null;
}

interface PoolEntry { key: string; pool: string; type: string; value: number }
interface TableEntry { key: string; buffer: string; iface: string; index: number; type: string; value: number }
interface PoolIfEntry { key: string; pool: string; iface: string; type: string; value: number }

// configure-view: device-level and global buffer-pool thresholds.
registerModal({
  id: "threshold",
  views: ["configure-view"],
  keywords: ["threshold"],
  run({ isNo, args, ctx }) {
    const sub = args[0]?.toLowerCase();
    const dev = ctx.device;

    if (sub === "device") {
      if (isNo) {
        cpUnset(dev, ID, "device");
        return { output: [] };
      }
      const v = pct(args[1]);
      if (v === null) return { output: [err("% Threshold value must be an integer in range 1-100.")] };
      cpSet(dev, ID, "device", v);
      return { output: [] };
    }

    if (sub === "buffer-pool") {
      const pool = args[1];
      const type = args[2]?.toLowerCase();
      if (!pool) return { output: [err("% Buffer pool name required.")] };
      if (type !== "shared" && type !== "multicast") {
        return { output: [err("% Buffer type must be shared or multicast.")] };
      }
      const key = `${pool}|${type}`;
      if (isNo) {
        cpRemove(dev, ID, "bufferpool", "key", key);
        return { output: [] };
      }
      const v = pct(args[3]);
      if (v === null) return { output: [err("% Threshold value must be an integer in range 1-100.")] };
      cpUpsert(dev, ID, "bufferpool", { key, pool, type, value: v }, "key");
      return { output: [] };
    }

    return { output: [err("% Expected: threshold device | threshold buffer-pool <pool> <type> <value>.")] };
  },
});

// configure-if-view: per-interface priority-group / queue / buffer-pool thresholds.
registerModal({
  id: "threshold-if",
  views: ["configure-if-view"],
  keywords: ["threshold"],
  run({ isNo, args, ifname, ctx }) {
    const dev = ctx.device;
    const iface = ifname ?? "";
    const sub = args[0]?.toLowerCase();

    if (sub === "priority-group" || sub === "queue") {
      const buffer = sub; // "priority-group" | "queue"
      const i = idx(args[1]);
      if (i === null) return { output: [err(`% ${buffer} index must be an integer in range 0-7.`)] };
      const type = args[2]?.toLowerCase();
      const allowed = buffer === "priority-group" ? ["shared", "headroom"] : ["unicast", "multicast"];
      if (!type || !allowed.includes(type)) {
        return { output: [err(`% Buffer type must be ${allowed.join(" or ")}.`)] };
      }
      const key = `${iface}|${buffer}|${i}|${type}`;
      if (isNo) {
        cpRemove(dev, ID, "table", "key", key);
        return { output: [] };
      }
      const v = pct(args[3]);
      if (v === null) return { output: [err("% Threshold value must be an integer in range 1-100.")] };
      cpUpsert(dev, ID, "table", { key, buffer, iface, index: i, type, value: v }, "key");
      return { output: [] };
    }

    if (sub === "buffer-pool") {
      const pool = args[1];
      const type = args[2]?.toLowerCase();
      if (!pool) return { output: [err("% Buffer pool name required.")] };
      if (type !== "shared" && type !== "unicast") {
        return { output: [err("% Buffer type must be shared or unicast.")] };
      }
      const key = `${iface}|${pool}|${type}`;
      if (isNo) {
        cpRemove(dev, ID, "bufferpool_if", "key", key);
        return { output: [] };
      }
      const v = pct(args[3]);
      if (v === null) return { output: [err("% Threshold value must be an integer in range 1-100.")] };
      cpUpsert(dev, ID, "bufferpool_if", { key, pool, iface, type, value: v }, "key");
      return { output: [] };
    }

    return { output: [err("% Expected: threshold priority-group|queue|buffer-pool ...")] };
  },
});

function renderDevice(dev: Device): OutputLine[] {
  const d = cpGet(dev, ID)?.device as number | undefined;
  return d === undefined ? [muted("No device threshold configured")] : [line(`Threshold: ${d}`)];
}

function renderBufferPool(dev: Device, ifaceFilter?: string): OutputLine[] {
  const out: OutputLine[] = [];
  if (!ifaceFilter) {
    for (const e of cpList(dev, ID, "bufferpool") as unknown as PoolEntry[]) {
      out.push(line(`Pool: ${e.pool}  Buffer-type: ${e.type}  Threshold: ${e.value}%`));
    }
  }
  for (const e of cpList(dev, ID, "bufferpool_if") as unknown as PoolIfEntry[]) {
    if (ifaceFilter && e.iface !== ifaceFilter) continue;
    out.push(line(`Interface: ${e.iface}  Pool: ${e.pool}  Buffer-type: ${e.type}  Threshold: ${e.value}%`));
  }
  return out.length ? out : [muted("No buffer-pool thresholds configured")];
}

function renderTable(dev: Device, buffer: string, typeFilter?: string): OutputLine[] {
  const rows = (cpList(dev, ID, "table") as unknown as TableEntry[]).filter(
    (e) => e.buffer === buffer && (!typeFilter || e.type === typeFilter),
  );
  if (!rows.length) return [muted(`No ${buffer} thresholds configured`)];
  return rows.map((e) =>
    line(`Interface: ${e.iface}  Index: ${e.index}  Buffer-type: ${e.type}  Threshold: ${e.value}%`),
  );
}

// enable-view: `show threshold [device|buffer-pool|priority-group|queue|breaches]`.
registerModal({
  id: "threshold-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "threshold") return null; // not ours
    const dev = ctx.device;
    const sub = args[1]?.toLowerCase();

    if (sub === "device") return { output: renderDevice(dev) };
    if (sub === "buffer-pool") {
      const ifaceFilter = args[2]?.toLowerCase() === "interface" ? args[3] : undefined;
      return { output: renderBufferPool(dev, ifaceFilter) };
    }
    if (sub === "priority-group") return { output: renderTable(dev, "priority-group", args[2]?.toLowerCase()) };
    if (sub === "queue") return { output: renderTable(dev, "queue", args[2]?.toLowerCase()) };
    if (sub === "breaches") {
      // Breach events are recorded by the box at runtime as buffers cross their
      // configured thresholds — a data-plane effect this lab does not model.
      return { output: [muted("No threshold breach events recorded (breach detection is a data-plane effect not simulated in this lab)")] };
    }

    // Bare `show threshold` — render everything configured, nothing fabricated.
    const out: OutputLine[] = [];
    out.push(line("Device:"));
    for (const l of renderDevice(dev)) out.push(line(`  ${l.text}`, l.kind));
    out.push(line("Buffer-pool:"));
    for (const l of renderBufferPool(dev)) out.push(line(`  ${l.text}`, l.kind));
    out.push(line("Priority-group:"));
    for (const l of renderTable(dev, "priority-group")) out.push(line(`  ${l.text}`, l.kind));
    out.push(line("Queue:"));
    for (const l of renderTable(dev, "queue")) out.push(line(`  ${l.text}`, l.kind));
    return { output: out };
  },
});
