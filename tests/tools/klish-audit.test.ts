/**
 * KLISH `show` coverage audit (opt-in: KLISH_AUDIT=1 npx vitest run tests/tools/klish-audit.test.ts).
 * Walks the real device grammar like a user pressing `?` (keywords literally, a realistic
 * sample for every placeholder), runs every complete `show …` command on a loaded lab switch,
 * and reports which ones fall through to "not simulated", are "Unrecognized", or answer "% …".
 * KLISH_PREFIX="show interface" limits it to one family; KLISH_LAB picks the lab (default lacp).
 */
import "../../lib/commands/sonic-cli/features";
import "../../lib/labs";
import { it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar, candidatesFor } from "../../lib/sonic/grammar";
import { resetAll } from "../helpers";
import { S, advance, byName } from "../control-helpers";

function sample(tok: string, prev: string): string {
  const t = tok.toLowerCase();
  if (prev === "Ethernet") return "0";
  if (prev === "PortChannel") return "1";
  if (prev === "Vlan") return "10";
  if (prev === "Loopback" || prev === "Management") return "0";
  if (t.includes("vlan")) return "10";
  if (t.includes("ipv6")) return "2001:db8::1";
  if (t.includes("prefix") || t.includes("cidr")) return "10.0.12.0/30";
  if (t.includes("ip") || t.includes("addr")) return "10.0.12.2";
  if (t.includes("mac")) return "00:11:22:33:44:55";
  if (t.includes("vrf")) return "default";
  return "1";
}

it.skipIf(!process.env.KLISH_AUDIT)("KLISH show coverage", () => {
  setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab(process.env.KLISH_LAB ?? "lacp");
  advance(5000);
  const id = byName(process.env.KLISH_DEV ?? "S1").id;
  const prefix = (process.env.KLISH_PREFIX ?? "show").split(" ");
  const found = new Set<string>();
  const walk = (typed: string[], depth: number) => {
    if (found.size > 6000 || depth > 8) return;
    for (const c of candidatesFor("enable-view", typed)) {
      if (c.token === "<cr>") {
        found.add(typed.join(" "));
        continue;
      }
      const tok = c.placeholder ? sample(c.token, typed[typed.length - 1]) : c.token;
      if (!c.placeholder && typed.includes(tok)) continue;
      walk([...typed, tok], depth + 1);
    }
  };
  walk(prefix, prefix.length);
  const res: Record<string, string[]> = { notSimulated: [], unrecognized: [], error: [], ok: [] };
  for (const cmd of [...found].sort()) {
    const out = S().execCommand(id, cmd).output.map((o) => o.text).join(" ").trim();
    if (/not simulated in this lab/.test(out)) res.notSimulated.push(cmd);
    else if (/Unrecognized command/.test(out)) res.unrecognized.push(cmd);
    else if (/^%/.test(out)) res.error.push(`${cmd}  =>  ${out.slice(0, 100)}`);
    else res.ok.push(cmd);
  }
  console.log(JSON.stringify({ total: found.size, counts: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.length])), notSimulated: res.notSimulated, unrecognized: res.unrecognized, error: res.error }, null, 1));
});
