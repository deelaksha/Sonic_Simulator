import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features";
import { useLabStore } from "../lib/store/lab-store";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, resetIds } from "../lib/engine";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { CommandContext } from "../lib/commands";
import { Simulation as Sim, CaptureRecord, SimEvent } from "../lib/engine";
import { Device } from "../lib/models/device";

describe("DHCP relay (cross-subnet packet-plane)", () => {
  it("relays DISCOVER→OFFER→REQUEST→ACK across subnets; client leases from the client-subnet pool", () => {
    resetMacCounter(1);
    resetIds();
    const mk = (id: string, t: Device["type"], n: string, p?: number) => createDevice({ id, type: t, name: n, x: 0, y: 0, ports: p });
    const pc = mk("pc", "pc", "PC");
    const r = mk("r", "router", "R", 2);
    const srv = mk("srv", "dhcp-server", "SRV");
    r.interfaces[0].ipv4 = [{ address: "10.1.1.1", prefix: 24 }];
    r.interfaces[1].ipv4 = [{ address: "10.2.2.1", prefix: 24 }];
    srv.interfaces[0].ipv4 = [{ address: "10.2.2.10", prefix: 24 }];
    pc.config.defaultGateway = "10.1.1.1";
    srv.config.defaultGateway = "10.2.2.1";
    [pc, r, srv].forEach(rebuildConnectedRoutes);
    r.config.features = { dhcpRelay: { [r.interfaces[0].name]: ["10.2.2.10"] } };
    srv.config.features = { dhcpServer: { gateway: "10.2.2.10", dns: "10.2.2.10", prefix: 24, leases: {}, pools: [{ subnet: "10.1.1.0", prefix: 24, gateway: "10.1.1.1", dns: "10.1.1.1", leases: {} }] } };
    const state: NetworkState = { devices: { pc, r, srv }, connections: [] };
    linkInterfaces(state, { deviceId: "pc", interfaceId: pc.interfaces[0].id }, { deviceId: "r", interfaceId: r.interfaces[0].id });
    linkInterfaces(state, { deviceId: "r", interfaceId: r.interfaces[1].id }, { deviceId: "srv", interfaceId: srv.interfaces[0].id });

    const sim = new Simulation(state);
    const res = sim.runDhcp("pc", pc.interfaces[0].id);
    expect(res.success).toBe(true);
    expect(res.assignedIp).toBe("10.1.1.100"); // from the client-subnet pool, not the server subnet
    expect(res.gateway).toBe("10.1.1.1"); // the relay
    expect(sim.events.some((e) => e.type === "DHCP_RELAY")).toBe(true);
  });

  it("without a relay configured, cross-subnet DHCP fails (no server on the segment)", () => {
    resetMacCounter(1);
    resetIds();
    const pc = createDevice({ id: "pc", type: "pc", name: "PC", x: 0, y: 0 });
    const r = createDevice({ id: "r", type: "router", name: "R", x: 0, y: 0, ports: 2 });
    const srv = createDevice({ id: "srv", type: "dhcp-server", name: "SRV", x: 0, y: 0 });
    r.interfaces[0].ipv4 = [{ address: "10.1.1.1", prefix: 24 }];
    r.interfaces[1].ipv4 = [{ address: "10.2.2.1", prefix: 24 }];
    srv.interfaces[0].ipv4 = [{ address: "10.2.2.10", prefix: 24 }];
    [pc, r, srv].forEach(rebuildConnectedRoutes);
    const state: NetworkState = { devices: { pc, r, srv }, connections: [] };
    linkInterfaces(state, { deviceId: "pc", interfaceId: pc.interfaces[0].id }, { deviceId: "r", interfaceId: r.interfaces[0].id });
    linkInterfaces(state, { deviceId: "r", interfaceId: r.interfaces[1].id }, { deviceId: "srv", interfaceId: srv.interfaces[0].id });
    expect(new Simulation(state).runDhcp("pc", pc.interfaces[0].id).success).toBe(false);
  });

  it("loadFeatureLab('dhcprelay') builds a working relay topology", () => {
    useLabStore.getState().newLab();
    useLabStore.getState().loadFeatureLab("dhcprelay");
    const net = useLabStore.getState().network;
    const pc = Object.values(net.devices).find((d) => d.type === "pc")!;
    const r = Object.values(net.devices).find((d) => d.type === "router")!;
    expect((r.config.features?.dhcpRelay as Record<string, string[]>)[r.interfaces[0].name]).toContain("10.2.2.10");
    const res = new Simulation(net).runDhcp(pc.id, pc.interfaces[0].id);
    expect(res.success).toBe(true);
    expect(res.assignedIp).toBe("10.1.1.100");
  });

  it("`ip dhcp-relay <server>` in interface config stores structured relay config", () => {
    resetMacCounter(1);
    resetIds();
    const r = createDevice({ id: "r", type: "switch", name: "sonic", x: 0, y: 0, ports: 4 });
    const state: NetworkState = { devices: { r }, connections: [] };
    const ctxFor = (): CommandContext => ({ device: r, network: state, captures: [] as CaptureRecord[], runSim<T>(fn: (s: Sim) => T) { const s = new Simulation(state); return { value: fn(s), events: s.events as SimEvent[] }; } });
    let stack: CliStack = ["exec"];
    for (const c of ["configure terminal", "interface Ethernet 0", "ip dhcp-relay 10.9.9.9", "exit", "exit"]) {
      const res = runSonicCli(c, stack, ctxFor());
      stack = res.toBash ? [] : res.stack;
    }
    expect((r.config.features?.dhcpRelay as Record<string, string[]>)["Ethernet0"]).toContain("10.9.9.9");
    const show = runSonicCli("show ip dhcp-relay", ["exec"], ctxFor());
    expect(show.output.map((o) => o.text).join("\n")).toContain("10.9.9.9");
  });
});
