import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";

function build(): NetworkState {
  resetMacCounter(1);
  resetIds();
  const r1 = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 2 });
  return { devices: { r1 }, connections: [] };
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

const textOf = (res: { output: { text: string }[] }) => res.output.map((o) => o.text).join("\n");

describe("SONiC route-map feature (source: routemap.txt)", () => {
  it("show route-map is empty before any config (TC-1)", () => {
    const state = build();
    const r1 = state.devices.r1;
    const res = execute("show route-map", ctxFor(state, r1));
    expect(textOf(res)).toContain("No route-maps configured");
  });

  it("creates a route-map statement; show renders name/action/sequence (TC-3, TC-15)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route-map RMAP permit 5", ctxFor(state, r1));
    const res = execute("show route-map RMAP", ctxFor(state, r1));
    const text = textOf(res);
    expect(text).toContain("Route map RMAP:");
    expect(text).toContain("permit, sequence 5");
  });

  it("match and set clauses land in show route-map (TC-6, TC-22)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route-map rmap permit 20", ctxFor(state, r1));
    execute("config route-map rmap permit 20 match local-preference 40", ctxFor(state, r1));
    execute("config route-map rmap permit 20 match metric 12", ctxFor(state, r1));
    execute("config route-map rmap permit 20 set ip next-hop 15.10.10.3", ctxFor(state, r1));
    execute("config route-map rmap permit 20 set metric 75", ctxFor(state, r1));
    const text = textOf(execute("show route-map rmap", ctxFor(state, r1)));
    expect(text).toContain("Match clauses:");
    expect(text).toContain("local-preference 40");
    expect(text).toContain("metric 12");
    expect(text).toContain("Set clauses:");
    expect(text).toContain("ip next-hop 15.10.10.3");
    expect(text).toContain("metric 75");
  });

  it("re-setting a key replaces the previous value (TC-45 -> TC-46)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route-map AGENT_RM permit 10 set local-preference 250", ctxFor(state, r1));
    execute("config route-map AGENT_RM permit 10 set local-preference 999", ctxFor(state, r1));
    const text = textOf(execute("show route-map AGENT_RM", ctxFor(state, r1)));
    expect(text).toContain("local-preference 999");
    expect(text).not.toContain("local-preference 250");
  });

  it("no match / no set removes a clause by key (TC-7 delete block)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route-map rmap permit 20 match metric 12", ctxFor(state, r1));
    execute("config route-map rmap permit 20 set weight 2400", ctxFor(state, r1));
    execute("config route-map rmap permit 20 no set weight", ctxFor(state, r1));
    execute("config route-map rmap permit 20 no match metric", ctxFor(state, r1));
    const text = textOf(execute("show route-map rmap", ctxFor(state, r1)));
    expect(text).not.toContain("weight 2400");
    expect(text).not.toContain("metric 12");
  });

  it("deny action is honored (TC-17, TC-18)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route-map AGENT_DENY deny 30", ctxFor(state, r1));
    const text = textOf(execute("show route-map AGENT_DENY", ctxFor(state, r1)));
    expect(text).toContain("deny, sequence 30");
    expect(text).not.toContain("permit, sequence 30");
  });

  it("rejects a sequence outside 1-65535 (TC-49, TC-50)", () => {
    const state = build();
    const r1 = state.devices.r1;
    const hi = execute("config route-map AGENT_NEG permit 65536", ctxFor(state, r1));
    const lo = execute("config route-map AGENT_NEG permit 0", ctxFor(state, r1));
    expect(hi.output.some((o) => o.kind === "error")).toBe(true);
    expect(lo.output.some((o) => o.kind === "error")).toBe(true);
    // nothing partially applied
    expect(textOf(execute("show route-map AGENT_NEG", ctxFor(state, r1)))).toContain("not configured");
  });

  it("rejects an invalid action", () => {
    const state = build();
    const r1 = state.devices.r1;
    const res = execute("config route-map RMAP allow 5", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("per-statement delete removes only that sequence (TC-60)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route-map AGENT_B permit 1", ctxFor(state, r1));
    execute("config route-map AGENT_B permit 65535", ctxFor(state, r1));
    execute("config route-map no AGENT_B permit 1", ctxFor(state, r1));
    const text = textOf(execute("show route-map AGENT_B", ctxFor(state, r1)));
    expect(text).not.toContain("sequence 1\n");
    expect(text).toContain("permit, sequence 65535");
  });

  it("whole-map delete removes the map; deleting an absent map is a silent no-op (TC-59, line 227)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route-map rmap permit 20 set metric 75", ctxFor(state, r1));
    execute("config route-map no rmap", ctxFor(state, r1));
    expect(textOf(execute("show route-map rmap", ctxFor(state, r1)))).toContain("not configured");
    const noop = execute("config route-map no DOES_NOT_EXIST", ctxFor(state, r1));
    expect(noop.output.some((o) => o.kind === "error")).toBe(false);
  });

  it("multiple maps coexist independently (TC-47, TC-48)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route-map AGENT_RM permit 10 set local-preference 999", ctxFor(state, r1));
    execute("config route-map AGENT_M permit 10 match tag 100", ctxFor(state, r1));
    execute("config route-map no AGENT_RM", ctxFor(state, r1));
    expect(textOf(execute("show route-map AGENT_RM", ctxFor(state, r1)))).toContain("not configured");
    const m = textOf(execute("show route-map AGENT_M", ctxFor(state, r1)));
    expect(m).toContain("Route map AGENT_M:");
    expect(m).toContain("tag 100");
  });
});
