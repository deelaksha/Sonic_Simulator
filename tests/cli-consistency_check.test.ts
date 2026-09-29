import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/consistency_check";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

function sw(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { state: { devices: { sw1: device }, connections: [] }, device };
}
function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (s: Simulation) => T) {
      const s = new Simulation(state);
      return { value: fn(s), events: s.events as SimEvent[] };
    },
  };
}
function run(state: NetworkState, device: Device, stack: CliStack, cmd: string): { stack: CliStack; text: string } {
  const r = runSonicCli(cmd, stack, ctxFor(state, device));
  return { stack: r.toBash ? [] : r.stack, text: r.output.map((o) => o.text).join("\n") };
}

describe("sonic-cli consistency-check (show-only config-plane feature)", () => {
  it("reports the checker is not run in the simulator", () => {
    const { state, device } = sw();
    const s: CliStack = ["exec"];
    expect(run(state, device, s, "show consistency-check").text).toContain("Consistency-check");
    expect(run(state, device, s, "show consistency-check").text).toContain("not run in this simulator");
  });

  it("reports access-list status with no fabricated per-entry results", () => {
    const { state, device } = sw();
    const s: CliStack = ["exec"];
    const text = run(state, device, s, "show consistency-check status access-list detail errors").text;
    expect(text).toContain("access-list");
    expect(text).toContain("no results");
  });

  it("reports route status without inventing operational state", () => {
    const { state, device } = sw();
    const s: CliStack = ["exec"];
    const text = run(state, device, s, "show consistency-check status route").text;
    expect(text).toContain("route");
    expect(text).toContain("no results");
  });

  it("does not claim unrelated show commands", () => {
    const { state, device } = sw();
    const s: CliStack = ["exec"];
    // args[0] is "consistency" (not "consistency-check") — handler must fall through.
    expect(run(state, device, s, "show consistency").text).not.toContain("Consistency-check");
  });
});
