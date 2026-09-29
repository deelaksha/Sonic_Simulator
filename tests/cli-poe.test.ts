import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/poe";
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
function session(state: NetworkState, device: Device, start: CliStack, lines: string[]): { stack: CliStack; text: string } {
  let stack = start;
  const out: string[] = [];
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    out.push(...r.output.map((o) => o.text));
    stack = r.toBash ? [] : r.stack;
  }
  return { stack, text: out.join("\n") };
}
function show(state: NetworkState, device: Device, cmd: string): string {
  return runSonicCli(cmd, ["exec"], ctxFor(state, device)).output.map((o) => o.text).join("\n");
}

describe("sonic-cli poe (config-plane)", () => {
  it("stores global PoE config and shows it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "poe power management dynamic",
      "poe usage-threshold 90",
      "poe auto-reset",
      "exit",
    ]);
    const text = show(state, device, "show poe");
    expect(text).toContain("dynamic");
    expect(text).toContain("90");
    expect(text).toContain("Auto Reset Mode");
    expect(text).toContain("Enable");
  });

  it("stores per-interface PoE config and shows it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "poe disable",
      "poe priority high",
      "poe power-limit 4000",
      "exit",
      "exit",
    ]);
    const text = show(state, device, "show poe port configuration all");
    expect(text).toContain("Ethernet0");
    expect(text).toContain("Disable");
    expect(text).toContain("Priority");
    expect(text).toContain("high");
    expect(text).toContain("4000");
  });

  it("no poe clears per-interface config", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "poe priority high",
      "poe disable",
      "no poe priority",       // clear a single setting
      "exit",
      "exit",
    ]);
    let text = show(state, device, "show poe port configuration all");
    expect(text).not.toContain("high");
    expect(text).toContain("Disable"); // other setting remains

    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "no poe",                // clear all PoE config on the port
      "exit",
      "exit",
    ]);
    text = show(state, device, "show poe port configuration all");
    expect(text).toContain("No PoE port configuration");
  });

  it("rejects invalid values", () => {
    const { state, device } = sw();
    const port = session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "poe priority bogus",
    ]);
    expect(port.text).toContain("priority must be one of");

    const global = session(state, device, ["exec"], [
      "configure terminal",
      "poe usage-threshold 200",
    ]);
    expect(global.text).toContain("usage-threshold must be an integer 1..99");
  });
});
