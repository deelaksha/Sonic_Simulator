/**
 * BFD SONiC feature module. `config bfd ...` stores the configured peers in the
 * simulated CONFIG_DB (features.bfd) and immediately reconciles the live BFD
 * sessions run by lib/protocols/bfd-daemon.ts (FRR bfdd model: real 24-byte
 * control packets, RFC 5880 state machine, timers). `show bfd ...` renders those
 * live sessions in FRR 10.3 bfdd_vty.c form (see the show section below).
 *
 * bfd.txt is authoritative. Real BFD is driven from FRR (`bfd` view, then
 * `peer <ip> interface <if> ...`). This module exposes the equivalent surface as
 * SONiC click-style `config bfd ...` commands (path ["bfd", ...]) to match the
 * project's config-plane pattern (vlan.ts / snmp.ts). Mapping to bfd.txt forms:
 *
 *   config bfd peer add <ip> [interface <if>] [local-address <ip>] [multihop]
 *                                     <- peer <ip> interface <if> local-address <ip>
 *                                     <- peer <ip> multihop local-address <ip>   (TC-6,7,20,88)
 *   config bfd peer del <ip>          <- no peer <ip> ...                          (TC-19,25,96)
 *   config bfd peer detect-multiplier <ip> <n>  <- detect-multiplier <n>          (TC-8,49-53,75)
 *   config bfd peer receive-interval  <ip> <ms> <- receive-interval <ms>          (TC-58,59,77)
 *   config bfd peer transmit-interval <ip> <ms> <- transmit-interval <ms>         (TC-61,62)
 *   config bfd peer shutdown    <ip>  <- shutdown                                 (TC-17)
 *   config bfd peer no-shutdown <ip>  <- no shutdown                              (TC-18)
 *   config bfd peer echo-mode <ip> | no-echo-mode <ip>   <- [no] echo-mode
 *   config bfd peer echo-interval <ip> <10-60000>        <- echo-interval <ms>
 *   show bfd peers [brief|counters]   <- show bfd peers [brief|counters]
 *   show bfd peer <ip> [counters]     <- show bfd peer <ip> [counters]
 *
 * Validation (bfd.txt): peer/local-address must be valid IPv4 (TC-68..72);
 * detect-multiplier 2..128 (TC-49..53); receive/transmit-interval a positive
 * integer, 0 and negatives rejected (TC-58,61,77); a multihop peer requires a
 * local-address (TC-88). Defaults shown when unset: detect-multiplier 3,
 * rx/tx 300ms (TC-6,16). Re-adding an existing peer updates it (TC-110);
 * deleting an absent peer is a silent no-op (TC-96).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState } from "../../models/feature-state";
import { isValidIpv4 } from "../../models/ip";
import { BfdSession, bfdSessions, reconcileBfd } from "../../protocols/bfd-daemon";

interface BfdPeer {
  peer: string;
  local?: string;
  interface?: string;
  multihop?: boolean;
  rxInterval?: number;
  txInterval?: number;
  multiplier?: number;
  shutdown?: boolean;
  echoMode?: boolean;
  echoInterval?: number;
}

interface BfdState {
  peers: BfdPeer[];
}

/** detect-multiplier valid range (bfd.txt TC-49..TC-53). */
const MULT = { min: 2, max: 128 };

function state(ctx: CommandContext): BfdState {
  return featureState<BfdState>(ctx.device, "bfd", () => ({ peers: [] as BfdPeer[] }));
}

function findPeer(st: BfdState, ip: string): BfdPeer | undefined {
  return st.peers.find((p) => p.peer === ip);
}

/** Parse a non-negative integer token; null for anything else (rejects -1, 4x, "" ). */
function parseUint(tok: string | undefined): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  return Number(tok);
}

// --- config -----------------------------------------------------------------

const config: SonicCmd[] = [
  {
    path: ["bfd", "peer", "add"],
    summary: "Add/update a BFD peer: add <ip> [interface <if>] [local-address <ip>] [multihop]",
    run(args, ctx): CommandResult {
      const ip = args[0];
      if (!ip) {
        return { output: [err("Usage: config bfd peer add <peer-ip> [interface <if>] [local-address <ip>] [multihop]")] };
      }
      if (!isValidIpv4(ip)) return { output: [err(`config bfd peer add: invalid peer IPv4 address '${ip}'`)] };

      let iface: string | undefined;
      let local: string | undefined;
      let multihop = false;
      for (let i = 1; i < args.length; i++) {
        const t = args[i];
        if (t === "interface") {
          iface = args[++i];
          if (iface === undefined) return { output: [err("config bfd peer add: 'interface' requires an interface name")] };
        } else if (t === "local-address") {
          local = args[++i];
          if (local === undefined) return { output: [err("config bfd peer add: 'local-address' requires an IPv4 address")] };
        } else if (t === "multihop") {
          multihop = true;
        } else {
          return { output: [err(`config bfd peer add: unexpected token '${t}'`)] };
        }
      }
      if (local !== undefined && !isValidIpv4(local)) {
        return { output: [err(`config bfd peer add: invalid local-address '${local}'`)] };
      }
      if (multihop && local === undefined) {
        return { output: [err("config bfd peer add: a multihop peer requires 'local-address <ip>'")] };
      }

      const st = state(ctx);
      const existing = findPeer(st, ip);
      if (existing) {
        // Re-adding an existing peer updates its identity fields (TC-110, graceful).
        existing.interface = iface;
        existing.local = local;
        existing.multihop = multihop;
      } else {
        st.peers.push({ peer: ip, interface: iface, local, multihop });
      }
      return { output: [muted(`BFD peer ${ip} configured`)] };
    },
  },
  {
    path: ["bfd", "peer", "del"],
    summary: "Delete a BFD peer by IP",
    run(args, ctx): CommandResult {
      const ip = args[0];
      if (!ip) return { output: [err("Usage: config bfd peer del <peer-ip>")] };
      const st = state(ctx);
      const before = st.peers.length;
      st.peers = st.peers.filter((p) => p.peer !== ip);
      // Deleting a non-existent peer is a silent no-op (TC-96).
      return {
        output: [muted(st.peers.length < before ? `BFD peer ${ip} deleted` : `BFD peer ${ip} not configured (no-op)`)],
      };
    },
  },
  {
    path: ["bfd", "peer", "detect-multiplier"],
    summary: "Set a peer's detection multiplier (2-128)",
    run: (a, c) => applyNumeric(c, a, "detect-multiplier", MULT.min, MULT.max, (p, n) => (p.multiplier = n)),
  },
  {
    path: ["bfd", "peer", "receive-interval"],
    summary: "Set a peer's required minimum receive interval (ms, > 0)",
    run: (a, c) => applyNumeric(c, a, "receive-interval", 1, undefined, (p, n) => (p.rxInterval = n)),
  },
  {
    path: ["bfd", "peer", "transmit-interval"],
    summary: "Set a peer's desired minimum transmit interval (ms, > 0)",
    run: (a, c) => applyNumeric(c, a, "transmit-interval", 1, undefined, (p, n) => (p.txInterval = n)),
  },
  {
    path: ["bfd", "peer", "echo-interval"],
    summary: "Set a peer's echo transmit + receive interval (ms, 10-60000)",
    run: (a, c) => applyNumeric(c, a, "echo-interval", 10, 60000, (p, n) => (p.echoInterval = n)),
  },
  {
    path: ["bfd", "peer", "echo-mode"],
    summary: "Enable the BFD echo function for a peer",
    run: (a, c) => setEcho(c, a, true),
  },
  {
    path: ["bfd", "peer", "no-echo-mode"],
    summary: "Disable the BFD echo function for a peer",
    run: (a, c) => setEcho(c, a, false),
  },
  {
    path: ["bfd", "peer", "shutdown"],
    summary: "Administratively disable a BFD peer",
    run: (a, c) => setAdmin(c, a, true),
  },
  {
    path: ["bfd", "peer", "no-shutdown"],
    summary: "Administratively enable a BFD peer",
    run: (a, c) => setAdmin(c, a, false),
  },
];

/** Shared numeric peer-setter with range validation. */
function applyNumeric(
  ctx: CommandContext,
  args: string[],
  label: string,
  min: number,
  max: number | undefined,
  set: (p: BfdPeer, n: number) => void,
): CommandResult {
  const ip = args[0];
  const valTok = args[1];
  if (!ip || valTok === undefined) {
    return { output: [err(`Usage: config bfd peer ${label} <peer-ip> <value>`)] };
  }
  const peer = findPeer(state(ctx), ip);
  if (!peer) return { output: [err(`config bfd peer ${label}: BFD peer ${ip} not configured`)] };
  const n = parseUint(valTok);
  if (n === null || n < min || (max !== undefined && n > max)) {
    const range = max !== undefined ? `${min}-${max}` : `> 0`;
    return { output: [err(`config bfd peer ${label}: value must be ${range} (got '${valTok}')`)] };
  }
  set(peer, n);
  return { output: [muted(`BFD peer ${ip} ${label} set to ${n}`)] };
}

/** `[no] echo-mode` (FRR bfdd_cli.c "echo-mode"; single hop only, bfd.c:171). */
function setEcho(ctx: CommandContext, args: string[], on: boolean): CommandResult {
  const verb = on ? "echo-mode" : "no-echo-mode";
  const ip = args[0];
  if (!ip) return { output: [err(`Usage: config bfd peer ${verb} <peer-ip>`)] };
  const peer = findPeer(state(ctx), ip);
  if (!peer) return { output: [err(`config bfd peer ${verb}: BFD peer ${ip} not configured`)] };
  if (on && peer.multihop) return { output: [err("% Echo mode is only available for single hop sessions.")] };
  peer.echoMode = on || undefined;
  return { output: [muted(`BFD peer ${ip} echo mode ${on ? "enabled" : "disabled"}`)] };
}

/** Set a peer's admin state (shutdown / no-shutdown). */
function setAdmin(ctx: CommandContext, args: string[], down: boolean): CommandResult {
  const verb = down ? "shutdown" : "no-shutdown";
  const ip = args[0];
  if (!ip) return { output: [err(`Usage: config bfd peer ${verb} <peer-ip>`)] };
  const peer = findPeer(state(ctx), ip);
  if (!peer) return { output: [err(`config bfd peer ${verb}: BFD peer ${ip} not configured`)] };
  peer.shutdown = down;
  return { output: [muted(`BFD peer ${ip} admin state ${down ? "down (shutdown)" : "up"}`)] };
}

// --- show (FRR 10.3 bfdd_vty.c text form) -------------------------------------
//
// `show bfd peers`, `show bfd peer <ip>`, `show bfd peers counters`,
// `show bfd peer <ip> counters`, `show bfd peers brief` render exactly what
// `vtysh -c "show bfd ..."` prints (bfdd_vty.c _display_peer :151,
// _display_peer_counter :520, _display_peers_brief :794), from the live BFD
// sessions of lib/protocols/bfd-daemon.ts. The KLISH `show bfd ...` form (Jinja
// templates) is rendered by lib/commands/sonic-cli/features/bfd.ts.

/** integer2timestr (bfd.c:1701). */
export function integer2timestr(sec: number): string {
  const M = 60, H = 60 * M, D = 24 * H, MO = 30 * D, Y = 12 * MO;
  let t = Math.max(0, Math.floor(sec));
  let s = "";
  for (const [unit, name] of [[Y, "year"], [MO, "month"], [D, "day"], [H, "hour"], [M, "minute"]] as const) {
    if (t >= unit) {
      const n = Math.floor(t / unit);
      t -= n * unit;
      s += `${n} ${name}(s), `;
    }
  }
  return `${s}${t % M} second(s)`;
}

/** diag2str (bfd.c:1652). */
export function diag2str(d: number): string {
  return (
    ["ok", "control detection time expired", "echo function failed", "neighbor signaled session down", "forwarding plane reset", "path down", "concatenated path down", "administratively down", "reverse concatenated path down"][d] ?? "unknown"
  );
}

/** state_list (bfdd.c:156). */
export const BFD_STATE_STR = ["admin-down", "down", "init", "up"];

/** _display_peer_header (bfdd_vty.c:108). */
function frrHeader(s: BfdSession): string {
  let h = `\tpeer ${s.peer}`;
  if (s.multihop) h += " multihop";
  if (s.local) h += ` local-address ${s.local}`;
  h += " vrf default";
  if (s.ifname) h += ` interface ${s.ifname}`;
  return h;
}

/** _display_peer (bfdd_vty.c:151). */
function frrPeer(s: BfdSession, now: number): OutputLine[] {
  const o: string[] = [frrHeader(s), `\t\tID: ${s.myDisc}`, `\t\tRemote ID: ${s.remoteDisc}`, "\t\tActive mode"];
  if (s.multihop) o.push(`\t\tMinimum TTL: ${s.mhTtl}`);
  const st = ["shutdown", "down", "init", "up"][s.state];
  o.push(`\t\tStatus: ${st}`);
  if (s.state === 1) o.push(`\t\tDowntime: ${integer2timestr((now - s.downtime) / 1000)}`);
  if (s.state === 3) o.push(`\t\tUptime: ${integer2timestr((now - s.uptime) / 1000)}`);
  o.push(
    `\t\tDiagnostics: ${diag2str(s.localDiag)}`,
    `\t\tRemote diagnostics: ${diag2str(s.remoteDiag)}`,
    `\t\tPeer Type: ${s.configured ? "configured" : "dynamic"}`,
    `\t\tRTT min/avg/max: ${rttStats(s)} usec`,
    "\t\tLocal timers:",
    `\t\t\tDetect-multiplier: ${s.detectMult}`,
    `\t\t\tReceive interval: ${s.requiredMinRx}ms`,
    `\t\t\tTransmission interval: ${s.desiredMinTx}ms`,
    s.requiredMinEchoRx ? `\t\t\tEcho receive interval: ${s.requiredMinEchoRx}ms` : "\t\t\tEcho receive interval: disabled",
    s.echoMode ? `\t\t\tEcho transmission interval: ${s.desiredMinEchoTx}ms` : "\t\t\tEcho transmission interval: disabled",
    "\t\tRemote timers:",
    `\t\t\tDetect-multiplier: ${s.remoteDetectMult}`,
    `\t\t\tReceive interval: ${s.remoteRequiredRx}ms`,
    `\t\t\tTransmission interval: ${s.remoteDesiredTx}ms`,
    s.remoteEchoRx ? `\t\t\tEcho receive interval: ${s.remoteEchoRx}ms` : "\t\t\tEcho receive interval: disabled",
    "",
  );
  return o.map((t) => line(t));
}

/** _display_rtt (bfdd_vty.c): min/avg/max over the valid echo RTT samples. */
export function rttStats(s: BfdSession): string {
  if (!s.rtt.length) return "0/0/0";
  const sum = s.rtt.reduce((a, b) => a + b, 0);
  return `${Math.min(...s.rtt)}/${Math.floor(sum / s.rtt.length)}/${Math.max(...s.rtt)}`;
}

/** _display_peer_counter (bfdd_vty.c:520). */
function frrCounters(s: BfdSession): OutputLine[] {
  return [
    frrHeader(s),
    `\t\tControl packet input: ${s.stats.rxCtrl} packets`,
    `\t\tControl packet output: ${s.stats.txCtrl} packets`,
    `\t\tEcho packet input: ${s.stats.rxEcho} packets`,
    `\t\tEcho packet output: ${s.stats.txEcho} packets`,
    `\t\tSession up events: ${s.stats.up}`,
    `\t\tSession down events: ${s.stats.down}`,
    `\t\tZebra notifications: ${s.stats.zebra}`,
    `\t\tTx fail packet: ${s.stats.txFail}`,
    "",
  ].map((t) => line(t));
}

/** _display_peers_brief (bfdd_vty.c:754-817). */
function frrBrief(sessions: BfdSession[]): OutputLine[] {
  const row = (a: string, b: string, c: string, d: string) => `${a.padEnd(10)} ${b.padEnd(40)} ${c.padEnd(40)}${d.padEnd(15)}`;
  return [
    `Session count: ${sessions.length}`,
    row("SessionId", "LocalAddress", "PeerAddress", "Status"),
    row("=========", "============", "===========", "======"),
    // Single hop prints the address packets arrived on ("unknown" until then).
    ...sessions.map((s) => row(String(s.myDisc), s.multihop ? s.local ?? "0.0.0.0" : s.pktLocal ?? "unknown", s.peer, BFD_STATE_STR[s.state])),
  ].map((t) => line(t));
}

/** `show bfd peer <ip> [multihop] [local-address A] [interface I] [counters]`. */
function showPeer(args: string[], ctx: CommandContext): CommandResult {
  const ip = args[0];
  if (!ip) return { output: [err("Usage: show bfd peer <peer-ip> [interface <if>] [local-address <ip>] [multihop] [counters]")] };
  let ifname: string | undefined;
  let local: string | undefined;
  let counters = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "interface") ifname = args[++i];
    else if (args[i] === "local-address") local = args[++i];
    else if (args[i] === "counters") counters = true;
  }
  const s = bfdSessions(ctx.device).find((x) => x.peer === ip && (!ifname || x.ifname === ifname) && (!local || x.local === local));
  if (!s) {
    // _find_peer_or_error (bfdd_vty.c:876-887).
    return { output: [line(`% Unable to find 'peer ${ip}${ifname ? ` interface ${ifname}` : ""}${local ? ` local-address ${local}` : ""}'`)] };
  }
  if (counters) return { output: frrCounters(s) };
  return { output: [line("BFD Peer:"), ...frrPeer(s, Date.now())] };
}

const show: SonicCmd[] = [
  {
    path: ["bfd", "peers"],
    summary: "Show all BFD peers (FRR bfdd format)",
    run: (_a, ctx) => ({ output: [line("BFD Peers:"), ...bfdSessions(ctx.device).flatMap((s) => frrPeer(s, Date.now()))] }),
  },
  {
    path: ["bfd", "peers", "counters"],
    summary: "Show BFD peer packet/session counters",
    run: (_a, ctx) => ({ output: [line("BFD Peers:"), ...bfdSessions(ctx.device).flatMap(frrCounters)] }),
  },
  {
    path: ["bfd", "peers", "brief"],
    summary: "Show BFD sessions in one line each",
    run: (_a, ctx) => ({ output: frrBrief(bfdSessions(ctx.device)) }),
  },
  { path: ["bfd", "peer"], summary: "Show one BFD peer [counters]", run: (a, ctx) => showPeer(positional(a), ctx) },
];

/** Every config change is applied to the running sessions at once (bfdd reacts to northbound commits). */
const liveConfig: SonicCmd[] = config.map((c) => ({
  ...c,
  run(args, ctx) {
    const r = c.run(args, ctx);
    reconcileBfd(ctx.device, Date.now());
    return r;
  },
}));

export const bfdModule: SonicFeatureModule = { id: "bfd", config: liveConfig, show };
