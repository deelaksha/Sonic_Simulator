import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { listVlans } from "../lib/models/vlan-ops";

function build() {
  resetMacCounter(1);
  resetIds();
  const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
  const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
  const pc3 = createDevice({ id: "pc3", type: "pc", name: "PC3", x: 0, y: 0 });
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  pc1.interfaces[0].ipv4 = [{ address: "10.0.0.1", prefix: 24 }];
  pc2.interfaces[0].ipv4 = [{ address: "10.0.0.2", prefix: 24 }];
  pc3.interfaces[0].ipv4 = [{ address: "10.0.0.3", prefix: 24 }];
  [pc1, pc2, pc3].forEach(rebuildConnectedRoutes);
  const state: NetworkState = { devices: { pc1, pc2, pc3, sw1 }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
  linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "sw1", interfaceId: "sw1-if1" });
  linkInterfaces(state, { deviceId: "pc3", interfaceId: "pc3-if0" }, { deviceId: "sw1", interfaceId: "sw1-if2" });
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

describe("SONiC VLAN feature (task §22, §54)", () => {
  it("config vlan add creates VLANs in switch state", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vlan add 10", ctxFor(state, sw));
    execute("sudo config vlan add 20", ctxFor(state, sw)); // sudo passthrough
    expect(listVlans(sw).map((v) => v.id).sort()).toEqual([10, 20]);
  });

  it("show vlan brief renders live membership", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vlan add 10", ctxFor(state, sw));
    execute("config vlan member add -u 10 Ethernet0", ctxFor(state, sw));
    const res = execute("show vlan brief", ctxFor(state, sw));
    const text = res.output.map((o) => o.text).join("\n");
    expect(text).toContain("10");
    expect(text).toContain("Ethernet0");
    expect(text).toContain("untagged");
  });

  it("rejects membership for a non-existent VLAN", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config vlan member add -u 99 Ethernet0", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("VLAN membership drives real forwarding: same VLAN pings, different VLAN is isolated", () => {
    const state = build();
    const sw = state.devices.sw1;
    // PC1 + PC2 in VLAN 10, PC3 in VLAN 20 (same IP subnet).
    execute("config vlan add 10", ctxFor(state, sw));
    execute("config vlan add 20", ctxFor(state, sw));
    execute("config vlan member add -u 10 Ethernet0", ctxFor(state, sw));
    execute("config vlan member add -u 10 Ethernet1", ctxFor(state, sw));
    execute("config vlan member add -u 20 Ethernet2", ctxFor(state, sw));

    const sameVlan = new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 });
    expect(sameVlan.received).toBe(1);

    const crossVlan = new Simulation(state).runPing("pc1", "10.0.0.3", { count: 1 });
    expect(crossVlan.received).toBe(0);
    expect(crossVlan.replies[0].reason).toBe("arp-failed");
  });

  it("config vlan del clears membership", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config vlan add 10", ctxFor(state, sw));
    execute("config vlan member add -u 10 Ethernet0", ctxFor(state, sw));
    execute("config vlan del 10", ctxFor(state, sw));
    expect(listVlans(sw).length).toBe(0);
    expect(sw.interfaces[0].vlan.accessVlan).toBe(1); // back to default
  });
});
