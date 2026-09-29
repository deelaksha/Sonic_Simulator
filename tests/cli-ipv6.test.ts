import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/ipv6";
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";
import { normalizeIpv6 } from "../lib/models/ipv6";

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
function session(state: NetworkState, device: Device, start: CliStack, lines: string[]): { stack: CliStack; text: string; toBash: boolean } {
  let stack = start;
  let toBash = false;
  const out: string[] = [];
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    out.push(...r.output.map((o) => o.text));
    stack = r.toBash ? [] : r.stack;
    if (r.toBash) toBash = true;
  }
  return { stack, text: out.join("\n"), toBash };
}

describe("sonic-cli ipv6 modal CLI", () => {
  it("ipv6 address assigns a v6 address to a physical interface (via Click)", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "ipv6 address 2001:db8::1/64",
      "exit",
      "exit",
    ]);
    const eth0 = device.interfaces.find((i) => i.name === "Ethernet0");
    expect(eth0?.ipv6.length).toBe(1);
    expect(eth0?.ipv6[0]).toEqual({ address: normalizeIpv6("2001:db8::1"), prefix: 64 });
    // A delegated show reflects the new address.
    const show = runSonicCli("show ipv6 interfaces", ["exec"], ctxFor(state, device));
    const text = show.output.map((o) => o.text).join("\n");
    expect(text).toContain("Ethernet0");
    expect(text).toContain("/64");
  });

  it("no ipv6 address removes the v6 address (via Click)", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 1",
      "ipv6 address 2001:db8:1::1/64",
      "no ipv6 address 2001:db8:1::1/64",
      "exit",
      "exit",
    ]);
    const eth1 = device.interfaces.find((i) => i.name === "Ethernet1");
    expect(eth1?.ipv6.length).toBe(0);
  });

  it("invalid ipv6 address surfaces the real Click usage error, not a fake one", () => {
    const { state, device } = sw();
    const { text } = session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "ipv6 address 10.0.0.1/24",
    ]);
    expect(text).toContain("Usage: config interface ipv6 add <port> <ipv6>/<prefix>");
    expect(device.interfaces.find((i) => i.name === "Ethernet0")?.ipv6.length).toBe(0);
  });

  it("unsupported ipv6 subcommands fall through to the grammar (not delegated)", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "interface Ethernet 0"]);
    const r = runSonicCli("ipv6 enable", ["exec", "config", "if-Ethernet0"], ctxFor(state, device));
    const text = r.output.map((o) => o.text).join("\n");
    // Recognized in the grammar but not the address command: accepted config-plane
    // (silent), NOT delegated to Click — so it must not add an IPv6 address.
    expect(text).not.toContain("Usage");
    expect(r.output.some((o) => o.kind === "error")).toBe(false);
    expect(device.interfaces.find((i) => i.name === "Ethernet0")?.ipv6.length).toBe(0);
  });
});
