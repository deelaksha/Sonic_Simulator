import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device, DeviceType } from "../lib/models/device";

function twoAs() {
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
  r1.config.features = { bgp: { localAs: 65001, routerId: "1.1.1.1", neighbors: [{ peer: "10.0.0.2", remoteAs: 65002 }], networks: ["10.1.1.0/24"] } };
  r2.config.features = { bgp: { localAs: 65002, routerId: "2.2.2.2", neighbors: [{ peer: "10.0.0.1", remoteAs: 65001 }], networks: ["10.2.2.0/24"] } };
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

describe("BGP packet-plane (spec §25)", () => {
  it("establishes sessions via OPEN over TCP/179 and installs NLRI routes", () => {
    const state = twoAs();
    const sim = new Simulation(state);
    const sum = sim.runBgp();
    expect(sum.sessions).toBe(2);
    expect(sum.routesInstalled).toBe(2);
    expect(sim.events.some((e) => e.type === "BGP_OPEN")).toBe(true);
    expect(sim.events.some((e) => e.type === "BGP_ESTABLISHED")).toBe(true);
    // a real TCP/179 BGP OPEN segment crossed the wire
    expect(sim.events.some((e) => e.frame?.tcp?.dstPort === 179 && e.frame.bgp?.messageType === "open")).toBe(true);
    const r = state.devices.r1.routingTable.find((rt) => rt.type === "bgp" && rt.destination === "10.2.2.0");
    expect(r?.nextHop).toBe("10.0.0.2");
  });

  it("makes cross-AS ping work only after convergence", () => {
    const state = twoAs();
    expect(new Simulation(state).runPing("pc1", "10.2.2.10", { count: 1 }).received).toBe(0);
    new Simulation(state).runBgp();
    const after = new Simulation(state).runPing("pc1", "10.2.2.10", { count: 1 });
    expect(after.received).toBe(1);
    expect(after.replies[0].ttl).toBe(62);
  });

  it("bgp converge command + show ip bgp summary reflect Established + PfxRcd", () => {
    const state = twoAs();
    const conv = execute("bgp converge", ctxFor(state, state.devices.r1));
    expect(conv.output.map((o) => o.text).join("\n")).toContain("Established");

    const summary = execute("show ip bgp summary", ctxFor(state, state.devices.r1)).output.map((o) => o.text).join("\n");
    expect(summary).toContain("10.0.0.2");
    expect(summary).toContain("Total number of neighbors established 1");
  });

  it("stays Idle when a neighbor is unreachable / not configured back", () => {
    const state = twoAs();
    // R2 removes its neighbor config → R1's OPEN arrives but R2 never opens back
    (state.devices.r2.config.features!.bgp as { neighbors: unknown[] }).neighbors = [];
    const sum = new Simulation(state).runBgp();
    expect(sum.sessions).toBe(0); // no bidirectional session
  });
});
