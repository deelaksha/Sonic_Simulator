/**
 * BGP SONiC feature module: config commands mutate the BGP config store
 * (device.config.features.bgp, read by the bgpd daemon in
 * lib/protocols/bgp-daemon.ts); show commands render the daemon's live state in
 * FRR 10.3 vtysh format (SONiC's `show ip bgp ...` runs vtysh):
 *
 *   show ip bgp summary      bgp_vty.c:11997 bgp_show_summary (header :12159-12313,
 *                            columns bgp_vty.h:52-53, peer line :12570-12680,
 *                            "Total number of neighbors" :12726)
 *   show ip bgp              bgp_route.c:12156-12185 header, route_vty_out
 *                            (:9557 status, :9440 prefix width 17, next hop 16,
 *                            %10u metric, %7u locprf, "%7u " weight, path, origin)
 *   show ip bgp neighbors    bgp_vty.c:14077+ bgp_show_peer (key lines)
 *
 * One-line Click forms (the KLISH sub-modes in sonic-cli/features/bgp.ts delegate here):
 *   config router bgp <as> | no
 *   config router bgp [no] router-id <ipv4>
 *   config router bgp neighbor <ip> [remote-as <as> | description <text> |
 *        ebgp-multihop [<n>] | timers <ka> <hold> | timers connect <s> |
 *        update-source <ip|ifname> | bfd | shutdown | activate]
 *   config router bgp no neighbor <ip> [<attribute>]   (no attribute = delete)
 *   config router bgp [no] network <cidr>
 *   config router bgp [no] timers <ka> <hold>           (= FRR `timers bgp`)
 *   config router bgp [no] redistribute connected
 *
 * Ranges: AS 1..4294967295; ebgp-multihop 1..255; keepalive 0..65535, hold 0 or
 * 3..65535 (FRR bgp_vty.c / bgp_packet.c:2025); connect 1..65535 (KLISH RANGE_1_65535).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { interfaceByName } from "../../models/device";
import { isValidIpv4, isValidPrefix, networkAddress } from "../../models/ip";
import { BgpConfig, BgpNeighbor, bgpConfigState, getBgpConfig } from "../../protocols/bgp";
import { BGP_DEFAULTS, BgpPath, FsmState, PeerRt, bgpRouterId, bgpTable, peekBgpRuntime, totalMsgs } from "../../protocols/bgp-daemon";
import { ORIGIN_STR, notifyText } from "../../protocols/bgp-wire";
import { frrUptime } from "./frr-route";

const AS = { min: 1, max: 4294967295 };
const MULTIHOP = { min: 1, max: 255 };

function parseInRange(tok: string | undefined, min: number, max: number): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  return n >= min && n <= max ? n : null;
}

function normalizeCidr(token: string | undefined): string | null {
  if (!token || !token.includes("/")) return null;
  const [addr, plen] = token.split("/");
  const len = Number(plen);
  if (!isValidIpv4(addr) || !/^\d+$/.test(plen) || !isValidPrefix(len)) return null;
  return `${networkAddress(addr, len)}/${len}`;
}

const NOT_CONFIGURED = "% BGP not configured: run 'config router bgp <as>' first";

/** keepalive/hold pair: returns an error string or the values. */
function parseTimers(ka: string | undefined, hold: string | undefined): { ka: number; hold: number } | string {
  const k = parseInRange(ka, 0, 65535);
  const h = parseInRange(hold, 0, 65535);
  if (k === null || h === null) return "timers: keepalive 0-65535, hold 0-65535";
  if (h !== 0 && h < 3) return "% hold time value must be either 0 or greater than 3";
  return { ka: k, hold: h };
}

function setNeighborAttr(ctx: CommandContext, st: BgpConfig, nb: BgpNeighbor, key: string, rest: string[]): CommandResult {
  const peer = nb.peer;
  const ok = (msg: string): CommandResult => ({ output: [muted(msg)] });
  switch (key) {
    case "remote-as": {
      const v = rest[0] === "internal" ? st.localAs! : rest[0] === "external" ? undefined : parseInRange(rest[0], AS.min, AS.max);
      if (v === null || v === undefined) return { output: [err(`config router bgp neighbor: remote-as must be ${AS.min}-${AS.max}`)] };
      nb.remoteAs = v;
      return ok(`neighbor ${peer} remote-as ${v} configured`);
    }
    case "description": {
      const text = rest.join(" ").trim();
      if (!text) return { output: [err("config router bgp neighbor: description needs text")] };
      nb.description = text;
      return ok(`neighbor ${peer} description set`);
    }
    case "ebgp-multihop": {
      const hops = rest[0] === undefined ? 255 : parseInRange(rest[0], MULTIHOP.min, MULTIHOP.max);
      if (hops === null) return { output: [err(`config router bgp neighbor: ebgp-multihop must be ${MULTIHOP.min}-${MULTIHOP.max}`)] };
      nb.ebgpMultihop = hops;
      return ok(`neighbor ${peer} ebgp-multihop ${hops} configured`);
    }
    case "timers": {
      if (rest[0] === "connect") {
        const c = parseInRange(rest[1], 1, 65535);
        if (c === null) return { output: [err("config router bgp neighbor: timers connect 1-65535")] };
        nb.connectRetry = c;
        return ok(`neighbor ${peer} timers connect ${c} configured`);
      }
      const t = parseTimers(rest[0], rest[1]);
      if (typeof t === "string") return { output: [err(t)] };
      nb.keepalive = t.ka;
      nb.holdtime = t.hold;
      return ok(`neighbor ${peer} timers ${t.ka} ${t.hold} configured`);
    }
    case "update-source": {
      const v = rest.filter((x) => x !== "interface").join("");
      if (!v || (!isValidIpv4(v) && !interfaceByName(ctx.device, v))) return { output: [err("config router bgp neighbor: update-source <ipv4|interface>")] };
      nb.updateSource = v;
      return ok(`neighbor ${peer} update-source ${v} configured`);
    }
    case "bfd":
      nb.bfd = true;
      return ok(`neighbor ${peer} bfd enabled`);
    case "shutdown":
      nb.shutdown = true;
      return ok(`neighbor ${peer} shutdown`);
    case "activate":
      return ok(`neighbor ${peer} activated for IPv4 unicast`);
  }
  return { output: [err(`config router bgp neighbor: unknown option '${key}'`)] };
}

const UNSET: Record<string, (keyof BgpNeighbor)[]> = {
  "remote-as": ["remoteAs"],
  description: ["description"],
  "ebgp-multihop": ["ebgpMultihop"],
  timers: ["keepalive", "holdtime"],
  "update-source": ["updateSource"],
  bfd: ["bfd"],
  shutdown: ["shutdown"],
  activate: [],
};

const config: SonicCmd[] = [
  {
    path: ["router", "bgp"],
    summary: "Set the local BGP AS (config router bgp <as>) or remove BGP (config router bgp no)",
    run(args, ctx): CommandResult {
      const st = bgpConfigState(ctx.device);
      if (args[0] === "no" && args.length === 1) {
        st.localAs = undefined;
        st.routerId = undefined;
        st.neighbors = [];
        st.networks = [];
        st.keepalive = st.holdtime = undefined;
        st.redistributeConnected = undefined;
        return { output: [muted("BGP instance removed")] };
      }
      const as = parseInRange(positional(args)[0], AS.min, AS.max);
      if (as === null) return { output: [err(`Usage: config router bgp <as> (${AS.min}-${AS.max})`)] };
      st.localAs = as;
      return { output: [muted(`router bgp ${as} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "router-id"],
    summary: "Set the BGP router-id (config router bgp router-id <ipv4>)",
    run(args, ctx): CommandResult {
      const st = getBgpConfig(ctx.device);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      const id = positional(args)[0];
      if (!id || !isValidIpv4(id)) return { output: [err("Usage: config router bgp router-id <ipv4>")] };
      st.routerId = id;
      return { output: [muted(`router-id ${id} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "no", "router-id"],
    summary: "Remove the configured router-id",
    run(_a, ctx): CommandResult {
      const st = getBgpConfig(ctx.device);
      if (st) st.routerId = undefined;
      return { output: [muted("router-id removed")] };
    },
  },
  {
    path: ["router", "bgp", "neighbor"],
    summary: "Configure a neighbor (remote-as | description | ebgp-multihop | timers | update-source | bfd | shutdown)",
    run(args, ctx): CommandResult {
      const st = getBgpConfig(ctx.device);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      const peer = args[0];
      if (!peer || !isValidIpv4(peer)) return { output: [err("Usage: config router bgp neighbor <ip> remote-as <as> | description <text> | ebgp-multihop <n> | timers <ka> <hold> | update-source <src> | bfd | shutdown")] };
      let nb = st.neighbors.find((n) => n.peer === peer);
      if (!nb) {
        nb = { peer };
        st.neighbors.push(nb);
      }
      if (args[1] === undefined) return { output: [muted(`neighbor ${peer} configured`)] };
      return setNeighborAttr(ctx, st, nb, args[1], args.slice(2));
    },
  },
  {
    path: ["router", "bgp", "no", "neighbor"],
    summary: "Delete a neighbor (no neighbor <ip>) or one of its attributes (no neighbor <ip> <attr>)",
    run(args, ctx): CommandResult {
      const st = bgpConfigState(ctx.device);
      const peer = args[0];
      if (!peer) return { output: [err("Usage: config router bgp no neighbor <ip> [<attribute>]")] };
      const nb = st.neighbors.find((n) => n.peer === peer);
      if (args[1] !== undefined) {
        const keys = args[1] === "timers" && args[2] === "connect" ? (["connectRetry"] as (keyof BgpNeighbor)[]) : UNSET[args[1]];
        if (!keys) return { output: [err(`config router bgp no neighbor: unknown option '${args[1]}'`)] };
        if (nb) for (const k of keys) delete nb[k];
        return { output: [muted(`neighbor ${peer} ${args[1]} removed`)] };
      }
      const before = st.neighbors.length;
      st.neighbors = st.neighbors.filter((n) => n.peer !== peer);
      return { output: [muted(st.neighbors.length < before ? `neighbor ${peer} deleted` : `neighbor ${peer} not configured (no-op)`)] };
    },
  },
  {
    path: ["router", "bgp", "network"],
    summary: "Originate a local network (config router bgp network <cidr>)",
    run(args, ctx): CommandResult {
      const st = getBgpConfig(ctx.device);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      const cidr = normalizeCidr(positional(args)[0]);
      if (!cidr) return { output: [err("Usage: config router bgp network <ip/prefix>")] };
      if (!st.networks.includes(cidr)) st.networks.push(cidr);
      return { output: [muted(`network ${cidr} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "no", "network"],
    summary: "Withdraw a local network (config router bgp no network <cidr>)",
    run(args, ctx): CommandResult {
      const st = bgpConfigState(ctx.device);
      const cidr = normalizeCidr(positional(args)[0]);
      if (!cidr) return { output: [err("Usage: config router bgp no network <ip/prefix>")] };
      const before = st.networks.length;
      st.networks = st.networks.filter((n) => n !== cidr);
      return { output: [muted(st.networks.length < before ? `network ${cidr} withdrawn` : `network ${cidr} not configured (no-op)`)] };
    },
  },
  {
    path: ["router", "bgp", "timers"],
    summary: "Router-wide keepalive/hold timers (config router bgp timers <ka> <hold>)",
    run(args, ctx): CommandResult {
      const st = getBgpConfig(ctx.device);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      const a = positional(args).filter((x) => x !== "bgp");
      const t = parseTimers(a[0], a[1]);
      if (typeof t === "string") return { output: [err(t)] };
      st.keepalive = t.ka;
      st.holdtime = t.hold;
      return { output: [muted(`timers bgp ${t.ka} ${t.hold} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "no", "timers"],
    summary: "Restore default timers (60/180)",
    run(_a, ctx): CommandResult {
      const st = getBgpConfig(ctx.device);
      if (st) st.keepalive = st.holdtime = undefined;
      return { output: [muted("timers bgp restored to defaults")] };
    },
  },
  {
    path: ["router", "bgp", "redistribute"],
    summary: "Redistribute connected routes into BGP",
    run(args, ctx): CommandResult {
      const st = getBgpConfig(ctx.device);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      if (args[0] !== "connected") return { output: [err("Usage: config router bgp redistribute connected")] };
      st.redistributeConnected = true;
      return { output: [muted("redistribute connected configured")] };
    },
  },
  {
    path: ["router", "bgp", "no", "redistribute"],
    summary: "Stop redistributing connected routes",
    run(args, ctx): CommandResult {
      const st = getBgpConfig(ctx.device);
      if (st && args[0] === "connected") st.redistributeConnected = undefined;
      return { output: [muted("redistribute connected removed")] };
    },
  },
];

// ---------------------------------------------------------------------------
// show (FRR 10.3 vtysh format)

function memstr(bytes: number): string {
  // lib_vty.c:306 mtype_memstr
  if (bytes === 0) return "0 bytes";
  const k = bytes >> 10;
  return k > 10 ? `${k + (bytes & 512 ? 1 : 0)} KiB` : `${bytes} bytes`;
}

function peerUptime(ms: number | undefined, now: number): string {
  return ms === undefined ? "never" : frrUptime(now - ms);
}

const configuredPeers = (cfg: BgpConfig) => cfg.neighbors.filter((n) => n.remoteAs !== undefined);

function stateOf(rt: PeerRt | undefined): FsmState {
  return rt?.state ?? "Idle";
}

export function renderBgpSummary(ctx: CommandContext, now = Date.now()): string[] {
  const cfg = getBgpConfig(ctx.device);
  if (!cfg) return ["% BGP instance not found"];
  const rt = peekBgpRuntime(ctx.device);
  const peers = configuredPeers(cfg);
  if (!peers.length) return ["% No BGP neighbors found in VRF default"];
  const ribEntries = bgpTable(ctx.device).size;
  const width = Math.max(16, ...peers.map((n) => n.peer.length + 1));
  const out = [
    "",
    "IPv4 Unicast Summary:",
    `BGP router identifier ${bgpRouterId(ctx.device, cfg)}, local AS number ${cfg.localAs} VRF default vrf-id 0`,
    `BGP table version ${rt?.tableVersion ?? 0}`,
    // sizes as used by SONiC's KLISH summary template (128 B / RIB entry, 71 KiB / peer)
    `RIB entries ${ribEntries}, using ${memstr(ribEntries * 128)} of memory`,
    `Peers ${peers.length}, using ${memstr(peers.length * 71 * 1024)} of memory`,
    "",
    `Neighbor${" ".repeat(width - 8)}V         AS   MsgRcvd   MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd   PfxSnt Desc`,
  ];
  for (const nb of peers) {
    const p = rt?.peers[nb.peer];
    const st = stateOf(p);
    let tail: string;
    if (st === "Established") tail = ` ${String(Object.keys(p!.adjIn).length).padStart(12)} ${String(Object.keys(p!.adjOut).length).padStart(8)}`;
    else tail = `${nb.shutdown ? " Idle (Admin)" : ` ${st.padStart(12)}`} ${"0".padStart(8)}`;
    const desc = nb.description ? nb.description.slice(0, 20) : "N/A";
    out.push(
      `${nb.peer.padEnd(width)}4${String(nb.remoteAs).padStart(11)} ${String(p ? totalMsgs(p.rcvd) : 0).padStart(9)} ${String(p ? totalMsgs(p.sent) : 0).padStart(9)} ${String(st === "Established" ? (rt?.tableVersion ?? 0) : 0).padStart(8)} ${"0".padStart(4)} ${"0".padStart(4)} ${peerUptime(p?.uptimeMs, now).padStart(8)}${tail} ${desc}`,
    );
  }
  out.push("", `Total number of neighbors ${peers.length}`);
  return out;
}

function pathLine(prefix: string | null, path: BgpPath, valid: boolean, best: boolean): string {
  const internal = path.peer !== "0.0.0.0" && !path.ebgp;
  const status = ` ${valid ? "*" : " "}${best ? ">" : " "}${internal ? "i" : " "} `;
  const pfx = prefix === null ? " ".repeat(17) : prefix.length >= 17 ? `${prefix}\n${" ".repeat(20)}` : prefix.padEnd(17);
  const nh = path.nextHop.padEnd(16);
  const metric = path.med !== undefined ? String(path.med).padStart(10) : " ".repeat(10);
  const lp = path.localPref !== undefined ? String(path.localPref).padStart(7) : " ".repeat(7);
  const weight = `${String(path.weight).padStart(7)} `;
  const as = path.asPath.length ? `${path.asPath.join(" ")} ` : "";
  return `${status}${pfx}${nh}${metric}${lp}${weight}${as}${ORIGIN_STR[path.origin] ?? "?"}`;
}

const pfxKey = (k: string) => {
  const [a, l] = k.split("/");
  return a.split(".").reduce((n, o) => n * 256 + Number(o), 0) * 64 + Number(l);
};

export function renderBgpTable(ctx: CommandContext, filter?: string): string[] {
  const cfg = getBgpConfig(ctx.device);
  if (!cfg) return ["No BGP process is configured"];
  const rt = peekBgpRuntime(ctx.device);
  const table = bgpTable(ctx.device);
  const keys = [...table.keys()].filter((k) => !filter || k === filter).sort((a, b) => pfxKey(a) - pfxKey(b));
  let paths = 0;
  for (const k of table.keys()) paths += table.get(k)!.length;
  if (!keys.length) return filter ? ["% Network not in table"] : [`No BGP prefixes displayed, ${paths} exist`];
  const out = [
    `BGP table version is ${rt?.tableVersion ?? 0}, local router ID is ${bgpRouterId(ctx.device, cfg)}, vrf id 0`,
    `Default local pref ${BGP_DEFAULTS.localPref}, local AS ${cfg.localAs}`,
    "Status codes:  s suppressed, d damped, h history, u unsorted, * valid, > best, = multipath,",
    "               i internal, r RIB-failure, S Stale, R Removed",
    "Nexthop codes: @NNN nexthop's vrf id, < announce-nh-self",
    "Origin codes:  i - IGP, e - EGP, ? - incomplete",
    "RPKI validation codes: V valid, I invalid, N Not found",
    "",
    "     Network          Next Hop            Metric LocPrf Weight Path",
  ];
  let shownPaths = 0;
  for (const k of keys) {
    table.get(k)!.forEach((e, i) => {
      out.push(pathLine(i === 0 ? k : null, e.path, e.valid, i === 0 && e.valid));
      shownPaths++;
    });
  }
  out.push("", `Displayed ${keys.length} routes and ${shownPaths} total paths`);
  return out;
}

function capLine(name: string, rcvd: boolean): string {
  return `    ${name}: advertised${rcvd ? " and received" : ""}`;
}

export function renderBgpNeighbors(ctx: CommandContext, filter?: string, now = Date.now()): string[] {
  const cfg = getBgpConfig(ctx.device);
  if (!cfg) return ["% No BGP process is configured"];
  const rt = peekBgpRuntime(ctx.device);
  let peers = configuredPeers(cfg);
  if (filter) {
    peers = peers.filter((n) => n.peer === filter);
    if (!peers.length) return ["% No such neighbor in this view/vrf"];
  }
  if (!peers.length) return ["% No BGP neighbors found"];
  const rid = bgpRouterId(ctx.device, cfg);
  const out: string[] = [];
  for (const nb of peers) {
    const p = rt?.peers[nb.peer];
    const st = stateOf(p);
    const ebgp = nb.remoteAs !== cfg.localAs;
    out.push(`BGP neighbor is ${nb.peer}, remote AS ${nb.remoteAs}, local AS ${cfg.localAs}, ${ebgp ? "external" : "internal"} link`);
    out.push("  Local Role: undefined", "  Remote Role: undefined");
    if (nb.description) out.push(` Description: ${nb.description}`);
    if (p?.remoteHost) out.push(`Hostname: ${p.remoteHost}`);
    if (nb.shutdown) out.push(" Administratively shut down");
    out.push(`  BGP version 4, remote router ID ${p?.remoteId ?? "0.0.0.0"}, local router ID ${rid}`);
    out.push(`  BGP state = ${st}${st === "Established" ? `, up for ${peerUptime(p?.uptimeMs, now).padStart(8)}` : ""}`);
    out.push(`  Last read ${peerUptime(p?.lastReadMs, now)}, Last write ${peerUptime(p?.lastWriteMs, now)}`);
    const cfgHold = nb.holdtime ?? cfg.holdtime ?? BGP_DEFAULTS.holdtime;
    const cfgKa = nb.holdtime !== undefined ? nb.keepalive ?? 0 : cfg.keepalive ?? BGP_DEFAULTS.keepalive;
    const established = st === "Established" || st === "OpenConfirm";
    out.push(`  Hold time is ${established ? p!.holdTime : cfgHold} seconds, keepalive interval is ${established ? p!.keepalive : cfgKa} seconds`);
    out.push(`  Configured hold time is ${cfgHold} seconds, keepalive interval is ${cfgKa} seconds`);
    out.push("  Configured conditional advertisements interval is 60 seconds");
    if (st === "Established" && p) {
      const has = (c: number) => p.capsRcvd.includes(c);
      out.push("  Neighbor capabilities:", capLine("4 Byte AS", has(65)), capLine("Extended Message", has(6)), `    Route refresh: advertised${has(2) ? " and received(new)" : ""}`, capLine("Enhanced Route Refresh", has(70)), capLine("Address Family IPv4 Unicast", has(1)));
      out.push(`    Hostname Capability: advertised (name: ${ctx.device.config.hostname || ctx.device.name},domain name: n/a)${has(73) ? ` received (name: ${p.remoteHost ?? "n/a"},domain name: n/a)` : " not received"}`);
    }
    const s = p?.sent ?? { open: 0, update: 0, notify: 0, keepalive: 0, refresh: 0 };
    const r = p?.rcvd ?? s;
    const row = (label: string, a: number, b: number) => `    ${label.padEnd(15)}${String(a).padStart(10)} ${String(b).padStart(10)}`;
    out.push(
      "  Message statistics:",
      "    Inq depth is 0",
      "    Outq depth is 0",
      "                         Sent       Rcvd",
      row("Opens:", s.open, r.open),
      row("Notifications:", s.notify, r.notify),
      row("Updates:", s.update, r.update),
      row("Keepalives:", s.keepalive, r.keepalive),
      row("Route Refresh:", s.refresh, r.refresh),
      row("Capability:", 0, 0),
      row("Total:", p ? totalMsgs(s) : 0, p ? totalMsgs(r) : 0),
      "",
      "  Minimum time between advertisement runs is 0 seconds",
      "",
      " For address family: IPv4 Unicast",
    );
    if (st === "Established" && p) out.push("  Update group 1, subgroup 1", "  Packet Queue length 0");
    out.push("  Community attribute sent to this neighbor(all)", `  ${p && st === "Established" ? Object.keys(p.adjIn).length : 0} accepted prefixes`, "");
    out.push(`  Connections established ${p?.established ?? 0}; dropped ${p?.dropped ?? 0}`);
    const lr = p?.lastReset;
    if (!lr) out.push("  Last reset never");
    else {
      const why = lr.notify ? ` Notification ${lr.notify.dir} (${notifyText(lr.notify.code, lr.notify.subcode)})` : ` ${lr.reason} (n/a)`;
      out.push(`  Last reset ${frrUptime(now - lr.atMs)}, ${why}`);
    }
    if (ebgp && nb.ebgpMultihop) out.push(`  External BGP neighbor may be up to ${nb.ebgpMultihop} hops away.`);
    if (p?.tcb && (st === "OpenSent" || st === "OpenConfirm" || st === "Established")) {
      out.push(`Local host: ${p.tcb.localIp}, Local port: ${p.tcb.localPort}`, `Foreign host: ${nb.peer}, Foreign port: ${p.tcb.remotePort}`, `Nexthop: ${p.tcb.localIp}`);
    }
    out.push(`BGP Connect Retry Timer in Seconds: ${nb.connectRetry ?? BGP_DEFAULTS.connectRetry}`);
    if (p?.connectAt !== undefined && st !== "Established") out.push(`Next connect timer due in ${Math.max(0, Math.ceil((p.connectAt - now) / 1000))} seconds`);
    out.push(`Read thread: ${st === "Established" ? "on" : "off"}  Write thread: ${st === "Established" ? "on" : "off"}  FD used: ${p?.tcb ? 25 : -1}`, "");
  }
  return out;
}

const toLines = (ls: string[]): OutputLine[] => ls.map((l) => (l.startsWith("%") ? muted(l) : line(l)));

const summaryCmd = (path: string[]): SonicCmd => ({ path, summary: "Show BGP neighbor summary (FRR format)", run: (_a, ctx) => ({ output: toLines(renderBgpSummary(ctx)) }) });
const neighborsCmd = (path: string[]): SonicCmd => ({ path, summary: "Show BGP neighbor detail (FRR format)", run: (a, ctx) => ({ output: toLines(renderBgpNeighbors(ctx, positional(a)[0])) }) });
const ribCmd = (path: string[]): SonicCmd => ({
  path,
  summary: "Show the BGP table (FRR format)",
  run: (a, ctx) => ({ output: toLines(renderBgpTable(ctx, normalizeCidr(positional(a)[0]) ?? undefined)) }),
});

const show: SonicCmd[] = [];
for (const base of [["ip", "bgp"], ["bgp"], ["bgp", "ipv4", "unicast"], ["ip", "bgp", "ipv4", "unicast"]]) {
  show.push(summaryCmd([...base, "summary"]), neighborsCmd([...base, "neighbors"]), ribCmd(base));
}

export const bgpModule: SonicFeatureModule = { id: "bgp", config, show };
