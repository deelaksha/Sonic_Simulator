/**
 * BGP SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and the `show` commands render SOLELY from that
 * stored state. Nothing establishes a real BGP session — there is no TCP/179
 * packet engine yet — so session state, learned routes, and prefix counts are
 * NOT fabricated; `show` renders the CONFIG plus a clear placeholder for anything
 * that would require an actual session (task guidance + bgp.txt).
 *
 * The authoritative CLI forms are the FRR/klish `router bgp` grammar in bgp.txt.
 * In klish you enter `router bgp <as>` config mode and issue one clause per line
 * (bgp.txt L392-L422); this stateless simulator carries each clause on a single
 * one-line click command under the central dispatcher, so tokens arrive as
 * ["router","bgp", ...] (config) / ["ip","bgp", ...] | ["bgp", ...] (show):
 *
 *   config router bgp <as>                       <- router bgp <as>            (bgp.txt L392) sets local AS
 *   config router bgp no                          <- no router bgp             (bgp.txt L460) removes BGP
 *   config router bgp router-id <ipv4>            <- router-id <ipv4>          (bgp.txt L393)
 *   config router bgp neighbor <ip> remote-as <as>   <- neighbor <ip> / remote-as <as> (bgp.txt L394-L395)
 *   config router bgp neighbor <ip> description <text>
 *   config router bgp neighbor <ip> ebgp-multihop <n>
 *   config router bgp no neighbor <ip>           <- no neighbor <ip>
 *   config router bgp network <cidr>             <- network <cidr>            (bgp.txt L407/L417)
 *   config router bgp no network <cidr>          <- no network <cidr>
 *
 *   show ip bgp summary   / show bgp summary     <- show bgp ipv4 unicast summary   (bgp.txt L185/L547)
 *   show ip bgp neighbors / show bgp neighbors   <- show bgp ipv4 unicast neighbors (bgp.txt L369/L798)
 *   show ip bgp           / show bgp             <- show bgp ipv4 unicast           (bgp.txt L446/L932)
 *
 * Validation ranges taken verbatim from bgp.txt:
 *   - remote-as / local AS: 1..4294967295 (TC-66 as 0 rejected, TC-67 4294967296 rejected)
 *   - ebgp-multihop: 1..255 (TC-53 256 rejected, TC-54 0 rejected)
 * Baseline summary reads "local AS number 0 ... % No BGP neighbors configured"
 * (bgp.txt TC-2 L187-188); neighbor link is external when remote-as != local AS,
 * internal (iBGP) when equal (bgp.txt L371 "external,internal link").
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { isValidIpv4, isValidPrefix, networkAddress } from "../../models/ip";

interface BgpNeighbor {
  peer: string;
  remoteAs?: number;
  description?: string;
  ebgpMultihop?: number;
}

interface BgpState {
  localAs: number | undefined;
  routerId: string | undefined;
  neighbors: BgpNeighbor[];
  networks: string[];
}

/** AS number range (bgp.txt TC-66/TC-67). */
const AS = { min: 1, max: 4294967295 };
/** ebgp-multihop range (bgp.txt TC-53/TC-54). */
const MULTIHOP = { min: 1, max: 255 };

function state(ctx: CommandContext): BgpState {
  return featureState<BgpState>(ctx.device, "bgp", () => ({
    localAs: undefined,
    routerId: undefined,
    neighbors: [],
    networks: [],
  }));
}

/** Parse an unsigned integer in [min,max]; null when out of range / not a number. */
function parseInRange(tok: string | undefined, min: number, max: number): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  return n >= min && n <= max ? n : null;
}

/** Normalize "<addr>/<len>" to "network/len", or null when invalid. */
function normalizeCidr(token: string | undefined): string | null {
  if (!token || !token.includes("/")) return null;
  const [addr, plen] = token.split("/");
  const len = Number(plen);
  if (!isValidIpv4(addr) || !isValidPrefix(len)) return null;
  return `${networkAddress(addr, len)}/${len}`;
}

const config: SonicCmd[] = [
  {
    path: ["router", "bgp"],
    summary: "Set the local BGP AS (config router bgp <as>) or remove BGP (config router bgp no)",
    run(args, ctx): CommandResult {
      const st = state(ctx);
      // `no router bgp` — remove the whole BGP instance.
      if (args[0] === "no" && args.length === 1) {
        st.localAs = undefined;
        st.routerId = undefined;
        st.neighbors = [];
        st.networks = [];
        return { output: [muted("BGP instance removed")] };
      }
      const as = parseInRange(positional(args)[0], AS.min, AS.max);
      if (as === null) {
        return { output: [err(`Usage: config router bgp <as> (${AS.min}-${AS.max})`)] };
      }
      st.localAs = as;
      return { output: [muted(`router bgp ${as} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "router-id"],
    summary: "Set the BGP router-id (config router bgp router-id <ipv4>)",
    run(args, ctx): CommandResult {
      const st = state(ctx);
      if (st.localAs === undefined) return { output: [err("% BGP not configured: run 'config router bgp <as>' first")] };
      const id = positional(args)[0];
      if (!id || !isValidIpv4(id)) return { output: [err("Usage: config router bgp router-id <ipv4>")] };
      st.routerId = id;
      return { output: [muted(`router-id ${id} configured`)] };
    },
  },
  {
    path: ["router", "bgp", "neighbor"],
    summary: "Configure a neighbor (config router bgp neighbor <ip> remote-as <as> | description <text> | ebgp-multihop <n>)",
    run(args, ctx): CommandResult {
      const st = state(ctx);
      if (st.localAs === undefined) return { output: [err("% BGP not configured: run 'config router bgp <as>' first")] };
      const pos = positional(args);
      const peer = pos[0];
      if (!peer || !isValidIpv4(peer)) {
        return { output: [err("Usage: config router bgp neighbor <ip> remote-as <as> | description <text> | ebgp-multihop <n>")] };
      }
      let nb = st.neighbors.find((n) => n.peer === peer);
      if (!nb) {
        nb = { peer };
        st.neighbors.push(nb);
      }
      const key = args[1];
      if (key === undefined) return { output: [muted(`neighbor ${peer} configured`)] };
      if (key === "remote-as") {
        const as = parseInRange(args[2], AS.min, AS.max);
        if (as === null) return { output: [err(`config router bgp neighbor: remote-as must be ${AS.min}-${AS.max}`)] };
        nb.remoteAs = as;
        return { output: [muted(`neighbor ${peer} remote-as ${as} configured`)] };
      }
      if (key === "description") {
        const text = args.slice(2).join(" ").trim();
        if (!text) return { output: [err("config router bgp neighbor: description needs text")] };
        nb.description = text;
        return { output: [muted(`neighbor ${peer} description set`)] };
      }
      if (key === "ebgp-multihop") {
        const hops = parseInRange(args[2], MULTIHOP.min, MULTIHOP.max);
        if (hops === null) return { output: [err(`config router bgp neighbor: ebgp-multihop must be ${MULTIHOP.min}-${MULTIHOP.max}`)] };
        nb.ebgpMultihop = hops;
        return { output: [muted(`neighbor ${peer} ebgp-multihop ${hops} configured`)] };
      }
      return { output: [err(`config router bgp neighbor: unknown option '${key}'`)] };
    },
  },
  {
    path: ["router", "bgp", "no", "neighbor"],
    summary: "Delete a neighbor (config router bgp no neighbor <ip>)",
    run(args, ctx): CommandResult {
      const st = state(ctx);
      const peer = positional(args)[0];
      if (!peer) return { output: [err("Usage: config router bgp no neighbor <ip>")] };
      const before = st.neighbors.length;
      st.neighbors = st.neighbors.filter((n) => n.peer !== peer);
      return {
        output: [muted(st.neighbors.length < before ? `neighbor ${peer} deleted` : `neighbor ${peer} not configured (no-op)`)],
      };
    },
  },
  {
    path: ["router", "bgp", "network"],
    summary: "Originate a local network (config router bgp network <cidr>)",
    run(args, ctx): CommandResult {
      const st = state(ctx);
      if (st.localAs === undefined) return { output: [err("% BGP not configured: run 'config router bgp <as>' first")] };
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
      const st = state(ctx);
      const cidr = normalizeCidr(positional(args)[0]);
      if (!cidr) return { output: [err("Usage: config router bgp no network <ip/prefix>")] };
      const before = st.networks.length;
      st.networks = st.networks.filter((n) => n !== cidr);
      return {
        output: [muted(st.networks.length < before ? `network ${cidr} withdrawn` : `network ${cidr} not configured (no-op)`)],
      };
    },
  },
];

/** eBGP when the peer AS differs from the local AS, iBGP when they match (bgp.txt L371). */
function linkType(localAs: number, remoteAs?: number): string {
  if (remoteAs === undefined) return "external";
  return remoteAs === localAs ? "internal" : "external";
}

function renderSummary(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<BgpState>(ctx.device, "bgp");
  const localAs = st?.localAs ?? 0;
  const routerId = st?.routerId ?? "0.0.0.0";
  const neighbors = st?.neighbors ?? [];
  const out: OutputLine[] = [
    line(`BGP router identifier ${routerId}, local AS number ${localAs} VRF default vrf-id 0`),
  ];
  if (neighbors.length === 0) {
    out.push(muted("% No BGP neighbors configured"));
    return out;
  }
  out.push(line(""));
  out.push(line(`${"Neighbor".padEnd(16)} ${"V".padEnd(3)} ${"AS".padStart(10)}  State/PfxRcd`));
  let established = 0;
  for (const n of neighbors) {
    const rt = n as { state?: string; prefixesReceived?: number };
    const col =
      rt.state === "established"
        ? String(rt.prefixesReceived ?? 0)
        : rt.state
          ? rt.state.charAt(0).toUpperCase() + rt.state.slice(1)
          : "Idle";
    if (rt.state === "established") established++;
    out.push(line(`${n.peer.padEnd(16)} ${"4".padEnd(3)} ${String(n.remoteAs ?? 0).padStart(10)}  ${col}`));
  }
  out.push(line(""));
  out.push(line(`Total number of neighbors ${neighbors.length}`));
  out.push(line(`Total number of neighbors established ${established}`));
  if (established === 0) out.push(muted("(run `bgp converge` to establish sessions)"));
  return out;
}

function renderNeighbors(ctx: CommandContext, args: string[]): OutputLine[] {
  const st = peekFeatureState<BgpState>(ctx.device, "bgp");
  const localAs = st?.localAs ?? 0;
  const routerId = st?.routerId ?? "0.0.0.0";
  let neighbors = st?.neighbors ?? [];
  const filter = positional(args)[0];
  if (filter) neighbors = neighbors.filter((n) => n.peer === filter);
  if (neighbors.length === 0) return [muted("% No BGP neighbors configured")];
  const out: OutputLine[] = [];
  for (const n of neighbors) {
    out.push(
      line(
        `BGP neighbor is ${n.peer}, remote AS ${n.remoteAs ?? "unset"}, local AS ${localAs}, ${linkType(localAs, n.remoteAs)} link`,
      ),
    );
    if (n.description !== undefined) out.push(line(`  Description: ${n.description}`));
    if (n.ebgpMultihop !== undefined) out.push(line(`  External BGP neighbor may be up to ${n.ebgpMultihop} hops away`));
    out.push(line(`  BGP version 4, local router ID ${routerId}`));
    const rt = n as { state?: string; prefixesReceived?: number; remoteAsSeen?: number };
    const stateLabel = rt.state === "established" ? "Established" : rt.state === "active" ? "Active" : "Idle";
    out.push(line(`  BGP state = ${stateLabel}`));
    if (rt.state === "established") out.push(line(`  Prefixes received: ${rt.prefixesReceived ?? 0}`));
    else out.push(muted("  (run `bgp converge` to establish the session)"));
  }
  return out;
}

function renderRib(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<BgpState>(ctx.device, "bgp");
  if (st?.localAs === undefined) return [muted("% No BGP process is configured")];
  const routerId = st.routerId ?? "0.0.0.0";
  const networks = st.networks;
  const out: OutputLine[] = [
    line(`BGP table version is 0, local router ID is ${routerId}`),
    line(`${"   Network".padEnd(21)}${"Next Hop".padEnd(20)}Metric LocPrf Weight Path`),
  ];
  for (const cidr of networks) {
    out.push(line(`*> ${cidr.padEnd(18)}${"0.0.0.0".padEnd(20)}${"0".padStart(6)}        32768 i`));
  }
  out.push(line(`Total number of routes: ${networks.length}`));
  return out;
}

const summaryCmd = (path: string[]): SonicCmd => ({
  path,
  summary: "Show BGP summary (local AS/router-id + neighbor config table)",
  run: (_a, ctx) => ({ output: renderSummary(ctx) }),
});
const neighborsCmd = (path: string[]): SonicCmd => ({
  path,
  summary: "Show BGP neighbor config (session state is a placeholder)",
  run: (a, ctx) => ({ output: renderNeighbors(ctx, a) }),
});
const ribCmd = (path: string[]): SonicCmd => ({
  path,
  summary: "Show the local BGP table (originated networks)",
  run: (_a, ctx) => ({ output: renderRib(ctx) }),
});

const show: SonicCmd[] = [
  summaryCmd(["ip", "bgp", "summary"]),
  neighborsCmd(["ip", "bgp", "neighbors"]),
  ribCmd(["ip", "bgp"]),
  summaryCmd(["bgp", "summary"]),
  neighborsCmd(["bgp", "neighbors"]),
  ribCmd(["bgp"]),
];

export const bgpModule: SonicFeatureModule = { id: "bgp", config, show };
