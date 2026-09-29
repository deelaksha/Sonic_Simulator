import { describe, it, expect } from "vitest";
import "../lib/commands/sonic-cli/features/qoscounterpoll"; // side-effect: register the handler
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

type CounterState = { types: Record<string, { enabled: boolean; intervalMs?: number }> };

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

/** Run modal lines from config view, threading the mode stack; return combined text. */
function session(state: NetworkState, device: Device, lines: string[]): string {
  let stack: CliStack = ["exec"];
  const out: string[] = [];
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    out.push(...r.output.map((o) => o.text));
    stack = r.toBash ? [] : r.stack;
  }
  return out.join("\n");
}

function counter(device: Device): CounterState {
  return device.config.features?.counterpoll as CounterState;
}

describe("sonic-cli qos counterpoll (configure-view)", () => {
  it("counterpoll <type> disable/enable toggles status via Click", () => {
    const { state, device } = sw();
    const text = session(state, device, ["configure terminal", "counterpoll port disable"]);
    expect(counter(device).types.port.enabled).toBe(false);
    // untouched types keep the seeded (enabled) baseline
    expect(counter(device).types.queue.enabled).toBe(true);
    expect(text).toContain("counterpoll port disable");
    // re-enable
    session(state, device, ["configure terminal", "counterpoll port enable"]);
    expect(counter(device).types.port.enabled).toBe(true);
  });

  it("counterpoll <type> interval <ms> sets the interval independently of status", () => {
    const { state, device } = sw();
    const text = session(state, device, ["configure terminal", "counterpoll queue interval 100"]);
    expect(counter(device).types.queue.intervalMs).toBe(100);
    expect(counter(device).types.queue.enabled).toBe(true); // interval does not toggle status
    expect(text).toContain("counterpoll queue interval 100");
  });

  it("no counterpoll <type> disables that type (maps to Click disable)", () => {
    const { state, device } = sw();
    session(state, device, ["configure terminal", "no counterpoll rif"]);
    expect(counter(device).types.rif.enabled).toBe(false);
  });

  it("out-of-range interval is rejected with the Click error string", () => {
    const { state, device } = sw();
    const text = session(state, device, ["configure terminal", "counterpoll port interval 30001"]);
    expect(text).toContain('% Error: Invalid input detected at "^" marker.');
  });
});
