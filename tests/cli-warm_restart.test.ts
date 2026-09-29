import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/warm_restart";
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

describe("sonic-cli warm-restart (config-plane)", () => {
  it("stores bgp enable / timer / eoiu and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "warm-restart bgp enable").stack;
    s = run(state, device, s, "warm-restart bgp eoiu").stack;
    s = run(state, device, s, "warm-restart bgp timer 60").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show warm-restart config").text;
    expect(out).toContain("bgp");
    expect(out).toContain("60");
    expect(out).toContain("EOIU");
  });

  it("stores swss / teamd / system settings and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "warm-restart swss timer 3600").stack;
    s = run(state, device, s, "warm-restart teamd enable").stack;
    s = run(state, device, s, "warm-restart system").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show warm-restart").text;
    expect(out).toContain("swss");
    expect(out).toContain("3600");
    expect(out).toContain("teamd");
    expect(out).toContain("system");
  });

  it("no warm-restart bgp timer clears just the timer", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "warm-restart bgp enable").stack;
    s = run(state, device, s, "warm-restart bgp timer 60").stack;
    s = run(state, device, s, "no warm-restart bgp timer").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show warm-restart config").text;
    expect(out).toContain("bgp");
    expect(out).not.toContain("60");
  });

  it("rejects a bgp timer outside 1..3600", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "warm-restart bgp timer 5000").text).toContain("must be an integer 1..3600");
  });
});
