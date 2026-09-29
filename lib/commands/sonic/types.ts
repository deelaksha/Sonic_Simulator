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
import { CommandContext, CommandResult } from "../types";

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
