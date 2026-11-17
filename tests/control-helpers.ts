/** Helpers for control-plane tests: drive the store's daemons on fake time. */
import { vi } from "vitest";
import { useLabStore } from "../lib/store/lab-store";

export const S = () => useLabStore.getState();

/** Advance fake wall-clock time, running controlTick every `stepMs` (as the page does). */
export function advance(ms: number, stepMs = 100): void {
  for (let t = 0; t < ms; t += stepMs) {
    vi.advanceTimersByTime(stepMs);
    S().controlTick();
  }
}

export const byName = (name: string) => Object.values(S().network.devices).find((d) => d.name === name)!;
export const out = (r: { output: { text: string }[] }) => r.output.map((o) => o.text).join("\n");
