/**
 * Every registered mission is solvable and starts unsolved: missions have at
 * least one objective open after the lab converges; troubleshooting labs are
 * broken after `inject` and fixed by their reference solution.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { allMissions } from "../lib/missions";
import { getLab as getRegisteredLab } from "../lib/labs";
import { resetAll } from "./helpers";
import { S } from "./control-helpers";
import { settle, solve, metIds } from "./mission-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 19, 9, 0, 0));
  resetAll();
});
afterEach(() => vi.useRealTimers());

const CONVERGE_MS = 45_000;

describe("lab missions", () => {
  it("are registered with unique ids on registered labs", () => {
    const ms = allMissions();
    expect(ms.length).toBeGreaterThan(0);
    expect(new Set(ms.map((m) => m.id)).size).toBe(ms.length);
    for (const m of ms) {
      expect(getRegisteredLab(m.labId), `${m.id}: lab ${m.labId}`).toBeTruthy();
      expect(m.objectives.length, m.id).toBeGreaterThan(0);
      expect(m.solution.length, m.id).toBeGreaterThan(0);
      if (m.kind === "troubleshoot") expect(m.inject, m.id).toBeTypeOf("function");
    }
  });

  for (const m of allMissions()) {
    it(`${m.kind} ${m.id}: unsolved at start, solved by its reference solution`, () => {
      S().startMission(m.id);
      settle(CONVERGE_MS);
      expect(S().mission?.solvedAtMs, `${m.id} solved before any learner action`).toBeUndefined();
      solve(m.id);
      const open = m.objectives.filter((o) => !metIds().includes(o.id)).map((o) => o.id);
      expect(open, `${m.id}: objectives still open after the solution`).toEqual([]);
      expect(S().mission?.solvedAtMs).toBeTypeOf("number");
      expect(S().missionProgress[m.id]).toBeTypeOf("number");
    });
  }
});
