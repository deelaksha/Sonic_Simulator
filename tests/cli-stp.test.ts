import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/stp";
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
function drive(state: NetworkState, device: Device, cmds: string[]): CliStack {
  let s: CliStack = ["exec"];
  for (const c of cmds) s = run(state, device, s, c).stack;
  return s;
}

describe("sonic-cli spanning-tree (config-plane clone)", () => {
  it("stores global params and renders them in running-configuration", () => {
    const { state, device } = sw();
    drive(state, device, [
      "configure terminal",
      "spanning-tree mode rapid-pvst",
      "spanning-tree forward-time 20",
      "spanning-tree priority 4096",
      "spanning-tree guard root timeout 10",
      "exit",
    ]);
    const out = run(state, device, ["exec"], "show running-configuration spanning-tree").text;
    expect(out).toContain("spanning-tree mode rapid-pvst");
    expect(out).toContain("spanning-tree forward-time 20");
    expect(out).toContain("spanning-tree priority 4096");
    expect(out).toContain("spanning-tree guard root timeout 10");
  });

  it("stores per-VLAN and per-interface config", () => {
    const { state, device } = sw();
    drive(state, device, [
      "configure terminal",
      "spanning-tree vlan 100 forward-time 5",
      "interface Ethernet 0",
      "spanning-tree cost 2",
      "spanning-tree bpdufilter enable",
      "exit",
      "exit",
    ]);
    const out = run(state, device, ["exec"], "show running-configuration spanning-tree").text;
    expect(out).toContain("spanning-tree vlan 100 forward-time 5");
    expect(out).toContain("interface Ethernet0");
    expect(out).toContain(" spanning-tree cost 2");
    expect(out).toContain(" spanning-tree bpdufilter enable");
  });

  it("no spanning-tree mode clears it and no spanning-tree vlan disables it", () => {
    const { state, device } = sw();
    drive(state, device, [
      "configure terminal",
      "spanning-tree mode pvst",
      "no spanning-tree mode",
      "no spanning-tree vlan 101",
      "exit",
    ]);
    const out = run(state, device, ["exec"], "show running-configuration spanning-tree").text;
    expect(out).not.toContain("spanning-tree mode");
    expect(out).toContain("no spanning-tree vlan 101");
  });

  it("rejects an out-of-range forward-time", () => {
    const { state, device } = sw();
    const s = drive(state, device, ["configure terminal"]);
    expect(run(state, device, s, "spanning-tree forward-time 99").text).toContain("value must be an integer 4-30");
  });
});
