import { describe, it, expect } from "vitest";
import "../lib/commands/sonic-cli/features/qospfc"; // side-effect: registers the qospfc handlers
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
function session(state: NetworkState, device: Device, lines: string[]): { stack: CliStack; text: string } {
  let stack: CliStack = ["exec"];
  const out: string[] = [];
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    out.push(...r.output.map((o) => o.text));
    stack = r.toBash ? [] : r.stack;
  }
  return { stack, text: out.join("\n") };
}

type PfcState = {
  pfcwd?: { pollInterval?: number };
  interfaces?: Record<string, { asymmetric?: boolean; priorities?: number[] }>;
};
const pfc = (device: Device): PfcState => (device.config.features?.pfc ?? {}) as PfcState;

describe("sonic-cli qospfc (PFC / PFC-watchdog) modal", () => {
  it("priority-flow-control priority <dot1p> adds/removes a lossless priority (configure-if-view)", () => {
    const { state, device } = sw();
    session(state, device, [
      "configure terminal",
      "interface Ethernet 0",
      "priority-flow-control priority 3",
      "exit",
      "exit",
    ]);
    expect(pfc(device).interfaces?.Ethernet0?.priorities).toEqual([3]);

    session(state, device, [
      "configure terminal",
      "interface Ethernet 0",
      "no priority-flow-control priority 3",
      "exit",
      "exit",
    ]);
    expect(pfc(device).interfaces?.Ethernet0?.priorities).toEqual([]);
  });

  it("priority-flow-control asymmetric stores state and emits the platform-unsupported warning", () => {
    const { state, device } = sw();
    const on = session(state, device, [
      "configure terminal",
      "interface Ethernet 1",
      "priority-flow-control asymmetric",
      "exit",
      "exit",
    ]);
    expect(pfc(device).interfaces?.Ethernet1?.asymmetric).toBe(true);
    // §32: stored in CONFIG_DB but not applied by this platform/SAI (Click's own warning).
    expect(on.text).toMatch(/not supported by this platform/);

    session(state, device, [
      "configure terminal",
      "interface Ethernet 1",
      "no priority-flow-control asymmetric",
      "exit",
      "exit",
    ]);
    expect(pfc(device).interfaces?.Ethernet1?.asymmetric).toBe(false);
  });

  it("priority-flow-control watchdog polling-interval sets the global poll interval (configure-view)", () => {
    const { state, device } = sw();
    session(state, device, ["configure terminal", "priority-flow-control watchdog polling-interval 200", "exit"]);
    expect(pfc(device).pfcwd?.pollInterval).toBe(200);
  });

  it("an out-of-range priority is rejected by the Click command", () => {
    const { state, device } = sw();
    const r = runSonicCli("priority-flow-control priority 9", ["exec", "config", "if-Ethernet2"], ctxFor(state, device));
    expect(r.output.some((o) => /invalid priority 9 \(valid range 0-7\)/.test(o.text))).toBe(true);
    expect(pfc(device).interfaces?.Ethernet2?.priorities ?? []).toEqual([]);
  });
});
