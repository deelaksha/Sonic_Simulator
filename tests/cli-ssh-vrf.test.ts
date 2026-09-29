import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/ssh-vrf";
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

describe("sonic-cli ssh-vrf (config-plane)", () => {
  it("stores an SSH server VRF and shows it in `show ssh-server vrf all`", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ssh-server vrf Vrf2").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show ssh-server vrf all").text;
    expect(text).toContain("Vrf2");
    expect(text).toContain("enable");
  });

  it("shows a single VRF's status by name", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ssh-server vrf Vrf5");
    run(state, device, s, "ssh-server vrf Vrf34");
    const text = run(state, device, ["exec"], "show ssh-server vrf Vrf5").text;
    expect(text).toContain("Vrf5");
    expect(text).not.toContain("Vrf34");
  });

  it("no ssh-server vrf removes it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ssh-server vrf Vrf2");
    run(state, device, s, "no ssh-server vrf Vrf2");
    expect(run(state, device, ["exec"], "show ssh-server vrf all").text).toContain("No SSH server VRFs configured");
  });

  it("rejects `ssh-server vrf` with no VRF name", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ssh-server vrf").text).toContain("VRF name required");
  });
});
