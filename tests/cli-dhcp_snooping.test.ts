import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/dhcp_snooping";
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

describe("sonic-cli ip dhcp snooping (config-plane)", () => {
  it("stores global enable + vlan and renders them on show", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip dhcp snooping").stack;
    s = run(state, device, s, "ip dhcp snooping Vlan10,20").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show ip dhcp snooping").text;
    expect(out).toContain("DHCP snooping is Enabled");
    expect(out).toContain("Vlan10,20");
  });

  it("marks a port trusted from interface view and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Ethernet 0").stack;
    s = run(state, device, s, "ip dhcp snooping trust").stack;
    s = run(state, device, s, "end").stack;
    const out = run(state, device, s, "show ip dhcp snooping").text;
    expect(out).toContain("Ethernet0");
    expect(out).toContain("Yes");
  });

  it("no ip dhcp snooping clears the global enable", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ip dhcp snooping");
    run(state, device, s, "no ip dhcp snooping");
    expect(run(state, device, ["exec"], "show ip dhcp snooping").text).toContain("DHCP snooping is Disabled");
  });

  it("rejects an invalid verify subcommand", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ip dhcp snooping verify bogus").text).toContain("Only 'verify mac-address' is supported");
  });
});
