/**
 * Lab missions and troubleshooting labs.
 *
 * A Mission runs on top of a registered feature lab (lib/labs): the learner
 * loads the lab, then works through objectives that are checked live against
 * the simulated network every second (lib/missions/check.ts).
 *
 *   kind "mission"      guided exercise; each objective latches once it is met.
 *   kind "troubleshoot" the lab is broken right after it loads (`inject`); the
 *                       ticket describes only the symptom. Solved when every
 *                       objective holds at the same time (no latching).
 *
 * Every mission carries its reference `solution` (shown on request in the UI,
 * and applied by tests to prove the objectives are reachable) and an
 * `explanation` shown once it is solved.
 */
import { LabApi } from "../labs/registry";
import { CheckCtx } from "./check";

export type MissionKind = "mission" | "troubleshoot";
export type MissionLevel = "beginner" | "intermediate" | "advanced";

export interface Objective {
  id: string;
  title: string;
  /** Progressive hints, revealed one at a time. */
  hints?: string[];
  check(c: CheckCtx): boolean;
}

/** One device's part of the reference solution. */
export interface SolutionStep {
  device: string;
  /** KLISH lines, applied from a fresh exec stack (`configure terminal` … `end`). */
  klish?: string[];
  /** Linux / Click commands typed at the device's shell. */
  shell?: string[];
  /** Wall-clock wait after this step so protocols can converge (ms). */
  waitMs?: number;
}

export interface Mission {
  id: string;
  labId: string;
  kind: MissionKind;
  level: MissionLevel;
  title: string;
  /** Mission: what to do. Troubleshoot: the ticket — symptom only, never the cause. */
  summary: string;
  objectives: Objective[];
  /** Troubleshoot only: break the freshly loaded lab. */
  inject?(api: LabApi): void;
  solution: SolutionStep[];
  /** Shown once solved: what was going on and why the fix works. */
  explanation: string;
}
