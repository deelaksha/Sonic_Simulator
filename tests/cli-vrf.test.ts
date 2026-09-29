import "../lib/commands/sonic-cli/features/vrf"; // register the VRF modal handler
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface Vrf {
  name: string;
  interfaces: string[];
}

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

/** Run a sequence of modal lines, threading the mode stack; return combined text. */
function session(state: NetworkState, device: Device, start: CliStack, lines: string[]): { stack: CliStack; text: string } {
  let stack = start;
  const out: string[] = [];
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    out.push(...r.output.map((o) => o.text));
    stack = r.toBash ? [] : r.stack;
  }
  return { stack, text: out.join("\n") };
}

function vrfs(device: Device): Vrf[] {
  return peekFeatureState<{ vrfs: Vrf[] }>(device, "vrf")?.vrfs ?? [];
}

describe("sonic-cli VRF modal CLI", () => {
  it("creates a data VRF in config mode (ip vrf <name>), matching vrf.xml", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "ip vrf Vrf_red", "exit"]);
    expect(vrfs(device).map((v) => v.name)).toEqual(["Vrf_red"]);
    // A delegated `show vrf` reflects the new VRF.
    const show = execute("show vrf", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("Vrf_red");
  });

  it("no ip vrf deletes a VRF", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "ip vrf Vrf_red", "ip vrf Vrf_blue", "no ip vrf Vrf_red", "exit"]);
    expect(vrfs(device).map((v) => v.name)).toEqual(["Vrf_blue"]);
  });

  it("ip vrf mgmt creates the management VRF", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "ip vrf mgmt", "exit"]);
    expect(vrfs(device).map((v) => v.name)).toEqual(["mgmt"]);
  });

  it("ip vrf forwarding binds an interface to a VRF; no ... unbinds", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "ip vrf Vrf_red",
      "interface Ethernet 0",
      "ip vrf forwarding Vrf_red",
      "exit",
      "exit",
    ]);
    expect(vrfs(device).find((v) => v.name === "Vrf_red")?.interfaces).toEqual(["Ethernet0"]);

    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "no ip vrf forwarding Vrf_red",
      "exit",
      "exit",
    ]);
    expect(vrfs(device).find((v) => v.name === "Vrf_red")?.interfaces).toEqual([]);
  });
});
