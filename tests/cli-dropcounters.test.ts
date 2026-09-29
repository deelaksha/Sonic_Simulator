import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/dropcounters";
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

describe("sonic-cli dropcounters (config-plane)", () => {
  it("stores a drop counter and renders it in the configuration table", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "dropcounters DEBUG_0").stack;
    s = run(state, device, s, "alias RX_LEGIT").stack;
    s = run(state, device, s, "group LEGIT").stack;
    s = run(state, device, s, "type PORT_INGRESS_DROPS").stack;
    s = run(state, device, s, "mirror Session1").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show dropcounters configuration").text;
    expect(out).toContain("DEBUG_0");
    expect(out).toContain("RX_LEGIT");
    expect(out).toContain("LEGIT");
    expect(out).toContain("PORT_INGRESS_DROPS");
    expect(out).toContain("Session1");
  });

  it("add-reason stores each reason on its own line", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "dropcounters DEBUG_1").stack;
    s = run(state, device, s, "add-reason SMAC_EQUALS_DMAC").stack;
    s = run(state, device, s, "add-reason INGRESS_VLAN_FILTER").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show dropcounters configuration").text;
    expect(out).toContain("SMAC_EQUALS_DMAC");
    expect(out).toContain("INGRESS_VLAN_FILTER");
  });

  it("no dropcounters deletes the counter", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "dropcounters DEBUG_0").stack;
    s = run(state, device, s, "exit").stack; // back to config-view
    run(state, device, s, "no dropcounters DEBUG_0");
    expect(run(state, device, ["exec"], "show dropcounters configuration").text).toContain("No drop counters configured");
  });

  it("rejects an invalid counter type", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "dropcounters DEBUG_0").stack;
    expect(run(state, device, s, "type BOGUS_DROPS").text).toContain("type must be one of");
  });
});
