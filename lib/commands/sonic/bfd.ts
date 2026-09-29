/**
 * BFD SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and `show bfd ...` renders SOLELY from that
 * stored state. There is no packet engine yet, so BFD session UP/DOWN and the
 * control-packet state machine are NOT fabricated here — `show` renders the
 * configured intent and notes that live session state is simulated separately.
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
 *   show bfd peers                    <- show bfd peers                           (TC-19,33)
 *   show bfd peer <ip>                <- show bfd peer <ip>                        (TC-30,47)
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
import { featureState, peekFeatureState } from "../../models/feature-state";
import { isValidIpv4 } from "../../models/ip";

interface BfdPeer {
  peer: string;
  local?: string;
  interface?: string;
  multihop?: boolean;
  rxInterval?: number;
  txInterval?: number;
  multiplier?: number;
  shutdown?: boolean;
}

interface BfdState {
  peers: BfdPeer[];
}

/** Defaults rendered when a timer/multiplier is unset (bfd.txt TC-6, TC-16). */
const DEFAULTS = { multiplier: 3, rx: 300, tx: 300 };
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

// --- show -------------------------------------------------------------------

/** bfd.txt header form, e.g. "peer 10.10.10.1 vrf default interface Ethernet4". */
function peerHeader(p: BfdPeer): string {
  let s = `peer ${p.peer}`;
  if (p.local) s += ` local-address ${p.local}`;
  s += " vrf default";
  if (p.multihop) s += " multihop";
  else if (p.interface) s += ` interface ${p.interface}`;
  return s;
}

const SESSION_NOTE =
  "Note: BFD session UP/DOWN state is simulated separately (no packet engine); the above is the configured intent.";

function renderPeers(ctx: CommandContext, filterIp?: string): OutputLine[] {
  const all = peekFeatureState<BfdState>(ctx.device, "bfd")?.peers ?? [];
  const peers = filterIp ? all.filter((p) => p.peer === filterIp) : all;
  if (filterIp && peers.length === 0) return [muted(`BFD peer ${filterIp} not found`)];
  if (peers.length === 0) return [muted("No BFD peers configured")];

  const out: OutputLine[] = [line("BFD Peers:")];
  for (const p of peers) {
    out.push(line(peerHeader(p)));
    out.push(line(`  Admin State: ${p.shutdown ? "down" : "up"}`));
    out.push(line("  Peer Type: configured"));
    out.push(line("  Local timers:"));
    out.push(line(`    Detect-multiplier: ${p.multiplier ?? DEFAULTS.multiplier}`));
    out.push(line(`    Receive interval: ${p.rxInterval ?? DEFAULTS.rx}ms`));
    out.push(line(`    Transmission interval: ${p.txInterval ?? DEFAULTS.tx}ms`));
  }
  out.push(muted(SESSION_NOTE));
  return out;
}

const show: SonicCmd[] = [
  { path: ["bfd", "peers"], summary: "Show all configured BFD peers", run: (_a, ctx) => ({ output: renderPeers(ctx) }) },
  {
    path: ["bfd", "peer"],
    summary: "Show a configured BFD peer by IP",
    run(args, ctx): CommandResult {
      const ip = positional(args)[0];
      if (!ip) return { output: [err("Usage: show bfd peer <peer-ip>")] };
      return { output: renderPeers(ctx, ip) };
    },
  },
];

export const bfdModule: SonicFeatureModule = { id: "bfd", config, show };
