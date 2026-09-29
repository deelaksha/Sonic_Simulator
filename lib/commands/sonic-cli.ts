/**
 * SONiC modal CLI (KLISH / `sonic-cli` style) — matches the reference cheat
 * sheets (20Augcheats), which drive the box through hierarchical config modes:
 *
 *   sonic# configure terminal
 *   sonic(config)# vlan 10
 *   sonic(config)# interface Ethernet 0
 *   sonic(config-if-Ethernet0)# switchport access Vlan 10
 *   sonic(config-if-Ethernet0)# exit
 *   sonic(config)# exit
 *   sonic# show vlan
 *
 * This is a MODE STATE MACHINE + TRANSLATOR: each modal command is mapped onto
 * the existing (tested) flat Click commands and run through execute(), so no
 * engine behaviour is duplicated or faked. The mode stack is owned by the store
 * per device; switches boot straight into sonic-cli (see cliModeFor).
 */
import { Device, isSwitch } from "../models/device";
import { createInterface } from "../models/interface";
import { generateMac } from "../models/mac";
import { SimEvent } from "../engine";
import { CommandContext, OutputLine, muted, err } from "./types";
import { execute } from "./index";
import { runModalHandlers } from "./sonic-cli/registry";
import { cpStoreLine } from "./sonic-cli/config-plane";
import { viewForStackTop, isKnownCommand, resolveModeEntry } from "../sonic/grammar";
import "./sonic-cli/features"; // side-effect: registers all feature handlers

/** Mode stack: [] = bash; ["exec"] = sonic#; [...,"config"]; [...,"if-Ethernet0"]. */
export type CliStack = string[];

export interface SonicCliResult {
  output: OutputLine[];
  stack: CliStack;
  clear?: boolean;
  toBash?: boolean;
  events?: SimEvent[];
}

/** Default CLI mode for a device: switches boot into sonic-cli, others use bash. */
export function cliModeFor(device: Device | undefined, override: CliStack | undefined): CliStack {
  if (override !== undefined) return override;
  return device && isSwitch(device.type) ? ["exec"] : [];
}

/** Modal prompt for a stack, e.g. "sonic#", "sonic(config)#", "sonic(config-if-Ethernet0)#". */
export function cliPrompt(stack: CliStack, hostname: string): string {
  const top = stack[stack.length - 1];
  if (!top || top === "exec") return `${hostname}#`;
  if (top.startsWith("gv:")) return `${hostname}(${top.slice(3).split("|")[1] ?? "config"})#`;
  if (top === "config") return `${hostname}(config)#`;
  if (top.startsWith("if-")) return `${hostname}(config-if-${top.slice(3)})#`;
  return `${hostname}#`;
}

/** Enter sonic-cli from the bash prompt. */
export function enterSonicCli(): SonicCliResult {
  return {
    stack: ["exec"],
    output: [muted("Entering sonic-cli. `configure terminal` to configure, `exit` to leave.")],
  };
}

type Delegate = (clickCommand: string) => OutputLine[];

const IF_TYPES: Record<string, string> = {
  ethernet: "Ethernet", eth: "Ethernet",
  vlan: "Vlan",
  loopback: "Loopback", lo: "Loopback",
  portchannel: "PortChannel", po: "PortChannel",
  management: "Management", mgmt: "Management",
};

/** A deterministic MAC for a logical interface (no shared-counter side effect). */
function logicalMac(name: string): string {
  let seed = 0x0e0000;
  for (const c of name) seed = (seed + c.charCodeAt(0) * 131) & 0xffffff;
  return generateMac(seed);
}

/**
 * Ensure a logical interface (Vlan SVI / Loopback / PortChannel) exists so it can
 * be configured and shown — matching the real device, where `interface Vlan 10`
 * / `interface Loopback 0` / `interface PortChannel 1` create the interface.
 * Returns false if the name is a physical Ethernet/Management port that must
 * already exist.
 */
function ensureInterface(device: Device, name: string): boolean {
  if (device.interfaces.some((i) => i.name === name)) return true;
  if (name.startsWith("Ethernet") || name.startsWith("Management")) return false; // physical/mgmt: must exist
  const iface = createInterface(`${device.id}-${name.toLowerCase()}`, name, logicalMac(name));
  iface.logical = true;
  iface.operState = name.startsWith("PortChannel") ? "down" : "up"; // LAG down until members; SVI/Loopback up
  device.interfaces.push(iface);
  return true;
}

/** Normalise "Ethernet 24" / "Ethernet24" / "Vlan 10" → "Ethernet24" / "Vlan10". */
function ifName(parts: string[]): string | null {
  const m = parts.join("").match(/^([a-zA-Z]+)(\d+)$/);
  if (!m) return null;
  const type = IF_TYPES[m[1].toLowerCase()];
  return type ? `${type}${m[2]}` : null;
}

export function runSonicCli(input: string, stack: CliStack, ctx: CommandContext): SonicCliResult {
  let events: SimEvent[] | undefined;
  const delegate: Delegate = (cmd) => {
    const r = execute(cmd, ctx);
    if (r.events) events = r.events;
    return r.output;
  };
  const res = dispatch(input.trim(), stack, ctx, delegate);
  return { ...res, events };
}

function dispatch(raw: string, stack: CliStack, ctx: CommandContext, delegate: Delegate): SonicCliResult {
  const stay = (output: OutputLine[] = []): SonicCliResult => ({ output, stack });
  if (!raw) return stay();

  const tokens = raw.split(/\s+/);
  const cmd = tokens[0].toLowerCase();
  const rest = tokens.slice(1);
  const top = stack[stack.length - 1] ?? "exec";

  // --- navigation, valid from any mode ---
  if (cmd === "end") return { output: [], stack: ["exec"] };
  if (cmd === "exit" || cmd === "quit" || cmd === "logout") {
    if (stack.length <= 1) return { output: [], stack: [], toBash: true };
    return { output: [], stack: stack.slice(0, -1) };
  }
  if (cmd === "clear" && rest.length === 0) return { output: [], stack, clear: true };
  if (cmd === "do") return stay(delegate(rest.join(" ")));

  // `show` works from any mode. Config-plane features may register a `show`
  // handler (enable-view, keyword "show") that renders from stored state; try
  // those first, then fall back to the tested Click `show` layer.
  if (cmd === "show") {
    const sr = runModalHandlers({ ctx, view: "enable-view", head: "show", isNo: false, args: rest, raw, delegate });
    if (sr) return stay(sr.output);
    const out = delegate(raw);
    // The Click `show` layer hard-rejects sub-commands it doesn't implement.
    // For a real device `show` command with no specific handler, degrade to the
    // graceful exec fallback (recognized-but-not-simulated) instead of falsely
    // reporting "unknown command" — matching how `clear`/config commands behave.
    if (out.some((o) => o.kind === "error" && /unknown command/i.test(o.text))) {
      return stay(unknownIn("enable-view", raw));
    }
    return stay(out);
  }
  if (["ping", "ping6", "traceroute", "tracepath", "tcpdump"].includes(cmd)) {
    return stay(delegate(raw));
  }
  if (cmd === "write" || cmd === "copy" || cmd === "commit") {
    return stay([muted("running-config is applied live in this simulator (no save needed).")]);
  }

  if (top === "exec") {
    if (cmd === "configure" || cmd === "config") {
      return { output: [muted("Enter configuration commands, one per line. End with `exit`.")], stack: [...stack, "config"] };
    }
    return stay(unknownIn("enable-view", raw));
  }
  if (top === "config") return configMode(cmd, rest, raw, stack, ctx, delegate);
  if (top.startsWith("if-")) return ifMode(top.slice(3), cmd, rest, raw, stack, ctx, delegate);
  if (top.startsWith("gv:")) return genericView(top, cmd, rest, raw, stack, ctx, delegate);
  return stay(unknownIn(viewForStackTop(top), raw));
}

/** exec-mode fallback: recognized-but-not-runnable vs unknown. */
function unknownIn(view: string, raw: string): OutputLine[] {
  if (isKnownCommand(view, raw)) return [muted(`% "${raw}" — recognized SONiC command; not simulated in this lab.`)];
  return [err(`% Unrecognized command "${raw}".`)];
}

/**
 * Config-mode fallback: if the command is a real device command that no specific
 * handler models, ACCEPT it and persist to running-config (config commands are
 * silent on the device). Only truly unknown input errors. `ctxLabel` scopes the
 * stored line to its mode (view + interface).
 */
function configFallback(ctx: CommandContext, view: string, ctxLabel: string, raw: string, isNo: boolean): OutputLine[] {
  if (isKnownCommand(view, raw)) {
    cpStoreLine(ctx.device, ctxLabel, raw, isNo);
    return []; // silent accept, like the real device
  }
  return [err(`% Unrecognized command "${raw}".`)];
}

function configMode(cmd: string, rest: string[], raw: string, stack: CliStack, ctx: CommandContext, delegate: Delegate): SonicCliResult {
  const stay = (output: OutputLine[] = []): SonicCliResult => ({ output, stack });
  const isNo = cmd === "no";
  const head = (isNo ? rest[0] : cmd)?.toLowerCase() ?? "";
  const args = isNo ? rest.slice(1) : rest;

  // Mode entry (core navigation) — enters a per-interface sub-view.
  if (head === "interface") {
    const name = ifName(args);
    if (!name) return stay([err(`% Invalid interface "${args.join(" ")}".`)]);
    if (isNo) {
      // `no interface Vlan/Loopback/PortChannel <n>` deletes the logical interface.
      const iface = ctx.device.interfaces.find((i) => i.name === name);
      if (!iface) return stay([err(`% Interface ${name} does not exist.`)]);
      if (!iface.logical) return stay([err(`% Cannot delete physical interface ${name}.`)]);
      ctx.device.interfaces = ctx.device.interfaces.filter((i) => i.name !== name);
      return stay();
    }
    // Ethernet/Management must already exist; Vlan SVI / Loopback / PortChannel are
    // created on entry (as on the real device). A Vlan SVI implies its VLAN.
    if (name.startsWith("Vlan")) {
      const vid = Number(name.slice(4));
      const vlans = (ctx.device.config.vlans ??= []);
      if (Number.isFinite(vid) && !vlans.some((v) => v.id === vid)) vlans.push({ id: vid, name });
    }
    if (!ensureInterface(ctx.device, name)) {
      return stay([err(`% Interface ${name} does not exist on this device.`)]);
    }
    return { output: [], stack: [...stack, `if-${name}`] };
  }
  if (head === "hostname") {
    if (!args[0]) return stay([err("% hostname requires a name.")]);
    ctx.device.config.hostname = args[0];
    return stay();
  }
  // Feature handlers (vlan, ...) registered in ./sonic-cli/features.
  const r = runModalHandlers({ ctx, view: "configure-view", head, isNo, args, raw, delegate });
  if (r) return r.enter ? { output: r.output, stack: [...stack, r.enter] } : stay(r.output);
  // `system vlan <id> reserve` / `no ...` — accepted (no packet-plane effect).
  if (head === "system" && args[0]?.toLowerCase() === "vlan") return stay();
  // Data-driven sub-mode entry (router bgp, route-map, ip access-list, bfd, line vty ...).
  if (!isNo) {
    const e = resolveModeEntry("configure-view", raw.trim().split(/\s+/));
    if (e) return { output: [], stack: [...stack, `gv:${e.targetView}|${e.promptBody}|${e.ctx}`] };
  }
  return stay(configFallback(ctx, "configure-view", "config", raw, isNo));
}

/** Generic dispatcher for a data-driven sub-view frame ("gv:<view>|<prompt>|<ctx>"). */
function genericView(top: string, cmd: string, rest: string[], raw: string, stack: CliStack, ctx: CommandContext, delegate: Delegate): SonicCliResult {
  const stay = (output: OutputLine[] = []): SonicCliResult => ({ output, stack });
  const parts = top.slice(3).split("|");
  const view = parts[0];
  const viewctx = parts[2] ?? "";
  const isNo = cmd === "no";
  const head = (isNo ? rest[0] : cmd)?.toLowerCase() ?? "";
  const args = isNo ? rest.slice(1) : rest;
  const r = runModalHandlers({ ctx, view, viewctx, head, isNo, args, raw, delegate });
  if (r) return r.enter ? { output: r.output, stack: [...stack, r.enter] } : stay(r.output);
  // nested sub-mode entry (e.g. router-bgp -> address-family / neighbor)
  if (!isNo) {
    const e = resolveModeEntry(view, raw.trim().split(/\s+/));
    if (e) return { output: [], stack: [...stack, `gv:${e.targetView}|${e.promptBody}|${e.ctx}`] };
  }
  return stay(configFallback(ctx, view, view.replace(/^configure-/, "").replace(/-view$/, ""), raw, isNo));
}

function ifMode(name: string, cmd: string, rest: string[], raw: string, stack: CliStack, ctx: CommandContext, delegate: Delegate): SonicCliResult {
  const stay = (output: OutputLine[] = []): SonicCliResult => ({ output, stack });
  const isNo = cmd === "no";
  const head = (isNo ? rest[0] : cmd)?.toLowerCase() ?? "";
  const args = isNo ? rest.slice(1) : rest;
  const view = viewForStackTop(`if-${name}`);
  const r = runModalHandlers({ ctx, view, ifname: name, head, isNo, args, raw, delegate });
  if (r) return r.enter ? { output: r.output, stack: [...stack, r.enter] } : stay(r.output);
  return stay(configFallback(ctx, view, name, raw, isNo));
}
