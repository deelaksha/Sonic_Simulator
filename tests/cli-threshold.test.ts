import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/threshold";
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

describe("sonic-cli threshold (config-plane)", () => {
  it("stores a device threshold and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "threshold device 80").stack;
    s = run(state, device, s, "exit").stack;
    expect(run(state, device, s, "show threshold device").text).toContain("Threshold: 80");
  });

  it("stores a per-interface priority-group threshold and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Ethernet0").stack;
    s = run(state, device, s, "threshold priority-group 5 headroom 57").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show threshold priority-group headroom").text;
    expect(out).toContain("Ethernet0");
    expect(out).toContain("Index: 5");
    expect(out).toContain("57%");
  });

  it("no threshold device clears it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "threshold device 80");
    run(state, device, s, "no threshold device");
    expect(run(state, device, ["exec"], "show threshold device").text).toContain("No device threshold configured");
  });

  it("rejects an out-of-range threshold value", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "threshold device 150").text).toContain("range 1-100");
    expect(run(state, device, ["exec"], "show threshold device").text).toContain("No device threshold configured");
  });
});
