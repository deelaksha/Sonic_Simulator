/** Regression: the STP daemon actually runs and sends BPDUs (nextDue used to stay in the future forever). */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { it, expect, vi, afterEach } from "vitest";
import { resetAll } from "./helpers";
import { S, advance } from "./control-helpers";

afterEach(() => vi.useRealTimers());

it("switches with L2 ports send BPDUs every hello time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("lacp");
  advance(5_000);
  const bpdus = S().controlEvents.filter((e) => e.type === "STP_BPDU_SENT");
  expect(bpdus.length).toBeGreaterThan(0);
  const first = bpdus.length;
  advance(4_000); // two more hello intervals
  expect(S().controlEvents.filter((e) => e.type === "STP_BPDU_SENT").length).toBeGreaterThan(first);
});
