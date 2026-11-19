/**
 * BGP KLISH modes (data/device-capture/klish-xml/bgp.xml, bgp_af_ipv4.xml):
 *
 *   sonic(config)# router bgp 65001                       -> configure-router-bgp-view
 *   sonic(config-router-bgp)# router-id 1.1.1.1
 *   sonic(config-router-bgp)# timers 10 30                 (bgp.xml:1647, global keepalive/hold)
 *   sonic(config-router-bgp)# neighbor 10.0.12.2           -> configure-router-bgp-nbr-view (bgp.xml:1464)
 *   sonic(config-router-bgp-neighbor)# remote-as 65002     (bgp.xml:1955)
 *   sonic(config-router-bgp-neighbor)# timers 3 9 | timers connect 10   (bgp.xml:1982)
 *   sonic(config-router-bgp-neighbor)# update-source <ip> | interface Loopback 0 (bgp.xml:2010)
 *   sonic(config-router-bgp-neighbor)# bfd | shutdown | description <text> | ebgp-multihop [n]
 *   sonic(config-router-bgp-neighbor)# address-family ipv4 unicast -> nbr-af view: activate
 *   sonic(config-router-bgp)# address-family ipv4 unicast  -> configure-router-bgp-ipv4-view
 *   sonic(config-router-bgp-af)# network 192.168.1.0/24 | redistribute connected
 *   sonic(config-router-bgp)# address-family l2vpn evpn  -> configure-router-bgp-l2vpn-view
 *   sonic(config-router-bgp-af)# advertise-all-vni       (bgp_af_l2vpn: advertise-all-vni)
 *   sonic(config-router-bgp-af)# neighbor 10.0.0.2 activate   (FRR vtysh form)
 *   sonic(config-router-bgp-neighbor)# address-family l2vpn evpn -> nbr-l2vpn view: [no] activate
 *
 *   sonic(config)# router bgp 65001 vrf Vrf-red          -> VRF instance (bgp.xml:719-722); every
 *                                                          sub-view carries "<ctx>@<vrf>"
 *   sonic(config-router-bgp)# bestpath as-path multipath-relax   (bgp.xml:1310)
 *   sonic(config-router-bgp)# address-family ipv6 unicast -> configure-router-bgp-ipv6-view
 *   sonic(config-router-bgp-af)# network 2001:db8:1::/64 | redistribute connected|static|ospf
 *        [route-map R] [metric N] | maximum-paths [ibgp] N | table-map R   (bgp_af_ipv4/6.xml)
 *   sonic(config-router-bgp-af)# neighbor X activate|route-map R in|out|prefix-list P in|out (FRR form)
 *   sonic(config-router-bgp-neighbor)# address-family ipv4|ipv6 unicast -> nbr-af view:
 *        activate | route-map R in|out | prefix-list P in|out | filter-list F in|out |
 *        weight N | soft-reconfiguration inbound   (bgp_af_ipv4.xml nbr-af commands)
 *   sonic(config)# bgp community-list standard NAME permit|deny AA:NN.. [any|all]
 *   sonic(config)# bgp as-path-list NAME [seq N] permit|deny REGEX   (bgp_community_sets.xml)
 *
 * FRR-vtysh one-liners are accepted in the BGP view too (`neighbor X remote-as N`,
 * `network`, `timers bgp K H`, `redistribute connected`). Every clause delegates to
 * the Click `config router bgp ...` commands (lib/commands/sonic/bgp.ts), the
 * single writer of the BGP config the daemon reads.
 *
 * `show bgp ipv4 unicast summary` typed in KLISH renders SONiC's KLISH template
 * (sonic-mgmt-framework CLI/renderer/templates/show_bgp_summary.j2); every other
 * `show ... bgp` falls through to the FRR-format Click show.
 */
import { err } from "../../types";
import { line, muted } from "../../types";
import { registerModal } from "../registry";
import { cpStoreLine } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";
import { getBgpConfig } from "../../../protocols/bgp";
import { bgpRouterId, bgpTable, peekBgpRuntime, totalMsgs } from "../../../protocols/bgp-daemon";
import { frrUptime } from "../../sonic/frr-route";

/** Sub-view context "<ctx>@<vrf>" → parts + the Click prefix for that instance. */
function scope(viewctx: string | undefined): { ctx: string; vrf?: string; pre: string; at: string } {
  const [ctx, vrf] = (viewctx ?? "").split("@");
  return { ctx, vrf, pre: vrf ? `config router bgp vrf ${vrf}` : "config router bgp", at: vrf ? `@${vrf}` : "" };
}

// configure-view: `router bgp <as> [vrf <vrf>]` — apply the AS, then drop into the BGP sub-view.
registerModal({
  id: "bgp-enter",
  views: ["configure-view"],
  keywords: ["router"],
  run({ isNo, args, delegate }) {
    if (args[0]?.toLowerCase() !== "bgp") return null; // not ours (e.g. `router ospf`)
    const vi = args.findIndex((a) => a.toLowerCase() === "vrf");
    const vrf = vi >= 0 && args[vi + 1] !== "default" ? args[vi + 1] : undefined;
    const as = args[1]?.toLowerCase() === "vrf" ? undefined : args[1];
    if (vi >= 0 && !args[vi + 1]) return { output: [err("% VRF name required.")] };
    if (isNo) return { output: delegate(vrf ? `config router bgp vrf ${vrf} no` : "config router bgp no") };
    if (!as) return { output: [err("% AS number required.")] };
    return { output: delegate(vrf ? `config router bgp vrf ${vrf} ${as}` : `config router bgp ${as}`), enter: subViewFrame("configure-router-bgp-view", vrf ? `${as}@${vrf}` : as) };
  },
});

// configure-view: community-lists and AS-path lists (bgp_community_sets.xml; FRR forms too).
registerModal({
  id: "bgp-lists",
  views: ["configure-view"],
  keywords: ["bgp"],
  run({ isNo, args, delegate }) {
    const k = args[0]?.toLowerCase();
    if (k !== "community-list" && k !== "as-path-list" && k !== "as-path") return null;
    return { output: delegate(`config ${isNo ? "no " : ""}bgp ${args.join(" ")}`) };
  },
});

// configure-router-bgp-view
registerModal({
  id: "bgp",
  views: ["configure-router-bgp-view"],
  keywords: ["neighbor", "network", "router-id", "bgp", "timers", "redistribute", "address-family", "bestpath"],
  run({ ctx, head, isNo, args, raw, viewctx, delegate }) {
    const no = isNo ? "no " : "";
    const { pre, at } = scope(viewctx);
    if (head === "router-id" || (head === "bgp" && args[0] === "router-id")) {
      const id = head === "bgp" ? args[1] : args[0];
      if (isNo) return { output: delegate(`${pre} no router-id`) };
      if (!id) return null;
      return { output: delegate(`${pre} router-id ${id}`) };
    }
    if (head === "bestpath" || (head === "bgp" && args[0] === "bestpath")) {
      const a = head === "bgp" ? args.slice(1) : args;
      return { output: delegate(`${pre} ${no}bestpath ${a.join(" ")}`) };
    }
    if (head === "neighbor") {
      const peer = args[0];
      if (!peer) return { output: [err("% neighbor address required.")] };
      if (isNo) return { output: delegate(`${pre} no neighbor ${args.join(" ")}`) };
      const out = delegate(`${pre} neighbor ${args.join(" ")}`);
      // `neighbor <ip>` alone enters the neighbor sub-view (bgp.xml:1464).
      if (args.length === 1 && !out.some((o) => o.kind === "error")) return { output: [], enter: subViewFrame("configure-router-bgp-nbr-view", `${peer}${at}`) };
      return { output: out };
    }
    if (head === "network") {
      if (!args[0]) return { output: [err("% prefix required.")] };
      return { output: delegate(`${pre} ${no}network ${args[0]}`) };
    }
    if (head === "timers") {
      const a = args.filter((x) => x !== "bgp");
      const out = delegate(isNo ? `${pre} no timers` : `${pre} timers ${a.join(" ")}`);
      // keep the typed line in show running-configuration (as the generic config-plane store did)
      if (!out.some((o) => o.kind === "error")) cpStoreLine(ctx.device, "router-bgp", raw, isNo);
      return { output: out };
    }
    if (head === "redistribute") return { output: delegate(`${pre} ${no}redistribute ${args.join(" ")}`) };
    if (head === "address-family") {
      if (isNo) return { output: [] };
      const fam = args[0]?.toLowerCase();
      if (fam === "l2vpn") return { output: [], enter: subViewFrame("configure-router-bgp-l2vpn-view", `l2vpn${at}`) };
      if (fam === "ipv6") return { output: [], enter: subViewFrame("configure-router-bgp-ipv6-view", `ipv6${at}`) };
      if (fam !== "ipv4") return null;
      return { output: [], enter: subViewFrame("configure-router-bgp-ipv4-view", `ipv4${at}`) };
    }
    return null;
  },
});

// configure-router-bgp-l2vpn-view (prompt config-router-bgp-af): advertise-all-vni,
// plus FRR's `neighbor X activate` form.
registerModal({
  id: "bgp-l2vpn",
  views: ["configure-router-bgp-l2vpn-view"],
  keywords: ["advertise-all-vni", "neighbor"],
  run({ head, isNo, args, viewctx, delegate }) {
    const no = isNo ? "no " : "";
    if (scope(viewctx).vrf) return null; // EVPN lives in the default instance here
    if (head === "advertise-all-vni") return { output: delegate(`config router bgp ${no}advertise-all-vni`) };
    if (args[1]?.toLowerCase() !== "activate" || !args[0]) return null;
    return { output: delegate(isNo ? `config router bgp no neighbor ${args[0]} activate evpn` : `config router bgp neighbor ${args[0]} activate evpn`) };
  },
});

// configure-router-bgp-ipv4-view / -ipv6-view (prompt config-router-bgp-af)
registerModal({
  id: "bgp-af",
  views: ["configure-router-bgp-ipv4-view", "configure-router-bgp-ipv6-view"],
  keywords: ["network", "redistribute", "maximum-paths", "table-map", "neighbor"],
  run({ view, head, isNo, args, viewctx, delegate }) {
    const no = isNo ? "no " : "";
    const { pre } = scope(viewctx);
    const af = view === "configure-router-bgp-ipv6-view" ? `${pre} ipv6` : pre;
    if (head === "network") {
      if (!args[0]) return { output: [err("% prefix required.")] };
      return { output: delegate(`${af} ${no}network ${args[0]}`) };
    }
    if (head === "neighbor") {
      if (!args[0] || !args[1]) return { output: [err("% neighbor <ip> <attribute> required.")] };
      return { output: delegate(`${af} ${no}neighbor ${args.join(" ")}`) };
    }
    return { output: delegate(`${af} ${no}${head} ${args.join(" ")}`.trim()) };
  },
});

// configure-router-bgp-nbr-view (viewctx = neighbor address)
registerModal({
  id: "bgp-nbr",
  views: ["configure-router-bgp-nbr-view"],
  keywords: ["remote-as", "timers", "update-source", "bfd", "shutdown", "description", "ebgp-multihop", "address-family"],
  run({ head, isNo, args, viewctx, delegate }) {
    const { ctx: peer, pre, at } = scope(viewctx);
    if (head === "address-family") {
      const fam = args[0]?.toLowerCase();
      if (isNo) return fam === "l2vpn" ? { output: delegate(`${pre} no neighbor ${peer} activate evpn`) } : fam === "ipv6" ? { output: delegate(`${pre} ipv6 no neighbor ${peer} activate`) } : { output: [] };
      if (fam === "l2vpn") return { output: [], enter: subViewFrame("configure-router-bgp-nbr-l2vpn-view", `${peer}${at}`) };
      if (fam === "ipv6") return { output: [], enter: subViewFrame("configure-router-bgp-nbr-ipv6-view", `${peer}${at}`) };
      if (fam !== "ipv4") return null;
      return { output: [], enter: subViewFrame("configure-router-bgp-nbr-ipv4-view", `${peer}${at}`) };
    }
    if (isNo) return { output: delegate(`${pre} no neighbor ${peer} ${head} ${args.join(" ")}`.trim()) };
    return { output: delegate(`${pre} neighbor ${peer} ${head} ${args.join(" ")}`.trim()) };
  },
});

// configure-router-bgp-nbr-ipv4-view / -ipv6-view: activate + per-AF policy.
registerModal({
  id: "bgp-nbr-af",
  views: ["configure-router-bgp-nbr-ipv4-view", "configure-router-bgp-nbr-ipv6-view"],
  keywords: ["activate", "route-map", "prefix-list", "filter-list", "weight", "soft-reconfiguration"],
  run({ view, head, isNo, args, viewctx, delegate }) {
    const { ctx: peer, pre } = scope(viewctx);
    const af = view === "configure-router-bgp-nbr-ipv6-view" ? `${pre} ipv6` : pre;
    return { output: delegate(`${af} ${isNo ? "no " : ""}neighbor ${peer} ${head} ${args.join(" ")}`.trim()) };
  },
});

// configure-router-bgp-nbr-l2vpn-view: [no] activate → MP capability AFI 25 / SAFI 70.
registerModal({
  id: "bgp-nbr-l2vpn",
  views: ["configure-router-bgp-nbr-l2vpn-view"],
  keywords: ["activate"],
  run({ isNo, viewctx, delegate }) {
    const { ctx: peer, pre } = scope(viewctx);
    return { output: delegate(`${pre} ${isNo ? "no " : ""}neighbor ${peer} activate evpn`) };
  },
});

// KLISH `show bgp ipv4 unicast summary` — show_bgp_summary.j2 layout.
registerModal({
  id: "bgp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (!(a[0] === "bgp" && a[1] === "ipv4" && a[2] === "unicast" && a[3] === "summary" && a.length === 4)) return null;
    const cfg = getBgpConfig(ctx.device);
    const rt = peekBgpRuntime(ctx.device);
    const peers = (cfg?.neighbors ?? []).filter((n) => n.remoteAs !== undefined);
    const table = bgpTable(ctx.device);
    const ribEntries = table.size;
    // PfxRcd = prefixes accepted after inbound policy (peer->pcount)
    const accepted = (peer: string) => [...table.values()].filter((l) => l.some((e) => e.path.peer === peer)).length;
    const out = [
      line(`BGP router identifier ${cfg ? bgpRouterId(ctx.device, cfg) : "0.0.0.0"}, local AS number ${cfg?.localAs ?? 0} VRF default vrf-id 0`),
      line(`BGP table version ${rt?.tableVersion ?? 0}`),
      line(`RIB entries ${ribEntries}, using ${ribEntries * 128} bytes of memory`),
      line(`Peers ${peers.length}, using ${peers.length * 71} KiB of memory`),
      line(""),
    ];
    if (!peers.length) return { output: [...out, muted("% No BGP neighbors found")] };
    out.push(line("Neighbor        V         AS   MsgRcvd   MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd   PfxSnt Desc"));
    let est = 0;
    const now = Date.now();
    for (const nb of peers) {
      const p = rt?.peers[nb.peer];
      const up = p?.state === "Established";
      if (up) est++;
      const state = up ? String(accepted(nb.peer)) : (p?.state ?? "Idle").charAt(0) + (p?.state ?? "Idle").slice(1).toLowerCase();
      const uptime = p?.uptimeMs === undefined ? "never" : frrUptime(now - p.uptimeMs);
      out.push(
        line(
          `${nb.peer.padEnd(15)} 4 ${String(nb.remoteAs).padStart(10)} ${String(p ? totalMsgs(p.rcvd) : 0).padStart(9)} ${String(p ? totalMsgs(p.sent) : 0).padStart(9)} ${"0".padStart(8)} ${"0".padStart(4)} ${"0".padStart(4)} ${uptime.padStart(8)} ${state.padStart(12)} ${String(up ? Object.keys(p!.adjOut).length : 0).padStart(8)} ${nb.description ?? ""}`.trimEnd(),
        ),
      );
    }
    out.push(line(""), line(`Total number of neighbors ${peers.length}`), line(`Total number of neighbors established ${est}`));
    return { output: out };
  },
});
