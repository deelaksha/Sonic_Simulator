/**
 * Command executor. The single entry point the terminal UI calls. Parses input,
 * resolves an allowed handler, and runs it — nothing else can execute (spec §44).
 */
import { CommandContext, CommandResult, err, muted } from "./types";
import { parse } from "./parser";
import { resolveCommand } from "./registry";

export * from "./types";
export { COMMANDS, resolveCommand, commandNames } from "./registry";
export { parse, tokenize } from "./parser";

export function execute(input: string, ctx: CommandContext): CommandResult {
  const parsed = parse(input);
  if (!parsed) return { output: [] };

  const handler = resolveCommand(parsed.name);
  if (!handler) {
    return {
      output: [
        err(`${parsed.name}: command not found`),
        muted("Type `help` to see the available commands."),
      ],
    };
  }

  try {
    return handler.run(parsed.args, ctx);
  } catch (e) {
    return { output: [err(`${parsed.name}: ${(e as Error).message}`)] };
  }
}
