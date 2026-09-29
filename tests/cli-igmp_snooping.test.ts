import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/igmp_snooping";
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

describe("sonic-cli ip igmp snooping (config-plane)", () => {
  it("stores per-VLAN snooping config and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Vlan 200").stack;
    s = run(state, device, s, "ip igmp snooping").stack;
    s = run(state, device, s, "ip igmp snooping querier").stack;
    s = run(state, device, s, "ip igmp snooping version 3").stack;
    s = run(state, device, s, "ip igmp snooping query-interval 20").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show ip igmp snooping").text;
    expect(out).toContain("Vlan ID: 200");
    expect(out).toContain("Querier: Enabled");
    expect(out).toContain("IGMP Operation mode: IGMPv3");
    expect(out).toContain("Query interval: 20");
    // untouched fields render documented defaults, not fabricated runtime data
    expect(out).toContain("Is Fast-Leave Enabled: Disabled");
    expect(out).toContain("Max Response time: 10");
  });

  it("no ip igmp snooping clears the VLAN entry", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Vlan 200").stack;
    s = run(state, device, s, "ip igmp snooping").stack;
    s = run(state, device, s, "no ip igmp snooping").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    expect(run(state, device, s, "show ip igmp snooping").text).toContain("not configured");
  });

  it("no ip igmp snooping query-interval resets the value to its default", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Vlan 200").stack;
    s = run(state, device, s, "ip igmp snooping query-interval 20").stack;
    s = run(state, device, s, "no ip igmp snooping query-interval").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    expect(run(state, device, s, "show ip igmp snooping vlan 200").text).toContain("Query interval: 125");
  });

  it("rejects an out-of-range IGMP version", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Vlan 200").stack;
    expect(run(state, device, s, "ip igmp snooping version 5").text).toContain("version must be 1, 2 or 3");
  });
});
