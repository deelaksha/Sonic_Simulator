import { describe, it, expect } from "vitest";
import { emptyNetwork, Connection } from "../lib/models/topology";
import { createDevice } from "../lib/models/factory";
import { computeStp, getStpPortState } from "../lib/protocols/stp-daemon";
import { Simulation } from "../lib/engine/simulation";
import { buildFrame } from "../lib/protocols/ethernet";
import { BROADCAST_MAC } from "../lib/models/mac";
import { runSonicCli } from "../lib/commands/sonic-cli";

describe("Spanning Tree Protocol (STP) & Loop Resolution", () => {
  it("elects root bridge based on lowest priority and mac", () => {
    const net = emptyNetwork();
    const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
    sw1.interfaces[0].mac = "00:aa:00:00:00:01";
    sw1.config.features = { stp: { priority: 4096 } };

    const sw2 = createDevice({ id: "sw2", type: "switch", name: "SW2", x: 100, y: 0, ports: 4 });
    sw2.interfaces[0].mac = "00:bb:00:00:00:02";
    sw2.config.features = { stp: { priority: 32768 } };

    net.devices[sw1.id] = sw1;
    net.devices[sw2.id] = sw2;

    // Connect SW1 Ethernet0 <-> SW2 Ethernet0
    const conn1: Connection = {
      id: "c1",
      a: { deviceId: sw1.id, interfaceId: sw1.interfaces[0].id },
      b: { deviceId: sw2.id, interfaceId: sw2.interfaces[0].id },
      state: "up",
    };
    sw1.interfaces[0].operState = "up";
    sw2.interfaces[0].operState = "up";
    net.connections.push(conn1);

    const stpMap = computeStp(net);
    expect(stpMap["sw1"]).toBeDefined();
    expect(stpMap["sw1"].isRoot).toBe(true);
    expect(stpMap["sw2"]).toBeDefined();
    expect(stpMap["sw2"].isRoot).toBe(false);
    expect(stpMap["sw2"].rootBridgeId).toBe("4096.00:AA:00:00:00:01");
    expect(stpMap["sw2"].ports[sw2.interfaces[0].id].role).toBe("Root");
    expect(stpMap["sw2"].ports[sw2.interfaces[0].id].state).toBe("FORWARDING");
  });

  it("blocks redundant link in a two-switch loop", () => {
    const net = emptyNetwork();
    const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
    sw1.interfaces[0].mac = "00:11:00:00:00:01";
    sw1.config.features = { stp: { priority: 4096 } }; // Root

    const sw2 = createDevice({ id: "sw2", type: "switch", name: "SW2", x: 100, y: 0, ports: 4 });
    sw2.interfaces[0].mac = "00:22:00:00:00:02";
    sw2.config.features = { stp: { priority: 32768 } };

    net.devices[sw1.id] = sw1;
    net.devices[sw2.id] = sw2;

    // Link 1: SW1 Eth0 <-> SW2 Eth0
    net.connections.push({
      id: "c1",
      a: { deviceId: sw1.id, interfaceId: sw1.interfaces[0].id },
      b: { deviceId: sw2.id, interfaceId: sw2.interfaces[0].id },
      state: "up",
    });
    sw1.interfaces[0].operState = "up";
    sw2.interfaces[0].operState = "up";

    // Link 2: SW1 Eth1 <-> SW2 Eth1 (Redundant loop link!)
    net.connections.push({
      id: "c2",
      a: { deviceId: sw1.id, interfaceId: sw1.interfaces[1].id },
      b: { deviceId: sw2.id, interfaceId: sw2.interfaces[1].id },
      state: "up",
    });
    sw1.interfaces[1].operState = "up";
    sw2.interfaces[1].operState = "up";

    const stpMap = computeStp(net);
    const sw1Oper = stpMap["sw1"];
    const sw2Oper = stpMap["sw2"];

    // SW1 is root: both ports are Designated and FORWARDING
    expect(sw1Oper.isRoot).toBe(true);
    expect(sw1Oper.ports[sw1.interfaces[0].id].state).toBe("FORWARDING");
    expect(sw1Oper.ports[sw1.interfaces[1].id].state).toBe("FORWARDING");

    // SW2 is non-root: Eth0 is Root Port (FORWARDING), Eth1 is Alternate Port (BLOCKING!)
    expect(sw2Oper.ports[sw2.interfaces[0].id].role).toBe("Root");
    expect(sw2Oper.ports[sw2.interfaces[0].id].state).toBe("FORWARDING");
    expect(sw2Oper.ports[sw2.interfaces[1].id].role).toBe("Alternate");
    expect(sw2Oper.ports[sw2.interfaces[1].id].state).toBe("BLOCKING");
    expect(getStpPortState(sw2, sw2.interfaces[1].id, net)).toBe("BLOCKING");
  });

  it("prevents broadcast loops when redundant links exist", () => {
    const net = emptyNetwork();
    const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
    sw1.interfaces[0].mac = "00:11:00:00:00:01";
    sw1.config.features = { stp: { priority: 4096 } };

    const sw2 = createDevice({ id: "sw2", type: "switch", name: "SW2", x: 100, y: 0, ports: 4 });
    sw2.interfaces[0].mac = "00:22:00:00:00:02";
    sw2.config.features = { stp: { priority: 32768 } };

    // Host connected to SW1 Eth2
    const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: -100, y: 0, ports: 1 });
    pc1.interfaces[0].ipv4 = [{ address: "192.168.1.10", prefix: 24 }];
    pc1.interfaces[0].operState = "up";

    net.devices[sw1.id] = sw1;
    net.devices[sw2.id] = sw2;
    net.devices[pc1.id] = pc1;

    // Cable PC1 Eth0 <-> SW1 Eth2
    net.connections.push({
      id: "c-pc1",
      a: { deviceId: pc1.id, interfaceId: pc1.interfaces[0].id },
      b: { deviceId: sw1.id, interfaceId: sw1.interfaces[2].id },
      state: "up",
    });
    sw1.interfaces[2].operState = "up";

    // Dual cable between SW1 and SW2 (loop!)
    net.connections.push({
      id: "c-loop1",
      a: { deviceId: sw1.id, interfaceId: sw1.interfaces[0].id },
      b: { deviceId: sw2.id, interfaceId: sw2.interfaces[0].id },
      state: "up",
    });
    sw1.interfaces[0].operState = "up";
    sw2.interfaces[0].operState = "up";

    net.connections.push({
      id: "c-loop2",
      a: { deviceId: sw1.id, interfaceId: sw1.interfaces[1].id },
      b: { deviceId: sw2.id, interfaceId: sw2.interfaces[1].id },
      state: "up",
    });
    sw1.interfaces[1].operState = "up";
    sw2.interfaces[1].operState = "up";

    const sim = new Simulation(net);
    // PC1 transmits a broadcast frame into SW1
    const bcastFrame = buildFrame(
      {
        srcMac: pc1.interfaces[0].mac,
        dstMac: BROADCAST_MAC,
        etherType: "ARP",
        payloadBytes: 28,
        summary: "ARP who-has 192.168.1.20",
      },
      {
        arp: {
          op: "request",
          senderMac: pc1.interfaces[0].mac,
          senderIp: "192.168.1.10",
          targetMac: "00:00:00:00:00:00",
          targetIp: "192.168.1.20",
        },
      },
    );

    sim.transmit(pc1.id, pc1.interfaces[0].id, bcastFrame);

    // Verify simulation completed cleanly without hitting runaway limit
    expect(sim.events.length).toBeLessThan(50);
    // Verify frame was dropped on the blocked port
    const dropEvents = sim.events.filter((e) => e.type === "FRAME_DROPPED" && e.message.includes("STP port in BLOCKING state"));
    expect(dropEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("renders show spanning-tree in sonic-cli", () => {
    const net = emptyNetwork();
    const sw = createDevice({ id: "sw", type: "switch", name: "sonic", x: 0, y: 0, ports: 4 });
    sw.interfaces[0].operState = "up";
    net.devices[sw.id] = sw;

    const ctx = {
      device: sw,
      network: net,
      captures: [],
      runSim: (fn: (sim: Simulation) => any) => ({ value: fn(new Simulation(net)), events: [] }),
    };

    const res = runSonicCli("show spanning-tree", ["exec"], ctx as any);
    expect(res.output.some((o) => o.text.includes("Spanning-tree Mode:"))).toBe(true);
    expect(res.output.some((o) => o.text.includes("Root Bridge ID:"))).toBe(true);
    expect(res.output.some((o) => o.text.includes("This bridge is the root"))).toBe(true);
    expect(res.output.some((o) => o.text.includes("Ethernet0"))).toBe(true);
  });
});
