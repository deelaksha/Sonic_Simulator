import { describe, it, expect } from "vitest";
import { emptyNetwork } from "../lib/models/topology";
import { createDevice, rebuildConnectedRoutes } from "../lib/models/factory";
import { execute } from "../lib/commands";
import { Simulation } from "../lib/engine/simulation";

describe("ss / netstat & curl commands", () => {
  it("displays listening sockets with ss and netstat", () => {
    const net = emptyNetwork();
    const router = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 4 });
    router.config.features = {
      bgp: { asn: 65001 },
      dns: { nameservers: ["8.8.8.8"] },
      ntp: { servers: ["pool.ntp.org"] },
    };
    net.devices[router.id] = router;

    const ctx = {
      device: router,
      network: net,
      captures: [],
      runSim: (fn: (sim: Simulation) => any) => ({ value: fn(new Simulation(net)), events: [] }),
    };

    const resSs = execute("ss -tuln", ctx as any);
    expect(resSs.output.some((o) => o.text.includes("0.0.0.0:22"))).toBe(true);
    expect(resSs.output.some((o) => o.text.includes("0.0.0.0:179"))).toBe(true);
    expect(resSs.output.some((o) => o.text.includes("0.0.0.0:53"))).toBe(true);
    expect(resSs.output.some((o) => o.text.includes("0.0.0.0:123"))).toBe(true);

    const resNetstat = execute("netstat -tuln", ctx as any);
    expect(resNetstat.output.some((o) => o.text.includes("0.0.0.0:179"))).toBe(true);
  });

  it("fetches web content with curl across routed network", () => {
    const net = emptyNetwork();
    const server = createDevice({ id: "srv", type: "server", name: "webserver", x: 100, y: 0, ports: 1 });
    server.interfaces[0].ipv4 = [{ address: "192.168.1.50", prefix: 24 }];
    server.interfaces[0].operState = "up";
    rebuildConnectedRoutes(server);

    const client = createDevice({ id: "client", type: "pc", name: "client", x: -100, y: 0, ports: 1 });
    client.interfaces[0].ipv4 = [{ address: "192.168.1.10", prefix: 24 }];
    client.interfaces[0].operState = "up";
    rebuildConnectedRoutes(client);

    net.devices[server.id] = server;
    net.devices[client.id] = client;

    // Direct link between client and server
    net.connections.push({
      id: "c1",
      a: { deviceId: client.id, interfaceId: client.interfaces[0].id },
      b: { deviceId: server.id, interfaceId: server.interfaces[0].id },
      state: "up",
    });

    const ctx = {
      device: client,
      network: net,
      captures: [],
      runSim: (fn: (sim: Simulation) => any) => {
        const sim = new Simulation(net);
        const val = fn(sim);
        return { value: val, events: sim.events };
      },
    };

    // Test curl -I (head request)
    const resHead = execute("curl -I http://192.168.1.50", ctx as any);
    expect(resHead.output.some((o) => o.text.includes("HTTP/1.1 200 OK"))).toBe(true);
    expect(resHead.output.some((o) => o.text.includes("Server: nginx"))).toBe(true);

    // Test curl GET (full body)
    const resGet = execute("curl http://192.168.1.50", ctx as any);
    expect(resGet.output.some((o) => o.text.includes("Welcome to SONiC Simulator Web Server!"))).toBe(true);

    // Test curl unreachable host
    const resFail = execute("curl http://10.254.254.254", ctx as any);
    expect(resFail.output.some((o) => o.text.includes("Failed to connect") || o.text.includes("unreachable"))).toBe(true);
  });
});
