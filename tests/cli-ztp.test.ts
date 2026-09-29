import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/ztp";
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

describe("sonic-cli ztp (config-plane)", () => {
  it("ztp enable stores admin mode and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ztp enable").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show ztp-status").text;
    expect(text).toContain("ZTP Admin Mode      : True");
  });

  it("no ztp enable disables the admin mode", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "no ztp enable");
    const text = run(state, device, ["exec"], "show ztp-status").text;
    expect(text).toContain("ZTP Admin Mode      : False");
  });

  it("shows the default status format on an unconfigured box", () => {
    const { state, device } = sw();
    const text = run(state, device, ["exec"], "show ztp-status").text;
    expect(text).toContain("ZTP");
    expect(text).toContain("ZTP Admin Mode      : True");
    expect(text).toContain("ZTP Status          : Not Started");
  });

  it("rejects an invalid ztp subcommand", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ztp bogus").text).toContain("Usage: [no] ztp enable");
  });
});
