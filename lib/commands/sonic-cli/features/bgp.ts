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

// configure-view: `router bgp <as>` — apply the AS, then drop into the BGP sub-view.
registerModal({
  id: "bgp-enter",
  views: ["configure-view"],
  keywords: ["router"],
  run({ isNo, args, delegate }) {
    if (args[0]?.toLowerCase() !== "bgp") return null; // not ours (e.g. `router ospf`)
    const as = args[1];
    if (isNo) return { output: delegate("config router bgp no") };
    if (!as) return { output: [err("% AS number required.")] };
    return { output: delegate(`config router bgp ${as}`), enter: subViewFrame("configure-router-bgp-view", as) };
  },
});

// configure-router-bgp-view
registerModal({
  id: "bgp",
  views: ["configure-router-bgp-view"],
  keywords: ["neighbor", "network", "router-id", "bgp", "timers", "redistribute", "address-family"],
  run({ ctx, head, isNo, args, raw, delegate }) {
    const no = isNo ? "no " : "";
    if (head === "router-id" || (head === "bgp" && args[0] === "router-id")) {
      const id = head === "bgp" ? args[1] : args[0];
      if (isNo) return { output: delegate("config router bgp no router-id") };
      if (!id) return null;
      return { output: delegate(`config router bgp router-id ${id}`) };
    }
    if (head === "neighbor") {
      const peer = args[0];
      if (!peer) return { output: [err("% neighbor address required.")] };
      if (isNo) return { output: delegate(`config router bgp no neighbor ${args.join(" ")}`) };
      const out = delegate(`config router bgp neighbor ${args.join(" ")}`);
      // `neighbor <ip>` alone enters the neighbor sub-view (bgp.xml:1464).
      if (args.length === 1 && !out.some((o) => o.kind === "error")) return { output: [], enter: subViewFrame("configure-router-bgp-nbr-view", peer) };
      return { output: out };
    }
    if (head === "network") {
      if (!args[0]) return { output: [err("% prefix required.")] };
      return { output: delegate(`config router bgp ${no}network ${args[0]}`) };
    }
    if (head === "timers") {
      const a = args.filter((x) => x !== "bgp");
      const out = delegate(isNo ? "config router bgp no timers" : `config router bgp timers ${a.join(" ")}`);
      // keep the typed line in show running-configuration (as the generic config-plane store did)
      if (!out.some((o) => o.kind === "error")) cpStoreLine(ctx.device, "router-bgp", raw, isNo);
      return { output: out };
    }
    if (head === "redistribute") return { output: delegate(`config router bgp ${no}redistribute ${args[0] ?? ""}`) };
    if (head === "address-family") {
      if (isNo) return { output: [] };
      if (args[0]?.toLowerCase() === "l2vpn") return { output: [], enter: subViewFrame("configure-router-bgp-l2vpn-view", "l2vpn") };
      if (args[0]?.toLowerCase() !== "ipv4") return null;
      return { output: [], enter: subViewFrame("configure-router-bgp-ipv4-view", "ipv4") };
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
  run({ head, isNo, args, delegate }) {
    const no = isNo ? "no " : "";
    if (head === "advertise-all-vni") return { output: delegate(`config router bgp ${no}advertise-all-vni`) };
    if (args[1]?.toLowerCase() !== "activate" || !args[0]) return null;
    return { output: delegate(isNo ? `config router bgp no neighbor ${args[0]} activate evpn` : `config router bgp neighbor ${args[0]} activate evpn`) };
  },
});

// configure-router-bgp-ipv4-view (prompt config-router-bgp-af)
registerModal({
  id: "bgp-af",
  views: ["configure-router-bgp-ipv4-view"],
  keywords: ["network", "redistribute"],
  run({ head, isNo, args, delegate }) {
    const no = isNo ? "no " : "";
    if (head === "network") {
      if (!args[0]) return { output: [err("% prefix required.")] };
      return { output: delegate(`config router bgp ${no}network ${args[0]}`) };
    }
    return { output: delegate(`config router bgp ${no}redistribute ${args[0] ?? ""}`) };
  },
});

// configure-router-bgp-nbr-view (viewctx = neighbor address)
registerModal({
  id: "bgp-nbr",
  views: ["configure-router-bgp-nbr-view"],
  keywords: ["remote-as", "timers", "update-source", "bfd", "shutdown", "description", "ebgp-multihop", "address-family"],
  run({ head, isNo, args, viewctx, delegate }) {
    const peer = viewctx ?? "";
    if (head === "address-family") {
      if (isNo) return args[0]?.toLowerCase() === "l2vpn" ? { output: delegate(`config router bgp no neighbor ${peer} activate evpn`) } : { output: [] };
      if (args[0]?.toLowerCase() === "l2vpn") return { output: [], enter: subViewFrame("configure-router-bgp-nbr-l2vpn-view", peer) };
      if (args[0]?.toLowerCase() !== "ipv4") return null;
      return { output: [], enter: subViewFrame("configure-router-bgp-nbr-ipv4-view", peer) };
    }
    if (isNo) return { output: delegate(`config router bgp no neighbor ${peer} ${head} ${args.join(" ")}`.trim()) };
    return { output: delegate(`config router bgp neighbor ${peer} ${head} ${args.join(" ")}`.trim()) };
  },
});

// configure-router-bgp-nbr-ipv4-view: activate (IPv4 unicast is always negotiated here).
registerModal({
  id: "bgp-nbr-af",
  views: ["configure-router-bgp-nbr-ipv4-view"],
  keywords: ["activate"],
  run({ viewctx, delegate }) {
    return { output: delegate(`config router bgp neighbor ${viewctx ?? ""} activate`) };
  },
});

// configure-router-bgp-nbr-l2vpn-view: [no] activate → MP capability AFI 25 / SAFI 70.
registerModal({
  id: "bgp-nbr-l2vpn",
  views: ["configure-router-bgp-nbr-l2vpn-view"],
  keywords: ["activate"],
  run({ isNo, viewctx, delegate }) {
    return { output: delegate(`config router bgp ${isNo ? "no " : ""}neighbor ${viewctx ?? ""} activate evpn`) };
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
    const ribEntries = cfg ? bgpTable(ctx.device).size : 0;
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
      const state = up ? String(Object.keys(p!.adjIn).length) : (p?.state ?? "Idle").charAt(0) + (p?.state ?? "Idle").slice(1).toLowerCase();
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
