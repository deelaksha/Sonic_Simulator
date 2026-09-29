import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

type VrfState = { vrfs: { name: string; interfaces: string[] }[] };

function build(): NetworkState {
  resetMacCounter(1);
  resetIds();
  // Router exposes L3 interfaces eth0..eth3 for VRF binding (config-plane only).
  const r1 = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 4 });
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

describe("SONiC VRF feature (config-plane, vrf.txt)", () => {
  it("config vrf add creates VRFs in device state", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config vrf add Vrf5", ctxFor(state, r1));
    execute("sudo config vrf add Vrf_red", ctxFor(state, r1)); // sudo passthrough
    expect(peekFeatureState<VrfState>(r1, "vrf")?.vrfs.map((v) => v.name)).toEqual(["Vrf5", "Vrf_red"]);
  });

  it("rejects duplicate vrf add", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config vrf add Vrf5", ctxFor(state, r1));
    const res = execute("config vrf add Vrf5", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<VrfState>(r1, "vrf")?.vrfs.length).toBe(1);
  });

  it("show vrf reflects added VRFs and bound interfaces", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config vrf add Vrf_red", ctxFor(state, r1));
    execute("config vrf member add Vrf_red eth0", ctxFor(state, r1));
    const text = execute("show vrf", ctxFor(state, r1)).output.map((o) => o.text).join("\n");
    expect(text).toContain("Vrf_red");
    expect(text).toContain("eth0");
  });

  it("show vrf <name> filters to a single VRF", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config vrf add Vrf5", ctxFor(state, r1));
    execute("config vrf add Vrf_red", ctxFor(state, r1));
    const text = execute("show vrf Vrf_red", ctxFor(state, r1)).output.map((o) => o.text).join("\n");
    expect(text).toContain("Vrf_red");
    expect(text).not.toContain("Vrf5");
  });

  it("rejects binding to a non-existent interface", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config vrf add Vrf_red", ctxFor(state, r1));
    const res = execute("config vrf member add Vrf_red eth99", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("rejects binding to a non-existent VRF", () => {
    const state = build();
    const r1 = state.devices.r1;
    const res = execute("config vrf member add VrfNope eth0", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("an interface belongs to exactly one VRF (re-bind moves it)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config vrf add Vrf_a", ctxFor(state, r1));
    execute("config vrf add Vrf_b", ctxFor(state, r1));
    execute("config vrf member add Vrf_a eth0", ctxFor(state, r1));
    execute("config vrf member add Vrf_b eth0", ctxFor(state, r1));
    const st = peekFeatureState<VrfState>(r1, "vrf");
    expect(st?.vrfs.find((v) => v.name === "Vrf_a")?.interfaces).toEqual([]);
    expect(st?.vrfs.find((v) => v.name === "Vrf_b")?.interfaces).toEqual(["eth0"]);
  });

  it("config vrf member del unbinds the interface", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config vrf add Vrf_red", ctxFor(state, r1));
    execute("config vrf member add Vrf_red eth0", ctxFor(state, r1));
    execute("config vrf member del Vrf_red eth0", ctxFor(state, r1));
    expect(peekFeatureState<VrfState>(r1, "vrf")?.vrfs.find((v) => v.name === "Vrf_red")?.interfaces).toEqual([]);
    const text = execute("show vrf", ctxFor(state, r1)).output.map((o) => o.text).join("\n");
    expect(text).not.toContain("eth0");
  });

  it("config vrf del removes the VRF", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config vrf add Vrf5", ctxFor(state, r1));
    execute("config vrf del Vrf5", ctxFor(state, r1));
    expect(peekFeatureState<VrfState>(r1, "vrf")?.vrfs.length).toBe(0);
    const text = execute("show vrf", ctxFor(state, r1)).output.map((o) => o.text).join("\n");
    expect(text).toContain("No VRFs configured");
  });
});
