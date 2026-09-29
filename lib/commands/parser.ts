/**
 * Command-line parsing (spec §42): commands are tokenized and parsed, not
 * matched as exact strings, so `ping X` and `ping -c 5 X` both work.
 */

export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

/** Split a line into tokens, honoring simple single/double quotes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

export function parse(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const tokens = tokenize(trimmed);
  return { name: tokens[0], args: tokens.slice(1), raw: trimmed };
}

/**
 * Extract a flag that takes a value, e.g. getFlagValue(args, "-c") on
 * ["-c", "5", "host"] returns "5" and removes both tokens from `args`.
 */
export function takeFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

/** True if the boolean flag is present; removes it from `args`. */
export function takeFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

/** First token that does not start with '-'. */
export function firstPositional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}
