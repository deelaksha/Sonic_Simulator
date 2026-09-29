import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar, subViewFrame } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/subinterface";
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

// The subinterface sub-view is entered on the real box via `interface Ethernet 0.10`;
// the shared core `interface` handler rejects dotted names, so drive the sub-view
// directly through its real dispatch frame (the same one subViewFrame builds).
const subif = (name: string): CliStack => ["exec", "config", subViewFrame("configure-subif-view", name)];

describe("sonic-cli subinterface (config-plane)", () => {
  it("stores encapsulation/mtu/admin and renders both show variants", () => {
    const { state, device } = sw();
    const s = subif("Ethernet0.10");
    run(state, device, s, "encapsulation dot1q vlan-id 100");
    run(state, device, s, "mtu 2000");
    run(state, device, s, "no shutdown");

    const status = run(state, device, ["exec"], "show subinterfaces status").text;
    expect(status).toContain("Ethernet0.10");
    expect(status).toContain("100");
    expect(status).toContain("2000");
    expect(status).toContain("dot1q-encapsulation");

    const cfg = run(state, device, ["exec"], "show running-configuration subinterface").text;
    expect(cfg).toContain("interface Ethernet0.10");
    expect(cfg).toContain("encapsulation dot1q vlan-id 100");
    expect(cfg).toContain("mtu 2000");
    expect(cfg).toContain("no shutdown");
  });

  it("no encapsulation clears the stored vlan but keeps the mtu", () => {
    const { state, device } = sw();
    const s = subif("Ethernet0.10");
    run(state, device, s, "encapsulation dot1q vlan-id 100");
    run(state, device, s, "mtu 2000");
    run(state, device, s, "no encapsulation");

    const cfg = run(state, device, ["exec"], "show running-configuration subinterface").text;
    expect(cfg).not.toContain("encapsulation dot1q vlan-id");
    expect(cfg).toContain("mtu 2000");
  });

  it("rejects an out-of-range vlan id and stores nothing", () => {
    const { state, device } = sw();
    const s = subif("Ethernet0.10");
    expect(run(state, device, s, "encapsulation dot1q vlan-id 5000").text).toContain("VLAN ID must be 1-4094");
    expect(run(state, device, ["exec"], "show subinterfaces status").text).toContain("No subinterfaces configured");
  });

  it("shows nothing configured before anything is set", () => {
    const { state, device } = sw();
    expect(run(state, device, ["exec"], "show running-configuration subinterface").text).toContain("No subinterfaces configured");
  });
});
