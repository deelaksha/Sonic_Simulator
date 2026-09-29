import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/event";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { runModalHandlers } from "../lib/commands/sonic-cli/registry";
import { Device } from "../lib/models/device";

function sw(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { state: { devices: { sw1: device }, connections: [] }, device };
}
function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return { device, network: state, captures, runSim<T>(fn: (s: Simulation) => T) { const s = new Simulation(state); return { value: fn(s), events: s.events as SimEvent[] }; } };
}
function run(state: NetworkState, device: Device, stack: CliStack, cmd: string): { stack: CliStack; text: string } {
  const r = runSonicCli(cmd, stack, ctxFor(state, device));
  return { stack: r.toBash ? [] : r.stack, text: r.output.map((o) => o.text).join("\n") };
}

// Event/alarm is a show-only feature: events & alarms are runtime data the sim
// cannot honestly model, so `show` reflects the (empty) config-plane store and
// never fabricates rows. There is no config command, hence no store/no-clear test.
describe("sonic-cli event/alarm (config-plane, show-only)", () => {
  it("show event reflects no simulated event history", () => {
    const { state, device } = sw();
    const text = run(state, device, ["exec"], "show event").text;
    expect(text).toContain("No events to display");
    expect(text).toContain("runtime data not simulated");
  });

  it("show alarm reflects no simulated alarm history", () => {
    const { state, device } = sw();
    const text = run(state, device, ["exec"], "show alarm").text;
    expect(text).toContain("No alarms to display");
    expect(text).toContain("runtime data not simulated");
  });

  it("show event summary is handled the same honest way", () => {
    const { state, device } = sw();
    const text = run(state, device, ["exec"], "show event summary").text;
    expect(text).toContain("No events to display");
  });

  it("does not claim a non-event/alarm show (returns null to fall through)", () => {
    const { state, device } = sw();
    const r = runModalHandlers({
      ctx: ctxFor(state, device),
      view: "enable-view",
      head: "show",
      isNo: false,
      args: ["version"],
      raw: "show version",
      delegate: () => [],
    });
    expect(r).toBeNull();
  });
});
