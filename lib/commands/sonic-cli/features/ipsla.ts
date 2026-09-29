/**
 * IP SLA — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 *   sonic(config)# ip sla <1-255>                  create instance + enter sub-view
 *   sonic(conf-ipsla-10)# frequency <1-300>        store IP_SLA fields
 *   sonic(conf-ipsla-10)# timeout <1-300>
 *   sonic(conf-ipsla-10)# threshold <1-300>
 *   sonic(conf-ipsla-10)# icmp-echo <addr>         set ICMP op + enter icmp sub-view
 *   sonic(conf-ipsla-10-icmp)# source-address <ip>
 *   sonic(conf-ipsla-10-icmp)# source-interface <if>
 *   sonic(conf-ipsla-10-icmp)# request-data-size <28-1472>
 *   sonic(conf-ipsla-10-icmp)# ttl|tos <n> | source-vrf <vrf>
 *   sonic(conf-ipsla-20)# tcp-connect <addr> port <1-65535>  set TCP op + sub-view
 *   sonic(conf-ipsla-20-tcp)# source-address|source-port|source-interface|ttl|tos|source-vrf
 *   sonic(config)# no ip sla <id>                  remove a whole instance
 *   sonic(conf-ipsla-*)# no <field>                clear one field
 *   sonic# show ip sla [<id> [history]]            render IP_SLA config
 *
 * Mirrors the real box's sonic-ip-sla IP_SLA_LIST CONFIG_DB table (see
 * data/device-capture/klish-xml/ipsla.xml). Config is stored honestly and
 * `show ip sla` renders exactly what was configured.
 *
 * DATA-PLANE NOT SIMULATED: the probe engine is not modelled — operational
 * fields in the box output (Operation state, state transitions, last change,
 * per-probe counters, and `show ip sla <id> history`) are runtime state and are
 * rendered as "-" / a not-simulated note, never fabricated.
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";
import { Device } from "../../../models/device";

// configure-ipsla-icmp-view sub-command -> IP_SLA field.
const ICMP_FIELDS: Record<string, { field: string; numeric?: boolean }> = {
  "source-address": { field: "icmp_src_ip" },
  "source-interface": { field: "icmp_src_if" },
  "request-data-size": { field: "icmp_size", numeric: true },
  ttl: { field: "icmp_ttl", numeric: true },
  tos: { field: "icmp_tos", numeric: true },
  "source-vrf": { field: "icmp_vrf" },
};

// configure-ipsla-tcp-view sub-command -> IP_SLA field.
const TCP_FIELDS: Record<string, { field: string; numeric?: boolean }> = {
  "source-address": { field: "tcp_src_ip" },
  "source-port": { field: "tcp_src_port", numeric: true },
  "source-interface": { field: "tcp_src_if" },
  ttl: { field: "tcp_ttl", numeric: true },
  tos: { field: "tcp_tos", numeric: true },
  "source-vrf": { field: "tcp_vrf" },
};

// All ICMP / TCP fields — cleared when the operation type is removed.
const ICMP_ALL = ["icmp_dst", ...Object.values(ICMP_FIELDS).map((f) => f.field), "type"];
const TCP_ALL = ["tcp_dst", "tcp_dst_port", ...Object.values(TCP_FIELDS).map((f) => f.field), "type"];

/** Merge a field onto the instance identified by `id`. */
function setField(device: Device, id: string, field: string, value: unknown): void {
  cpUpsert(device, "ipsla", "instances", { id, [field]: value }, "id");
}

/** Remove one or more fields from the instance identified by `id` (the `no` form). */
function clearFields(device: Device, id: string, fields: string[]): void {
  const inst = cpList(device, "ipsla", "instances").find((d) => d.id === id);
  if (!inst) return;
  const copy: Record<string, unknown> = { ...inst };
  for (const f of fields) delete copy[f];
  cpRemove(device, "ipsla", "instances", "id", id);
  cpUpsert(device, "ipsla", "instances", copy, "id");
}

/** Shared runner for the icmp/tcp sub-views (single-value fields). */
function applyField(
  device: Device,
  id: string,
  head: string,
  isNo: boolean,
  args: string[],
  fields: Record<string, { field: string; numeric?: boolean }>,
): { output: OutputLine[] } | null {
  const f = fields[head];
  if (!f) return null; // not ours
  if (isNo) {
    clearFields(device, id, [f.field]);
    return { output: [] };
  }
  const value = args.join(" ").trim();
  if (!value) return { output: [err(`% ${head} requires a value`)] };
  if (f.numeric && !/^\d+$/.test(value)) return { output: [err(`% ${head} value must be an integer`)] };
  setField(device, id, f.field, value);
  return { output: [] };
}

// configure-view: `ip sla <id>` (enter sub-view) and `no ip sla <id>`.
registerModal({
  id: "ipsla",
  views: ["configure-view"],
  keywords: ["ip"],
  run({ isNo, args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "sla") return null; // not ours (ip route, ip ssh, ...)
    const id = args[1];
    if (!id || !/^\d+$/.test(id) || +id < 1 || +id > 255)
      return { output: [err("% IP SLA ID must be an integer (1-255)")] };
    if (isNo) {
      cpRemove(ctx.device, "ipsla", "instances", "id", id);
      return { output: [] };
    }
    cpUpsert(ctx.device, "ipsla", "instances", { id }, "id");
    return { output: [], enter: subViewFrame("configure-ipsla-view", id) };
  },
});

// configure-ipsla-view: frequency/threshold/timeout + icmp-echo / tcp-connect entry.
registerModal({
  id: "ipsla-instance",
  views: ["configure-ipsla-view"],
  keywords: ["frequency", "threshold", "timeout", "icmp-echo", "tcp-connect"],
  run({ isNo, args, head, viewctx, ctx }) {
    const id = viewctx ?? "";

    if (head === "frequency" || head === "threshold" || head === "timeout") {
      if (isNo) {
        clearFields(ctx.device, id, [head]);
        return { output: [] };
      }
      const val = args[0];
      if (!val || !/^\d+$/.test(val)) return { output: [err(`% ${head} value must be an integer (1-300)`)] };
      setField(ctx.device, id, head, val);
      return { output: [] };
    }

    if (head === "icmp-echo") {
      if (isNo) {
        clearFields(ctx.device, id, ICMP_ALL);
        return { output: [] };
      }
      const addr = args[0];
      if (!addr) return { output: [err("% ICMP destination IP address required")] };
      cpUpsert(ctx.device, "ipsla", "instances", { id, type: "ICMP-echo", icmp_dst: addr }, "id");
      return { output: [], enter: subViewFrame("configure-ipsla-icmp-view", id) };
    }

    if (head === "tcp-connect") {
      if (isNo) {
        clearFields(ctx.device, id, TCP_ALL);
        return { output: [] };
      }
      const addr = args[0];
      if (!addr) return { output: [err("% TCP destination IP address required")] };
      if ((args[1] ?? "").toLowerCase() !== "port" || !args[2])
        return { output: [err("% syntax: tcp-connect <addr> port <1-65535>")] };
      const port = args[2];
      if (!/^\d+$/.test(port)) return { output: [err("% TCP destination port must be an integer (1-65535)")] };
      cpUpsert(ctx.device, "ipsla", "instances", { id, type: "TCP-connect", tcp_dst: addr, tcp_dst_port: port }, "id");
      return { output: [], enter: subViewFrame("configure-ipsla-tcp-view", id) };
    }

    return null;
  },
});

// configure-ipsla-icmp-view: per-instance ICMP fields (sla-id carried in viewctx).
registerModal({
  id: "ipsla-icmp",
  views: ["configure-ipsla-icmp-view"],
  keywords: Object.keys(ICMP_FIELDS),
  run({ isNo, args, head, viewctx, ctx }) {
    return applyField(ctx.device, viewctx ?? "", head, isNo, args, ICMP_FIELDS);
  },
});

// configure-ipsla-tcp-view: per-instance TCP fields (sla-id carried in viewctx).
registerModal({
  id: "ipsla-tcp",
  views: ["configure-ipsla-tcp-view"],
  keywords: Object.keys(TCP_FIELDS),
  run({ isNo, args, head, viewctx, ctx }) {
    return applyField(ctx.device, viewctx ?? "", head, isNo, args, TCP_FIELDS);
  },
});

// Detailed `show ip sla <id>` rows (label -> stored field). Rendered only when set.
const ICMP_DETAIL: { label: string; field: string }[] = [
  { label: "ICMP destination IP address", field: "icmp_dst" },
  { label: "ICMP source IP address", field: "icmp_src_ip" },
  { label: "ICMP source interface", field: "icmp_src_if" },
  { label: "ICMP request data size", field: "icmp_size" },
  { label: "ICMP Time-To-Live(TTL)", field: "icmp_ttl" },
  { label: "ICMP Type-of-Service(ToS)", field: "icmp_tos" },
  { label: "Source VRF", field: "icmp_vrf" },
  { label: "Operation frequency (sec)", field: "frequency" },
  { label: "Operation timeout (sec)", field: "timeout" },
  { label: "Operation threshold", field: "threshold" },
];
const TCP_DETAIL: { label: string; field: string }[] = [
  { label: "TCP destination IP address", field: "tcp_dst" },
  { label: "TCP destination port", field: "tcp_dst_port" },
  { label: "TCP source IP address", field: "tcp_src_ip" },
  { label: "TCP source port", field: "tcp_src_port" },
  { label: "TCP source interface", field: "tcp_src_if" },
  { label: "TCP Time-To-Live(TTL)", field: "tcp_ttl" },
  { label: "TCP Type-of-Service(ToS)", field: "tcp_tos" },
  { label: "Source VRF", field: "tcp_vrf" },
  { label: "Operation frequency (sec)", field: "frequency" },
  { label: "Operation timeout (sec)", field: "timeout" },
  { label: "Operation threshold", field: "threshold" },
];
const COMMON_DETAIL: { label: string; field: string }[] = [
  { label: "Operation frequency (sec)", field: "frequency" },
  { label: "Operation timeout (sec)", field: "timeout" },
  { label: "Operation threshold", field: "threshold" },
];

const cell = (v: unknown) => (v === undefined || v === "" ? "-" : String(v));

// enable-view: `show ip sla [<id> [history]]` renders configured IP SLA instances.
registerModal({
  id: "ipsla-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ip" || args[1]?.toLowerCase() !== "sla") return null; // not ours
    const instances = cpList(ctx.device, "ipsla", "instances");
    const idArg = args[2];

    // Summary: `show ip sla`.
    if (!idArg) {
      if (!instances.length) return { output: [muted("No IP SLA instances configured")] };
      const row = (a: string, b: string, c: string, d: string, e: string, f: string, g: string) =>
        a.padEnd(8) + b.padEnd(13) + c.padEnd(6) + d.padEnd(26) + e.padEnd(13) + f.padEnd(13) + g;
      const out: OutputLine[] = [
        line(row("SLA#", "Type", "State", "Target", "VRF", "Transitions", "Last change")),
        line(row("----", "----", "-----", "------", "---", "-----------", "-----------")),
      ];
      for (const i of instances) {
        const isTcp = i.type === "TCP-connect";
        const target = isTcp ? `${cell(i.tcp_dst)}(${cell(i.tcp_dst_port)})` : cell(i.icmp_dst);
        const vrf = cell(isTcp ? i.tcp_vrf : i.icmp_vrf);
        // State / Transitions / Last change are operational — not simulated.
        out.push(line(row(cell(i.id), cell(i.type), "-", target, vrf, "-", "-")));
      }
      out.push(muted("Operational state (State/Transitions/Last change) is not simulated."));
      return { output: out };
    }

    // Detailed: `show ip sla <id> [history]`.
    const inst = instances.find((i) => i.id === idArg);
    if (!inst) return { output: [err(`% IP SLA instance ${idArg} not configured`)] };
    if (args[3]?.toLowerCase() === "history")
      return { output: [muted(`IP SLA ${idArg} history is operational state — not simulated`)] };

    const rows = inst.type === "TCP-connect" ? TCP_DETAIL : inst.type === "ICMP-echo" ? ICMP_DETAIL : COMMON_DETAIL;
    const out: OutputLine[] = [line(`IP SLA Operation Number: ${String(inst.id)}`)];
    if (inst.type) out.push(line(`Type of Operation: ${String(inst.type)}`));
    for (const r of rows) {
      const v = inst[r.field];
      if (v !== undefined && v !== "") out.push(line(`${r.label}: ${String(v)}`));
    }
    out.push(muted("Operational state and per-probe counters are not simulated."));
    return { output: out };
  },
});
