import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";

/**
 * R1 ── R2, transit subnet 10.0.0.0/24. R2 also owns the remote subnet
 * 192.168.9.0/24 (on r2-if1). R1 has NO route to 192.168.9.0/24 until a static
 * route is configured, so it is the perfect probe for `config route add`.
 */
function build(): NetworkState {
  resetMacCounter(1);
  resetIds();
  const r1 = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 2 });
  const r2 = createDevice({ id: "r2", type: "router", name: "R2", x: 0, y: 0, ports: 2 });
  r1.interfaces[0].ipv4 = [{ address: "10.0.0.1", prefix: 24 }];
  r2.interfaces[0].ipv4 = [{ address: "10.0.0.2", prefix: 24 }];
  r2.interfaces[1].ipv4 = [{ address: "192.168.9.1", prefix: 24 }];
  [r1, r2].forEach(rebuildConnectedRoutes);
  const state: NetworkState = { devices: { r1, r2 }, connections: [] };
  linkInterfaces(state, { deviceId: "r1", interfaceId: "r1-if0" }, { deviceId: "r2", interfaceId: "r2-if0" });
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

describe("SONiC static route feature (staticroute.txt)", () => {
  it("config route add installs a static route in the device routing table", () => {
    const state = build();
    const r1 = state.devices.r1;
    const res = execute("config route add prefix 192.168.9.0/24 nexthop 10.0.0.2", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(false);
    const route = r1.routingTable.find((r) => r.destination === "192.168.9.0" && r.prefix === 24);
    expect(route).toBeDefined();
    expect(route!.type).toBe("static");
    expect(route!.nextHop).toBe("10.0.0.2");
    expect(route!.interfaceId).toBe("r1-if0"); // interface whose subnet owns the next hop
  });

  it("normalizes host bits to the network address (destination = networkAddress)", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route add prefix 192.168.9.55/24 nexthop 10.0.0.2", ctxFor(state, r1));
    expect(r1.routingTable.some((r) => r.destination === "192.168.9.0" && r.prefix === 24 && r.type === "static")).toBe(true);
  });

  it("the static route drives REAL forwarding: ping fails before, succeeds after, fails again after del", () => {
    const state = build();
    const r1 = state.devices.r1;

    // Before: R1 has no route to 192.168.9.0/24.
    const before = new Simulation(state).runPing("r1", "192.168.9.1", { count: 1 });
    expect(before.received).toBe(0);
    expect(before.replies[0].reason).toBe("no-route");

    // Add the static route via the SONiC click command.
    execute("config route add prefix 192.168.9.0/24 nexthop 10.0.0.2", ctxFor(state, r1));

    // After: the engine's longestPrefixMatch now resolves the route and R1 reaches R2's far interface.
    const after = new Simulation(state).runPing("r1", "192.168.9.1", { count: 1 });
    expect(after.received).toBe(1);

    // Remove it: forwarding breaks again, proving the show/config path is the live table.
    execute("config route del prefix 192.168.9.0/24 nexthop 10.0.0.2", ctxFor(state, r1));
    const removed = new Simulation(state).runPing("r1", "192.168.9.1", { count: 1 });
    expect(removed.received).toBe(0);
    expect(removed.replies[0].reason).toBe("no-route");
  });

  it("config route del is idempotent when nothing matches", () => {
    const state = build();
    const r1 = state.devices.r1;
    const res = execute("config route del prefix 172.16.0.0/16 nexthop 10.0.0.2", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(false);
  });

  it("rejects a next hop that is not on any connected subnet", () => {
    const state = build();
    const r1 = state.devices.r1;
    const res = execute("config route add prefix 192.168.9.0/24 nexthop 172.16.5.5", ctxFor(state, r1));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(r1.routingTable.some((r) => r.type === "static")).toBe(false);
  });

  it("rejects malformed input (bad prefix / bad next hop)", () => {
    const state = build();
    const r1 = state.devices.r1;
    expect(execute("config route add prefix 192.168.9.0/33 nexthop 10.0.0.2", ctxFor(state, r1)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config route add prefix 300.1.1.0/24 nexthop 10.0.0.2", ctxFor(state, r1)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config route add prefix 192.168.9.0/24 nexthop 999.1.1.1", ctxFor(state, r1)).output.some((o) => o.kind === "error")).toBe(true);
    expect(r1.routingTable.some((r) => r.type === "static")).toBe(false);
  });

  it("show ip route renders the live table and filters by prefix", () => {
    const state = build();
    const r1 = state.devices.r1;
    execute("config route add prefix 192.168.9.0/24 nexthop 10.0.0.2", ctxFor(state, r1));

    const all = execute("show ip route", ctxFor(state, r1));
    const allText = all.output.map((o) => o.text).join("\n");
    expect(allText).toContain("192.168.9.0/24");
    expect(allText).toContain("via 10.0.0.2");
    expect(allText).toContain("10.0.0.0/24"); // connected transit route also shown

    const one = execute("show ip route 192.168.9.0/24", ctxFor(state, r1));
    const oneText = one.output.map((o) => o.text).join("\n");
    expect(oneText).toContain("192.168.9.0/24");
    expect(oneText).not.toContain("10.0.0.0/24"); // filtered out
  });
});
