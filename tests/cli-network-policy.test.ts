import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/network-policy";
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

describe("sonic-cli network-policy (config-plane sub-mode)", () => {
  it("stores voice and voice-signaling in a profile and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "network-policy profile 1").stack;
    s = run(state, device, s, "voice vlan 100 cos 4 dscp 20").stack;
    s = run(state, device, s, "voice-signaling vlan dot1p cos 3 dscp 10").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show network-policy").text;
    expect(text).toContain("network-policy profile 1");
    expect(text).toContain("voice vlan 100 cos 4 dscp 20");
    expect(text).toContain("voice-signaling vlan dot1p cos 3 dscp 10");
  });

  it("no network-policy profile clears the profile", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "network-policy profile 5").stack;
    s = run(state, device, s, "voice vlan 200 untagged").stack;
    s = run(state, device, s, "exit").stack; // back to configure-view
    run(state, device, s, "no network-policy profile 5");
    expect(run(state, device, ["exec"], "show network-policy").text).toContain("No network-policy profiles configured");
  });

  it("rejects a profile number outside 1-128", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "network-policy profile 200").text).toContain("must be 1-128");
  });

  it("rejects an invalid cos value", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "network-policy profile 2").stack;
    expect(run(state, device, s, "voice vlan 100 cos 9").text).toContain("cos value must be 0-7");
  });
});
