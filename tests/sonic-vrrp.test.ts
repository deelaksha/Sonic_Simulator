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

describe("SONiC VRRP feature (Click config + show)", () => {
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
    // FRR vrrpd `show vrrp` layout (vrrp_vty.c:487-598): priority defaults to 100,
    // version to 3, preempt enabled when unset; no switch ports up → Initialize.
    expect(out).toMatch(/ Priority +100\n/);
    expect(out).toMatch(/ Protocol Version +3\n/);
    expect(out).toMatch(/ Preempt Mode +Yes\n/);
    expect(out).toMatch(/ Status \(v4\) +Initialize\n/);
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
    expect(out).toMatch(/ Protocol Version +2\n/);
    expect(out).toMatch(/ Preempt Mode +No\n/);
  });

  it("config vrrp del removes the instance", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vrrp add Ethernet0 10", ctxFor(state, sw));
    execute("config vrrp del Ethernet0 10", ctxFor(state, sw));
    expect(peekFeatureState<VrrpState>(sw, "vrrp")!.instances.length).toBe(0);
    // vtysh `show vrrp` prints nothing when no instance exists.
    expect(text(execute("show vrrp", ctxFor(state, sw)))).toBe("");
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

describe("sonic-utilities `config interface vrrp ...` (config/main.py:6510-6790)", () => {
  it("ip add creates the instance; priority / adv_interval / pre_empt / version / ip remove / remove", () => {
    const state = build();
    const sw = state.devices.sw1;
    const run = (c: string) => execute(c, ctxFor(state, sw));
    run("config interface vrrp ip add Ethernet0 7 10.1.1.1/24");
    run("config interface vrrp priority Ethernet0 7 150");
    run("config interface vrrp adv_interval Ethernet0 7 2");
    run("config interface vrrp pre_empt Ethernet0 7 disabled");
    run("config interface vrrp version Ethernet0 7 2");
    expect(peekFeatureState<VrrpState>(sw, "vrrp")!.instances[0]).toMatchObject({ iface: "Ethernet0", vrid: 7, vip: "10.1.1.1", priority: 150, advInterval: 2000, preempt: false, version: 2 });
    expect(run("config interface vrrp adv_interval Ethernet0 7 256").output.some((o) => o.kind === "error")).toBe(true);
    expect(run("config interface vrrp ip remove Ethernet0 7 10.9.9.9").output.some((o) => o.kind === "error")).toBe(true);
    run("config interface vrrp ip remove Ethernet0 7 10.1.1.1");
    expect(peekFeatureState<VrrpState>(sw, "vrrp")!.instances[0].vip).toBeUndefined();
    run("config interface vrrp remove Ethernet0 7");
    expect(peekFeatureState<VrrpState>(sw, "vrrp")!.instances).toHaveLength(0);
  });

  it("show vrrp summary lists the instance (FRR summary table)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config interface vrrp ip add Ethernet0 7 10.1.1.1", ctxFor(state, sw));
    const lines = text(execute("show vrrp summary", ctxFor(state, sw))).split("\n");
    expect(lines[1]).toBe(" Interface   VRID   Priority   IPv4   IPv6   State (v4)   State (v6)");
    expect(lines[3]).toBe(" Ethernet0   7      100        1      0      Backup       Backup");
  });
});
