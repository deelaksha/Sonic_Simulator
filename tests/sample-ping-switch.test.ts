import { describe, it, expect } from "vitest";
import { useLabStore } from "../lib/store/lab-store";
import { Simulation } from "../lib/engine/simulation";

describe("Sample lab ping to switch and peer PC", () => {
  it("allows PC1 to ping both PC2 and the switch SW1", () => {
    useLabStore.getState().loadSample();
    const net = useLabStore.getState().network;
    const pc1 = Object.values(net.devices).find((d) => d.name === "PC1")!;
    const pc2 = Object.values(net.devices).find((d) => d.name === "PC2")!;
    const sw1 = Object.values(net.devices).find((d) => d.name === "SW1")!;

    // 1. PC1 -> PC2 (192.168.100.101)
    const sim1 = new Simulation(net);
    const r1 = sim1.runPing(pc1.id, "192.168.100.101", { count: 2 });
    expect(r1.received).toBe(2);

    // 2. PC1 -> SW1 (192.168.100.1)
    const sim2 = new Simulation(net);
    const r2 = sim2.runPing(pc1.id, "192.168.100.1", { count: 2 });
    expect(r2.received).toBe(2);

    // 3. PC2 -> SW1 (192.168.100.1)
    const sim3 = new Simulation(net);
    const r3 = sim3.runPing(pc2.id, "192.168.100.1", { count: 2 });
    expect(r3.received).toBe(2);

    // 4. PC1 -> unused IP (192.168.100.99)
    const sim4 = new Simulation(net);
    const r4 = sim4.runPing(pc1.id, "192.168.100.99", { count: 1 });
    expect(r4.received).toBe(0);
    expect(r4.replies[0].reason).toBe("arp-failed");
  });
});

