import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device, DeviceType } from "../lib/models/device";

function domain() {
  resetMacCounter(1);
  resetIds();
  const mk = (id: string, type: DeviceType, name: string, ports?: number) => createDevice({ id, type, name, x: 0, y: 0, ports });
  const pc1 = mk("pc1", "pc", "PC1");
  const pc2 = mk("pc2", "pc", "PC2");
  const r1 = mk("r1", "router", "R1", 2);
  const r2 = mk("r2", "router", "R2", 2);
  pc1.interfaces[0].ipv4 = [{ address: "10.1.1.10", prefix: 24 }];
  pc1.config.defaultGateway = "10.1.1.1";
  r1.interfaces[0].ipv4 = [{ address: "10.1.1.1", prefix: 24 }];
  r1.interfaces[1].ipv4 = [{ address: "10.0.0.1", prefix: 30 }];
  r2.interfaces[0].ipv4 = [{ address: "10.0.0.2", prefix: 30 }];
  r2.interfaces[1].ipv4 = [{ address: "10.2.2.1", prefix: 24 }];
  pc2.interfaces[0].ipv4 = [{ address: "10.2.2.10", prefix: 24 }];
  pc2.config.defaultGateway = "10.2.2.1";
  [pc1, pc2, r1, r2].forEach(rebuildConnectedRoutes);
  r1.config.features = {
    ospf: { routerId: "1.1.1.1", networks: [{ network: "10.1.1.0/24", area: "0.0.0.0" }, { network: "10.0.0.0/30", area: "0.0.0.0" }], areas: [] },
  };
  r2.config.features = {
    ospf: { routerId: "2.2.2.2", networks: [{ network: "10.2.2.0/24", area: "0.0.0.0" }, { network: "10.0.0.0/30", area: "0.0.0.0" }], areas: [] },
  };
  const state: NetworkState = { devices: { pc1, pc2, r1, r2 }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "r1", interfaceId: "r1-if0" });
  linkInterfaces(state, { deviceId: "r1", interfaceId: "r1-if1" }, { deviceId: "r2", interfaceId: "r2-if0" });
  linkInterfaces(state, { deviceId: "r2", interfaceId: "r2-if1" }, { deviceId: "pc2", interfaceId: "pc2-if0" });
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

describe("OSPF packet-plane (spec §24)", () => {
  it("forms Full adjacency via Hello and installs SPF routes", () => {
    const state = domain();
    const sim = new Simulation(state);
    const sum = sim.runOspf();
    expect(sum.adjacencies).toBe(2); // R1↔R2 both directions
    expect(sum.routesInstalled).toBe(2);
    expect(sim.events.some((e) => e.type === "OSPF_HELLO")).toBe(true);
    expect(sim.events.some((e) => e.type === "OSPF_NEIGHBOR")).toBe(true);
    // a real OSPF (proto 89) frame crossed the wire
    expect(sim.events.some((e) => e.frame?.ospf?.packetType === "hello")).toBe(true);
    // R1 learned PC2's subnet via OSPF
    const r = state.devices.r1.routingTable.find((rt) => rt.type === "ospf" && rt.destination === "10.2.2.0");
    expect(r?.nextHop).toBe("10.0.0.2");
  });

  it("makes cross-router ping work only after convergence", () => {
    const state = domain();
    expect(new Simulation(state).runPing("pc1", "10.2.2.10", { count: 1 }).received).toBe(0);
    new Simulation(state).runOspf();
    const after = new Simulation(state).runPing("pc1", "10.2.2.10", { count: 1 });
    expect(after.received).toBe(1);
    expect(after.replies[0].ttl).toBe(62); // decremented by both routers
  });

  it("ospf converge command + show ip ospf neighbor/route reflect real state", () => {
    const state = domain();
    const conv = execute("ospf converge", ctxFor(state, state.devices.r1));
    expect(conv.output.map((o) => o.text).join("\n")).toContain("adjacency");

    const nbr = execute("show ip ospf neighbor", ctxFor(state, state.devices.r1)).output.map((o) => o.text).join("\n");
    expect(nbr).toContain("2.2.2.2");
    expect(nbr).toContain("Full");

    const rt = execute("show ip ospf route", ctxFor(state, state.devices.r1)).output.map((o) => o.text).join("\n");
    expect(rt).toContain("10.2.2.0/24");

    // regression: show ip route / show ip arp still resolve to their own handlers
    const iproute = execute("show ip route", ctxFor(state, state.devices.r1)).output.map((o) => o.text).join("\n");
    expect(iproute).toContain("10.2.2.0/24"); // ospf route also shows in the main table
  });
});
