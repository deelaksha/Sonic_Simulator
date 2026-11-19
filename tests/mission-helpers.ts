/** Drive a lab mission like a learner: type commands, wait for convergence, re-check objectives. */
import { getMission, SolutionStep } from "../lib/missions";
import { S, advance, byName } from "./control-helpers";

/** Type a command at a device's prompt (recorded as terminal input, as the Terminal component does). */
export function typeAt(device: string, cmd: string): string {
  const id = byName(device).id;
  S().appendTerminal(id, [{ text: `$ ${cmd}`, kind: "input" }]);
  const r = S().execCommand(id, cmd);
  return r.output.map((o) => o.text).join("\n");
}

/** Advance fake time in 1 s steps, re-checking objectives each second (as the page does). */
export function settle(ms: number): void {
  for (let t = 0; t < ms; t += 1000) {
    advance(1000);
    S().missionTick();
  }
}

export function applyStep(step: SolutionStep): void {
  if (step.klish) S().runCliScript(byName(step.device).id, step.klish);
  for (const cmd of step.shell ?? []) typeAt(step.device, cmd);
  S().missionTick();
  settle(step.waitMs ?? 1000);
}

/** Objectives currently met (ids), per the store. */
export const metIds = () => Object.keys(S().mission?.done ?? {});

export function solve(id: string): void {
  for (const step of getMission(id)!.solution) applyStep(step);
}
