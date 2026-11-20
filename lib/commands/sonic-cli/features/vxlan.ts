/**
 * VXLAN — KLISH VTEP sub-mode + `show vxlan ...` (the data plane and EVPN glue are
 * lib/protocols/vxlan-daemon.ts; Click forms lib/protocols/vxlan-cli.ts).
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
 * Runtime views (`show vxlan tunnel`, `show vxlan remote vni|mac [<ip>] [count]`)
 * render the VTEP's live EVPN state. The KLISH templates are not part of the source
 * tree, so they use the sonic-utilities tables (show/vxlan.py remotevtep/remotevni/
 * remotemac); `show vxlan counters` prints the tunnelstat table.
 *
 * Symmetric IRB / ARP suppression (behaviour in lib/protocols/vxlan-daemon.ts):
 *   sonic(conf-if-vxlan-vtep1)# map vni 50000 vrf Vrf-red     L3 VNI of the VRF
 *   sonic(conf-if-Vlan10)# neigh-suppress                    (interface.xml:1142,
 *                                                SUPPRESS_VLAN_NEIGH|Vlan10 suppress=on)
 *   sonic(config)# router bgp 65001 vrf Vrf-red              the VRF's BGP instance
 *   sonic(config-router-bgp)# address-family l2vpn evpn
 *   sonic(config-router-bgp-af)# advertise ipv4 unicast      (bgp_af_l2vpn.xml) → type-5
 *   sonic# show neighbor-suppress-status [Vlan <id>]         (interface.xml:486)
 * The VRF instance itself belongs to the BGP module (features/bgp.ts, sub-view context
 * "<ctx>@<vrf>"); only `advertise ipv4 unicast` in its l2vpn evpn view is handled here
 * (cp_vxlan "bgpvrf").
 *
 * KLISH creates the VXLAN_EVPN_NVO implicitly with the VTEP (there is no NVO command
 * in the KLISH grammar, unlike Click `config vxlan evpn_nvo add`): setting the
 * source-ip also stores NVO "nvo1" for the VTEP. (Assumption — the Broadcom
 * transformer source is not available.)
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { Device } from "../../../models/device";
import { showRemoteMac, showRemoteVni, showRemoteVtep, showVlanVniMap, showVrfVniMap, showVxlanCounters } from "../../../protocols/vxlan-cli";

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
      upsertVtep(dev, name, { [field]: args.join("") });
      if (field === "source_ip" && !cpList(dev, "vxlan", "nvo").length) cpUpsert(dev, "vxlan", "nvo", { name: "nvo1", source_vtep: name }, "name");
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
          else cpUpsert(dev, "vxlan", "vlanmap", { vlan: vname, vni: String(vni + i), vtep: name }, "vlan");
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

// configure-vlan-view: `[no] neigh-suppress` (ARP/ND suppression for the VLAN's VNI).
registerModal({
  id: "vxlan-neigh-suppress",
  views: ["configure-vlan-view"],
  keywords: ["neigh-suppress"],
  run({ isNo, ifname, ctx }) {
    if (!ifname) return null;
    if (isNo) cpRemove(ctx.device, "vxlan", "suppress", "name", ifname);
    else cpUpsert(ctx.device, "vxlan", "suppress", { name: ifname, suppress: "on" }, "name");
    return { output: [] };
  },
});

// configure-router-bgp-l2vpn-view of a VRF instance (`router bgp <as> vrf <vrf>`, sub-view
// context "l2vpn@<vrf>" from features/bgp.ts): `[no] advertise ipv4 unicast` (type-5).
registerModal({
  id: "vxlan-bgp-vrf-advertise",
  views: ["configure-router-bgp-l2vpn-view"],
  keywords: ["advertise"],
  run({ viewctx, isNo, args, ctx }) {
    const vrf = (viewctx ?? "").split("@")[1];
    if (!vrf || args[0]?.toLowerCase() !== "ipv4") return null;
    cpUpsert(ctx.device, "vxlan", "bgpvrf", { vrf, advertise_ipv4: isNo ? "" : "true" }, "vrf");
    return { output: [] };
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

const L = (ls: string[]): OutputLine[] => ls.map((x) => line(x));

registerModal({
  id: "vxlan-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() === "neighbor-suppress-status") {
      // Template show_neigh_suppress.j2 is not in the tree: VLAN / status grid.
      const want = args[1] ? `Vlan${args.slice(1).join("").replace(/^vlan/i, "")}` : undefined;
      const on = new Set((cpList(ctx.device, "vxlan", "suppress") as Row[]).filter((r) => r.suppress === "on").map((r) => r.name));
      const vlans = (ctx.device.config.vlans ?? []).map((v) => `Vlan${v.id}`).filter((v) => !want || v === want);
      return { output: grid(["VLAN", "STATUS"], vlans.map((v) => [v, on.has(v) ? "on" : "off"]), [false, false]) };
    }
    if (args[0]?.toLowerCase() !== "vxlan") return null; // not ours
    const sub = (args[1] ?? "").toLowerCase();
    const dev = ctx.device;
    if (sub === "interface") return { output: showInterface(dev) };
    const count = args.some((a) => a.toLowerCase() === "count");
    if (sub === "vlanvnimap") return cpList(dev, "vxlan", "vlanmap").length || count ? { output: L(showVlanVniMap(dev, count)) } : { output: showMap(dev, "vlanmap", "vlan", "VLAN", "VLAN VNI", false) };
    if (sub === "vrfvnimap") return cpList(dev, "vxlan", "vrfmap").length && !count ? { output: L(showVrfVniMap(dev)) } : { output: showMap(dev, "vrfmap", "vrf", "VRF", "VRF VNI", count) };
    if (sub === "tunnel") return { output: L(showRemoteVtep(dev, count)) };
    if (sub === "remote") {
      const what = (args[2] ?? "").toLowerCase();
      const ip = args[3] && args[3].toLowerCase() !== "count" ? args[3] : "all";
      if (what === "vni") return { output: L(showRemoteVni(dev, ip, count)) };
      if (what === "mac") return { output: L(showRemoteMac(dev, ip, count)) };
      return null; // bare container + `nexthop-group`: klish-evpn-show.ts
    }
    if (sub === "counters") return { output: L(showVxlanCounters(dev, args[2])) };
    return null; // Click-only forms (remotevtep, remotevni, remotemac, name) fall through to the Click show
  },
});
