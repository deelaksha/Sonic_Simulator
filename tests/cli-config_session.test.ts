import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/config_session";
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
  return { device, network: state, captures, runSim<T>(fn: (s: Simulation) => T) { const s = new Simulation(state); return { value: fn(s), events: s.events as SimEvent[] }; } };
}
function run(state: NetworkState, device: Device, stack: CliStack, cmd: string): { stack: CliStack; text: string } {
  const r = runSonicCli(cmd, stack, ctxFor(state, device));
  return { stack: r.toBash ? [] : r.stack, text: r.output.map((o) => o.text).join("\n") };
}

describe("sonic-cli config session (show-only config-plane clone)", () => {
  it("show config session renders the session table with no active session", () => {
    const { state, device } = sw();
    const text = run(state, device, ["exec"], "show config session").text;
    expect(text).toContain("Name");
    expect(text).toContain("State");
    expect(text).toContain("No configuration session in progress");
  });

  it("show config checkpoints renders the checkpoint header with no checkpoints", () => {
    const { state, device } = sw();
    const text = run(state, device, ["exec"], "show config checkpoints").text;
    expect(text).toContain("Timestamp");
    expect(text).toContain("No configuration checkpoints");
  });

  it("abort reports there is no session to discard (no/clear analog)", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure session").stack;
    expect(run(state, device, s, "abort").text).toContain("No configuration session in progress to abort");
  });

  it("rejects an unknown show config option (negative)", () => {
    const { state, device } = sw();
    expect(run(state, device, ["exec"], "show config bogus").text).toContain('Unknown "show config" option');
  });
});
