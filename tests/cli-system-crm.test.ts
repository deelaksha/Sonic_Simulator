import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/system-crm";
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

describe("sonic-cli system-crm (config-plane)", () => {
  it("stores the polling interval and shows it in the summary", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "crm polling interval 300").stack;
    s = run(state, device, s, "exit").stack;
    expect(run(state, device, s, "show crm summary").text).toContain("300");
  });

  it("stores a threshold and renders it in the thresholds table", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "crm thresholds ipv4 route type percentage").stack;
    s = run(state, device, s, "crm thresholds ipv4 route high 85").stack;
    const out = run(state, device, ["exec"], "show crm thresholds").text;
    expect(out).toContain("ipv4_route");
    expect(out).toContain("percentage");
    expect(out).toContain("85");
  });

  it("no crm all clears every CRM configuration", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "crm polling interval 120").stack;
    s = run(state, device, s, "crm thresholds fdb high 90").stack;
    run(state, device, s, "no crm all");
    expect(run(state, device, ["exec"], "show crm summary").text).toContain("not configured");
    expect(run(state, device, ["exec"], "show crm thresholds").text).toContain("No CRM thresholds configured");
  });

  it("rejects an invalid threshold type", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "crm thresholds all type bogus").text).toContain("threshold type must be one of");
  });
});
