/**
 * SONiC command-module contract (task §12-§18).
 *
 * A feature contributes `config` and `show` sub-commands. The central `config`
 * and `show` handlers (see ./index.ts) match the longest `path` prefix of the
 * typed tokens and invoke the matching sub-command with the REMAINING args.
 *
 * Every handler operates on the SAME network state the Linux CLI + packet engine
 * use (ctx.network / ctx.device), so a `config` command produces a real state
 * transition (task §61) and `show` renders live state (task §17).
 *
 * Feature modules live in their own files and are composed in ./index.ts, which
 * lets features be added independently (one file each) without merge conflicts.
 */
import { CommandContext, CommandResult, OutputLine, line, err } from "../types";

export interface SonicCmd {
  /** Tokens after `config`/`show`, e.g. ["vlan","member","add"] or ["vlan"]. */
  path: string[];
  summary: string;
  /** args = tokens AFTER the matched path. */
  run(args: string[], ctx: CommandContext): CommandResult;
}

export interface SonicFeatureModule {
  id: string;
  config: SonicCmd[];
  show: SonicCmd[];
}

/** Longest-prefix match of a sub-command against typed tokens. */
export function matchSonic(cmds: SonicCmd[], tokens: string[]): { cmd: SonicCmd; rest: string[] } | null {
  let best: SonicCmd | null = null;
  for (const c of cmds) {
    if (c.path.length > tokens.length) continue;
    if (c.path.every((p, i) => p === tokens[i]) && (!best || c.path.length > best.path.length)) {
      best = c;
    }
  }
  return best ? { cmd: best, rest: tokens.slice(best.path.length) } : null;
}

/** Positional (non-flag) tokens. */
export function positional(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

/**
 * What Click prints for a group invoked without a sub-command (no invoke_without_command):
 * usage, the group's docstring, options, and the sub-command list with their short help.
 */
export function clickGroupUsage(path: string, help: string, commands: [string, string][]): OutputLine[] {
  const w = Math.max(...commands.map(([n]) => n.length), 14) + 2;
  return [
    line(`Usage: ${path} [OPTIONS] COMMAND [ARGS]...`),
    line(""),
    line(`  ${help}`),
    line(""),
    line("Options:"),
    line("  -?, -h, --help  Show this message and exit."),
    line(""),
    line("Commands:"),
    ...commands.map(([n, h]) => line(`  ${n.padEnd(w)}${h}`)),
  ];
}

/** Click 7.0 usage error (UsageError.show): usage, help hint, blank, message. */
export function clickUsageError(cmd: string, usageArgs: string, msg: string): OutputLine[] {
  return [line(`Usage: ${cmd} [OPTIONS]${usageArgs ? ` ${usageArgs}` : ""}`), line(`Try "${cmd} -h" for help.`), line(""), err(`Error: ${msg}`)];
}

/** A Click group (no invoke_without_command): its help when bare, "No such command" otherwise. */
export function clickGroup(path: string[], help: string, cmds: [string, string][], bare?: (ctx: CommandContext) => OutputLine[]): SonicCmd {
  const full = `show ${path.join(" ")}`;
  return {
    path,
    summary: help,
    run(args, ctx) {
      const sub = positional(args)[0];
      if (!sub) return { output: bare ? bare(ctx) : clickGroupUsage(full, help, cmds) };
      return { output: clickUsageError(full, "COMMAND [ARGS]...", `No such command "${sub}".`) };
    },
  };
}
