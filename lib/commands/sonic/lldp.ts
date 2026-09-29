/**
 * LLDP SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and `show lldp ...` renders SOLELY from that
 * stored state. Nothing exchanges real LLDP frames — neighbor discovery needs a
 * packet engine that does not exist yet, so neighbors are NEVER fabricated;
 * `show lldp table` / `show lldp neighbors` print the configured local state plus
 * a clear placeholder for the (unsimulated) remote side.
 *
 * Commands use the click-style `config lldp` / `show lldp` family (path
 * ["lldp", ...]); the fields, enum values and validation ranges come from
 * lldp.txt, whose management-framework forms they mirror one-to-one:
 *
 *   config lldp enable                          <- lldp enable
 *   config lldp disable                         <- no lldp enable
 *   config lldp transmit                        <- lldp transmit
 *   config lldp no-transmit                     <- no lldp transmit
 *   config lldp receive                         <- lldp receive
 *   config lldp no-receive                      <- no lldp receive
 *   config lldp timer <5-254>                   <- lldp timer <n>
 *   config lldp no-timer                        <- no lldp timer
 *   config lldp multiplier <1-10>               <- lldp multiplier <n>
 *   config lldp no-multiplier                   <- no lldp multiplier
 *   config lldp system-name <name>              <- lldp system-name <name>
 *   config lldp no-system-name                  <- no lldp system-name
 *   config lldp system-description <text ...>   <- lldp system-description "<text>"
 *   config lldp no-system-description           <- no lldp system-description
 *   config lldp interface <port> <enable|disable|transmit|no-transmit|receive|no-receive>
 *                                               <- interface <port> / lldp {enable|receive|transmit}
 *   show lldp                                    <- show lldp / show running-configuration lldp
 *   show lldp table                             <- show lldp table
 *   show lldp neighbors [port]                  <- show lldp neighbor [<port>]
 *   show lldp statistics [port]                 <- show lldp statistics [<port>]
 *
 * Ranges are the XML ptypes confirmed in lldp.txt (AGENT block): timer 5..254
 * (LLDP_HELLO_TIME_TYPE, TC-16/17/18), multiplier 1..10 (LLDP_MULTIPLIER_TYPE,
 * TC-21/22/23). Out-of-range values are rejected ("% Error: Invalid input
 * detected") and leave the previously configured value intact (TC-19/24).
 * `no ...` knob removal clears the value (TC-20/25/27). LLDP defaults ON with
 * both transmit and receive enabled (AGENT finding: default-ON in CONFIG_DB).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { interfaceByName, isSwitch, isRouter, Device } from "../../models/device";
import { NetInterface } from "../../models/interface";

/** Per-interface LLDP overrides (undefined = inherit the default, i.e. enabled). */
interface LldpPortState {
  name: string;
  enabled: boolean;
  transmit: boolean;
  receive: boolean;
}

interface LldpState {
  enabled: boolean;
  transmit: boolean;
  receive: boolean;
  timer: number | undefined;
  multiplier: number | undefined;
  systemName: string | undefined;
  systemDescription: string | undefined;
  interfaces: Record<string, LldpPortState>;
}

/** ptype LLDP_HELLO_TIME_TYPE (lldp.txt TC-16/17/18). */
const TIMER = { min: 5, max: 254 };
/** ptype LLDP_MULTIPLIER_TYPE (lldp.txt TC-21/22/23). */
const MULT = { min: 1, max: 10 };

const INVALID = "% Error: Invalid input detected";

function state(ctx: CommandContext): LldpState {
  return featureState<LldpState>(ctx.device, "lldp", () => ({
    enabled: true,
    transmit: true,
    receive: true,
    timer: undefined,
    multiplier: undefined,
    systemName: undefined,
    systemDescription: undefined,
    interfaces: {},
  }));
}

/** Parse an integer token and check it falls within [min, max]; else null. */
function parseInRange(tok: string | undefined, range: { min: number; max: number }): number | null {
  if (tok === undefined || !/^\d+$/.test(tok)) return null;
  const n = Number(tok);
  return n >= range.min && n <= range.max ? n : null;
}

/** Get (creating on first use) the per-interface override record for a port. */
function portState(st: LldpState, name: string): LldpPortState {
  if (!st.interfaces[name]) st.interfaces[name] = { name, enabled: true, transmit: true, receive: true };
  return st.interfaces[name];
}

const config: SonicCmd[] = [
  {
    path: ["lldp", "enable"],
    summary: "Enable LLDP globally",
    run(_args, ctx): CommandResult {
      state(ctx).enabled = true;
      return { output: [muted("LLDP enabled")] };
    },
  },
  {
    path: ["lldp", "disable"],
    summary: "Disable LLDP globally",
    run(_args, ctx): CommandResult {
      state(ctx).enabled = false;
      return { output: [muted("LLDP disabled")] };
    },
  },
  {
    path: ["lldp", "transmit"],
    summary: "Enable LLDP frame transmission globally",
    run(_args, ctx): CommandResult {
      state(ctx).transmit = true;
      return { output: [muted("LLDP transmit enabled")] };
    },
  },
  {
    path: ["lldp", "no-transmit"],
    summary: "Disable LLDP frame transmission globally",
    run(_args, ctx): CommandResult {
      state(ctx).transmit = false;
      return { output: [muted("LLDP transmit disabled")] };
    },
  },
  {
    path: ["lldp", "receive"],
    summary: "Enable LLDP frame reception globally",
    run(_args, ctx): CommandResult {
      state(ctx).receive = true;
      return { output: [muted("LLDP receive enabled")] };
    },
  },
  {
    path: ["lldp", "no-receive"],
    summary: "Disable LLDP frame reception globally",
    run(_args, ctx): CommandResult {
      state(ctx).receive = false;
      return { output: [muted("LLDP receive disabled")] };
    },
  },
  {
    path: ["lldp", "timer"],
    summary: `Set the LLDP tx-interval / hello timer (${TIMER.min}-${TIMER.max} s)`,
    run(args, ctx): CommandResult {
      const tok = positional(args)[0];
      const n = parseInRange(tok, TIMER);
      // Out-of-range is rejected and leaves the existing timer intact (TC-17/18/19).
      if (n === null) return { output: [err(`${INVALID}: timer must be ${TIMER.min}-${TIMER.max} (got '${tok ?? ""}')`)] };
      state(ctx).timer = n;
      return { output: [muted(`LLDP tx-interval set to ${n}`)] };
    },
  },
  {
    path: ["lldp", "no-timer"],
    summary: "Restore the default LLDP timer",
    run(_args, ctx): CommandResult {
      state(ctx).timer = undefined;
      return { output: [muted("LLDP timer restored to default")] };
    },
  },
  {
    path: ["lldp", "multiplier"],
    summary: `Set the LLDP holdtime multiplier (${MULT.min}-${MULT.max})`,
    run(args, ctx): CommandResult {
      const tok = positional(args)[0];
      const n = parseInRange(tok, MULT);
      // Out-of-range is rejected and leaves the existing multiplier intact (TC-22/23/24).
      if (n === null) return { output: [err(`${INVALID}: multiplier must be ${MULT.min}-${MULT.max} (got '${tok ?? ""}')`)] };
      state(ctx).multiplier = n;
      return { output: [muted(`LLDP holdtime multiplier set to ${n}`)] };
    },
  },
  {
    path: ["lldp", "no-multiplier"],
    summary: "Restore the default LLDP multiplier",
    run(_args, ctx): CommandResult {
      state(ctx).multiplier = undefined;
      return { output: [muted("LLDP multiplier restored to default")] };
    },
  },
  {
    path: ["lldp", "system-name"],
    summary: "Set the advertised LLDP system name",
    run(args, ctx): CommandResult {
      const name = positional(args)[0];
      if (!name) return { output: [err("Usage: config lldp system-name <name>")] };
      state(ctx).systemName = name;
      return { output: [muted(`LLDP system-name set to ${name}`)] };
    },
  },
  {
    path: ["lldp", "no-system-name"],
    summary: "Clear the advertised LLDP system name",
    run(_args, ctx): CommandResult {
      state(ctx).systemName = undefined;
      return { output: [muted("LLDP system-name cleared")] };
    },
  },
  {
    path: ["lldp", "system-description"],
    summary: "Set the advertised LLDP system description",
    run(args, ctx): CommandResult {
      const text = positional(args).join(" ").trim();
      if (!text) return { output: [err("Usage: config lldp system-description <text>")] };
      state(ctx).systemDescription = text;
      return { output: [muted(`LLDP system-description set to "${text}"`)] };
    },
  },
  {
    path: ["lldp", "no-system-description"],
    summary: "Clear the advertised LLDP system description",
    run(_args, ctx): CommandResult {
      state(ctx).systemDescription = undefined;
      return { output: [muted("LLDP system-description cleared")] };
    },
  },
  {
    path: ["lldp", "interface"],
    summary: "Per-interface LLDP: <port> <enable|disable|transmit|no-transmit|receive|no-receive>",
    run(args, ctx): CommandResult {
      const pos = positional(args);
      const portName = pos[0];
      const action = pos[1];
      const usage = "Usage: config lldp interface <port> <enable|disable|transmit|no-transmit|receive|no-receive>";
      if (!portName || !action) return { output: [err(usage)] };
      if (!interfaceByName(ctx.device, portName)) {
        return { output: [err(`config lldp interface: no such interface '${portName}'`)] };
      }
      const port = portState(state(ctx), portName);
      switch (action) {
        case "enable": port.enabled = true; break;
        case "disable": port.enabled = false; break;
        case "transmit": port.transmit = true; break;
        case "no-transmit": port.transmit = false; break;
        case "receive": port.receive = true; break;
        case "no-receive": port.receive = false; break;
        default: return { output: [err(usage)] };
      }
      return { output: [muted(`LLDP ${portName}: ${action}`)] };
    },
  },
];

/** Interfaces on which LLDP is effectively active given global + per-port state. */
function activePorts(ctx: CommandContext, st: LldpState | undefined): string[] {
  const names = ctx.device.interfaces.filter((i) => !i.management).map((i) => i.name);
  // LLDP defaults ON: an unconfigured device (st undefined) is active on all ports.
  if (st && !st.enabled) return [];
  return names.filter((n) => st?.interfaces[n]?.enabled !== false);
}

/** Effective LLDP tx/rx on a device's port (global knobs + per-port overrides). */
function lldpTxRx(device: Device, portName: string): { tx: boolean; rx: boolean } {
  const st = peekFeatureState<LldpState>(device, "lldp");
  if (st?.enabled === false) return { tx: false, rx: false };
  const p = st?.interfaces[portName];
  if (p && p.enabled === false) return { tx: false, rx: false };
  return {
    tx: st?.transmit !== false && (p?.transmit ?? true) !== false,
    rx: st?.receive !== false && (p?.receive ?? true) !== false,
  };
}

/** LLDP capability advertised for a device type. */
function capabilityOf(type: Device["type"]): string {
  if (isSwitch(type)) return "Bridge";
  if (isRouter(type)) return "Router";
  return "Station";
}

function neighSysName(peer: Device): string {
  return peekFeatureState<LldpState>(peer, "lldp")?.systemName ?? peer.config.hostname ?? peer.name;
}

/**
 * Discover the directly-connected LLDP neighbor on a local interface. Neighbors
 * are DERIVED from the real topology (interface.connectedTo — the single source
 * of truth), gated by LLDP being effectively rx-enabled locally and tx-enabled
 * on the peer, exactly as a real LLDP exchange would require.
 */
interface Neighbor { peer: Device; peerIf: NetInterface }
function neighborOn(ctx: CommandContext, iface: NetInterface): Neighbor | undefined {
  const c = iface.connectedTo;
  if (!c || iface.management) return undefined;
  if (!lldpTxRx(ctx.device, iface.name).rx) return undefined;
  const peer = ctx.network.devices[c.deviceId];
  const peerIf = peer?.interfaces.find((i) => i.id === c.interfaceId);
  if (!peer || !peerIf) return undefined;
  if (!lldpTxRx(peer, peerIf.name).tx) return undefined;
  return { peer, peerIf };
}

function renderSummary(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<LldpState>(ctx.device, "lldp");
  const mode = st === undefined || (st.transmit && st.receive)
    ? "rx+tx"
    : st.transmit
      ? "tx-only"
      : st.receive
        ? "rx-only"
        : "off";
  const out: OutputLine[] = [
    line("LLDP Global Configuration"),
    line(`  Admin state          : ${st?.enabled === false ? "disabled" : "enabled"}`),
    line(`  Mode                 : ${mode}`),
    line(`  TX interval (timer)  : ${st?.timer ?? "default"}`),
    line(`  TX hold multiplier   : ${st?.multiplier ?? "default"}`),
    line(`  System name          : ${st?.systemName ?? "(default)"}`),
    line(`  System description   : ${st?.systemDescription ?? "(default)"}`),
  ];
  const overrides = Object.values(st?.interfaces ?? {});
  if (overrides.length > 0) {
    out.push(line("Per-interface overrides"));
    for (const p of overrides.sort((a, b) => a.name.localeCompare(b.name))) {
      const m = p.transmit && p.receive ? "rx+tx" : p.transmit ? "tx-only" : p.receive ? "rx-only" : "off";
      out.push(line(`  ${p.name.padEnd(12)} : ${p.enabled ? "enabled" : "disabled"}, ${m}`));
    }
  }
  return out;
}

function renderTable(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<LldpState>(ctx.device, "lldp");
  const out: OutputLine[] = [
    line("LocalPort    RemoteDevice    RemotePortID    Capability    RemotePortDescr"),
    line("-----------  --------------  --------------  ------------  ---------------"),
  ];
  if (st?.enabled === false) {
    out.push(muted("LLDP is administratively disabled"));
    return out;
  }
  let any = false;
  for (const iface of ctx.device.interfaces) {
    const nb = neighborOn(ctx, iface);
    if (!nb) continue;
    any = true;
    out.push(
      line(
        `${iface.name.padEnd(11)}  ${neighSysName(nb.peer).padEnd(14)}  ${nb.peerIf.name.padEnd(14)}  ${capabilityOf(nb.peer.type).padEnd(12)}  ${nb.peerIf.name}`,
      ),
    );
  }
  if (!any) out.push(muted("No LLDP neighbors discovered (no LLDP-active connected links)"));
  return out;
}

function renderNeighbors(ctx: CommandContext, portArg: string | undefined): OutputLine[] {
  const st = peekFeatureState<LldpState>(ctx.device, "lldp");
  if (portArg && !interfaceByName(ctx.device, portArg)) {
    return [err(`show lldp neighbors: no such interface '${portArg}'`)];
  }
  const out: OutputLine[] = [];
  if (st?.enabled === false) return [line("LLDP Neighbors"), muted("LLDP is administratively disabled")];
  const ifaces = portArg ? ctx.device.interfaces.filter((i) => i.name === portArg) : ctx.device.interfaces;
  let any = false;
  for (const iface of ifaces) {
    const nb = neighborOn(ctx, iface);
    if (!nb) continue;
    any = true;
    const chassis = nb.peerIf.mac || "n/a";
    out.push(line(`-------------------------------------------------------------------------------`));
    out.push(line(`Local Interface: ${iface.name}`));
    out.push(line(`  Chassis id:      ${chassis}`));
    out.push(line(`  System Name:     ${neighSysName(nb.peer)}`));
    out.push(line(`  System Descr:    ${peekFeatureState<LldpState>(nb.peer, "lldp")?.systemDescription ?? `SONiC ${nb.peer.type}`}`));
    out.push(line(`  Port id:         ${nb.peerIf.name}`));
    out.push(line(`  Port descr:      ${nb.peerIf.name}`));
    out.push(line(`  Capability:      ${capabilityOf(nb.peer.type)}`));
  }
  if (!any) {
    return [line("LLDP Neighbors"), muted(portArg ? `No neighbor on ${portArg}` : "No LLDP neighbors discovered (no LLDP-active connected links)")];
  }
  return [line("LLDP Neighbors"), ...out];
}

function renderStatistics(ctx: CommandContext, portArg: string | undefined): OutputLine[] {
  if (portArg && !interfaceByName(ctx.device, portArg)) {
    return [err(`show lldp statistics: no such interface '${portArg}'`)];
  }
  const ports = portArg ? [portArg] : ctx.device.interfaces.map((i) => i.name);
  const out: OutputLine[] = [line("LLDP Statistics")];
  // No packet engine yet: counters are typed and rendered as zero (not fabricated).
  for (const p of ports) {
    out.push(line(`Interface: ${p}`));
    out.push(line("  Transmitted : 0"));
    out.push(line("  Received : 0"));
    out.push(line("  Discarded : 0"));
    out.push(line("  Unrecognized TLV : 0"));
    out.push(line("  Ageout : 0"));
  }
  return out;
}

const show: SonicCmd[] = [
  { path: ["lldp", "table"], summary: "Show LLDP neighbor table (local ports)", run: (_a, ctx) => ({ output: renderTable(ctx) }) },
  {
    path: ["lldp", "neighbors"],
    summary: "Show LLDP neighbors (optionally one port)",
    run: (a, ctx) => ({ output: renderNeighbors(ctx, positional(a)[0]) }),
  },
  {
    path: ["lldp", "neighbor"],
    summary: "Alias of `show lldp neighbors`",
    run: (a, ctx) => ({ output: renderNeighbors(ctx, positional(a)[0]) }),
  },
  {
    path: ["lldp", "statistics"],
    summary: "Show LLDP per-interface statistics (optionally one port)",
    run: (a, ctx) => ({ output: renderStatistics(ctx, positional(a)[0]) }),
  },
  { path: ["lldp"], summary: "Show LLDP global configuration", run: (_a, ctx) => ({ output: renderSummary(ctx) }) },
];

export const lldpModule: SonicFeatureModule = { id: "lldp", config, show };
