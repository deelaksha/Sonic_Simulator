import { describe, it, expect } from "vitest";
import { emptyNetwork } from "../lib/models/topology";
import { createDevice, rebuildConnectedRoutes } from "../lib/models/factory";
import { runSonicCli } from "../lib/commands/sonic-cli";
import { Simulation } from "../lib/engine/simulation";

describe("802.1Q Subinterface & Router-on-a-Stick", () => {
  it("creates subinterfaces and parses encapsulation and IP in sonic-cli", () => {
    const net = emptyNetwork();
    const router = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 4 });
    router.interfaces[0].operState = "up";
    net.devices[router.id] = router;

    const ctx = {
      device: router,
      network: net,
      captures: [],
      runSim: (fn: (sim: Simulation) => any) => ({ value: fn(new Simulation(net)), events: [] }),
    };

    // 1. Enter subinterface config mode (eth0.10 or Ethernet0.10)
    let stack = ["exec", "config"];
    let res = runSonicCli("interface eth0.10", stack, ctx as any);
    expect(res.stack[res.stack.length - 1]).toContain("gv:configure-subif-view|config-subif-eth0.10|eth0.10");

    stack = res.stack;

    // 2. Configure encapsulation dot1q vlan-id 10
    res = runSonicCli("encapsulation dot1q vlan-id 10", stack, ctx as any);
    expect(res.output.filter((o) => o.kind === "error")).toHaveLength(0);

    // 3. Configure ip address 192.168.10.1/24
    res = runSonicCli("ip address 192.168.10.1/24", stack, ctx as any);
    expect(res.output.filter((o) => o.kind === "error")).toHaveLength(0);

    // Check that subinterface exists on router
    const subif = router.interfaces.find((i) => i.name === "eth0.10");
    expect(subif).toBeDefined();
    expect(subif?.ipv4[0].address).toBe("192.168.10.1");
    expect(subif?.ipv4[0].prefix).toBe(24);
    expect(subif?.vlan.accessVlan).toBe(10);

    // Connected route should be installed for 192.168.10.0/24
    const route = router.routingTable.find((r) => r.destination === "192.168.10.0");
    expect(route).toBeDefined();
    expect(route?.interfaceId).toBe(subif?.id);
  });

  it("routes tagged 802.1Q traffic between subinterfaces", () => {
    const net = emptyNetwork();
    const router = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 4 });
    router.interfaces[0].operState = "up";

    // Create subinterfaces eth0.10 and eth0.20
    const ctx = {
      device: router,
      network: net,
      captures: [],
      runSim: (fn: (sim: Simulation) => any) => ({ value: fn(new Simulation(net)), events: [] }),
    };
    net.devices[router.id] = router;

    runSonicCli("interface eth0.10", ["exec", "config"], ctx as any);
    runSonicCli("encapsulation dot1q vlan-id 10", ["exec", "config", "gv:configure-subif-view|config-subif-eth0.10|eth0.10"], ctx as any);
    runSonicCli("ip address 192.168.10.1/24", ["exec", "config", "gv:configure-subif-view|config-subif-eth0.10|eth0.10"], ctx as any);

    runSonicCli("interface eth0.20", ["exec", "config"], ctx as any);
    runSonicCli("encapsulation dot1q vlan-id 20", ["exec", "config", "gv:configure-subif-view|config-subif-eth0.20|eth0.20"], ctx as any);
    runSonicCli("ip address 192.168.20.1/24", ["exec", "config", "gv:configure-subif-view|config-subif-eth0.20|eth0.20"], ctx as any);

    // Switch connected to router
    const sw = createDevice({ id: "sw", type: "switch", name: "SW", x: 0, y: 100, ports: 4 });
    // Port 0 to router (trunk: allowed 10, 20)
    sw.interfaces[0].vlan = { mode: "trunk", accessVlan: 1, nativeVlan: 1, allowedVlans: [10, 20] };
    sw.interfaces[0].operState = "up";
    // Port 1 to PC1 (access vlan 10)
    sw.interfaces[1].vlan = { mode: "access", accessVlan: 10, nativeVlan: 1, allowedVlans: [10] };
    sw.interfaces[1].operState = "up";
    // Port 2 to PC2 (access vlan 20)
    sw.interfaces[2].vlan = { mode: "access", accessVlan: 20, nativeVlan: 1, allowedVlans: [20] };
    sw.interfaces[2].operState = "up";
    net.devices[sw.id] = sw;

    // PC1 on VLAN 10
    const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: -100, y: 200, ports: 1 });
    pc1.interfaces[0].ipv4 = [{ address: "192.168.10.100", prefix: 24 }];
    pc1.config.defaultGateway = "192.168.10.1";
    pc1.interfaces[0].operState = "up";
    rebuildConnectedRoutes(pc1);
    net.devices[pc1.id] = pc1;

    // PC2 on VLAN 20
    const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 100, y: 200, ports: 1 });
    pc2.interfaces[0].ipv4 = [{ address: "192.168.20.100", prefix: 24 }];
    pc2.config.defaultGateway = "192.168.20.1";
    pc2.interfaces[0].operState = "up";
    rebuildConnectedRoutes(pc2);
    net.devices[pc2.id] = pc2;

    // Cables
    net.connections.push({
      id: "c-trunk",
      a: { deviceId: router.id, interfaceId: router.interfaces[0].id },
      b: { deviceId: sw.id, interfaceId: sw.interfaces[0].id },
      state: "up",
    });
    net.connections.push({
      id: "c-pc1",
      a: { deviceId: pc1.id, interfaceId: pc1.interfaces[0].id },
      b: { deviceId: sw.id, interfaceId: sw.interfaces[1].id },
      state: "up",
    });
    net.connections.push({
      id: "c-pc2",
      a: { deviceId: pc2.id, interfaceId: pc2.interfaces[0].id },
      b: { deviceId: sw.id, interfaceId: sw.interfaces[2].id },
      state: "up",
    });

    const sim = new Simulation(net);
    // PC1 pings its gateway on the router-on-a-stick subinterface
    const pingGw = sim.runPing(pc1.id, "192.168.10.1", { count: 2 });
    expect(pingGw.received).toBe(2);

    // PC1 pings PC2 across the router-on-a-stick subinterfaces (VLAN 10 -> VLAN 20)
    const pingInterVlan = sim.runPing(pc1.id, "192.168.20.100", { count: 2 });
    expect(pingInterVlan.received).toBe(2);
  });
});
