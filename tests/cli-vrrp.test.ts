import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/vrrp";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, cliPrompt, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

// A switch names its ports Ethernet0.. (routers use eth0..), so VRRP — which is
// entered from a physical interface view — is tested on a switch.
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
    runSim<T>(fn: (s: Simulation) => T): { value: T; events: SimEvent[] } {
      const s = new Simulation(state);
      return { value: fn(s), events: s.events };
    },
  };
}
function session(state: NetworkState, device: Device, lines: string[]): { stack: CliStack; prompts: string[] } {
  let stack: CliStack = ["exec"];
  const prompts: string[] = [];
  for (const l of lines) {
    prompts.push(cliPrompt(stack, "sw1"));
    const r = runSonicCli(l, stack, ctxFor(state, device));
    stack = r.toBash ? [] : r.stack;
  }
  return { stack, prompts };
}

interface VrrpInstance {
  iface: string;
  vrid: number;
  vip?: string;
  priority?: number;
  preempt?: boolean;
  version?: number;
}
function instances(device: Device): VrrpInstance[] {
  return (device.config.features?.vrrp as { instances?: VrrpInstance[] } | undefined)?.instances ?? [];
}

describe("sonic-cli VRRP sub-mode", () => {
  it("vrrp <vrid> address-family ipv4 creates the instance and enters the sub-view", () => {
    const { state, device } = sw();
    const { prompts } = session(state, device, ["configure terminal", "interface Ethernet 0", "vrrp 1 address-family ipv4", "priority 120"]);
    // the instance was created on Ethernet0 (priority 120 also applied inside the sub-view)
    expect(instances(device)).toHaveLength(1);
    expect(instances(device)[0]).toMatchObject({ iface: "Ethernet0", vrid: 1 });
    // the prompt before `priority 120` is the VRRP IPv4 sub-view
    expect(prompts.some((p) => p.includes("vrrp-ipv4"))).toBe(true);
  });

  it("priority / vip / version apply inside the sub-view", () => {
    const { state, device } = sw();
    session(state, device, [
      "configure terminal",
      "interface Ethernet 0",
      "vrrp 1 address-family ipv4",
      "priority 120",
      "vip 40.0.0.5",
      "version 3",
      "exit",
      "exit",
      "exit",
    ]);
    expect(instances(device)[0]).toMatchObject({ iface: "Ethernet0", vrid: 1, priority: 120, vip: "40.0.0.5", version: 3 });
  });

  it("preempt / no preempt toggle preemption", () => {
    const { state, device } = sw();
    session(state, device, ["configure terminal", "interface Ethernet 1", "vrrp 2 address-family ipv4", "no preempt"]);
    expect(instances(device)[0]).toMatchObject({ iface: "Ethernet1", vrid: 2, preempt: false });
    session(state, device, ["configure terminal", "interface Ethernet 1", "vrrp 2 address-family ipv4", "preempt"]);
    expect(instances(device)[0]).toMatchObject({ iface: "Ethernet1", vrid: 2, preempt: true });
  });

  it("no vrrp <vrid> address-family ipv4 deletes the instance from the interface view", () => {
    const { state, device } = sw();
    session(state, device, [
      "configure terminal",
      "interface Ethernet 0",
      "vrrp 1 address-family ipv4",
      "exit", // sub-view -> if-view
      "no vrrp 1 address-family ipv4",
    ]);
    expect(instances(device)).toHaveLength(0);
  });
});
