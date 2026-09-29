import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, resetIds, CaptureRecord, SimEvent } from "../lib/engine";
import { Route } from "../lib/models/route";
import { Device } from "../lib/models/device";
import { CommandContext, execute } from "../lib/commands";
import { useLabStore } from "../lib/store/lab-store";

const mk = (id: string, t: Device["type"], n: string, p?: number) => createDevice({ id, type: t, name: n, x: 0, y: 0, ports: p });

function direct(): { state: NetworkState; pc: Device } {
  resetMacCounter(1);
  resetIds();
  const pc = mk("pc", "pc", "PC");
  const dns = mk("dns", "dns-server", "DNS");
  pc.interfaces[0].ipv4 = [{ address: "10.0.0.2", prefix: 24 }];
  dns.interfaces[0].ipv4 = [{ address: "10.0.0.53", prefix: 24 }];
  pc.config.features = { dns: { nameservers: ["10.0.0.53"] } };
  dns.config.features = { dnsRecords: { "server1.lab": "10.0.0.9" } };
  [pc, dns].forEach(rebuildConnectedRoutes);
  const state: NetworkState = { devices: { pc, dns }, connections: [] };
  linkInterfaces(state, { deviceId: "pc", interfaceId: pc.interfaces[0].id }, { deviceId: "dns", interfaceId: dns.interfaces[0].id });
  return { state, pc };
}

function upstream(): { state: NetworkState; pc: Device } {
  resetMacCounter(1);
  resetIds();
  const pc = mk("pc", "pc", "PC");
  const r = mk("r", "router", "R", 2);
  const net = mk("net", "internet", "Internet");
  pc.interfaces[0].ipv4 = [{ address: "192.168.1.10", prefix: 24 }];
  pc.config.defaultGateway = "192.168.1.1";
  pc.config.features = { dns: { nameservers: ["8.8.8.8"] } };
  r.interfaces[0].ipv4 = [{ address: "192.168.1.1", prefix: 24 }];
  r.interfaces[1].ipv4 = [{ address: "203.0.113.1", prefix: 30 }];
  net.interfaces[0].ipv4 = [{ address: "203.0.113.2", prefix: 30 }];
  [pc, r, net].forEach(rebuildConnectedRoutes);
  const def = (nh: string, iface: string): Route => ({ destination: "0.0.0.0", prefix: 0, nextHop: nh, interfaceId: iface, type: "static", metric: 1 });
  r.routingTable.push(def("203.0.113.2", r.interfaces[1].id));
  net.routingTable.push(def("203.0.113.1", net.interfaces[0].id));
  const state: NetworkState = { devices: { pc, r, net }, connections: [] };
  linkInterfaces(state, { deviceId: "pc", interfaceId: pc.interfaces[0].id }, { deviceId: "r", interfaceId: r.interfaces[0].id });
  linkInterfaces(state, { deviceId: "r", interfaceId: r.interfaces[1].id }, { deviceId: "net", interfaceId: net.interfaces[0].id });
  return { state, pc };
}

const ctxFor = (state: NetworkState, device: Device): CommandContext => ({
  device, network: state, captures: [] as CaptureRecord[],
  runSim<T>(fn: (s: Simulation) => T) { const s = new Simulation(state); return { value: fn(s), events: s.events as SimEvent[] }; },
});

describe("DNS resolution (reach a nameserver over the network — same model as NTP)", () => {
  it("resolves an A record from a directly-connected dns-server", () => {
    const { state } = direct();
    const r = new Simulation(state).runDnsResolve("pc", "server1.lab");
    expect(r.ok).toBe(true);
    expect(r.address).toBe("10.0.0.9");
  });

  it("resolves via a PUBLIC nameserver reached by routing (internet upstream)", () => {
    const { state } = upstream();
    const r = new Simulation(state).runDnsResolve("pc", "google.com");
    expect(r.ok).toBe(true);
    expect(r.address).toMatch(/^198\.51\.100\./); // deterministic public IP
    // and it is pingable via the internet
    expect(new Simulation(state).runPing("pc", r.address!, { count: 1 }).received).toBe(1);
  });

  it("nslookup command prints the resolved address", () => {
    const { state, pc } = direct();
    const out = execute("nslookup server1.lab", ctxFor(state, pc)).output.map((o) => o.text).join("\n");
    expect(out).toContain("server1.lab");
    expect(out).toContain("10.0.0.9");
  });

  it("ping <hostname> resolves via DNS then pings the address", () => {
    const { state, pc } = upstream();
    const out = execute("ping -c 1 google.com", ctxFor(state, pc)).output.map((o) => o.text).join("\n");
    expect(out).toContain("resolved google.com");
    expect(out).toMatch(/1 received|bytes from/);
  });

  it("fails cleanly with no nameserver configured", () => {
    resetMacCounter(1);
    resetIds();
    const pc = mk("pc", "pc", "PC");
    pc.interfaces[0].ipv4 = [{ address: "10.0.0.2", prefix: 24 }];
    rebuildConnectedRoutes(pc);
    const state: NetworkState = { devices: { pc }, connections: [] };
    expect(new Simulation(state).runDnsResolve("pc", "x.lab").ok).toBe(false);
  });

  it("loadFeatureLab('dns') and ('dns-upstream') build working resolvers", () => {
    useLabStore.getState().newLab();
    useLabStore.getState().loadFeatureLab("dns");
    let net = useLabStore.getState().network;
    let pc = Object.values(net.devices).find((d) => d.type === "pc")!;
    expect(new Simulation(net).runDnsResolve(pc.id, "server1.lab").address).toBe("10.0.0.9");

    useLabStore.getState().newLab();
    useLabStore.getState().loadFeatureLab("dns-upstream");
    net = useLabStore.getState().network;
    pc = Object.values(net.devices).find((d) => d.type === "pc")!;
    expect(new Simulation(net).runDnsResolve(pc.id, "example.com").ok).toBe(true);
  });
});
