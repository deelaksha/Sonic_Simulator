/**
 * Round-trip helpers for KLISH `show running-configuration` tests.
 *
 * baseLab(id) registers (once) and loads a copy of lab `id` built WITHOUT its
 * switch configuration: every LabApi call is forwarded except runCliScript and
 * exec on switches, so the topology, cabling, host config and the addresses the
 * topology helper sets are there, but nothing typed into KLISH/Click is.
 *
 * klishReplay(name, lines) replays a rendered running-config the way KLISH
 * does: a command the current sub-mode does not know is retried in the
 * enclosing modes; unindented lines are configure-view commands.
 */
import { getLab, registerLab, LabApi } from "../lib/labs/registry";
import { S, out } from "./control-helpers";
import { useLabStore } from "../lib/store/lab-store";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { CommandContext } from "../lib/commands/types";
import { Simulation } from "../lib/engine";

export function baseLab(id: string): void {
  const baseId = `rc-base:${id}`;
  if (!getLab(baseId)) {
    registerLab(baseId, (api) => {
      const isSwitch = (devId: string) => S().network.devices[devId]?.type === "switch";
      const proxy: LabApi = { ...api, runCliScript: () => {}, exec: (d, c) => (isSwitch(d) ? undefined : api.exec(d, c)), hint: () => {} };
      getLab(id)!(proxy);
    });
  }
  S().loadFeatureLab(baseId);
}

export const devId = (name: string) => Object.values(S().network.devices).find((d) => d.name === name)!.id;
export const runcfg = (name: string, cmd = "show running-configuration") => out(S().execCommand(devId(name), cmd)).split("\n");
export const switches = () => Object.values(S().network.devices).filter((d) => d.type === "switch").map((d) => d.name);

const unknown = (t: string) => /Unrecognized command/.test(t);

/** Replay a rendered running-config the way KLISH does (parent-view fallback). Returns the errors. */
export function klishReplay(name: string, rendered: string[]): string[] {
  const draft = structuredClone(S().network);
  const device = draft.devices[devId(name)];
  const ctx: CommandContext = {
    device,
    network: draft,
    captures: [],
    runSim(fn) {
      const sim = new Simulation(draft, { wallBase: Date.now() });
      return { value: fn(sim), events: sim.events };
    },
  };
  let stack: CliStack = ["exec", "config"];
  const errors: string[] = [];
  for (const raw of rendered) {
    const l = raw.trim();
    if (!l || l === "!" || l === "Current configuration:" || l === "end" || l.startsWith("! ")) continue;
    // A top-level (unindented) line is a configure-view command.
    let s = raw.startsWith(" ") ? stack : (["exec", "config"] as CliStack);
    for (;;) {
      const r = runSonicCli(l, s, ctx);
      const errs = r.output.filter((o) => o.kind === "error").map((o) => o.text);
      if (errs.some(unknown) && s.length > 2) {
        s = s.slice(0, -1); // not known here: try the enclosing mode
        continue;
      }
      errors.push(...errs);
      stack = r.toBash ? ["exec", "config"] : r.stack.length < 2 ? ["exec", "config"] : r.stack;
      break;
    }
  }
  useLabStore.setState({ network: draft });
  return errors;
}

/** Render every switch of `lab`, replay KLISH-style on the config-less copy; [before, after, replay errors] per switch. */
export function roundTrip(lab: string, extra: Record<string, string[]> = {}): { name: string; before: string[]; after: string[]; errors: string[] }[] {
  S().loadFeatureLab(lab);
  for (const [name, lines] of Object.entries(extra)) S().runCliScript(devId(name), lines, { silent: true });
  const before = new Map(switches().map((n) => [n, runcfg(n)]));
  baseLab(lab);
  return [...before].map(([name, rc]) => ({ name, before: rc, errors: klishReplay(name, rc), after: runcfg(name) }));
}
