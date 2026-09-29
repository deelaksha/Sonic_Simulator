import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/dhcpv6_relay"; // register the dhcpv6_relay modal handlers
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

function show(state: NetworkState, device: Device, cmd: string): string {
  return runSonicCli(cmd, ["exec"], ctxFor(state, device)).output.map((o) => o.text).join("\n");
}

describe("sonic-cli dhcpv6_relay (config-plane)", () => {
  it("stores relay server addresses configured on a VLAN interface", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Vlan 100",
      "ipv6 dhcp-relay 2001::1 2001::2",
      "exit",
      "exit",
    ]);
    const text = show(state, device, "show ipv6 dhcp-relay");
    expect(text).toContain("Vlan100");
    expect(text).toContain("2001::1");
    expect(text).toContain("2001::2");
  });

  it("renders source-interface and max-hop-count under `show ... detailed`", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "ipv6 dhcp-relay 2001::10",
      "ipv6 dhcp-relay source-interface Ethernet1",
      "ipv6 dhcp-relay max-hop-count 9",
      "ipv6 dhcp-relay vrf-select",
    ]);
    const text = show(state, device, "show ipv6 dhcp-relay detailed");
    expect(text).toContain("Ethernet0");
    expect(text).toContain("Source Interface: Ethernet1");
    expect(text).toContain("Max Hop Count: 9");
    expect(text).toContain("VRF Selection: enabled");
  });

  it("`no ipv6 dhcp-relay` clears the stored relay addresses", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Vlan 100",
      "ipv6 dhcp-relay 2001::1",
      "no ipv6 dhcp-relay",
      "exit",
      "exit",
    ]);
    const text = show(state, device, "show ipv6 dhcp-relay");
    expect(text).toContain("No DHCPv6 relay configured");
    expect(text).not.toContain("2001::1");
  });

  it("rejects an out-of-range max-hop-count", () => {
    const { state, device } = sw();
    const { text } = session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "ipv6 dhcp-relay max-hop-count 99",
    ]);
    expect(text).toContain("max hop count must be an integer in 0..16");
  });
});
