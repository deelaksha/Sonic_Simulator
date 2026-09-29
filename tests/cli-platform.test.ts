import "../lib/commands/sonic-cli/features/platform"; // registers the handler
import { describe, it, expect } from "vitest";
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

describe("sonic-cli platform (show-only feature)", () => {
  it("delegates `show platform summary` from config mode, reflecting live device state", () => {
    const { state, device } = sw();
    const res = session(state, device, ["exec"], ["configure terminal", "show platform summary"]);
    // The summary is rendered by the tested Click command from live device fields.
    expect(res.text).toContain("Platform: networklab-sim");
    // Port count is derived live from the non-management interfaces (4 for ports:4).
    const ports = device.interfaces.filter((i) => !i.management).length;
    expect(res.text).toContain(`Ports: ${ports}`);
    expect(res.stack).toEqual(["exec", "config"]); // show does not leave config mode
  });

  it("passes hardware-only queries through to the honest SIMULATION LIMITATION notice", () => {
    const { state, device } = sw();
    const res = session(state, device, ["exec"], ["configure terminal", "show platform psustatus"]);
    // Matches the exact string from lib/commands/sonic/platform.ts (no faked PSU data).
    expect(res.text).toContain("SIMULATION LIMITATION: PSU status is hardware-specific and not modeled in the simulator.");
  });

  it("has no configure-view platform config: the handler declines and the line is rejected", () => {
    const { state, device } = sw();
    // `platform` is claimed by the handler but there is nothing to configure, so it
    // returns null and the engine reports the line as unrecognized in configure-view.
    const r = runSonicCli("platform something", ["exec", "config"], ctxFor(state, device));
    expect(r.output.some((o) => o.kind === "error")).toBe(true);
    expect(r.stack).toEqual(["exec", "config"]); // stays in config; nothing entered/changed
  });
});
