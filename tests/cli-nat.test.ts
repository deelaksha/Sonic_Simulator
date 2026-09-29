import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/nat";
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
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (s: Simulation) => T) {
      const s = new Simulation(state);
      return { value: fn(s), events: s.events as SimEvent[] };
    },
  };
}

function run(state: NetworkState, device: Device, stack: CliStack, cmd: string): { stack: CliStack; text: string } {
  const r = runSonicCli(cmd, stack, ctxFor(state, device));
  return { stack: r.toBash ? [] : r.stack, text: r.output.map((o) => o.text).join("\n") };
}

describe("sonic-cli nat (config-plane)", () => {
  it("stores global values, a pool and a binding and renders them on show nat config", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "nat").stack;
    s = run(state, device, s, "enable").stack;
    s = run(state, device, s, "timeout 900").stack;
    s = run(state, device, s, "pool p1 65.55.45.1-65.55.45.5 100-200").stack;
    s = run(state, device, s, "binding b1 p1 acl1 snat").stack;
    const out = run(state, device, s, "show nat config").text;
    expect(out).toContain("enabled");
    expect(out).toContain("900");
    expect(out).toContain("p1");
    expect(out).toContain("65.55.45.1-65.55.45.5");
    expect(out).toContain("100-200");
    expect(out).toContain("b1");
    expect(out).toContain("acl1");
    expect(out).toContain("snat");
  });

  it("stores static NAT entries (basic and napt)", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "nat").stack;
    s = run(state, device, s, "static basic 65.55.42.1 10.0.0.1 dnat").stack;
    s = run(state, device, s, "static tcp 65.55.42.2 100 10.0.0.2 200").stack;
    const out = run(state, device, s, "show nat config static").text;
    expect(out).toContain("65.55.42.1");
    expect(out).toContain("10.0.0.1");
    expect(out).toContain("dnat");
    expect(out).toContain("tcp");
    expect(out).toContain("65.55.42.2");
    expect(out).toContain("100");
    expect(out).toContain("200");
  });

  it("no removes a pool and clears an interface nat-zone", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "nat").stack;
    s = run(state, device, s, "pool p1 65.55.45.1-65.55.45.5").stack;
    s = run(state, device, s, "no pool p1").stack;
    expect(run(state, device, s, "show nat config pool").text).toContain("No NAT pools configured");
    // nat-zone on a VLAN interface (VLAN names bypass the interface-exists check).
    s = run(state, device, s, "exit").stack; // leave NAT sub-view -> config
    s = run(state, device, s, "interface Vlan10").stack;
    s = run(state, device, s, "nat-zone 5").stack;
    const zones = run(state, device, s, "show nat config zones").text;
    expect(zones).toContain("Vlan10");
    expect(zones).toContain("5");
    s = run(state, device, s, "no nat-zone").stack;
    expect(run(state, device, s, "show nat config zones").text).toContain("No NAT zones configured");
  });

  it("rejects a non-numeric timeout and keeps the default", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "nat").stack;
    expect(run(state, device, s, "timeout abc").text).toContain("value must be a number");
    // Nothing was stored, so globalvalues still shows the default 600 secs.
    expect(run(state, device, s, "show nat config globalvalues").text).toContain("600");
  });
});
