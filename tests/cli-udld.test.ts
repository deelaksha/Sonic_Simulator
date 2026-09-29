import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/udld";
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

describe("sonic-cli udld (config-plane)", () => {
  it("stores global enable/aggressive/message-time/multiplier and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "udld enable").stack;
    s = run(state, device, s, "udld aggressive").stack;
    s = run(state, device, s, "udld message-time 3").stack;
    s = run(state, device, s, "udld multiplier 8").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show udld global").text;
    expect(text).toContain("UDLD Enabled");
    expect(text).toContain("Aggressive");
    expect(text).toContain("3 seconds");
    expect(text).toMatch(/UDLD Multiplier\s+:\s+8/);
  });

  it("no udld enable clears the global admin state", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "udld enable");
    run(state, device, s, "no udld enable");
    expect(run(state, device, ["exec"], "show udld global").text).toContain("UDLD Disabled");
  });

  it("interface-level udld enable is stored and shown per port", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Ethernet 0").stack;
    s = run(state, device, s, "udld enable").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show udld interface Ethernet0").text;
    expect(text).toContain("UDLD information for Ethernet0");
    expect(text).toMatch(/UDLD Admin State:\s+Enabled/);
  });

  it("rejects an out-of-range message-time", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "udld message-time 99").text).toContain("message-time must be an integer in 1..30");
  });
});
