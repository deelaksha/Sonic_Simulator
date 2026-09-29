import "../lib/commands/sonic-cli/features/fbs"; // side-effect: registers the FBS modal handler
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

const showText = (state: NetworkState, device: Device, cmd: string): string =>
  execute(cmd, ctxFor(state, device)).output.map((o) => o.text).join("\n");

describe("sonic-cli FBS modal CLI", () => {
  it("service-policy binds a policy-map to an interface (configure-if-view)", () => {
    const { state, device } = sw();
    // The policy-map create form enters an FBS sub-view (out of scope), so seed it via Click.
    execute("config fbs policy add p1 forwarding", ctxFor(state, device));
    const res = session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "service-policy type forwarding in p1",
      "exit",
      "exit",
    ]);
    expect(res.stack).toEqual(["exec"]);
    const show = showText(state, device, "show fbs bindings");
    expect(show).toContain("Ethernet0");
    expect(show).toContain("forwarding policy p1 at ingress");
  });

  it("no service-policy removes the binding (policy name resolved from state)", () => {
    const { state, device } = sw();
    execute("config fbs policy add p1 forwarding", ctxFor(state, device));
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 1",
      "service-policy type forwarding in p1",
      "no service-policy type forwarding in",
      "exit",
      "exit",
    ]);
    expect(showText(state, device, "show fbs bindings")).toContain("No FBS service-policy bindings configured");
  });

  it("no policy-map / no class-map delete FBS objects from configure-view", () => {
    const { state, device } = sw();
    execute("config fbs classifier add c1", ctxFor(state, device));
    execute("config fbs policy add p1 qos", ctxFor(state, device));
    const res = session(state, device, ["exec"], [
      "configure terminal",
      "no class-map c1",
      "no policy-map p1",
      "exit",
    ]);
    expect(res.text).toContain("FBS classifier c1 deleted");
    expect(res.text).toContain("FBS policy p1 deleted");
    expect(showText(state, device, "show fbs classifier")).toContain("No FBS classifiers configured");
    expect(showText(state, device, "show fbs policy")).toContain("No FBS policies configured");
  });

  it("service-policy with a missing policy name is rejected", () => {
    const { state, device } = sw();
    const r = runSonicCli("service-policy type forwarding in", ["exec", "config", "if-Ethernet0"], ctxFor(state, device));
    expect(r.output.some((o) => o.kind === "error")).toBe(true);
  });
});
