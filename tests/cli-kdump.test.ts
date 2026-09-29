import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/kdump";
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

describe("sonic-cli kdump (config-plane)", () => {
  it("stores enable + memory + num-dumps and shows them via show kdump status", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "kdump enable").stack;
    s = run(state, device, s, "kdump memory 512M").stack;
    s = run(state, device, s, "kdump num-dumps 5").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show kdump status").text;
    expect(out).toContain("Enabled");
    expect(out).toContain("Memory Reserved: 512M");
    expect(out).toContain("Maximum number of Kernel Core files Stored: 5");
  });

  it("show kdump memory / num-dumps reflect the configured values", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "kdump memory 256M");
    run(state, device, s, "kdump num-dumps 3");
    expect(run(state, device, ["exec"], "show kdump memory").text).toContain("Memory Reserved: 256M");
    expect(run(state, device, ["exec"], "show kdump num-dumps").text).toContain("Maximum number of Kernel Core files Stored: 3");
  });

  it("no kdump memory clears the reserved memory", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "kdump memory 1024M");
    run(state, device, s, "no kdump memory");
    expect(run(state, device, ["exec"], "show kdump memory").text).toContain("not configured");
  });

  it("rejects an out-of-range num-dumps value", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "kdump num-dumps 15").text).toContain("num-dumps must be an integer 1..9");
  });
});
