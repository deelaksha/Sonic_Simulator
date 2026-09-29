/**
 * Command layer contracts (spec §15, §42, §44). The terminal is just another
 * interface into the ONE network state: handlers read/mutate `ctx.network` and
 * run simulations via `ctx.runSim`. Only registered handlers can run — there is
 * no path to arbitrary host execution (spec §44).
 */
import { Device } from "../models/device";
import { NetworkState } from "../models/topology";
import { Simulation, SimEvent, CaptureRecord } from "../engine";

export type LineKind = "normal" | "error" | "muted" | "success" | "heading";

export interface OutputLine {
  text: string;
  kind?: LineKind;
}

export interface CommandResult {
  output: OutputLine[];
  /** Timeline events produced by this command (drives animation/inspector). */
  events?: SimEvent[];
  /** When true, the terminal clears its scrollback. */
  clear?: boolean;
}

export interface CommandContext {
  /** The device whose shell issued the command. */
  device: Device;
  /** The working network state; mutations persist (single source of truth). */
  network: NetworkState;
  /** Rolling capture log across commands; tcpdump reads it, sims append to it. */
  captures: CaptureRecord[];
  /** Run a simulation against `network`, appending its captures to the log. */
  runSim<T>(fn: (sim: Simulation) => T): { value: T; events: SimEvent[] };
}

export interface CommandHandler {
  name: string;
  aliases?: string[];
  /** CLI family for the §59 Linux-vs-SONiC distinction. Defaults to "linux". */
  cli?: "linux" | "sonic";
  summary: string;
  usage: string;
  help: string[];
  run(args: string[], ctx: CommandContext): CommandResult;
}

// --- small output helpers ---
export const line = (text: string, kind?: LineKind): OutputLine => ({ text, kind });
export const err = (text: string): OutputLine => ({ text, kind: "error" });
export const muted = (text: string): OutputLine => ({ text, kind: "muted" });
