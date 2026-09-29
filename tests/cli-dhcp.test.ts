import { describe, it, expect } from "vitest";
import "../lib/commands/sonic-cli/features/dhcp"; // register the dhcp modal handler
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface DhcpRelayState {
  relays: Record<string, string[]>;
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

function relays(device: Device): Record<string, string[]> {
  return peekFeatureState<DhcpRelayState>(device, "dhcp")?.relays ?? {};
}

describe("sonic-cli dhcp-relay modal CLI", () => {
  it("ip dhcp-relay <ip> adds a helper address on an interface (state + show)", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "ip dhcp-relay 3.3.3.3",
      "exit",
      "exit",
    ]);
    expect(relays(device)["Ethernet0"]).toEqual(["3.3.3.3"]);
    const show = execute("show dhcp-relay", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("Ethernet0");
    expect(show).toContain("3.3.3.3");
  });

  it("ip dhcp-relay <ip> <ip> adds multiple helper addresses in order", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 1",
      "ip dhcp-relay 10.0.0.1 10.0.0.2",
      "exit",
      "exit",
    ]);
    expect(relays(device)["Ethernet1"]).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("no ip dhcp-relay <ip> removes a previously configured helper address", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 2",
      "ip dhcp-relay 8.8.8.8",
      "no ip dhcp-relay 8.8.8.8",
      "exit",
      "exit",
    ]);
    // Click deletes the interface key once its helper list is empty.
    expect(relays(device)["Ethernet2"]).toBeUndefined();
  });

  it("unsupported suboptions fall through and never corrupt relay state", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 3",
      "ip dhcp-relay source-interface Ethernet1",
      "exit",
      "exit",
    ]);
    // "source-interface" must NOT be recorded as a bogus helper address.
    expect(relays(device)["Ethernet3"]).toBeUndefined();
  });
});
