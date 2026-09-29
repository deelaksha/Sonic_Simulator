import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/feature";
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

describe("sonic-cli feature (config-plane)", () => {
  it("stores feature state + autorestart and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "feature state nat enabled").stack;
    s = run(state, device, s, "feature autorestart nat disabled").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show feature status").text;
    expect(out).toContain("Feature");
    expect(out).toContain("nat");
    expect(out).toContain("enabled");
    expect(out).toContain("disabled");
  });

  it("show feature autorestart renders the autorestart column", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "feature autorestart bgp enabled").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show feature autorestart").text;
    expect(out).toContain("AutoRestart");
    expect(out).toContain("bgp");
    expect(out).toContain("enabled");
  });

  it("no feature <name> clears the stored config", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "feature state stp enabled");
    run(state, device, s, "no feature stp");
    expect(run(state, device, ["exec"], "show feature status").text).toContain("No features configured");
  });

  it("rejects an invalid state value", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "feature state nat bogus").text).toContain("must be one of");
  });
});
