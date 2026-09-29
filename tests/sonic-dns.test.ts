import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface DnsState {
  nameservers: string[];
}

function build(): NetworkState {
  resetMacCounter(1);
  resetIds();
  const rtr1 = createDevice({ id: "rtr1", type: "router", name: "RTR1", x: 0, y: 0 });
  return { devices: { rtr1 }, connections: [] };
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

function servers(dev: Device): string[] {
  return peekFeatureState<DnsState>(dev, "dns")?.nameservers ?? [];
}

describe("SONiC DNS feature (config dns nameserver / show dns nameserver)", () => {
  it("add stores a nameserver and show lists it", () => {
    const state = build();
    const rtr = state.devices.rtr1;
    execute("config dns nameserver add 10.20.30.41", ctxFor(state, rtr));
    execute("sudo config dns nameserver add 10.20.30.42", ctxFor(state, rtr)); // sudo passthrough
    expect(servers(rtr).sort()).toEqual(["10.20.30.41", "10.20.30.42"]);

    const res = execute("show dns nameserver", ctxFor(state, rtr));
    const text = res.output.map((o) => o.text).join("\n");
    expect(text).toContain("Nameserver");
    expect(text).toContain("10.20.30.41");
    expect(text).toContain("10.20.30.42");
  });

  it("del removes a nameserver", () => {
    const state = build();
    const rtr = state.devices.rtr1;
    execute("config dns nameserver add 10.20.30.41", ctxFor(state, rtr));
    execute("config dns nameserver del 10.20.30.41", ctxFor(state, rtr));
    expect(servers(rtr)).toEqual([]);
    const res = execute("show dns nameserver", ctxFor(state, rtr));
    expect(res.output.map((o) => o.text).join("\n")).not.toContain("10.20.30.41");
  });

  it("rejects an invalid IPv4 address", () => {
    const state = build();
    const rtr = state.devices.rtr1;
    const res = execute("config dns nameserver add 999.1.1.1", ctxFor(state, rtr));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(servers(rtr)).toEqual([]);
  });

  it("rejects a duplicate nameserver", () => {
    const state = build();
    const rtr = state.devices.rtr1;
    execute("config dns nameserver add 10.20.30.41", ctxFor(state, rtr));
    const res = execute("config dns nameserver add 10.20.30.41", ctxFor(state, rtr));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(servers(rtr)).toEqual(["10.20.30.41"]);
  });

  it("enforces the max of 3 nameservers", () => {
    const state = build();
    const rtr = state.devices.rtr1;
    execute("config dns nameserver add 10.20.30.41", ctxFor(state, rtr));
    execute("config dns nameserver add 10.20.30.42", ctxFor(state, rtr));
    execute("config dns nameserver add 10.20.30.43", ctxFor(state, rtr));
    const res = execute("config dns nameserver add 10.20.30.44", ctxFor(state, rtr));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(servers(rtr).length).toBe(3);
  });

  it("rejects deleting a nameserver that was never configured", () => {
    const state = build();
    const rtr = state.devices.rtr1;
    const res = execute("config dns nameserver del 10.99.99.99", ctxFor(state, rtr));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });
});
