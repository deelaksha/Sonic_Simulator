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
 *   show ip bgp neighbors    bgp_vty.c:14077+ bgp_show_peer (key lines; per-AF policy
 *                            lines bgp_vty.c:13824-13979, accepted prefixes :14018)
 *   show ip bgp <prefix>     bgp_route.c:12501 route_vty_out_detail_header ("Paths: (N
 *                            available, best #1, table default)", advertised-to peers)
 *                            + :10760 route_vty_out_detail (path, next hop / from,
 *                            Origin/metric/localpref/weight/valid/external/best
 *                            (<reason>), Community:, Last update:)
 *   show ip bgp neighbors X advertised-routes|received-routes|routes
 *                            bgp_route.c:14880 show_adj_route ("Total number of
 *                            prefixes N"; received-routes needs soft-reconfiguration
 *                            inbound, else "% Inbound soft reconfiguration not enabled")
 *   show ip bgp community [<c>..] [exact-match] | community-list <name>
 *   show bgp ipv6 unicast [...]   same views for the IPv6 unicast table
 *   show [ip] bgp vrf <vrf> [ipv4|ipv6 unicast] [...]   VRF instances
 *   show bgp community-list | as-path-access-list   bgp_vty.c:22295, bgp_filter.c:601
 *   show bgp l2vpn evpn [route [type macip|multicast|2|3]]
 *                            bgp_evpn_vty.c:3099 evpn_show_all_routes: legend
 *                            (:334-357), "Route Distinguisher:" per RD (:292),
 *                            route_vty_out (bgp_route.c:9678) — 5-char status
 *                            (:9621-9665), prefix then newline + 20 spaces when
 *                            longer than 17 (:9486), MP next hop (:9806-9838),
 *                            ext. communities on their own line (:10133-10146),
 *                            "Displayed N prefixes (M paths)" (:3268)
 *   show bgp l2vpn evpn summary   bgp_vty.c:12784 "L2VPN EVPN Summary:" + the
 *                            same table, EVPN-activated peers only
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
 *   config router bgp neighbor <ip> activate evpn      (l2vpn evpn: neighbor X activate)
 *   config router bgp no neighbor <ip> activate evpn
 *   config router bgp [no] advertise-all-vni            (l2vpn evpn: advertise-all-vni)
 *   config router bgp vrf <vrf> <as> | no | <any command above>   (router bgp <as> vrf <vrf>)
 *   config router bgp ipv6 <network|redistribute|maximum-paths|table-map|neighbor ...>
 *                                                       (address-family ipv6 unicast)
 *   config router bgp neighbor <ip> route-map|prefix-list|filter-list <name> in|out
 *   config router bgp neighbor <ip> weight <n> | soft-reconfiguration inbound | activate
 *   config router bgp [no] redistribute connected|static|ospf [route-map <rm>] [metric <n>]
 *   config router bgp [no] maximum-paths [ibgp] <n> | [no] table-map <rm>
 *   config router bgp [no] bestpath as-path multipath-relax
 *   config [no] bgp community-list standard <name> [seq <n>] permit|deny <comm>.. [any|all]
 *   config [no] bgp as-path access-list <name> [seq <n>] permit|deny <regex>  (KLISH: as-path-list)
 *
 * The VXLAN Click commands (config/show vxlan, show evpn ...) are appended to this
 * module's lists (lib/protocols/vxlan-cli.ts).
 *
 * Ranges: AS 1..4294967295; ebgp-multihop 1..255; keepalive 0..65535, hold 0 or
 * 3..65535 (FRR bgp_vty.c / bgp_packet.c:2025); connect 1..65535 (KLISH RANGE_1_65535).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, matchSonic, positional } from "./types";
import { interfaceByName } from "../../models/device";
import { isValidIpv4, isValidPrefix, networkAddress } from "../../models/ip";
import { isValidIpv6, networkAddress6 } from "../../models/ipv6";
import { vrfNames } from "../../models/vrf";
import { BgpAfConfig, BgpConfig, BgpNbrAf, BgpNeighbor, RedistProto, bgpConfigState, bgpVrfNames, bgpVrfState, getBgpConfig } from "../../protocols/bgp";
import { BGP_DEFAULTS, BgpPath, BgpRt, FsmState, PeerRt, TableEntry, bgpRouterId, bgpTable, peekBgpRuntime, totalMsgs, v6Up } from "../../protocols/bgp-daemon";
import { Af, COMMUNITY, asPathRegex, bgpListsState, communitiesStr, communityListPermits, parseCommunity, peekBgpLists, prefixListExists, routeMapExists, sortCommunities } from "../../protocols/bgp-policy";
import { ORIGIN_STR, notifyText } from "../../protocols/bgp-wire";
import { EvpnPath, evpnTable, evpnUp } from "../../protocols/bgp-daemon";
import { ecListStr, evpnPrefixStr } from "../../protocols/evpn-wire";
import { vxlanClickConfig, vxlanClickShow } from "../../protocols/vxlan-cli";
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

// ---------------------------------------------------------------------------
// community-lists / AS-path access-lists (global, like FRR's bgp_clist / as_list)
//   config bgp community-list standard <name> [seq <n>] permit|deny <comm>.. [any|all]
//   config no bgp community-list standard <name> [[seq <n>] permit|deny <comm>..]
//   config bgp as-path access-list <name> [seq <n>] permit|deny <regex>   (FRR)
//   config bgp as-path-list <name> [seq <n>] permit|deny <regex>          (KLISH)
//   config no bgp as-path access-list|as-path-list <name> [[seq <n>] permit|deny <regex>]

/** Optional `seq <n>` then permit|deny; FRR auto-numbers in steps of 5 (bgp_clist.c / bgp_filter.c). */
function parseSeqAction(tokens: string[], existing: { seq: number }[]): { seq: number; action: "permit" | "deny"; rest: string[] } | null {
  let i = 0;
  let seq: number | undefined;
  if (tokens[0] === "seq") {
    const n = parseInRange(tokens[1], 0, 4294967295);
    if (n === null) return null;
    seq = n;
    i = 2;
  }
  const action = tokens[i];
  if (action !== "permit" && action !== "deny") return null;
  return { seq: seq ?? (existing.length ? Math.max(...existing.map((e) => e.seq)) + 5 : 5), action, rest: tokens.slice(i + 1) };
}

function communityListCmd(args: string[], ctx: CommandContext, isNo: boolean): CommandResult {
  const usage = `Usage: config ${isNo ? "no " : ""}bgp community-list standard <name> [seq <n>] permit|deny <AA:NN|no-export|no-advertise|local-as|no-peer>.. [any|all]`;
  if (args[0] !== "standard" || !args[1]) return { output: [err(usage)] };
  const name = args[1];
  const lists = bgpListsState(ctx.device).community;
  if (isNo && args.length === 2) {
    delete lists[name];
    return { output: [muted(`community-list ${name} removed`)] };
  }
  const list = lists[name] ?? [];
  const p = parseSeqAction(args.slice(2), list);
  if (!p) return { output: [err(usage)] };
  const any = p.rest.includes("any");
  const members = p.rest.filter((x) => x !== "any" && x !== "all");
  if (!members.length || members.some((m) => parseCommunity(m) === null)) return { output: [err("% Malformed community-list value")] };
  if (isNo) {
    const kept = list.filter((e) => !(e.action === p.action && e.members.join(" ") === members.join(" ")));
    if (kept.length) lists[name] = kept;
    else delete lists[name];
    return { output: [muted(`community-list ${name} entry removed`)] };
  }
  lists[name] = [...list.filter((e) => e.seq !== p.seq), { seq: p.seq, action: p.action, members, ...(any ? { any } : {}) }];
  return { output: [muted(`community-list standard ${name} seq ${p.seq} ${p.action} ${members.join(" ")} configured`)] };
}

function asPathListCmd(args: string[], ctx: CommandContext, isNo: boolean): CommandResult {
  const usage = `Usage: config ${isNo ? "no " : ""}bgp as-path access-list <name> [seq <n>] permit|deny <regex>`;
  const name = args[0];
  if (!name) return { output: [err(usage)] };
  const lists = bgpListsState(ctx.device).aspath;
  if (isNo && args.length === 1) {
    delete lists[name];
    return { output: [muted(`as-path access-list ${name} removed`)] };
  }
  const list = lists[name] ?? [];
  const p = parseSeqAction(args.slice(1), list);
  const regex = p?.rest.join(" ");
  if (!p || !regex) return { output: [err(usage)] };
  try {
    asPathRegex(regex);
  } catch {
    return { output: [err(`% Invalid AS path regular expression: ${regex}`)] };
  }
  if (isNo) {
    const kept = list.filter((e) => !(e.action === p.action && e.regex === regex));
    if (kept.length) lists[name] = kept;
    else delete lists[name];
    return { output: [muted(`as-path access-list ${name} entry removed`)] };
  }
  lists[name] = [...list.filter((e) => e.seq !== p.seq), { seq: p.seq, action: p.action, regex }];
  return { output: [muted(`as-path access-list ${name} seq ${p.seq} ${p.action} ${regex} configured`)] };
}

const listConfig: SonicCmd[] = [
  { path: ["bgp", "community-list"], summary: "Add a BGP community-list entry", run: (a, ctx) => communityListCmd(a, ctx, false) },
  { path: ["no", "bgp", "community-list"], summary: "Delete a BGP community-list (or one entry)", run: (a, ctx) => communityListCmd(a, ctx, true) },
  { path: ["bgp", "as-path", "access-list"], summary: "Add an AS-path access-list entry (FRR form)", run: (a, ctx) => asPathListCmd(a, ctx, false) },
  { path: ["no", "bgp", "as-path", "access-list"], summary: "Delete an AS-path access-list (or one entry)", run: (a, ctx) => asPathListCmd(a, ctx, true) },
  { path: ["bgp", "as-path-list"], summary: "Add an AS-path access-list entry (KLISH form)", run: (a, ctx) => asPathListCmd(a, ctx, false) },
  { path: ["no", "bgp", "as-path-list"], summary: "Delete an AS-path access-list (KLISH form)", run: (a, ctx) => asPathListCmd(a, ctx, true) },
];

/** show bgp community-list [<name> [detail]] — bgp_vty.c:22295 community_list_show. */
function renderCommunityLists(ctx: CommandContext, name?: string): string[] {
  const lists = peekBgpLists(ctx.device)?.community ?? {};
  const names = Object.keys(lists).filter((n) => !name || n === name).sort();
  if (name && !names.length) return ["% Can't find community-list"];
  const out: string[] = [];
  for (const n of names) {
    out.push(/^\d+$/.test(n) ? `Community standard list ${n}` : `Named Community standard list ${n}`);
    for (const e of [...lists[n]].sort((a, b) => a.seq - b.seq)) {
      const vals = sortCommunities(e.members.map((m) => parseCommunity(m)!));
      out.push(`    ${e.action} ${communitiesStr(vals)}`);
    }
  }
  return out;
}

/** show bgp as-path-access-list [<name>] — bgp_filter.c:601 as_list_show. */
function renderAsPathLists(ctx: CommandContext, name?: string): string[] {
  const lists = peekBgpLists(ctx.device)?.aspath ?? {};
  const names = Object.keys(lists).filter((n) => !name || n === name).sort();
  if (name && !names.length) return [`% AS path access list ${name} not found`];
  const out: string[] = [];
  for (const n of names) {
    out.push(`AS path access list ${n}`);
    for (const e of [...lists[n]].sort((a, b) => a.seq - b.seq)) out.push(`    ${e.action} ${e.regex}`);
  }
  return out;
}

// Instance + address family selected by the `vrf <name>` / `ipv6` prefixes while
// the nested command runs (config router bgp [vrf <vrf>] [ipv6] ...).
let curVrf = "default";
let curAf: Af = "ipv4";

function cfgOf(ctx: CommandContext): BgpConfig | undefined {
  return getBgpConfig(ctx.device, curVrf);
}

/** Config store of the selected instance (created on first use). */
function storeOf(ctx: CommandContext): BgpConfig {
  if (curVrf === "default") return bgpConfigState(ctx.device);
  const vrfs = bgpVrfState(ctx.device).vrfs;
  return (vrfs[curVrf] ??= { localAs: undefined, neighbors: [], networks: [], vrf: curVrf });
}

/** The selected address family's settings (IPv4 lives on BgpConfig itself). */
function afStore(st: BgpConfig): BgpAfConfig {
  if (curAf === "ipv4") return st as BgpAfConfig;
  return (st.ipv6 ??= { networks: [] });
}

function scoped(vrf: string, af: Af, tokens: string[], ctx: CommandContext): CommandResult {
  const [v, a] = [curVrf, curAf];
  curVrf = vrf;
  curAf = af;
  try {
    const m = matchSonic(config, ["router", "bgp", ...tokens]);
    if (!m) return { output: [err("Usage: config router bgp [vrf <vrf>] [ipv6] <command>")] };
    return m.cmd.run(m.rest, ctx);
  } finally {
    curVrf = v;
    curAf = a;
  }
}

function normalizeCidrAf(token: string | undefined): string | null {
  if (curAf === "ipv4") return normalizeCidr(token);
  if (!token || !token.includes("/")) return null;
  const [addr, plen] = token.split("/");
  const len = Number(plen);
  if (!isValidIpv6(addr) || !/^\d+$/.test(plen) || len > 128) return null;
  return `${networkAddress6(addr, len)}/${len}`;
}

const AF_NAME = () => (curAf === "ipv4" ? "IPv4 unicast" : "IPv6 unicast");
const nbAf = (nb: BgpNeighbor): BgpNbrAf => ((nb.af ??= {})[curAf] ??= {});

const POLICY_KEY: Record<string, { in: keyof BgpNbrAf; out: keyof BgpNbrAf }> = {
  "route-map": { in: "routeMapIn", out: "routeMapOut" },
  "prefix-list": { in: "prefixListIn", out: "prefixListOut" },
  "filter-list": { in: "filterListIn", out: "filterListOut" },
};

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
      if (rest[0] === "evpn" || rest[0] === "l2vpn") {
        nb.evpn = true;
        return ok(`neighbor ${peer} activated for L2VPN EVPN`);
      }
      if (curAf === "ipv6" || rest[0] === "ipv6") {
        nb.ipv6 = true;
        return ok(`neighbor ${peer} activated for IPv6 unicast`);
      }
      return ok(`neighbor ${peer} activated for IPv4 unicast`);
    case "route-map":
    case "prefix-list":
    case "filter-list": {
      const [name, dir] = rest;
      if (!name || (dir !== "in" && dir !== "out")) return { output: [err(`config router bgp neighbor: ${key} <name> in|out`)] };
      (nbAf(nb) as Record<string, unknown>)[POLICY_KEY[key][dir]] = name;
      return ok(`neighbor ${peer} ${key} ${name} ${dir} configured (${AF_NAME()})`);
    }
    case "weight": {
      const w = parseInRange(rest[0], 0, 65535);
      if (w === null) return { output: [err("config router bgp neighbor: weight 0-65535")] };
      nbAf(nb).weight = w;
      return ok(`neighbor ${peer} weight ${w} configured (${AF_NAME()})`);
    }
    case "soft-reconfiguration":
      if (rest[0] !== "inbound") return { output: [err("config router bgp neighbor: soft-reconfiguration inbound")] };
      nbAf(nb).softReconfig = true;
      return ok(`neighbor ${peer} soft-reconfiguration inbound configured (${AF_NAME()})`);
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

const REDIST: RedistProto[] = ["connected", "static", "ospf"];

const config: SonicCmd[] = [
  {
    path: ["router", "bgp"],
    summary: "Set the local BGP AS (config router bgp <as>) or remove BGP (config router bgp no)",
    run(args, ctx): CommandResult {
      if (args[0] === "no" && args.length === 1) {
        if (curVrf !== "default") {
          delete bgpVrfState(ctx.device).vrfs[curVrf];
          return { output: [muted(`BGP instance in vrf ${curVrf} removed`)] };
        }
        // bgp_vty.c no_router_bgp: "Cannot delete default BGP instance. Dependent VRF instances exist"
        if (bgpVrfNames(ctx.device).length) return { output: [err("% Cannot delete default BGP instance. Dependent VRF instances exist")] };
        const st = storeOf(ctx);
        st.localAs = undefined;
        st.routerId = undefined;
        st.neighbors = [];
        st.networks = [];
        st.keepalive = st.holdtime = undefined;
        st.redistributeConnected = undefined;
        st.advertiseAllVni = undefined;
        st.redist = st.maxPaths = st.maxPathsIbgp = st.tableMap = st.ipv6 = st.multipathRelax = undefined;
        return { output: [muted("BGP instance removed")] };
      }
      const as = parseInRange(positional(args)[0], AS.min, AS.max);
      if (as === null) return { output: [err(`Usage: config router bgp [vrf <vrf>] <as> (${AS.min}-${AS.max})`)] };
      const st = storeOf(ctx);
      st.localAs = as;
      return { output: [muted(`router bgp ${as}${curVrf !== "default" ? ` vrf ${curVrf}` : ""} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "vrf"],
    summary: "Run a BGP command in a VRF instance (config router bgp vrf <vrf> <as> | no | <command>)",
    run(args, ctx): CommandResult {
      const vrf = args[0];
      if (!vrf || args.length < 2) return { output: [err("Usage: config router bgp vrf <vrf> <as> | no | <command>")] };
      return scoped(vrf, curAf, args.slice(1), ctx);
    },
  },
  {
    path: ["router", "bgp", "ipv6"],
    summary: "Run a BGP command in address-family ipv6 unicast (config router bgp ipv6 network|redistribute|maximum-paths|neighbor ...)",
    run(args, ctx): CommandResult {
      if (!args.length) return { output: [err("Usage: config router bgp ipv6 <command>")] };
      return scoped(curVrf, "ipv6", args, ctx);
    },
  },
  {
    path: ["router", "bgp", "router-id"],
    summary: "Set the BGP router-id (config router bgp router-id <ipv4>)",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
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
      const st = cfgOf(ctx);
      if (st) st.routerId = undefined;
      return { output: [muted("router-id removed")] };
    },
  },
  {
    path: ["router", "bgp", "neighbor"],
    summary: "Configure a neighbor (remote-as | description | ebgp-multihop | timers | update-source | bfd | shutdown | activate | route-map | prefix-list | filter-list | weight | soft-reconfiguration)",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      const peer = args[0];
      if (!peer || !isValidIpv4(peer)) return { output: [err("Usage: config router bgp neighbor <ip> remote-as <as> | description <text> | ebgp-multihop <n> | timers <ka> <hold> | update-source <src> | bfd | shutdown | route-map <rm> in|out")] };
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
      const st = storeOf(ctx);
      const peer = args[0];
      if (!peer) return { output: [err("Usage: config router bgp no neighbor <ip> [<attribute>]")] };
      const nb = st.neighbors.find((n) => n.peer === peer);
      const attr = args[1];
      if (attr !== undefined) {
        if (POLICY_KEY[attr]) {
          // no neighbor X route-map [NAME] in|out
          const dir = args.slice(2).find((x) => x === "in" || x === "out") as "in" | "out" | undefined;
          if (!dir) return { output: [err(`config router bgp no neighbor: ${attr} [<name>] in|out`)] };
          if (nb?.af?.[curAf]) delete nb.af[curAf]![POLICY_KEY[attr][dir]];
          return { output: [muted(`neighbor ${peer} ${attr} ${dir} removed (${AF_NAME()})`)] };
        }
        if (attr === "weight" || attr === "soft-reconfiguration") {
          if (nb?.af?.[curAf]) delete nb.af[curAf]![attr === "weight" ? "weight" : "softReconfig"];
          return { output: [muted(`neighbor ${peer} ${attr} removed (${AF_NAME()})`)] };
        }
        const keys =
          attr === "timers" && args[2] === "connect"
            ? (["connectRetry"] as (keyof BgpNeighbor)[])
            : attr === "activate" && (args[2] === "evpn" || args[2] === "l2vpn")
              ? (["evpn"] as (keyof BgpNeighbor)[])
              : attr === "activate" && (curAf === "ipv6" || args[2] === "ipv6")
                ? (["ipv6"] as (keyof BgpNeighbor)[])
                : UNSET[attr];
        if (!keys) return { output: [err(`config router bgp no neighbor: unknown option '${attr}'`)] };
        if (nb) for (const k of keys) delete nb[k];
        return { output: [muted(`neighbor ${peer} ${attr} removed`)] };
      }
      const before = st.neighbors.length;
      st.neighbors = st.neighbors.filter((n) => n.peer !== peer);
      return { output: [muted(st.neighbors.length < before ? `neighbor ${peer} deleted` : `neighbor ${peer} not configured (no-op)`)] };
    },
  },
  {
    path: ["router", "bgp", "network"],
    summary: "Originate a local network (config router bgp [ipv6] network <cidr>)",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      const cidr = normalizeCidrAf(positional(args)[0]);
      if (!cidr) return { output: [err(`Usage: config router bgp ${curAf === "ipv6" ? "ipv6 " : ""}network <ip/prefix>`)] };
      const af = afStore(st);
      if (!af.networks.includes(cidr)) af.networks.push(cidr);
      return { output: [muted(`network ${cidr} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "no", "network"],
    summary: "Withdraw a local network (config router bgp [ipv6] no network <cidr>)",
    run(args, ctx): CommandResult {
      const af = afStore(storeOf(ctx));
      const cidr = normalizeCidrAf(positional(args)[0]);
      if (!cidr) return { output: [err("Usage: config router bgp no network <ip/prefix>")] };
      const before = af.networks.length;
      af.networks = af.networks.filter((n) => n !== cidr);
      return { output: [muted(af.networks.length < before ? `network ${cidr} withdrawn` : `network ${cidr} not configured (no-op)`)] };
    },
  },
  {
    path: ["router", "bgp", "timers"],
    summary: "Router-wide keepalive/hold timers (config router bgp timers <ka> <hold>)",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
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
      const st = cfgOf(ctx);
      if (st) st.keepalive = st.holdtime = undefined;
      return { output: [muted("timers bgp restored to defaults")] };
    },
  },
  {
    path: ["router", "bgp", "redistribute"],
    summary: "Redistribute routes into BGP (config router bgp [ipv6] redistribute connected|static|ospf [route-map <rm>] [metric <n>])",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      const proto = args[0] as RedistProto;
      const rmI = args.indexOf("route-map");
      const mI = args.indexOf("metric");
      const metric = mI >= 0 ? parseInRange(args[mI + 1], 0, 4294967295) : undefined;
      if (!REDIST.includes(proto) || (rmI >= 0 && !args[rmI + 1]) || metric === null) return { output: [err("Usage: config router bgp redistribute connected|static|ospf [route-map <name>] [metric <0-4294967295>]")] };
      const af = afStore(st);
      (af.redist ??= {})[proto] = { ...(rmI >= 0 ? { routeMap: args[rmI + 1] } : {}), ...(metric !== undefined ? { metric } : {}) };
      if (curAf === "ipv4" && proto === "connected") st.redistributeConnected = true;
      return { output: [muted(`redistribute ${args.join(" ")} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "no", "redistribute"],
    summary: "Stop redistributing a protocol",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
      const proto = args[0] as RedistProto;
      if (st && REDIST.includes(proto)) {
        const af = afStore(st);
        if (af.redist) delete af.redist[proto];
        if (curAf === "ipv4" && proto === "connected") st.redistributeConnected = undefined;
      }
      return { output: [muted(`redistribute ${proto ?? ""} removed`)] };
    },
  },
  {
    path: ["router", "bgp", "maximum-paths"],
    summary: "ECMP paths (config router bgp [ipv6] maximum-paths [ibgp] <1-256>)",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      const ibgp = args[0] === "ibgp";
      const n = parseInRange(args[ibgp ? 1 : 0], 1, BGP_DEFAULTS.maxPaths);
      if (n === null) return { output: [err(`Usage: config router bgp maximum-paths [ibgp] <1-${BGP_DEFAULTS.maxPaths}>`)] };
      const af = afStore(st);
      if (ibgp) af.maxPathsIbgp = n;
      else af.maxPaths = n;
      return { output: [muted(`maximum-paths ${ibgp ? "ibgp " : ""}${n} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "no", "maximum-paths"],
    summary: "Restore the default number of ECMP paths",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (st) {
        const af = afStore(st);
        if (args[0] === "ibgp") af.maxPathsIbgp = undefined;
        else af.maxPaths = undefined;
      }
      return { output: [muted("maximum-paths restored to default")] };
    },
  },
  {
    path: ["router", "bgp", "table-map"],
    summary: "Route-map applied when installing BGP routes into the RIB (config router bgp [ipv6] table-map <rm>)",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      if (!args[0]) return { output: [err("Usage: config router bgp table-map <route-map>")] };
      afStore(st).tableMap = args[0];
      return { output: [muted(`table-map ${args[0]} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "no", "table-map"],
    summary: "Remove the table-map",
    run(_a, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (st) afStore(st).tableMap = undefined;
      return { output: [muted("table-map removed")] };
    },
  },
  {
    path: ["router", "bgp", "bestpath"],
    summary: "Best-path options (config router bgp bestpath as-path multipath-relax)",
    run(args, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      if (args.join(" ") !== "as-path multipath-relax") return { output: [err("Usage: config router bgp bestpath as-path multipath-relax")] };
      st.multipathRelax = true;
      return { output: [muted("bgp bestpath as-path multipath-relax configured")] };
    },
  },
  {
    path: ["router", "bgp", "no", "bestpath"],
    summary: "Remove a best-path option",
    run(_a, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (st) st.multipathRelax = undefined;
      return { output: [muted("bgp bestpath as-path multipath-relax removed")] };
    },
  },
  {
    path: ["router", "bgp", "advertise-all-vni"],
    summary: "L2VPN EVPN: advertise all local VNIs (config router bgp advertise-all-vni)",
    run(_a, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (!st) return { output: [err(NOT_CONFIGURED)] };
      st.advertiseAllVni = true;
      return { output: [muted("advertise-all-vni configured")] };
    },
  },
  {
    path: ["router", "bgp", "no", "advertise-all-vni"],
    summary: "L2VPN EVPN: stop advertising local VNIs",
    run(_a, ctx): CommandResult {
      const st = cfgOf(ctx);
      if (st) st.advertiseAllVni = undefined;
      return { output: [muted("advertise-all-vni removed")] };
    },
  },
  ...listConfig,
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

/** Linux VRF table id stand-in: position in the VRF list (default = 0). */
const vrfId = (ctx: CommandContext, vrf: string) => Math.max(0, vrfNames(ctx.device).indexOf(vrf));
const AF_TITLE: Record<Af, string> = { ipv4: "IPv4 Unicast", ipv6: "IPv6 Unicast" };
const afUp = (af: Af, nb: BgpNeighbor, p: PeerRt | undefined) => af === "ipv4" || v6Up(nb, p);
const adjInOf = (p: PeerRt, af: Af) => (af === "ipv4" ? p.adjIn : (p.adjIn6 ?? {}));
const adjOutOf = (p: PeerRt, af: Af) => (af === "ipv4" ? p.adjOut : (p.adjOut6 ?? {}));

/** Prefixes from `peer` accepted into the table (peer->pcount). */
function acceptedCount(table: Map<string, TableEntry[]>, peer: string): number {
  let n = 0;
  for (const list of table.values()) if (list.some((e) => e.path.peer === peer)) n++;
  return n;
}

export function renderBgpSummary(ctx: CommandContext, now = Date.now(), evpn = false, vrf = "default", af: Af = "ipv4"): string[] {
  const cfg = getBgpConfig(ctx.device, vrf);
  if (!cfg) return [vrf === "default" ? "% BGP instance not found" : `% BGP instance not found for VRF ${vrf}`];
  const rt = peekBgpRuntime(ctx.device, vrf);
  const peers = configuredPeers(cfg).filter((n) => (!evpn || n.evpn) && (evpn || af === "ipv4" || n.ipv6));
  if (!peers.length) return [`% No BGP neighbors found in VRF ${vrf}`];
  const table = evpn ? undefined : bgpTable(ctx.device, af, vrf);
  const ribEntries = evpn ? evpnRibEntries(ctx) : table!.size;
  const rcvd = (p: PeerRt) => (evpn ? Object.keys(p.evpnIn ?? {}).length : acceptedCount(table!, p.peer));
  const sent = (p: PeerRt) => (evpn ? Object.keys(p.evpnOut ?? {}).length : Object.keys(adjOutOf(p, af)).length);
  const width = Math.max(16, ...peers.map((n) => n.peer.length + 1));
  const out = [
    "",
    evpn ? "L2VPN EVPN Summary:" : `${AF_TITLE[af]} Summary:`,
    `BGP router identifier ${bgpRouterId(ctx.device, cfg)}, local AS number ${cfg.localAs} VRF ${vrf} vrf-id ${vrfId(ctx, vrf)}`,
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
    if (st === "Established" && ((evpn && !evpnUp(nb, p)) || (!evpn && !afUp(af, nb, p)))) tail = ` ${"NoNeg".padStart(12)} ${"NoNeg".padStart(8)}`;
    else if (st === "Established") tail = ` ${String(rcvd(p!)).padStart(12)} ${String(sent(p!)).padStart(8)}`;
    else tail = `${nb.shutdown ? " Idle (Admin)" : ` ${st.padStart(12)}`} ${"0".padStart(8)}`;
    const desc = nb.description ? nb.description.slice(0, 20) : "N/A";
    out.push(
      `${nb.peer.padEnd(width)}4${String(nb.remoteAs).padStart(11)} ${String(p ? totalMsgs(p.rcvd) : 0).padStart(9)} ${String(p ? totalMsgs(p.sent) : 0).padStart(9)} ${String(st === "Established" ? (rt?.tableVersion ?? 0) : 0).padStart(8)} ${"0".padStart(4)} ${"0".padStart(4)} ${peerUptime(p?.uptimeMs, now).padStart(8)}${tail} ${desc}`,
    );
  }
  out.push("", `Total number of neighbors ${peers.length}`);
  return out;
}

/** route_vty_out (bgp_route.c:9678): status, prefix (17), next hop (16), metric, locprf, weight, path, origin. */
function pathLine(prefix: string | null, path: BgpPath, valid: boolean, best: boolean, multipath = false): string {
  const internal = path.peer !== "0.0.0.0" && !path.ebgp;
  const status = ` ${valid ? "*" : " "}${best ? ">" : multipath ? "=" : " "}${internal ? "i" : " "} `;
  const pfx = prefix === null ? " ".repeat(17) : prefix.length >= 17 ? `${prefix}\n${" ".repeat(20)}` : prefix.padEnd(17);
  const nhStr = path.nextHopLL ?? path.nextHop;
  const nh = nhStr.length >= 16 ? `${nhStr}\n${" ".repeat(36)}` : nhStr.padEnd(16);
  const metric = path.med !== undefined ? String(path.med).padStart(10) : " ".repeat(10);
  const lp = path.localPref !== undefined ? String(path.localPref).padStart(7) : " ".repeat(7);
  const weight = `${String(path.weight).padStart(7)} `;
  const as = path.asPath.length ? `${path.asPath.join(" ")} ` : "";
  return `${status}${pfx}${nh}${metric}${lp}${weight}${as}${ORIGIN_STR[path.origin] ?? "?"}`;
}

const pfxKey = (k: string) => {
  const [a, l] = k.split("/");
  if (a.includes(":")) return 0;
  return a.split(".").reduce((n, o) => n * 256 + Number(o), 0) * 64 + Number(l);
};
const sortKeys = (keys: string[]) => (keys.some((k) => k.includes(":")) ? keys.sort() : keys.sort((a, b) => pfxKey(a) - pfxKey(b)));

function tableHeader(ctx: CommandContext, cfg: BgpConfig, rt: BgpRt | undefined, vrf: string): string[] {
  return [
    `BGP table version is ${rt?.tableVersion ?? 0}, local router ID is ${bgpRouterId(ctx.device, cfg)}, vrf id ${vrfId(ctx, vrf)}`,
    `Default local pref ${BGP_DEFAULTS.localPref}, local AS ${cfg.localAs}`,
    "Status codes:  s suppressed, d damped, h history, u unsorted, * valid, > best, = multipath,",
    "               i internal, r RIB-failure, S Stale, R Removed",
    "Nexthop codes: @NNN nexthop's vrf id, < announce-nh-self",
    "Origin codes:  i - IGP, e - EGP, ? - incomplete",
    "RPKI validation codes: V valid, I invalid, N Not found",
    "",
    "     Network          Next Hop            Metric LocPrf Weight Path",
  ];
}

/** Path filter for `show ... bgp community ...` / `neighbors X routes`. */
type PathFilter = (k: string, e: TableEntry) => boolean;

export function renderBgpTable(ctx: CommandContext, filter?: string, vrf = "default", af: Af = "ipv4", pathFilter?: PathFilter): string[] {
  const cfg = getBgpConfig(ctx.device, vrf);
  if (!cfg) return ["No BGP process is configured"];
  const rt = peekBgpRuntime(ctx.device, vrf);
  const table = bgpTable(ctx.device, af, vrf);
  const keys = sortKeys([...table.keys()].filter((k) => !filter || k === filter));
  let paths = 0;
  for (const k of table.keys()) paths += table.get(k)!.length;
  const rows: string[] = [];
  let shownRoutes = 0;
  let shownPaths = 0;
  for (const k of keys) {
    const list = table.get(k)!;
    const sel = list.map((e, i) => ({ e, i })).filter(({ e }) => !pathFilter || pathFilter(k, e));
    if (!sel.length) continue;
    shownRoutes++;
    sel.forEach(({ e, i }, n) => {
      rows.push(pathLine(n === 0 ? k : null, e.path, e.valid, i === 0 && e.valid, !!e.multipath));
      shownPaths++;
    });
  }
  if (!shownRoutes) return filter ? ["% Network not in table"] : [`No BGP prefixes displayed, ${paths} exist`];
  return [...tableHeader(ctx, cfg, rt, vrf), ...rows, "", `Displayed ${shownRoutes} routes and ${shownPaths} total paths`];
}

/** ctime(3) as FRR's time_to_string prints it. */
function ctime(ms: number): string {
  const d = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${day} ${mon} ${String(d.getDate()).padStart(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
}

const ORIGIN_LONG = ["IGP", "EGP", "incomplete"]; // bgp_attr.c bgp_origin_long_str

/** `show ip bgp <prefix>` — route_vty_out_detail_header (bgp_route.c:12501) + route_vty_out_detail (:10760). */
export function renderBgpDetail(ctx: CommandContext, prefix: string, vrf = "default", af: Af = "ipv4", now = Date.now()): string[] {
  const cfg = getBgpConfig(ctx.device, vrf);
  if (!cfg) return ["No BGP process is configured"];
  const rt = peekBgpRuntime(ctx.device, vrf);
  const list = bgpTable(ctx.device, af, vrf).get(prefix);
  if (!list?.length) return ["% Network not in table"];
  const best = list[0].valid ? list[0] : undefined;
  const comms = best?.path.communities ?? [];
  const note = comms.includes(COMMUNITY.NO_EXPORT)
    ? ", not advertised to EBGP peer"
    : comms.includes(COMMUNITY.NO_ADVERTISE)
      ? ", not advertised to any peer"
      : comms.includes(COMMUNITY.LOCAL_AS)
        ? ", not advertised outside local AS"
        : comms.includes(COMMUNITY.NO_PEER)
          ? ", inform EBGP peer not to advertise to their EBGP peers"
          : "";
  const out = [`BGP routing table entry for ${prefix}, version ${rt?.tableVersion ?? 0}`, `Paths: (${list.length} available${best ? `, best #1, ${vrf === "default" ? "table default" : `vrf ${vrf}`}` : ", no best path"}${note})`];
  const advTo = Object.values(rt?.peers ?? {})
    .filter((p) => adjOutOf(p, af)[prefix] !== undefined)
    .map((p) => p.peer);
  out.push(advTo.length ? "  Advertised to non peer-group peers:" : "  Not advertised to any peer");
  if (advTo.length) out.push(` ${advTo.map((p) => ` ${p}`).join("")}`);
  for (const e of list) {
    const p = e.path;
    const local = p.peer === "0.0.0.0";
    out.push(`  ${p.asPath.length ? p.asPath.join(" ") : "Local"}`);
    const reach = !e.valid ? " (inaccessible)" : p.igpMetric ? ` (metric ${p.igpMetric})` : "";
    const from = local ? ` from ${af === "ipv4" ? "0.0.0.0" : "::"} (${bgpRouterId(ctx.device, cfg)})` : ` from ${p.peer} (${p.peerRid})`;
    out.push(`    ${p.nextHop}${reach}${from}`);
    if (p.nextHopLL) out.push(`    (${p.nextHopLL}) (used)`);
    let l3 = `      Origin ${ORIGIN_LONG[p.origin] ?? "incomplete"}`;
    if (p.med !== undefined) l3 += `, metric ${p.med}`;
    if (p.localPref !== undefined) l3 += `, localpref ${p.localPref}`;
    if (p.weight) l3 += `, weight ${p.weight}`;
    if (e.valid) l3 += ", valid";
    l3 += local ? (p.local === "network" ? ", sourced, local" : ", sourced") : p.ebgp ? ", external" : ", internal";
    if (e.multipath || (e === best && list.some((x) => x.multipath))) l3 += ", multipath";
    if (e === best) l3 += `, best (${e.reason ?? "First path received"})`;
    out.push(l3);
    if (p.communities?.length) out.push(`      Community: ${communitiesStr(p.communities)}`);
    out.push(`      Last update: ${ctime(p.sinceMs || now)}`);
  }
  return out;
}

/** `show ip bgp neighbors X advertised-routes|received-routes|routes` (bgp_route.c:14880 show_adj_route). */
export function renderNeighborRoutes(ctx: CommandContext, peer: string, kind: "advertised-routes" | "received-routes" | "routes", vrf = "default", af: Af = "ipv4"): string[] {
  const cfg = getBgpConfig(ctx.device, vrf);
  if (!cfg) return ["No BGP process is configured"];
  const nb = cfg.neighbors.find((n) => n.peer === peer);
  const rt = peekBgpRuntime(ctx.device, vrf);
  const p = rt?.peers[peer];
  if (!nb || nb.remoteAs === undefined) return ["% No such neighbor or address family"];
  if (kind === "routes") return renderBgpTable(ctx, undefined, vrf, af, (_k, e) => e.path.peer === peer);
  if (kind === "received-routes" && !nb.af?.[af]?.softReconfig) return ["% Inbound soft reconfiguration not enabled"];
  if (!p || p.state !== "Established") return [];
  const src = kind === "advertised-routes" ? ((af === "ipv4" ? p.advOut : p.advOut6) ?? {}) : adjInOf(p, af);
  const keys = sortKeys(Object.keys(src));
  if (!keys.length) return [];
  return [...tableHeader(ctx, cfg, rt, vrf), ...keys.map((k) => pathLine(k, src[k], true, true)), "", `Total number of prefixes ${keys.length}`];
}

function capLine(name: string, rcvd: boolean): string {
  return `    ${name}: advertised${rcvd ? " and received" : ""}`;
}

/** bgp_vty.c bgp_show_peer_afi policy lines ("*" = the list/map exists). */
function afPolicyLines(ctx: CommandContext, nb: BgpNeighbor, af: Af): string[] {
  const pol = nb.af?.[af];
  if (!pol) return [];
  const star = (ok: boolean) => (ok ? "*" : "");
  const out: string[] = [];
  if (pol.softReconfig) out.push("  Inbound soft reconfiguration allowed");
  if (pol.prefixListIn) out.push(`  Incoming update prefix filter list is ${star(prefixListExists(ctx.device, pol.prefixListIn, af))}${pol.prefixListIn}`);
  if (pol.prefixListOut) out.push(`  Outgoing update prefix filter list is ${star(prefixListExists(ctx.device, pol.prefixListOut, af))}${pol.prefixListOut}`);
  const asl = peekBgpLists(ctx.device)?.aspath ?? {};
  if (pol.filterListIn) out.push(`  Incoming update AS path filter list is ${star(!!asl[pol.filterListIn])}${pol.filterListIn}`);
  if (pol.filterListOut) out.push(`  Outgoing update AS path filter list is ${star(!!asl[pol.filterListOut])}${pol.filterListOut}`);
  if (pol.routeMapIn) out.push(`  Route map for incoming advertisements is ${star(routeMapExists(ctx.device, pol.routeMapIn))}${pol.routeMapIn}`);
  if (pol.routeMapOut) out.push(`  Route map for outgoing advertisements is ${star(routeMapExists(ctx.device, pol.routeMapOut))}${pol.routeMapOut}`);
  return out;
}

export function renderBgpNeighbors(ctx: CommandContext, filter?: string, now = Date.now(), vrf = "default"): string[] {
  const cfg = getBgpConfig(ctx.device, vrf);
  if (!cfg) return ["% No BGP process is configured"];
  const rt = peekBgpRuntime(ctx.device, vrf);
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
      if (nb.ipv6) out.push(capLine("Address Family IPv6 Unicast", (p.mpRcvd ?? []).includes("2/1")));
      if (nb.evpn) out.push(capLine("Address Family L2VPN EVPN", (p.mpRcvd ?? []).includes("25/70")));
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
    );
    for (const af of ["ipv4", "ipv6"] as Af[]) {
      if (af === "ipv6" && !nb.ipv6) continue;
      out.push(` For address family: ${AF_TITLE[af]}`);
      if (st === "Established" && p) out.push(`  Update group ${af === "ipv4" ? 1 : 2}, subgroup ${af === "ipv4" ? 1 : 2}`, "  Packet Queue length 0");
      out.push(...afPolicyLines(ctx, nb, af));
      const accepted = p && st === "Established" && afUp(af, nb, p) ? acceptedCount(bgpTable(ctx.device, af, vrf), nb.peer) : 0;
      out.push("  Community attribute sent to this neighbor(all)", `  ${accepted} accepted prefixes`, "");
    }
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

/** RD nodes + prefixes in the EVPN table (FRR counts both levels of the 2-level table). */
function evpnRibEntries(ctx: CommandContext): number {
  const keys = [...evpnTable(ctx.device).keys()];
  return keys.length + new Set(keys.map((k) => k.split("|")[0])).size;
}

const rdOrder = (rd: string) => {
  const [a, n] = rd.split(":");
  return a.split(".").reduce((x, o) => x * 256 + Number(o), 0) * 65536 + Number(n);
};
const evpnOrder = (k: string) => k.split("|")[1]; // [2]… before [3]…, then by MAC/IP

function evpnPathLines(path: EvpnPath, valid: boolean, best: boolean): string[] {
  const internal = path.peer !== "0.0.0.0" && !path.ebgp;
  const status = ` ${valid ? "*" : " "}${best ? ">" : " "}${internal ? "i" : " "} `;
  const pfx = evpnPrefixStr(path.route);
  const head = pfx.length >= 17 ? `${status}${pfx}\n${" ".repeat(20)}` : `${status}${pfx.padEnd(17)}`;
  const nh = path.nextHop.length >= 16 ? `${path.nextHop}\n${" ".repeat(36)}` : path.nextHop.padEnd(16);
  const metric = path.med !== undefined ? String(path.med).padStart(10) : " ".repeat(10);
  const lp = path.localPref !== undefined ? String(path.localPref).padStart(7) : " ".repeat(7);
  const as = path.asPath.length ? `${path.asPath.join(" ")} ` : "";
  const out = `${head}${nh}${metric}${lp}${String(path.weight).padStart(7)} ${as}${ORIGIN_STR[path.origin] ?? "?"}`.split("\n");
  if (path.extComms.length) out.push(`${" ".repeat(20)}${ecListStr(path.extComms)}`);
  return out;
}

export function renderEvpnTable(ctx: CommandContext, type?: 1 | 2 | 3 | 4 | 5): string[] {
  const cfg = getBgpConfig(ctx.device);
  if (!cfg) return ["No BGP process is configured"];
  const rt = peekBgpRuntime(ctx.device);
  const table = evpnTable(ctx.device);
  const keys = [...table.keys()]
    .filter((k) => !type || table.get(k)![0].path.route.type === type)
    .sort((a, b) => rdOrder(a.split("|")[0]) - rdOrder(b.split("|")[0]) || evpnOrder(a).localeCompare(evpnOrder(b)));
  if (!keys.length) return [`No EVPN prefixes ${type ? "(of requested type) " : ""}exist`];
  const out = [
    `BGP table version is ${rt?.tableVersion ?? 0}, local router ID is ${bgpRouterId(ctx.device, cfg)}`,
    "Status codes: s suppressed, d damped, h history, * valid, > best, i - internal",
    "Origin codes: i - IGP, e - EGP, ? - incomplete",
    "EVPN type-1 prefix: [1]:[EthTag]:[ESI]:[IPlen]:[VTEP-IP]:[Frag-id]",
    "EVPN type-2 prefix: [2]:[EthTag]:[MAClen]:[MAC]:[IPlen]:[IP]",
    "EVPN type-3 prefix: [3]:[EthTag]:[IPlen]:[OrigIP]",
    "EVPN type-4 prefix: [4]:[ESI]:[IPlen]:[OrigIP]",
    "EVPN type-5 prefix: [5]:[EthTag]:[IPlen]:[IP]",
    "",
    "   Network          Next Hop            Metric LocPrf Weight Path",
    `${" ".repeat(19)} Extended Community`,
  ];
  let rd = "";
  let paths = 0;
  for (const k of keys) {
    const r = k.split("|")[0];
    if (r !== rd) out.push(`Route Distinguisher: ${(rd = r)}`);
    table.get(k)!.forEach((e, i) => {
      out.push(...evpnPathLines(e.path, e.valid, i === 0 && e.valid));
      paths++;
    });
  }
  out.push("", `Displayed ${keys.length} prefixes (${paths} paths)${type ? " (of requested type)" : ""}`);
  return out;
}

const toLines = (ls: string[]): OutputLine[] => ls.map((l) => (l.startsWith("%") ? muted(l) : line(l)));

/** Normalized prefix (or the longest match for a bare address) in the AF's table. */
function lookupPrefix(ctx: CommandContext, tok: string, vrf: string, af: Af): string | null {
  if (af === "ipv4") {
    if (tok.includes("/")) return normalizeCidr(tok);
    if (!isValidIpv4(tok)) return null;
    const keys = [...bgpTable(ctx.device, af, vrf).keys()].filter((k) => {
      const [a, l] = k.split("/");
      return networkAddress(tok, Number(l)) === a;
    });
    return keys.sort((a, b) => Number(b.split("/")[1]) - Number(a.split("/")[1]))[0] ?? `${tok}/32`;
  }
  const [addr, l] = tok.split("/");
  if (!isValidIpv6(addr)) return null;
  if (l !== undefined) return `${networkAddress6(addr, Number(l))}/${l}`;
  const keys = [...bgpTable(ctx.device, af, vrf).keys()].filter((k) => {
    const [a, kl] = k.split("/");
    return networkAddress6(addr, Number(kl)) === a;
  });
  return keys.sort((a, b) => Number(b.split("/")[1]) - Number(a.split("/")[1]))[0] ?? `${addr}/128`;
}

/**
 * `show [ip] bgp [vrf <vrf>] [ipv4|ipv6 [unicast]] [summary | neighbors [<ip>
 * [advertised-routes|received-routes|routes]] | <prefix> | community [<comm>..]
 * [exact-match] | community-list <name>]` (bgp_route.c / bgp_vty.c show commands).
 */
function bgpShow(ctx: CommandContext, args: string[], vrf: string, af: Af): CommandResult {
  const a = positional(args);
  if (a[0] === "ipv4" || a[0] === "ipv6") {
    af = a[0];
    a.splice(0, a[1] === "unicast" ? 2 : 1);
  }
  const sub = a[0];
  if (sub === "summary") return { output: toLines(renderBgpSummary(ctx, Date.now(), false, vrf, af)) };
  if (sub === "neighbors") {
    const kind = a[2];
    if (kind === "advertised-routes" || kind === "received-routes" || kind === "routes") return { output: toLines(renderNeighborRoutes(ctx, a[1], kind, vrf, af)) };
    return { output: toLines(renderBgpNeighbors(ctx, a[1], Date.now(), vrf)) };
  }
  if (sub === "community") {
    const exact = a.includes("exact-match");
    const want = a.slice(1).filter((x) => x !== "exact-match").map(parseCommunity);
    if (want.some((v) => v === null)) return { output: [err("% Community malformed")] };
    const vals = want as number[];
    // bgp_show_type_community(_all): every given community present (exact-match: the same set)
    const f: PathFilter = (_k, e) => {
      const c = e.path.communities ?? [];
      if (!vals.length) return c.length > 0;
      return exact ? c.length === vals.length && vals.every((v) => c.includes(v)) : vals.every((v) => c.includes(v));
    };
    return { output: toLines(renderBgpTable(ctx, undefined, vrf, af, f)) };
  }
  if (sub === "community-list") {
    if (!a[1]) return { output: [err("% community-list name required")] };
    return { output: toLines(renderBgpTable(ctx, undefined, vrf, af, (_k, e) => communityListPermits(ctx.device, a[1], e.path.communities ?? []))) };
  }
  if (sub) {
    const pfx = lookupPrefix(ctx, sub, vrf, af);
    if (!pfx) return { output: [err(`% Malformed ${af === "ipv4" ? "IPv4" : "IPv6"} address/prefix`)] };
    return { output: toLines(renderBgpDetail(ctx, pfx, vrf, af)) };
  }
  return { output: toLines(renderBgpTable(ctx, undefined, vrf, af)) };
}

const show: SonicCmd[] = [];
for (const [base, af] of [
  [["ip", "bgp"], "ipv4"],
  [["bgp"], "ipv4"],
  [["bgp", "ipv4", "unicast"], "ipv4"],
  [["ip", "bgp", "ipv4", "unicast"], "ipv4"],
  [["bgp", "ipv6", "unicast"], "ipv6"],
  [["bgp", "ipv6"], "ipv6"],
] as [string[], Af][]) {
  show.push({ path: base, summary: `Show BGP ${AF_TITLE[af]} (table, summary, neighbors, prefix, community) in FRR format`, run: (a, ctx) => bgpShow(ctx, a, "default", af) });
}
for (const base of [
  ["ip", "bgp", "vrf"],
  ["bgp", "vrf"],
]) {
  show.push({
    path: base,
    summary: "Show BGP for a VRF instance (FRR format)",
    run(a, ctx) {
      const vrf = a[0];
      if (!vrf) return { output: [err("% VRF name required")] };
      return bgpShow(ctx, a.slice(1), vrf, "ipv4");
    },
  });
}
show.push(
  { path: ["bgp", "community-list"], summary: "Show BGP community-lists", run: (a, ctx) => ({ output: toLines(renderCommunityLists(ctx, positional(a)[0])) }) },
  { path: ["bgp", "as-path-access-list"], summary: "Show AS-path access-lists", run: (a, ctx) => ({ output: toLines(renderAsPathLists(ctx, positional(a)[0])) }) },
);

const EVPN_TYPE: Record<string, 1 | 2 | 3 | 4 | 5> = { ead: 1, "1": 1, macip: 2, "2": 2, multicast: 3, "3": 3, es: 4, "4": 4, prefix: 5, "5": 5 };
const evpnRouteCmd = (path: string[]): SonicCmd => ({
  path,
  summary: "Show the L2VPN EVPN table (FRR format)",
  run(a, ctx) {
    const i = a.indexOf("type");
    const type = i >= 0 ? EVPN_TYPE[a[i + 1] ?? ""] : undefined;
    if (i >= 0 && !type) return { output: [err("% type must be ead|macip|multicast|es|prefix|1-5")] };
    return { output: toLines(renderEvpnTable(ctx, type)) };
  },
});
show.push(
  evpnRouteCmd(["bgp", "l2vpn", "evpn"]),
  evpnRouteCmd(["bgp", "l2vpn", "evpn", "route"]),
  { path: ["bgp", "l2vpn", "evpn", "summary"], summary: "Show L2VPN EVPN neighbor summary (FRR format)", run: (_a, ctx) => ({ output: toLines(renderBgpSummary(ctx, Date.now(), true)) }) },
);

export const bgpModule: SonicFeatureModule = { id: "bgp", config: [...config, ...vxlanClickConfig], show: [...show, ...vxlanClickShow] };
