import "../lib/commands/sonic-cli/features/aaa"; // register the AAA modal handler
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
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

const showAaa = (state: NetworkState, device: Device): string =>
  execute("show aaa", ctxFor(state, device)).output.map((o) => o.text).join("\n");

describe("sonic-cli AAA modal CLI", () => {
  it("aaa authentication login default sets the login method-list", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "aaa authentication login default group radius local",
      "exit",
    ]);
    expect(showAaa(state, device)).toMatch(/login-method : radius, local/);
  });

  it("aaa authentication failthrough enable/disable toggles fail-through", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "aaa authentication failthrough enable", "exit"]);
    expect(showAaa(state, device)).toMatch(/failthrough : enabled/);
    session(state, device, ["exec"], ["configure terminal", "aaa authentication failthrough disable", "exit"]);
    expect(showAaa(state, device)).toMatch(/failthrough : disabled/);
  });

  it("no aaa authentication login default resets the method-list to local", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "aaa authentication login default group radius local",
      "no aaa authentication login default",
      "exit",
    ]);
    expect(showAaa(state, device)).toMatch(/login-method : local \(default\)/);
  });

  it("tacacs+ login method is rejected (no passkey) and leaves the default", () => {
    const { state, device } = sw();
    const r = session(state, device, ["exec"], [
      "configure terminal",
      "aaa authentication login default group tacacs+ local",
      "exit",
    ]);
    expect(r.text).toMatch(/passkey/);
    expect(showAaa(state, device)).toMatch(/login-method : local \(default\)/);
  });
});
