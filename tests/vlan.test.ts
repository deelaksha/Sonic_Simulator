import { describe, it, expect } from "vitest";
import { lan2 } from "./helpers";
import { Simulation } from "../lib/engine";

describe("VLAN forwarding-plane isolation (spec §8, §24)", () => {
  it("isolates access ports in different VLANs", () => {
    const { state, sw1 } = lan2();
    // PC1's switch port → VLAN 10, PC2's switch port → VLAN 20 (same IP subnet).
    sw1.interfaces[0].vlan.accessVlan = 10;
    sw1.interfaces[1].vlan.accessVlan = 20;

    const summary = new Simulation(state).runPing("pc1", "192.168.1.20", { count: 1 });
    // ARP flood in VLAN 10 has no member to reach PC2 → resolution fails.
    expect(summary.received).toBe(0);
    expect(summary.replies[0].reason).toBe("arp-failed");
  });

  it("allows access ports in the same VLAN", () => {
    const { state, sw1 } = lan2();
    sw1.interfaces[0].vlan.accessVlan = 10;
    sw1.interfaces[1].vlan.accessVlan = 10;

    const summary = new Simulation(state).runPing("pc1", "192.168.1.20", { count: 1 });
    expect(summary.received).toBe(1);
    // MAC learned under VLAN 10, not the default VLAN 1.
    expect(sw1.macTable.every((m) => m.vlan === 10)).toBe(true);
  });
});
