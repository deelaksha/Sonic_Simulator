import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/pim";
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

describe("sonic-cli pim (config-plane)", () => {
  it("stores global PIM config and renders it in show running-configuration pim", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip pim ecmp rebalance").stack;
    s = run(state, device, s, "ip pim join-prune-interval 70").stack;
    s = run(state, device, s, "ip pim keep-alive-timer 45").stack;
    s = run(state, device, s, "ip pim ssm prefix-list PL_SSM").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show running-configuration pim").text;
    expect(out).toContain("ip pim ecmp rebalance");
    expect(out).toContain("ip pim join-prune-interval 70");
    expect(out).toContain("ip pim keep-alive-timer 45");
    expect(out).toContain("ip pim ssm prefix-list PL_SSM");
  });

  it("stores per-interface PIM config keyed by interface", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Vlan100").stack;
    s = run(state, device, s, "ip pim sparse-mode").stack;
    s = run(state, device, s, "ip pim drpriority 10").stack;
    s = run(state, device, s, "ip pim hello 30").stack;
    const out = run(state, device, ["exec"], "show running-configuration pim").text;
    expect(out).toContain("interface Vlan100");
    expect(out).toContain("ip pim sparse-mode");
    expect(out).toContain("ip pim drpriority 10");
    expect(out).toContain("ip pim hello 30");
  });

  it("no ip pim clears a stored value", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ip pim join-prune-interval 70");
    expect(run(state, device, ["exec"], "show running-configuration pim").text).toContain("join-prune-interval 70");
    run(state, device, s, "no ip pim join-prune-interval");
    expect(run(state, device, ["exec"], "show running-configuration pim").text).toContain("No PIM configuration");
  });

  it("rejects a join-prune-interval outside the 60-600 range", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ip pim join-prune-interval 5").text).toContain("60-600");
  });
});
