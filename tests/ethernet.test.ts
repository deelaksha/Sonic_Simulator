import { describe, it, expect } from "vitest";
import { lan2 } from "./helpers";
import { Simulation } from "../lib/engine";

describe("L2 switching (spec §7)", () => {
  it("learns source MACs on the correct ingress ports", () => {
    const { state, sw1 } = lan2();
    new Simulation(state).runPing("pc1", "192.168.1.20", { count: 1 });

    const pc1Mac = state.devices.pc1.interfaces[0].mac;
    const pc2Mac = state.devices.pc2.interfaces[0].mac;
    const e1 = sw1.macTable.find((m) => m.mac === pc1Mac);
    const e2 = sw1.macTable.find((m) => m.mac === pc2Mac);

    expect(e1?.interfaceId).toBe("sw1-if0");
    expect(e2?.interfaceId).toBe("sw1-if1");
    expect(e1?.vlan).toBe(1);
  });

  it("floods a broadcast (ARP request) but forwards known unicast (ICMP)", () => {
    const { state } = lan2();
    const sim = new Simulation(state);
    sim.runPing("pc1", "192.168.1.20", { count: 1 });

    const flooded = sim.events.filter((e) => e.type === "FRAME_FLOODED");
    const forwarded = sim.events.filter((e) => e.type === "FRAME_FORWARDED");

    // The ARP who-has is broadcast → flooded.
    expect(flooded.some((e) => e.frame?.arp?.op === "request")).toBe(true);
    // Once MACs are known, ICMP is forwarded to a single port, not flooded.
    expect(forwarded.some((e) => e.frame?.icmp)).toBe(true);
    expect(flooded.some((e) => e.frame?.icmp)).toBe(false);
  });

  it("does not learn from broadcast source addresses", () => {
    const { state, sw1 } = lan2();
    new Simulation(state).runPing("pc1", "192.168.1.20", { count: 1 });
    expect(sw1.macTable.some((m) => m.mac === "FF:FF:FF:FF:FF:FF")).toBe(false);
  });
});
