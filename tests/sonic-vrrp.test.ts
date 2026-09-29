import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface VrrpInstance {
  iface: string;
  vrid: number;
  vip?: string;
  priority?: number;
  preempt?: boolean;
  version?: number;
}
interface VrrpState {
  instances: VrrpInstance[];
}

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

describe("SONiC VRRP feature (config-plane)", () => {
  it("config vrrp add creates an instance on the interface", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vrrp add Ethernet0 10", ctxFor(state, sw));
    execute("sudo config vrrp add Ethernet1 20", ctxFor(state, sw)); // sudo passthrough
    const st = peekFeatureState<VrrpState>(sw, "vrrp")!;
    expect(st.instances.map((i) => `${i.iface}:${i.vrid}`).sort()).toEqual(["Ethernet0:10", "Ethernet1:20"]);
  });

  it("config vrrp add + vip: show vrrp reflects the instance and its virtual IP", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vrrp add Ethernet0 10", ctxFor(state, sw));
    execute("config vrrp vip Ethernet0 10 10.4.4.100", ctxFor(state, sw));
    const out = text(execute("show vrrp", ctxFor(state, sw)));
    expect(out).toContain("Ethernet0");
    expect(out).toContain("10");
    expect(out).toContain("10.4.4.100");
    // priority defaults to 100, version to v3, preempt enabled when unset.
    expect(out).toContain("100");
    expect(out).toContain("v3");
    expect(out).toContain("enabled");
  });

  it("config vrrp priority updates and show reflects it", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vrrp add Ethernet0 10", ctxFor(state, sw));
    execute("config vrrp priority Ethernet0 10 120", ctxFor(state, sw));
    expect(peekFeatureState<VrrpState>(sw, "vrrp")!.instances[0].priority).toBe(120);
    expect(text(execute("show vrrp", ctxFor(state, sw)))).toContain("120");
  });

  it("config vrrp version and preempt update the instance", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vrrp add Ethernet0 10", ctxFor(state, sw));
    execute("config vrrp version Ethernet0 10 2", ctxFor(state, sw));
    execute("config vrrp preempt Ethernet0 10 disable", ctxFor(state, sw));
    const inst = peekFeatureState<VrrpState>(sw, "vrrp")!.instances[0];
    expect(inst.version).toBe(2);
    expect(inst.preempt).toBe(false);
    const out = text(execute("show vrrp", ctxFor(state, sw)));
    expect(out).toContain("v2");
    expect(out).toContain("disabled");
  });

  it("config vrrp del removes the instance", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vrrp add Ethernet0 10", ctxFor(state, sw));
    execute("config vrrp del Ethernet0 10", ctxFor(state, sw));
    expect(peekFeatureState<VrrpState>(sw, "vrrp")!.instances.length).toBe(0);
    expect(text(execute("show vrrp", ctxFor(state, sw)))).toContain("No VRRP instances configured");
  });

  it("deleting a non-existent instance is a silent no-op (vrrp.txt Section 7)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config vrrp del Ethernet0 99", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(false);
    expect(text(res)).toContain("no-op");
  });

  it("rejects a VRID outside 1-255", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(execute("config vrrp add Ethernet0 0", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config vrrp add Ethernet0 256", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<VrrpState>(sw, "vrrp")?.instances.length ?? 0).toBe(0);
  });

  it("rejects an invalid virtual IPv4 address", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vrrp add Ethernet0 10", ctxFor(state, sw));
    const res = execute("config vrrp vip Ethernet0 10 10.4.4.999", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<VrrpState>(sw, "vrrp")!.instances[0].vip).toBeUndefined();
  });

  it("rejects a priority outside 1-254", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vrrp add Ethernet0 10", ctxFor(state, sw));
    expect(execute("config vrrp priority Ethernet0 10 255", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });

  it("rejects config on an unknown interface", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config vrrp add Ethernet99 10", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("rejects vip/priority for an instance that was never created", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(execute("config vrrp vip Ethernet0 10 10.4.4.100", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });
});
