import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";

function build() {
  resetMacCounter(1);
  resetIds();
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  const state: NetworkState = { devices: { sw1 }, connections: [] };
  return state;
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

function text(res: { output: { text: string }[] }): string {
  return res.output.map((o) => o.text).join("\n");
}

describe("SONiC QoS feature (config-plane, path [qos])", () => {
  it("config qos map dscp-tc add persists and show reflects it", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config qos map dscp-tc add DSCP-TC1 3 5", ctxFor(state, sw));
    execute("sudo config qos map dscp-tc add DSCP-TC1 10 2", ctxFor(state, sw)); // sudo passthrough
    const out = text(execute("show qos map dscp-tc", ctxFor(state, sw)));
    expect(out).toContain("DSCP-TC-MAP: DSCP-TC1");
    expect(out).toContain("DSCP");
    expect(out).toContain("3");
    expect(out).toContain("5");
    expect(out).toContain("10");
  });

  it("re-adding the same dscp key updates (modify) rather than duplicating", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config qos map dscp-tc add M 3 5", ctxFor(state, sw));
    execute("config qos map dscp-tc add M 3 7", ctxFor(state, sw));
    const lines = execute("show qos map dscp-tc M", ctxFor(state, sw)).output.map((o) => o.text);
    const rows = lines.filter((l) => l.startsWith("3"));
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain("7");
  });

  it("rejects out-of-range dscp (>63) and tc (>7)", () => {
    const state = build();
    const sw = state.devices.sw1;
    // qos.txt TC-30: `dscp 64` rejected; TC-31: `traffic-class 8` rejected.
    const bad1 = execute("config qos map dscp-tc add M 64 1", ctxFor(state, sw));
    const bad2 = execute("config qos map dscp-tc add M 10 8", ctxFor(state, sw));
    expect(bad1.output.some((o) => o.kind === "error")).toBe(true);
    expect(bad2.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("config qos map tc-queue add and show", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config qos map tc-queue add TC-QUEUE1 3 2", ctxFor(state, sw));
    const out = text(execute("show qos map tc-queue", ctxFor(state, sw)));
    expect(out).toContain("Traffic-Class-Queue-MAP: TC-QUEUE1");
    expect(out).toContain("Queue");
    expect(out).toContain("3");
    expect(out).toContain("2");
  });

  it("scheduler-policy add renders queue/type/weight; strict needs no weight", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config qos scheduler-policy add SP1 5 dwrr 10", ctxFor(state, sw));
    execute("config qos scheduler-policy add SP1 0 strict", ctxFor(state, sw));
    const out = text(execute("show qos scheduler-policy SP1", ctxFor(state, sw)));
    expect(out).toContain("Scheduler Policy: SP1");
    expect(out).toContain("Queue: 5");
    expect(out).toContain("type: dwrr");
    expect(out).toContain("weight: 10");
    expect(out).toContain("Queue: 0");
    expect(out).toContain("type: strict");
  });

  it("scheduler-policy dwrr without weight is rejected", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config qos scheduler-policy add SP1 5 dwrr", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("wred-policy add renders per-color thresholds", () => {
    const state = build();
    const sw = state.devices.sw1;
    // qos.txt TC-2: green minimum-threshold 130 maximum-threshold 150 drop-probability 10.
    execute("config qos wred-policy add WP1 green 130 150 10", ctxFor(state, sw));
    const out = text(execute("show qos wred-policy", ctxFor(state, sw)));
    expect(out).toContain("Policy");
    expect(out).toContain("WP1");
    expect(out).toContain("green-min-threshold");
    expect(out).toContain("130");
    expect(out).toContain("150");
    expect(out).toContain("10");
  });

  it("wred-policy rejects min > max", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config qos wred-policy add WP1 green 200 150 10", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("interface bind requires an existing map, then show qos interface reflects it", () => {
    const state = build();
    const sw = state.devices.sw1;
    // bind before the map exists -> error
    const bad = execute("config qos interface bind Ethernet0 dscp-tc DSCP-TC1", ctxFor(state, sw));
    expect(bad.output.some((o) => o.kind === "error")).toBe(true);

    execute("config qos map dscp-tc add DSCP-TC1 3 5", ctxFor(state, sw));
    execute("config qos scheduler-policy add SP1 5 dwrr 10", ctxFor(state, sw));
    execute("config qos interface bind Ethernet0 dscp-tc DSCP-TC1", ctxFor(state, sw));
    execute("config qos interface bind Ethernet0 scheduler-policy SP1", ctxFor(state, sw));

    const out = text(execute("show qos interface Ethernet0", ctxFor(state, sw)));
    expect(out).toContain("dscp-tc-map: DSCP-TC1");
    expect(out).toContain("scheduler policy: SP1@5"); // @<first queue>
  });

  it("deleting a map that is bound is rejected (in use); unbind then delete succeeds", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config qos map dscp-tc add DSCP-TC1 3 5", ctxFor(state, sw));
    execute("config qos interface bind Ethernet0 dscp-tc DSCP-TC1", ctxFor(state, sw));

    // qos.txt TC-115: deleting an in-use map fails.
    const inUse = execute("config qos map dscp-tc del DSCP-TC1", ctxFor(state, sw));
    expect(inUse.output.some((o) => o.kind === "error")).toBe(true);

    execute("config qos interface unbind Ethernet0 dscp-tc", ctxFor(state, sw));
    execute("config qos map dscp-tc del DSCP-TC1", ctxFor(state, sw));
    const out = text(execute("show qos map dscp-tc", ctxFor(state, sw)));
    expect(out).toContain("No DSCP-TC-MAPs configured");
  });

  it("show qos summary flags the model as simulated config-plane", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config qos map dscp-tc add DSCP-TC1 3 5", ctxFor(state, sw));
    const out = text(execute("show qos", ctxFor(state, sw)));
    expect(out.toLowerCase()).toContain("simulated");
    expect(out).toContain("DSCP-TC maps");
  });
});
