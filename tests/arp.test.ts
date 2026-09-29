import { describe, it, expect } from "vitest";
import { lan2 } from "./helpers";
import { Simulation } from "../lib/engine";

describe("ARP engine (spec §11)", () => {
  it("resolves the destination and caches it", () => {
    const { state, pc1 } = lan2();
    const sim = new Simulation(state);
    sim.runPing("pc1", "192.168.1.20", { count: 1 });

    const entry = pc1.arpTable.find((e) => e.ip === "192.168.1.20");
    expect(entry?.state).toBe("reachable");
    expect(entry?.mac).toBe(state.devices.pc2.interfaces[0].mac);

    expect(sim.events.some((e) => e.type === "ARP_REQUEST")).toBe(true);
    expect(sim.events.some((e) => e.type === "ARP_REPLY")).toBe(true);
  });

  it("uses the cache on subsequent probes (one ARP for two pings)", () => {
    const { state } = lan2();
    const sim = new Simulation(state);
    sim.runPing("pc1", "192.168.1.20", { count: 2 });
    const requests = sim.events.filter((e) => e.type === "ARP_REQUEST");
    expect(requests.length).toBe(1);
  });

  it("marks the neighbour INCOMPLETE when nobody answers", () => {
    const { state, pc1 } = lan2();
    const sim = new Simulation(state);
    const summary = sim.runPing("pc1", "192.168.1.99", { count: 1 });

    expect(summary.received).toBe(0);
    expect(summary.replies[0].reason).toBe("arp-failed");
    const entry = pc1.arpTable.find((e) => e.ip === "192.168.1.99");
    expect(entry?.state).toBe("incomplete");
  });
});
