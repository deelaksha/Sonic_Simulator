import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface AaaState {
  loginMethods: string[];
  failthrough: boolean;
  fallback: boolean;
}

function build(): NetworkState {
  resetMacCounter(1);
  resetIds();
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { devices: { sw1 }, connections: [] };
}

function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (sim: Simulation) => T): { value: T; events: SimEvent[] } {
      const sim = new Simulation(state);
      const value = fn(sim);
      captures.push(...sim.captures);
      return { value, events: sim.events };
    },
  };
}

const textOf = (r: { output: { text: string }[] }) => r.output.map((o) => o.text).join("\n");

describe("SONiC AAA feature (source: aaa.txt)", () => {
  it("show aaa renders all-default state initially", () => {
    const state = build();
    const text = textOf(execute("show aaa", ctxFor(state, state.devices.sw1)));
    expect(text).toContain("AAA Authentication Information");
    expect(text).toContain("failthrough : disabled (default)");
    expect(text).toContain("fallback : disabled (default)");
    expect(text).toContain("login-method : local (default)");
  });

  it("config aaa authentication login sets an ordered method-list that show reflects", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config aaa authentication login radius local", ctxFor(state, sw));
    expect(peekFeatureState<AaaState>(sw, "aaa")?.loginMethods).toEqual(["radius", "local"]);
    expect(textOf(execute("show aaa", ctxFor(state, sw)))).toContain("login-method : radius, local");
  });

  it("config aaa authentication login default resets to local", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config aaa authentication login radius local", ctxFor(state, sw));
    execute("config aaa authentication login default", ctxFor(state, sw));
    expect(peekFeatureState<AaaState>(sw, "aaa")?.loginMethods).toEqual([]);
    expect(textOf(execute("show aaa", ctxFor(state, sw)))).toContain("login-method : local (default)");
  });

  it("failthrough enable/disable is reflected by show (sudo passthrough)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("sudo config aaa authentication failthrough enable", ctxFor(state, sw));
    expect(textOf(execute("show aaa", ctxFor(state, sw)))).toContain("failthrough : enabled");
    execute("config aaa authentication failthrough disable", ctxFor(state, sw));
    expect(textOf(execute("show aaa", ctxFor(state, sw)))).toContain("failthrough : disabled (default)");
  });

  it("fallback enable is reflected by show", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config aaa authentication fallback enable", ctxFor(state, sw));
    expect(textOf(execute("show aaa", ctxFor(state, sw)))).toContain("fallback : enabled");
  });

  it("rejects a tacacs+ login method when no passkey exists (TC-4/TC-5)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config aaa authentication login tacacs+ local", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(textOf(res)).toContain("is not allowed when passkey not exists");
    // rejected config must not mutate stored state
    expect(peekFeatureState<AaaState>(sw, "aaa")?.loginMethods).toEqual([]);
  });

  it("rejects an invalid failthrough enum (TC-16)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config aaa authentication failthrough foobar", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(textOf(res)).toContain('Invalid input detected at "^" marker.');
  });
});
