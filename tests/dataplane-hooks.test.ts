import { describe, it, expect, beforeEach } from "vitest";
import { createDevice, rebuildConnectedRoutes } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation } from "../lib/engine";
import { Device } from "../lib/models/device";
import { createInterface } from "../lib/models/interface";
import { registerDataPlaneHook } from "../lib/control/hooks";
import { bridgeInput } from "../lib/protocols/switch";
import { resetAll } from "./helpers";

/** PC1 ── SW (2 ports) ── PC2, plus an extra cable pair SW2 for LAG tests. */
function lan(): { state: NetworkState; pc1: Device; pc2: Device; sw: Device } {
  resetAll();
  const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
  const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
  const sw = createDevice({ id: "sw", type: "switch", name: "SW", x: 0, y: 0, ports: 2 });
  pc1.interfaces[0].ipv4 = [{ address: "10.0.0.1", prefix: 24 }];
  pc2.interfaces[0].ipv4 = [{ address: "10.0.0.2", prefix: 24 }];
  [pc1, pc2].forEach(rebuildConnectedRoutes);
  const state: NetworkState = { devices: { pc1, pc2, sw }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw", interfaceId: "sw-if0" });
  linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "sw", interfaceId: "sw-if1" });
  return { state, pc1, pc2, sw };
}

const off = { portIngress: undefined, portEgress: undefined, lagOf: undefined, egressMember: undefined, flood: undefined, forwardVirtual: undefined, isLocalMac: undefined, allowEgress: undefined };
beforeEach(() => registerDataPlaneHook({ id: "test", ...off }));

describe("data-plane hooks", () => {
  it("portIngress can drop a frame before switching", () => {
    const { state, pc1 } = lan();
    registerDataPlaneHook({ id: "test", ...off, portIngress: (_c, d, _i, f) => !(d.id === "sw" && f.icmp) });
    const r = new Simulation(state).runPing(pc1.id, "10.0.0.2", { count: 1 });
    expect(r.received).toBe(0); // ARP passed, ICMP dropped at SW ingress
    expect(state.devices.pc1.arpTable.some((e) => e.ip === "10.0.0.2")).toBe(true);
  });

  it("lagOf/egressMember make two cables one bridge port (MAC learned on the LAG)", () => {
    resetAll();
    const sw1 = createDevice({ id: "s1", type: "switch", name: "S1", x: 0, y: 0, ports: 3 });
    const sw2 = createDevice({ id: "s2", type: "switch", name: "S2", x: 0, y: 0, ports: 3 });
    const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
    const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
    pc1.interfaces[0].ipv4 = [{ address: "10.0.0.1", prefix: 24 }];
    pc2.interfaces[0].ipv4 = [{ address: "10.0.0.2", prefix: 24 }];
    [pc1, pc2].forEach(rebuildConnectedRoutes);
    for (const s of [sw1, sw2]) {
      const pc = createInterface(`${s.id}-pc1`, "PortChannel1", "02:AA:00:00:00:0" + (s.id === "s1" ? "1" : "2"));
      pc.logical = true;
      pc.operState = "up";
      s.interfaces.push(pc);
    }
    const state: NetworkState = { devices: { s1: sw1, s2: sw2, pc1, pc2 }, connections: [] };
    linkInterfaces(state, { deviceId: "s1", interfaceId: "s1-if0" }, { deviceId: "s2", interfaceId: "s2-if0" });
    linkInterfaces(state, { deviceId: "s1", interfaceId: "s1-if1" }, { deviceId: "s2", interfaceId: "s2-if1" });
    linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "s1", interfaceId: "s1-if2" });
    linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "s2", interfaceId: "s2-if2" });
    let hashed = 0;
    registerDataPlaneHook({
      id: "test",
      ...off,
      lagOf: (d, i) => (/-if[01]$/.test(i.id) ? d.interfaces.find((x) => x.name === "PortChannel1") : undefined),
      egressMember: (d, l) => {
        if (l.name !== "PortChannel1") return undefined;
        hashed += 1;
        return d.interfaces.find((x) => x.id === `${d.id}-if1`);
      },
    });
    const r = new Simulation(state).runPing("pc1", "10.0.0.2", { count: 2 });
    expect(r.received).toBe(2);
    expect(hashed).toBeGreaterThan(0);
    // S2 learned PC1's MAC on the PortChannel, never on a member port.
    const e = sw2.macTable.find((m) => m.mac === pc1.interfaces[0].mac)!;
    expect(sw2.interfaces.find((i) => i.id === e.interfaceId)?.name).toBe("PortChannel1");
    // Only one member carried traffic (no duplicate floods over both cables).
    expect(sw2.interfaces[0].statistics.rxFrames).toBe(0);
  });

  it("virtual ports: bridgeInput learns on a virtual id; floods and known MACs reach it", () => {
    const { state, pc2, sw } = lan();
    const sent: string[] = [];
    registerDataPlaneHook({
      id: "test",
      ...off,
      flood: (_c, _s, ingressId, vid) => void sent.push(`flood vid${vid} from ${ingressId}`),
      forwardVirtual: (_c, _s, id) => (sent.push(`to ${id}`), true),
    });
    const sim = new Simulation(state);
    // A remote host behind a tunnel ARPs for PC2.
    bridgeInput(sim, sw, "vtep:9.9.9.9", 1, {
      id: "f1",
      ethernet: { srcMac: "02:00:00:00:99:99", dstMac: "FF:FF:FF:FF:FF:FF", etherType: "ARP" },
      arp: { op: "request", senderMac: "02:00:00:00:99:99", senderIp: "10.0.0.99", targetMac: "00:00:00:00:00:00", targetIp: "10.0.0.2" },
      meta: { sizeBytes: 64, summary: "ARP who-has 10.0.0.2" },
    });
    expect(sw.macTable.find((m) => m.mac === "02:00:00:00:99:99")?.interfaceId).toBe("vtep:9.9.9.9");
    expect(sent).toContain("flood vid1 from vtep:9.9.9.9"); // hook sees split-horizon source
    expect(pc2.arpTable.length + sent.length).toBeGreaterThan(0);
    // PC2's ARP reply to the remote MAC is forwarded to the virtual port.
    expect(sent).toContain("to vtep:9.9.9.9");
  });
});
