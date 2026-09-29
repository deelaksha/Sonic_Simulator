import "../lib/commands/sonic-cli/features/lldp"; // side-effect: registers the LLDP modal handler
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { peekFeatureState } from "../lib/models/feature-state";
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

interface LldpPeek {
  enabled: boolean;
  transmit: boolean;
  receive: boolean;
  timer: number | undefined;
  multiplier: number | undefined;
  systemName: string | undefined;
  interfaces: Record<string, { enabled: boolean; transmit: boolean; receive: boolean }>;
}
const peek = (d: Device) => peekFeatureState<LldpPeek>(d, "lldp");

describe("sonic-cli LLDP modal config", () => {
  it("no lldp enable disables LLDP globally; lldp enable re-enables it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "no lldp enable", "exit"]);
    expect(peek(device)?.enabled).toBe(false);
    const show = execute("show lldp", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toMatch(/Admin state\s*:\s*disabled/);

    session(state, device, ["exec"], ["configure terminal", "lldp enable", "exit"]);
    expect(peek(device)?.enabled).toBe(true);
  });

  it("lldp timer / multiplier set global values; out-of-range timer is rejected", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "lldp timer 10", "lldp multiplier 6", "exit"]);
    expect(peek(device)?.timer).toBe(10);
    expect(peek(device)?.multiplier).toBe(6);

    // Out-of-range (grammar range is 5..254) is rejected by the delegated Click cmd and leaves 10 intact.
    const r = runSonicCli("lldp timer 3", ["exec", "config"], ctxFor(state, device));
    expect(r.output.some((o) => o.kind === "error")).toBe(true);
    expect(peek(device)?.timer).toBe(10);
  });

  it("lldp receive/transmit + system-name set global mode and name", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "no lldp transmit",
      "lldp system-name LabSwitch",
      "exit",
    ]);
    expect(peek(device)?.transmit).toBe(false);
    expect(peek(device)?.receive).toBe(true);
    expect(peek(device)?.systemName).toBe("LabSwitch");
    const show = execute("show lldp", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toMatch(/System name\s*:\s*LabSwitch/);
  });

  it("interface-level: no lldp enable disables LLDP on the port", () => {
    const { state, device } = sw();
    const res = session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "no lldp enable",
      "no lldp receive",
      "exit",
      "exit",
    ]);
    const port = peek(device)?.interfaces["Ethernet0"];
    expect(port?.enabled).toBe(false);
    expect(port?.receive).toBe(false);
    expect(res.stack).toEqual(["exec"]);
  });
});
