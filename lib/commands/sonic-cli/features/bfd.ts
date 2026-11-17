/**
 * BFD modal behaviour (feature SUB-MODE cloning, two nested views).
 *
 *   sonic(config)# bfd                         -> enters BFD sub-view (no effect)
 *   sonic(config-bfd)# peer 10.10.10.1 interface Ethernet0
 *                                              -> config bfd peer add ... + enters peer sub-view
 *   sonic(config-bfd-peer)# detect-multiplier 5
 *   sonic(config-bfd-peer)# receive-interval 200
 *   sonic(config-bfd-peer)# transmit-interval 200
 *   sonic(config-bfd-peer)# shutdown | no shutdown
 *   sonic(config-bfd)# no peer 10.10.10.1      -> config bfd peer del (stays in BFD view)
 *
 * The tested Click module (lib/commands/sonic/bfd.ts) is FLAT: every sub-command
 * carries the peer IP as an argument. In the modal peer sub-view that IP is the
 * view context (a.viewctx, set on entry), so each in-mode command delegates to
 * `config bfd peer <cmd> <viewctx-ip> ...`. Behaviour/output is not re-faked.
 *
 * KLISH `show bfd ...` (enable-view) renders the sonic-mgmt-framework Jinja
 * templates (CLI/renderer/templates, rendered with trim_blocks/lstrip_blocks,
 * render_cli.py:151-154) from the live sessions of lib/protocols/bfd-daemon.ts,
 * with the values the openconfig-bfd-ext transformer derives from FRR's JSON
 * (sonic-mgmt-common xfmr_bfd.go parseFRRSession / formatDuration :243):
 *   show bfd peers | show bfd peer <ip>   -> show_bfd_peer_detail.j2
 *   show bfd peers brief                  -> show_bfd_peers_brief.j2
 *   show bfd peers counters               -> show_bfd_peers_counters.j2
 *   show bfd peer <ip> counters           -> show_bfd_counters.j2
 * (actioner sonic_cli_bfd_show.py:136-304 picks the template.)
 */
import { OutputLine, err, line } from "../../types";
import { registerModal } from "../registry";
import { subViewFrame } from "../../../sonic/grammar";
import { BfdSession, bfdSessions } from "../../../protocols/bfd-daemon";
import { diag2str } from "../../sonic/bfd";

// configure-view: `bfd` enters the BFD sub-view (clish_nop in KLISH -> no effect).
registerModal({
  id: "bfd-enter",
  views: ["configure-view"],
  keywords: ["bfd"],
  run({ isNo }) {
    if (isNo) return null; // `no bfd` is not a real command; fall through.
    return { output: [], enter: subViewFrame("configure-bfd-view") };
  },
});

// configure-bfd-view: `peer <ip> ...` adds the peer + enters the peer sub-view;
// `no peer <ip>` deletes it and stays. Delegates to `config bfd peer add|del`.
registerModal({
  id: "bfd",
  views: ["configure-bfd-view"],
  keywords: ["peer"],
  run({ isNo, args, delegate }) {
    const ip = args[0];
    if (!ip) return { output: [err("% BFD peer IP address required.")] };
    if (isNo) return { output: delegate(`config bfd peer del ${ip}`) };
    // Forward the identity tokens verbatim (interface/local-address/multihop
    // share the exact keyword names the Click parser expects).
    return {
      output: delegate(`config bfd peer add ${args.join(" ")}`),
      enter: subViewFrame("configure-bfd-peer-view", ip),
    };
  },
});

// configure-bfd-peer-view: per-peer timers/admin state. The peer IP is a.viewctx.
registerModal({
  id: "bfd-peer",
  views: ["configure-bfd-peer-view"],
  keywords: ["detect-multiplier", "receive-interval", "transmit-interval", "shutdown"],
  run({ head, isNo, args, viewctx, delegate }) {
    const ip = viewctx ?? "";
    if (head === "shutdown") {
      return { output: delegate(`config bfd peer ${isNo ? "no-shutdown" : "shutdown"} ${ip}`) };
    }
    // detect-multiplier / receive-interval / transmit-interval: no reset form in Click.
    if (isNo) return null;
    return { output: delegate(`config bfd peer ${head} ${ip} ${args.join(" ")}`) };
  },
});

// --- KLISH show ---------------------------------------------------------------

/** xfmr_bfd.go formatDuration (:243). */
const duration = (sec: number) => {
  const t = Math.max(0, Math.floor(sec));
  return `${Math.floor(t / 86400)} day(s), ${Math.floor((t % 86400) / 3600)} hour(s), ${Math.floor((t % 3600) / 60)} min(s), ${t % 60} sec(s)`;
};

/** openconfig session-state enum, lower-cased by the templates. */
const OC_STATE = ["admin_down", "down", "init", "up"];

/** show_bfd_peer_detail.j2, one session block (blank line before the peer line and after the block). */
function klishDetail(s: BfdSession, now: number): string[] {
  const o = ["", `    peer ${s.peer}${s.local ? ` local-address ${s.local}` : ""} vrf default${s.ifname ? ` interface ${s.ifname}` : ""}`];
  o.push(`        ID: ${s.myDisc}`, `        Remote ID: ${s.remoteDisc}`, "        Passive mode: Disabled");
  if (s.multihop) o.push(`        Minimum TTL: ${s.mhTtl}`);
  o.push(`        Admin State: ${s.shutdown ? "down" : "up"}`, `        Status: ${OC_STATE[s.state]}`);
  if (s.state === 3) o.push(`        Uptime: ${duration((now - s.uptime) / 1000)}`);
  else {
    // FRR's JSON carries "downtime" only in the down state (bfdd_vty.c:303-306).
    const dt = s.state === 1 ? Math.floor((now - s.downtime) / 1000) : 0;
    o.push(`        Downtime: ${dt ? duration(dt) : "N/A"}`);
  }
  o.push(
    `        Diagnostics: ${diag2str(s.localDiag)}`,
    `        Remote diagnostics: ${diag2str(s.remoteDiag)}`,
    `        Peer Type: ${s.configured ? "configured" : "dynamic"}`,
    "        Local timers:",
    `            Detect-multiplier: ${s.detectMult}`,
    `            Receive interval: ${s.requiredMinRx}ms`,
    `            Transmission interval: ${s.desiredMinTx}ms`,
    `            Echo transmission interval: ${s.requiredMinEchoRx}ms`,
    "        Remote timers:",
    `            Detect-multiplier: ${s.remoteDetectMult}`,
    `            Receive interval: ${s.remoteRequiredRx}ms`,
    `            Transmission interval: ${s.remoteDesiredTx}ms`,
    `            Echo transmission interval: ${s.remoteEchoRx}ms`,
    "",
  );
  return o;
}

/** show_bfd_peers_counters.j2 / show_bfd_counters.j2, one session block. */
function klishCounters(s: BfdSession): string[] {
  return [
    `peer ${s.peer}${s.multihop ? " multihop" : ""}${s.local ? ` local-address ${s.local}` : ""}${s.ifname ? ` interface ${s.ifname}` : ""} vrf default`,
    `    Control packet input: ${s.stats.rxCtrl} packets`,
    `    Control packet output: ${s.stats.txCtrl} packets`,
    "    Echo packet input: 0 packets",
    "    Echo packet output: 0 packets",
    `    Session up events: ${s.stats.up}`,
    `    Session down events: ${s.stats.down}`,
    `    Zebra notifications: ${s.stats.zebra}`,
    "",
  ];
}

/** show_bfd_peers_brief.j2: '%-10s %-41s %-41s %-14s %-14s %-8s'. */
function klishBrief(list: BfdSession[]): string[] {
  if (!list.length) return [];
  const row = (...c: string[]) => [c[0].padEnd(10), c[1].padEnd(41), c[2].padEnd(41), c[3].padEnd(14), c[4].padEnd(14), c[5].padEnd(8)].join(" ");
  return [
    `Session Count: ${list.length}`,
    row("SessionId", "LocalAddress", "PeerAddress", "Status", "Interface", "Vrf"),
    row("=========", "============", "===========", "======", "=========", "==="),
    ...list.map((s) => row(String(s.myDisc), s.local ?? "", s.peer, OC_STATE[s.state], s.ifname ?? "-", "default")),
  ];
}

registerModal({
  id: "bfd-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "bfd") return null;
    const sub = (args[1] ?? "").toLowerCase();
    const all = bfdSessions(ctx.device);
    const now = Date.now();
    const out = (l: string[]): { output: OutputLine[] } => ({ output: l.map((t) => line(t)) });
    if (sub === "peers") {
      const mode = (args[2] ?? "").toLowerCase();
      if (mode === "brief") return out(klishBrief(all));
      if (mode === "counters") return out(all.length ? all.flatMap(klishCounters) : ["No BFD peers configured"]);
      if (mode) return null;
      return out(all.length ? ["BFD Peers:", "", ...all.flatMap((s) => klishDetail(s, now))] : ["No BFD peers configured"]);
    }
    if (sub === "peer") {
      const ip = args[2];
      if (!ip) return null;
      const rest = args.slice(3).map((a) => a.toLowerCase());
      const ifIdx = rest.indexOf("interface");
      const ifname = ifIdx >= 0 ? args[3 + ifIdx + 1] : undefined;
      const found = all.filter((s) => s.peer === ip && (!ifname || s.ifname === ifname));
      if (rest.includes("counters")) return out(found.length ? found.flatMap(klishCounters) : ["No BFD peer found with specified filters"]);
      return out(found.length ? ["BFD Peers:", "", ...found.flatMap((s) => klishDetail(s, now))] : [`BFD peer ${ip} not found`]);
    }
    return null;
  },
});
