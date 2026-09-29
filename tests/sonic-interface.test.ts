import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";

/**
 * PC1 (no IP yet) --- SW1 --- PC2 (10.0.0.2/24), all in default VLAN 1.
 * PC1 is the device under test; the interface commands run on its eth0.
 */
function build() {
  resetMacCounter(1);
  resetIds();
  const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
  const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  pc2.interfaces[0].ipv4 = [{ address: "10.0.0.2", prefix: 24 }];
  [pc1, pc2].forEach(rebuildConnectedRoutes);
  const state: NetworkState = { devices: { pc1, pc2, sw1 }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
  linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "sw1", interfaceId: "sw1-if1" });
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

describe("SONiC interface feature", () => {
  it("config interface ip add assigns a real address and installs a connected route", () => {
    const state = build();
    const pc1 = state.devices.pc1;
    execute("config interface ip add eth0 10.0.0.1/24", ctxFor(state, pc1));
    expect(pc1.interfaces[0].ipv4).toEqual([{ address: "10.0.0.1", prefix: 24 }]);
    // Route rebuilt from the new addressing (single source of truth).
    expect(pc1.routingTable.some((r) => r.destination === "10.0.0.0" && r.prefix === 24)).toBe(true);
  });

  it("the added address is visible via `show ip interfaces` (common module reads the same state)", () => {
    const state = build();
    const pc1 = state.devices.pc1;
    execute("sudo config interface ip add eth0 10.0.0.1/24", ctxFor(state, pc1)); // sudo passthrough
    const res = execute("show ip interfaces", ctxFor(state, pc1));
    const text = res.output.map((o) => o.text).join("\n");
    expect(text).toContain("eth0");
    expect(text).toContain("10.0.0.1/24");
  });

  it("adding an IP makes ping succeed (real forwarding)", () => {
    const state = build();
    const pc1 = state.devices.pc1;
    // Before addressing, PC1 has no route/source IP -> ping fails.
    expect(new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 }).received).toBe(0);
    execute("config interface ip add eth0 10.0.0.1/24", ctxFor(state, pc1));
    expect(new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 }).received).toBe(1);
  });

  it("shutdown stops forwarding, startup restores it", () => {
    const state = build();
    const pc1 = state.devices.pc1;
    execute("config interface ip add eth0 10.0.0.1/24", ctxFor(state, pc1));
    expect(new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 }).received).toBe(1);

    execute("config interface shutdown eth0", ctxFor(state, pc1));
    expect(pc1.interfaces[0].adminState).toBe("down");
    expect(pc1.interfaces[0].operState).toBe("down");
    expect(new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 }).received).toBe(0);

    execute("config interface startup eth0", ctxFor(state, pc1));
    expect(pc1.interfaces[0].adminState).toBe("up");
    expect(pc1.interfaces[0].operState).toBe("up");
    expect(new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 }).received).toBe(1);
  });

  it("config interface ip del removes the address and stops forwarding", () => {
    const state = build();
    const pc1 = state.devices.pc1;
    execute("config interface ip add eth0 10.0.0.1/24", ctxFor(state, pc1));
    execute("config interface ip del eth0 10.0.0.1/24", ctxFor(state, pc1));
    expect(pc1.interfaces[0].ipv4).toEqual([]);
    const res = execute("show ip interfaces", ctxFor(state, pc1));
    expect(res.output.map((o) => o.text).join("\n")).not.toContain("10.0.0.1/24");
    expect(new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 }).received).toBe(0);
  });

  it("rejects an invalid address and an unknown port", () => {
    const state = build();
    const pc1 = state.devices.pc1;
    expect(execute("config interface ip add eth0 999.1.1.1/24", ctxFor(state, pc1)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config interface ip add eth99 10.0.0.1/24", ctxFor(state, pc1)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config interface ip del eth0 10.0.0.1/24", ctxFor(state, pc1)).output.some((o) => o.kind === "error")).toBe(true);
  });

  it("show interfaces renders live admin/oper/mac/ip", () => {
    const state = build();
    const pc1 = state.devices.pc1;
    execute("config interface ip add eth0 10.0.0.1/24", ctxFor(state, pc1));
    const text = execute("show interfaces", ctxFor(state, pc1)).output.map((o) => o.text).join("\n");
    expect(text).toContain("eth0");
    expect(text).toContain("10.0.0.1/24");
    expect(text).toContain(pc1.interfaces[0].mac);
  });
});
