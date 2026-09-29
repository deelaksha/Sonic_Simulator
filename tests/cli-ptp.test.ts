import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/ptp";
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

describe("sonic-cli ptp (config-plane)", () => {
  it("stores clock config and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ptp mode boundary-clock").stack;
    s = run(state, device, s, "ptp domain 1").stack;
    s = run(state, device, s, "ptp priority1 128").stack;
    s = run(state, device, s, "ptp network-transport ipv4 unicast").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show ptp").text;
    expect(out).toContain("boundary-clock");
    expect(out).toMatch(/Domain Number\s+1/);
    expect(out).toMatch(/Priority1\s+128/);
    expect(out).toContain("ipv4 unicast");
  });

  it("adds a ptp port and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ptp port add Ethernet 64 role master").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show ptp port").text;
    expect(out).toContain("Ethernet64");
    expect(out).toContain("role master");
  });

  it("no ptp domain clears the stored value", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ptp domain 5");
    run(state, device, s, "no ptp domain");
    expect(run(state, device, ["exec"], "show ptp").text).toContain("No PTP configuration");
  });

  it("rejects an out-of-range domain", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ptp domain 200").text).toContain("must be an integer 0..127");
  });
});
