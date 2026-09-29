/**
 * VXLAN — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 *   sonic(config)# interface vxlan vtep1            -> enter the VTEP sub-view
 *   sonic(conf-if-vxlan-vtep1)# source-ip 1.1.1.1
 *   sonic(conf-if-vxlan-vtep1)# primary-ip 1.1.1.2
 *   sonic(conf-if-vxlan-vtep1)# qos-mode pipe dscp 5
 *   sonic(conf-if-vxlan-vtep1)# map vni 100 vlan 100 count 2
 *   sonic(conf-if-vxlan-vtep1)# map vni 600 vrf Vrf1
 *   sonic(conf-if-vxlan-vtep1)# no source-ip / no map vni 100 vlan 100
 *   sonic# show vxlan interface | vlanvnimap | vrfvnimap    -> render from store
 *
 * VXLAN config lives in a DEDICATED SUB-MODE (grammar view="configure-vxlan-view",
 * entered by `interface vxlan <name>`), so we follow the sub-mode pattern and store
 * the VTEP + its VNI maps in the config-plane store, keyed by the VTEP name that the
 * core carries into the sub-view as `viewctx`.
 *
 * NOTE ON ENTRY: the entry command `interface vxlan <name>` is dispatched by the
 * shared core (lib/commands/sonic-cli.ts) which intercepts every `interface ...`
 * line for interface-name normalisation before feature handlers run. Cloning that
 * one entry line would require editing that shared file, which is out of scope for
 * this feature module; the core's generic `gv:` frame mechanism (subViewFrame)
 * carries the VTEP name into `configure-vxlan-view` where the handler below stores
 * the fields exactly as the real box's VXLAN_TUNNEL / VXLAN_TUNNEL_MAP tables do.
 *
 * DATA-PLANE: VXLAN encapsulation/tunnelling is an ASIC/data-plane function the sim
 * cannot forward, so runtime state (discovered tunnels, remote VNIs/MACs, per-tunnel
 * counters) is NEVER fabricated — those `show` variants report that runtime state is
 * not simulated. Only configured values (source-ip, qos-mode, VNI maps) are shown.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { Device } from "../../../models/device";

type Row = Record<string, string>;

const isIpv4 = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const upsertVtep = (dev: Device, name: string, patch: Row): void =>
  cpUpsert(dev, "vxlan", "vteps", { name, ...patch }, "name");

// configure-vxlan-view: per-VTEP config. `viewctx` is the VTEP name from the core.
registerModal({
  id: "vxlan",
  views: ["configure-vxlan-view"],
  keywords: ["source-ip", "primary-ip", "external-ip", "qos-mode", "map"],
  run({ head, isNo, args, viewctx, ctx }) {
    const name = viewctx;
    if (!name) return null;
    const dev = ctx.device;

    if (head === "source-ip" || head === "primary-ip" || head === "external-ip") {
      const field = head === "source-ip" ? "source_ip" : head === "primary-ip" ? "primary_ip" : "external_ip";
      if (isNo) {
        upsertVtep(dev, name, { [field]: "" });
        return { output: [] };
      }
      if (!args[0]) return { output: [err(`% ${head} requires an IPv4 address or Loopback interface.`)] };
      upsertVtep(dev, name, { [field]: args[0] });
      return { output: [] };
    }

    if (head === "qos-mode") {
      if (isNo) return null; // no `no qos-mode` on the real box
      const mode = (args[0] ?? "").toLowerCase();
      if (mode !== "uniform" && mode !== "pipe") return { output: [err("% qos-mode must be uniform | pipe.")] };
      const dscp = mode === "pipe" && args[1]?.toLowerCase() === "dscp" ? (args[2] ?? "") : "";
      upsertVtep(dev, name, { qos_mode: mode, dscp });
      return { output: [] };
    }

    // map vni <vnid> vlan <vlanid> [count <n>]  |  map vni <vnid> vrf <vrfname>
    if (head === "map") {
      if (args[0]?.toLowerCase() !== "vni" || !args[1]) return { output: [err("% usage: map vni <vnid> {vlan <vlanid> [count <n>] | vrf <name>}")] };
      const vni = Number(args[1]);
      if (!Number.isInteger(vni)) return { output: [err("% VNID must be a number (1-16777215).")] };
      const opt = (args[2] ?? "").toLowerCase();
      if (opt === "vlan") {
        const vlan = Number(args[3]);
        if (!Number.isInteger(vlan)) return { output: [err("% VLAN ID must be a number.")] };
        const count = args[4]?.toLowerCase() === "count" ? Math.max(1, Number(args[5]) || 1) : 1;
        for (let i = 0; i < count; i++) {
          const vname = `Vlan${vlan + i}`;
          if (isNo) cpRemove(dev, "vxlan", "vlanmap", "vlan", vname);
          else cpUpsert(dev, "vxlan", "vlanmap", { vlan: vname, vni: String(vni + i) }, "vlan");
        }
        return { output: [] };
      }
      if (opt === "vrf") {
        const vrf = args[3];
        if (!vrf) return { output: [err("% VRF name required.")] };
        if (isNo) cpRemove(dev, "vxlan", "vrfmap", "vrf", vrf);
        else cpUpsert(dev, "vxlan", "vrfmap", { vrf, vni: String(vni) }, "vrf");
        return { output: [] };
      }
      return { output: [err("% expected `vlan` or `vrf` after the VNID.")] };
    }

    return null;
  },
});

// --- show rendering (enable-view) ------------------------------------------

const kv = (k: string, v: string): OutputLine => line(`${k.padEnd(16)} :  ${v}`);

/** tabulate-style grid matching `show vxlan vlanvnimap/vrfvnimap` output. */
function grid(headers: string[], rows: string[][], right: boolean[]): OutputLine[] {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const bar = (fill: string): OutputLine => line("+" + w.map((n) => fill.repeat(n + 2)).join("+") + "+");
  const fmt = (cells: string[]): OutputLine =>
    line("| " + cells.map((c, i) => (right[i] ? c.padStart(w[i]) : c.padEnd(w[i]))).join(" | ") + " |");
  const out: OutputLine[] = [bar("-"), fmt(headers), bar("=")];
  for (const r of rows) { out.push(fmt(r)); out.push(bar("-")); }
  return out;
}

function showInterface(dev: Device): OutputLine[] {
  const vteps = cpList(dev, "vxlan", "vteps") as Row[];
  if (!vteps.length) return [muted("No VXLAN VTEP configured")];
  const out: OutputLine[] = [];
  for (const v of vteps) {
    const src = v.source_ip ?? "";
    out.push(kv("VTEP Name", v.name));
    out.push(kv("VTEP Source IP", isIpv4(src) ? src : ""));
    out.push(kv("QoS Mode", v.qos_mode === "pipe" ? `pipe (dscp:${v.dscp || "0"})` : v.qos_mode === "uniform" ? "uniform" : ""));
    out.push(kv("Source Interface", isIpv4(src) ? "" : src));
    if (v.primary_ip) out.push(kv("VTEP Primary IP", v.primary_ip));
    if (v.external_ip) out.push(kv("VTEP External IP", v.external_ip));
    out.push(line(""));
  }
  return out;
}

function showMap(dev: Device, storeKey: string, idField: string, col: string, label: string, count: boolean): OutputLine[] {
  const rows = (cpList(dev, "vxlan", storeKey) as Row[]).map((m) => [m[idField], m.vni]);
  if (count) return [line(`Total count : ${rows.length}`)];
  if (!rows.length) return [muted(`No ${label} mappings configured`)];
  return [...grid([col, "VNI"], rows, [false, true]), line(`Total count : ${rows.length}`)];
}

const RUNTIME = "% VXLAN data-plane is not simulated in this lab; runtime state (discovered tunnels, remote VNIs/MACs, per-tunnel counters) is not modelled.";

registerModal({
  id: "vxlan-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "vxlan") return null; // not ours
    const sub = (args[1] ?? "").toLowerCase();
    const dev = ctx.device;
    if (sub === "interface") return { output: showInterface(dev) };
    if (sub === "vlanvnimap") return { output: showMap(dev, "vlanmap", "vlan", "VLAN", "VLAN VNI", args[2]?.toLowerCase() === "count") };
    if (sub === "vrfvnimap") return { output: showMap(dev, "vrfmap", "vrf", "VRF", "VRF VNI", args[2]?.toLowerCase() === "count") };
    if (sub === "tunnel" || sub === "remote" || sub === "counters") return { output: [muted(RUNTIME)] };
    return { output: [muted("% specify one of: interface | vlanvnimap | vrfvnimap")] };
  },
});
