import "../lib/commands/sonic-cli/features/pbo";
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

describe("sonic-cli PBO (dynamic port breakout) modal CLI", () => {
  it("breaks out a port via `pbo port <p> mode <m>` and reflects it in show pbo", () => {
    const { state, device } = sw();
    const res = session(state, device, ["exec"], ["configure terminal", "pbo port 1/2 mode 4x200G", "exit"]);
    // Success note comes straight from the Click pbo module.
    expect(res.text).toContain("Breakout on port 1/2 set to 4x200G");
    const show = execute("show pbo", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("1/2");
    expect(show).toContain("4x200G");
    expect(res.stack).toEqual(["exec"]);
  });

  it("passes num-lanes through to the Click command", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "pbo port 1/3 mode 2x50G num-lanes 4", "exit"]);
    const show = execute("show pbo port 1/3", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("2x50G");
    expect(show).toMatch(/Num Lanes\s*:\s*4/);
  });

  it("`no pbo port <p>` resets the breakout", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "pbo port 1/4 mode 4x100G", "no pbo port 1/4", "exit"]);
    const show = execute("show pbo", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("No breakout configured");
  });
});
