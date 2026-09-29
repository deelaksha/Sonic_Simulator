import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/storm_control";
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

describe("sonic-cli storm-control (config-plane)", () => {
  it("stores per-interface storm-control rates and shows them", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "storm-control broadcast 10000",
      "storm-control unknown-unicast 20000",
      "exit",
      "exit",
    ]);
    const text = show(state, device, "show storm-control");
    expect(text).toContain("Ethernet0");
    expect(text).toContain("broadcast");
    expect(text).toContain("10000");
    expect(text).toContain("unknown-unicast");
    expect(text).toContain("20000");
  });

  it("filters show storm-control interface to a single interface", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "storm-control broadcast 10000",
      "exit",
      "interface Ethernet 1",
      "storm-control unknown-multicast 30000",
      "exit",
      "exit",
    ]);
    const text = show(state, device, "show storm-control interface Ethernet 1");
    expect(text).toContain("Ethernet1");
    expect(text).toContain("30000");
    expect(text).not.toContain("Ethernet0");
    expect(text).not.toContain("10000");
  });

  it("no storm-control <type> clears that entry", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "storm-control broadcast 10000",
      "no storm-control broadcast",
      "exit",
      "exit",
    ]);
    const text = show(state, device, "show storm-control");
    expect(text).not.toContain("10000");
    expect(text).not.toContain("broadcast");
  });

  it("rejects an invalid storm-type", () => {
    const { state, device } = sw();
    const { text } = session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "storm-control bogus 10000",
    ]);
    expect(text).toContain("storm-type must be one of");
  });
});
