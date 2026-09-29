import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/sag";
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

describe("sonic-cli sag (static-anycast-gateway config-plane)", () => {
  it("stores the global anycast MAC + a per-Vlan IPv4 gateway and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip anycast-mac-address 00:22:33:44:55:66").stack;
    s = run(state, device, s, "ip anycast-address enable").stack;
    s = run(state, device, s, "interface Vlan3").stack;
    s = run(state, device, s, "ip anycast-address 30.30.1.1/24").stack;
    s = run(state, device, s, "exit").stack; // leave interface
    s = run(state, device, s, "exit").stack; // leave config
    const out = run(state, device, s, "show ip static-anycast-gateway").text;
    expect(out).toContain("00:22:33:44:55:66");
    expect(out).toContain("30.30.1.1/24");
    expect(out).toContain("Vlan3");
    expect(out).toContain("Total number of gateway: 1");
  });

  it("stores an IPv6 gateway only under the ipv6 show, not the ipv4 show", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Vlan5").stack;
    s = run(state, device, s, "ipv6 anycast-address 50::1/64").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    expect(run(state, device, s, "show ipv6 static-anycast-gateway").text).toContain("50::1/64");
    const v4 = run(state, device, s, "show ip static-anycast-gateway").text;
    expect(v4).not.toContain("50::1/64");
    expect(v4).toContain("Total number of gateway: 0");
  });

  it("no ip anycast-address <addr> clears the stored gateway", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "interface Vlan3").stack;
    s = run(state, device, s, "ip anycast-address 30.30.1.1/24").stack;
    s = run(state, device, s, "no ip anycast-address 30.30.1.1/24").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show ip static-anycast-gateway").text;
    expect(out).not.toContain("30.30.1.1/24");
    expect(out).toContain("No anycast gateways configured");
  });

  it("rejects an invalid anycast MAC address", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ip anycast-mac-address not-a-mac").text).toContain("Invalid MAC address");
  });
});
