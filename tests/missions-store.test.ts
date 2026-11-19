/** Mission engine behaviour in the store (lib/missions + lab-store mission slice). */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, byName } from "./control-helpers";
import { settle, typeAt, metIds } from "./mission-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 19, 9, 0, 0));
  resetAll();
});
afterEach(() => vi.useRealTimers());

const terminalText = (dev: string) => (S().terminals[byName(dev).id] ?? []).map((l) => l.text).join("\n");

describe("mission engine", () => {
  it("a troubleshooting fault is injected silently (nothing in any terminal gives it away)", () => {
    S().startMission("ospf-trouble-hello");
    for (const d of ["S1", "S2", "S3"]) expect(terminalText(d)).not.toMatch(/hello-interval/);
    settle(30_000);
    expect(S().mission?.solvedAtMs).toBeUndefined();
    expect(typeAt("S2", "exit") + typeAt("S2", "show ip ospf interface Ethernet0")).toMatch(/Hello 5s/); // but it is discoverable
  });

  it("mission objectives latch; checks never touch the learner's network", () => {
    S().startMission("ospf-cost-steering");
    settle(30_000);
    const arpBefore = JSON.stringify(byName("H1").arpTable);
    S().missionTick(); // runs a ping on a copy for the "reach" objective
    expect(JSON.stringify(byName("H1").arpTable)).toBe(arpBefore);
    typeAt("H1", "traceroute 192.168.3.10");
    S().missionTick();
    expect(metIds()).toContain("path");
    S().newLab(); // loading something else ends the mission
    expect(S().mission).toBeNull();
  });

  it("hints are revealed one at a time; the solution is shown on request", () => {
    S().startMission("ospf-cost-steering");
    S().revealHint("via-s2");
    S().revealHint("via-s2");
    expect(S().mission?.hints["via-s2"]).toBe(2);
    expect(S().mission?.solutionShown).toBe(false);
    S().showSolution();
    expect(S().mission?.solutionShown).toBe(true);
    S().stopMission();
    expect(S().mission).toBeNull();
  });
});
