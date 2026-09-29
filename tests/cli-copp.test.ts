import "../lib/commands/sonic-cli/features/copp"; // side-effect: registers the copp modal handler
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

describe("sonic-cli copp modal CLI", () => {
  it("copp-action creates an action group, reflected by `show copp actions`", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "copp-action myaction", "exit"]);
    const show = execute("show copp actions", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("CoPP action group myaction");
  });

  it("no copp-action deletes a single group, leaving the others", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "copp-action a1", "copp-action a2", "no copp-action a1", "exit"]);
    const show = execute("show copp actions", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("CoPP action group a2");
    expect(show).not.toContain("CoPP action group a1");
  });

  it("copp-action emits the Click create message and does not enter a sub-view (stays in config)", () => {
    const { state, device } = sw();
    const r = runSonicCli("copp-action foo", ["exec", "config"], ctxFor(state, device));
    expect(r.output.map((o) => o.text).join("\n")).toContain("CoPP action group foo created");
    expect(r.stack).toEqual(["exec", "config"]); // sub-view entry is deferred
  });

  it("copp-action without a name is rejected", () => {
    const { state, device } = sw();
    const r = runSonicCli("copp-action", ["exec", "config"], ctxFor(state, device));
    expect(r.output.some((o) => o.kind === "error")).toBe(true);
  });
});
