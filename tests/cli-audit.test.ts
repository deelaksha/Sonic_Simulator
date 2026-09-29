import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/audit";
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

describe("sonic-cli auditd-system (config-plane)", () => {
  it("stores a rules profile and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "auditd-system rules detail").stack;
    s = run(state, device, s, "exit").stack;
    const t = run(state, device, s, "show auditd-system rules").text;
    expect(t).toContain("Audit rules profile:  detail");
  });

  it("no auditd-system rules clears the profile", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "auditd-system rules basic");
    run(state, device, s, "no auditd-system rules");
    expect(run(state, device, ["exec"], "show auditd-system rules").text).toContain("No audit rules profile configured");
  });

  it("rejects an invalid rules profile", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "auditd-system rules bogus").text).toContain("profile must be one of");
  });

  it("stores the bare auditd-system global entry", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "auditd-system");
    expect(run(state, device, ["exec"], "show auditd-system").text).toContain("auditd-system: enabled");
  });
});
