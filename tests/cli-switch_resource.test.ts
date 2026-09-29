import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/switch_resource";
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

describe("sonic-cli switch-resource (config-plane sub-mode)", () => {
  it("stores route-scale routes and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "switch-resource").stack;
    s = run(state, device, s, "route-scale routes max").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    expect(run(state, device, s, "show switch-resource route-scale").text).toContain("max");
  });

  it("stores ecmp-group partition and vlan-stacking, shows both", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "switch-resource").stack;
    s = run(state, device, s, "ecmp-group level-1-partition 512").stack;
    s = run(state, device, s, "vlan-stacking").stack;
    const text = run(state, device, s, "show switch-resource").text;
    expect(text).toContain("512");
    expect(text).toContain("Enabled");
  });

  it("no route-scale routes clears it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "switch-resource").stack;
    run(state, device, s, "route-scale routes max");
    run(state, device, s, "no route-scale routes");
    expect(run(state, device, ["exec"], "show switch-resource route-scale").text).toContain("No switch-resource configuration");
  });

  it("rejects an invalid ecmp-group partition size", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "switch-resource").stack;
    expect(run(state, device, s, "ecmp-group level-1-partition 999").text).toContain("level-1-partition size must be one of");
  });
});
