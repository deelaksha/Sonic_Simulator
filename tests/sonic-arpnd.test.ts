import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";

function build() {
  resetMacCounter(1);
  resetIds();
  const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
  const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  pc1.interfaces[0].ipv4 = [{ address: "10.0.0.1", prefix: 24 }];
  pc2.interfaces[0].ipv4 = [{ address: "10.0.0.2", prefix: 24 }];
  [pc1, pc2].forEach(rebuildConnectedRoutes);
  const state: NetworkState = { devices: { pc1, pc2, sw1 }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
  linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "sw1", interfaceId: "sw1-if1" });
  return { state, pc1, pc2, sw1 };
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

const textOf = (r: { output: { text: string }[] }) => r.output.map((o) => o.text).join("\n");

describe("SONiC ARP/ND feature (arpnd.txt)", () => {
  it("show arp reflects the neighbour the engine learned during a ping", () => {
    const { state, pc1, pc2 } = build();
    const summary = new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 });
    expect(summary.received).toBe(1);

    const res = execute("show arp", ctxFor(state, pc1));
    const text = textOf(res);
    expect(text).toContain("10.0.0.2");
    expect(text).toContain(pc2.interfaces[0].mac);
  });

  it("show ip arp is an alias for show arp", () => {
    const { state, pc1, pc2 } = build();
    new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 });
    const text = textOf(execute("show ip arp", ctxFor(state, pc1)));
    expect(text).toContain("10.0.0.2");
    expect(text).toContain(pc2.interfaces[0].mac);
  });

  it("show arp is empty before any traffic", () => {
    const { state, pc1 } = build();
    const text = textOf(execute("show arp", ctxFor(state, pc1)));
    expect(text).toContain("No ARP entries found.");
  });

  it("config arp add pushes a reachable static entry that show arp renders", () => {
    const { state, pc1 } = build();
    execute("config arp add 10.0.0.9 aa:bb:cc:dd:ee:01 eth0", ctxFor(state, pc1));
    expect(pc1.arpTable).toContainEqual({
      ip: "10.0.0.9",
      mac: "aa:bb:cc:dd:ee:01",
      interfaceId: "pc1-if0",
      state: "reachable",
    });
    const text = textOf(execute("show arp", ctxFor(state, pc1)));
    expect(text).toContain("10.0.0.9");
    expect(text).toContain("aa:bb:cc:dd:ee:01");
  });

  it("config arp add rejects an unknown interface", () => {
    const { state, pc1 } = build();
    const res = execute("config arp add 10.0.0.9 aa:bb:cc:dd:ee:01 Ethernet99", ctxFor(state, pc1));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(pc1.arpTable.length).toBe(0);
  });

  it("show arp <ip> filters to a single neighbour", () => {
    const { state, pc1 } = build();
    execute("config arp add 10.0.0.9 aa:bb:cc:dd:ee:01 eth0", ctxFor(state, pc1));
    execute("config arp add 10.0.0.8 aa:bb:cc:dd:ee:02 eth0", ctxFor(state, pc1));
    const text = textOf(execute("show arp 10.0.0.9", ctxFor(state, pc1)));
    expect(text).toContain("10.0.0.9");
    expect(text).not.toContain("10.0.0.8");
  });

  it("config arp clear empties the neighbour cache", () => {
    const { state, pc1 } = build();
    new Simulation(state).runPing("pc1", "10.0.0.2", { count: 1 });
    expect(pc1.arpTable.length).toBeGreaterThan(0);
    execute("config arp clear", ctxFor(state, pc1));
    expect(pc1.arpTable.length).toBe(0);
    expect(textOf(execute("show arp", ctxFor(state, pc1)))).toContain("No ARP entries found.");
  });

  it("show ipv6 neighbors / show ndp report no ND entries (model has no IPv6 table)", () => {
    const { state, pc1 } = build();
    expect(textOf(execute("show ipv6 neighbors", ctxFor(state, pc1)))).toContain("No IPv6 neighbor entries found.");
    expect(textOf(execute("show ndp", ctxFor(state, pc1)))).toContain("No IPv6 neighbor entries found.");
  });
});
