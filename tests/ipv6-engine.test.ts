import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes6, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device, DeviceType } from "../lib/models/device";

function sameLink() {
  resetMacCounter(1);
  resetIds();
  const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
  const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
  const sw = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  pc1.interfaces[0].ipv6 = [{ address: "2001:db8::10", prefix: 64 }];
  pc2.interfaces[0].ipv6 = [{ address: "2001:db8::20", prefix: 64 }];
  [pc1, pc2].forEach(rebuildConnectedRoutes6);
  const state: NetworkState = { devices: { pc1, pc2, sw1: sw }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
  linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "sw1", interfaceId: "sw1-if1" });
  return state;
}

function routed() {
  resetMacCounter(50);
  resetIds();
  const mk = (id: string, type: DeviceType, name: string, ports?: number) => createDevice({ id, type, name, x: 0, y: 0, ports });
  const pc1 = mk("pc1", "pc", "PC1");
  const pc2 = mk("pc2", "pc", "PC2");
  const r1 = mk("r1", "router", "R1", 2);
  pc1.interfaces[0].ipv6 = [{ address: "2001:db8:1::10", prefix: 64 }];
  r1.interfaces[0].ipv6 = [{ address: "2001:db8:1::1", prefix: 64 }];
  r1.interfaces[1].ipv6 = [{ address: "2001:db8:2::1", prefix: 64 }];
  pc2.interfaces[0].ipv6 = [{ address: "2001:db8:2::10", prefix: 64 }];
  pc1.config.defaultGateway6 = "2001:db8:1::1";
  pc2.config.defaultGateway6 = "2001:db8:2::1";
  [pc1, pc2, r1].forEach(rebuildConnectedRoutes6);
  const state: NetworkState = { devices: { pc1, pc2, r1 }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "r1", interfaceId: "r1-if0" });
  linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "r1", interfaceId: "r1-if1" });
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

describe("IPv6 packet-plane (spec §40)", () => {
  it("ping6 on a link resolves via NDP (not ARP) and echoes", () => {
    const state = sameLink();
    const sim = new Simulation(state);
    const r = sim.runPing6("pc1", "2001:db8::20", { count: 1 });
    expect(r.received).toBe(1);
    expect(r.replies[0].ttl).toBe(64);
    // NDP, not ARP
    expect(sim.events.some((e) => e.type === "NDP_SOLICITATION")).toBe(true);
    expect(sim.events.some((e) => e.type === "NDP_ADVERTISEMENT")).toBe(true);
    expect(sim.events.some((e) => e.type === "ARP_REQUEST")).toBe(false);
    // a real IPv6 frame crossed the wire
    expect(sim.events.some((e) => e.frame?.ipv6 && e.frame.icmp6?.type === "echo-request")).toBe(true);
    // neighbour cache populated
    expect(state.devices.pc1.ndpTable.some((n) => n.ip === "2001:db8::20")).toBe(true);
  });

  it("second ping6 uses the NDP cache (one solicitation for two echoes)", () => {
    const state = sameLink();
    const sim = new Simulation(state);
    sim.runPing6("pc1", "2001:db8::20", { count: 2 });
    expect(sim.events.filter((e) => e.type === "NDP_SOLICITATION").length).toBe(1);
  });

  it("routes IPv6 across a router and decrements hop-limit", () => {
    const state = routed();
    const sim = new Simulation(state);
    const r = sim.runPing6("pc1", "2001:db8:2::10", { count: 1 });
    expect(r.received).toBe(1);
    expect(r.replies[0].ttl).toBe(63); // 64 → 63 at the router
    expect(sim.events.some((e) => e.type === "TTL_DECREMENT")).toBe(true);
  });

  it("fails with ndp-failed for an unresolvable on-link address", () => {
    const state = sameLink();
    const r = new Simulation(state).runPing6("pc1", "2001:db8::99", { count: 1 });
    expect(r.received).toBe(0);
    expect(r.replies[0].reason).toBe("ndp-failed");
  });
});

describe("IPv6 SONiC CLI + ping6 command", () => {
  it("config interface ipv6 add makes ping6 work and shows in show ipv6 route/interfaces", () => {
    resetMacCounter(1);
    resetIds();
    const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
    const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
    const sw = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
    pc2.interfaces[0].ipv6 = [{ address: "2001:db8::20", prefix: 64 }];
    rebuildConnectedRoutes6(pc2);
    const state: NetworkState = { devices: { pc1, pc2, sw1: sw }, connections: [] };
    linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
    linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "sw1", interfaceId: "sw1-if1" });

    execute("config interface ipv6 add eth0 2001:db8::10/64", ctxFor(state, pc1));
    expect(pc1.interfaces[0].ipv6[0]).toEqual({ address: "2001:db8::10", prefix: 64 });

    const routeOut = execute("show ipv6 route", ctxFor(state, pc1)).output.map((o) => o.text).join("\n");
    expect(routeOut).toContain("2001:db8::/64");

    const ping = execute("ping6 -c 1 2001:db8::20", ctxFor(state, pc1)).output.map((o) => o.text).join("\n");
    expect(ping).toContain("bytes from 2001:db8::20");

    const nd = execute("show ipv6 neighbors", ctxFor(state, pc1)).output.map((o) => o.text).join("\n");
    expect(nd).toContain("2001:db8::20");
  });
});
