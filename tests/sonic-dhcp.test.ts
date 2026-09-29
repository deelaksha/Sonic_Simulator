import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface DhcpRelayState {
  relays: Record<string, string[]>;
}

function build() {
  resetMacCounter(1);
  resetIds();
  const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  pc1.interfaces[0].ipv4 = [{ address: "10.0.0.1", prefix: 24 }];
  rebuildConnectedRoutes(pc1);
  const state: NetworkState = { devices: { pc1, sw1 }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
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

function relays(dev: Device): Record<string, string[]> {
  return peekFeatureState<DhcpRelayState>(dev, "dhcp")?.relays ?? {};
}

describe("SONiC DHCP relay feature (config-plane only)", () => {
  it("config dhcp-relay add records a helper address per interface", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config dhcp-relay add Ethernet0 10.0.0.100", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(false);
    expect(relays(sw).Ethernet0).toEqual(["10.0.0.100"]);
  });

  it("show dhcp-relay reflects added helpers; multiple per interface accumulate", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config dhcp-relay add Ethernet0 10.0.0.100", ctxFor(state, sw));
    execute("config dhcp-relay add Ethernet0 10.0.0.101", ctxFor(state, sw));
    execute("config dhcp-relay add Ethernet1 192.168.1.1", ctxFor(state, sw));
    const text = execute("show dhcp-relay", ctxFor(state, sw)).output.map((o) => o.text).join("\n");
    expect(text).toContain("Ethernet0");
    expect(text).toContain("10.0.0.100");
    expect(text).toContain("10.0.0.101");
    expect(text).toContain("Ethernet1");
    expect(text).toContain("192.168.1.1");
  });

  it("empty state renders a 'no relay' notice", () => {
    const state = build();
    const sw = state.devices.sw1;
    const text = execute("show dhcp-relay", ctxFor(state, sw)).output.map((o) => o.text).join("\n");
    expect(text).toContain("No DHCP relay helper addresses configured");
  });

  it("config dhcp-relay del removes the helper; interface drops out when empty", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config dhcp-relay add Ethernet0 10.0.0.100", ctxFor(state, sw));
    execute("config dhcp-relay add Ethernet0 10.0.0.101", ctxFor(state, sw));
    execute("config dhcp-relay del Ethernet0 10.0.0.100", ctxFor(state, sw));
    expect(relays(sw).Ethernet0).toEqual(["10.0.0.101"]);
    execute("config dhcp-relay del Ethernet0 10.0.0.101", ctxFor(state, sw));
    expect(relays(sw).Ethernet0).toBeUndefined();
  });

  it("rejects an invalid server IP", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config dhcp-relay add Ethernet0 999.0.0.1", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(relays(sw).Ethernet0).toBeUndefined();
  });

  it("rejects an unknown interface on add and del", () => {
    const state = build();
    const sw = state.devices.sw1;
    const add = execute("config dhcp-relay add Ethernet99 10.0.0.100", ctxFor(state, sw));
    expect(add.output.some((o) => o.kind === "error")).toBe(true);
    const del = execute("config dhcp-relay del Ethernet99 10.0.0.100", ctxFor(state, sw));
    expect(del.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("deleting a helper that is not configured is a silent no-op (not an error)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config dhcp-relay del Ethernet0 10.0.0.100", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(false);
  });

  it("re-adding the same helper is an idempotent no-op (no duplicate)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config dhcp-relay add Ethernet0 10.0.0.100", ctxFor(state, sw));
    execute("config dhcp-relay add Ethernet0 10.0.0.100", ctxFor(state, sw));
    expect(relays(sw).Ethernet0).toEqual(["10.0.0.100"]);
  });
});
