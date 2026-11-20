/**
 * Click `show` coverage audit (opt-in: CLICK_AUDIT=1 npx vitest run tests/tools/click-audit.test.ts).
 * click-show-commands.json lists every real `show` command path in sonic-utilities/show (Click
 * groups and commands, extracted from the decorators); CLICK_LIST=<json> overrides it. Each
 * runs in the bash shell of a loaded lab switch and its answer is printed.
 */
import "../../lib/commands/sonic-cli/features";
import "../../lib/labs";
import { it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { resetAll } from "../helpers";
import { S, advance, byName } from "../control-helpers";

it.skipIf(!process.env.CLICK_AUDIT)("Click show coverage", () => {
  const cmds: string[] = JSON.parse(readFileSync(process.env.CLICK_LIST ?? join(__dirname, "click-show-commands.json"), "utf8"));
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab(process.env.CLICK_LAB ?? "lacp");
  advance(5000);
  const id = byName(process.env.CLICK_DEV ?? "S1").id;
  S().execCommand(id, "exit"); // switches boot into sonic-cli; Click lives at the bash prompt
  const rows = cmds.map((cmd) => {
    const out = S().execCommand(id, cmd).output.map((o) => o.text).join(" | ").trim();
    return `${cmd}  =>  ${out.slice(0, 140)}`;
  });
  console.log(rows.join("\n"));
});
