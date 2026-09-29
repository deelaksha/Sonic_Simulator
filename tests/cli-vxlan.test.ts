import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar, subViewFrame } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/vxlan";
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

// The entry line `interface vxlan <name>` is normalised by the shared core before
// feature handlers run, so we enter the sub-view via the same generic frame the core
// produces (subViewFrame carries the VTEP name in as `viewctx`).
function enterVtep(state: NetworkState, device: Device, name: string): CliStack {
  let s: CliStack = ["exec"];
  s = run(state, device, s, "configure terminal").stack;
  return [...s, subViewFrame("configure-vxlan-view", name)];
}

describe("sonic-cli vxlan (config-plane)", () => {
  it("stores VTEP source-ip + qos-mode and renders show vxlan interface", () => {
    const { state, device } = sw();
    let s = enterVtep(state, device, "vtep1");
    s = run(state, device, s, "source-ip 1.1.1.1").stack;
    s = run(state, device, s, "qos-mode pipe dscp 5").stack;
    const out = run(state, device, s, "show vxlan interface").text;
    expect(out).toContain("vtep1");
    expect(out).toContain("1.1.1.1");
    expect(out).toContain("pipe (dscp:5)");
  });

  it("stores VNI maps and renders vlanvnimap / vrfvnimap with counts", () => {
    const { state, device } = sw();
    let s = enterVtep(state, device, "vtep1");
    s = run(state, device, s, "map vni 100 vlan 100 count 2").stack;
    s = run(state, device, s, "map vni 600 vrf Vrf1").stack;
    const vlan = run(state, device, s, "show vxlan vlanvnimap").text;
    expect(vlan).toContain("Vlan100");
    expect(vlan).toContain("Vlan101");
    expect(vlan).toContain("Total count : 2");
    const vrf = run(state, device, s, "show vxlan vrfvnimap").text;
    expect(vrf).toContain("Vrf1");
    expect(vrf).toContain("600");
  });

  it("`no source-ip` clears the stored source and `no map` removes a mapping", () => {
    const { state, device } = sw();
    let s = enterVtep(state, device, "vtep1");
    s = run(state, device, s, "source-ip 2.2.2.2").stack;
    s = run(state, device, s, "map vni 100 vlan 100").stack;
    s = run(state, device, s, "no source-ip").stack;
    s = run(state, device, s, "no map vni 100 vlan 100").stack;
    expect(run(state, device, s, "show vxlan interface").text).not.toContain("2.2.2.2");
    expect(run(state, device, s, "show vxlan vlanvnimap").text).toContain("No VLAN VNI mappings configured");
  });

  it("rejects an invalid qos-mode", () => {
    const { state, device } = sw();
    const s = enterVtep(state, device, "vtep1");
    expect(run(state, device, s, "qos-mode bogus").text).toContain("qos-mode must be uniform | pipe");
  });
});
