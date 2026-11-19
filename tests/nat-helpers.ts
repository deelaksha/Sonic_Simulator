/** Shared helpers for the l3-services lab tests (NAT, FBS/PBR, IP SLA, load-share). */
import { S, byName, out } from "./control-helpers";

export const id = (dev: string) => byName(dev).id;

/** Bash / Click command (switch terminals start in KLISH). */
export function bash(dev: string, cmd: string): string {
  if (byName(dev).type === "switch" && (S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}

/** KLISH lines from wherever the terminal is (enters sonic-cli from bash). */
export function klish(dev: string, ...lines: string[]): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return lines.map((l) => out(S().execCommand(id(dev), l))).join("\n");
}

/** Lines printed by a live tcpdump on `dev` while `fn` runs. */
export function tcpdump(dev: string, args: string, fn: () => void): string {
  const before = (S().terminals[id(dev)] ?? []).length;
  bash(dev, `sudo tcpdump -nn ${args}`);
  fn();
  S().stopLiveCapture(id(dev));
  return (S().terminals[id(dev)] ?? []).slice(before).map((l) => l.text).join("\n");
}
