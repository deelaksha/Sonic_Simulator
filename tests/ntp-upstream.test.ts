import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, resetIds } from "../lib/engine";
import { Route } from "../lib/models/route";
import { Device } from "../lib/models/device";
import { useLabStore } from "../lib/store/lab-store";

function upstreamTopo(): NetworkState {
  resetMacCounter(1);
  resetIds();
  const mk = (id: string, t: Device["type"], n: string, p?: number) => createDevice({ id, type: t, name: n, x: 0, y: 0, ports: p });
  const pc = mk("pc", "pc", "PC");
  const r = mk("r", "router", "R", 2);
  const net = mk("net", "internet", "Internet");
  pc.interfaces[0].ipv4 = [{ address: "192.168.1.10", prefix: 24 }];
  pc.config.defaultGateway = "192.168.1.1";
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
  return state;
}

describe("NTP upstream over the network (routed) + internet upstream", () => {
  it("syncs to a PUBLIC NTP IP reached via routing through the internet node", () => {
    const res = new Simulation(upstreamTopo()).runNtpSync("pc", "216.239.35.0");
    expect(res.synced).toBe(true);
    expect(res.stratum).toBe(2);
  });

  it("the internet node answers ping to any public IP (from that IP)", () => {
    const r = new Simulation(upstreamTopo()).runPing("pc", "8.8.8.8", { count: 1 });
    expect(r.received).toBe(1);
  });

  it("router preserves the UDP payload across a hop (regression: NTP survived forwarding)", () => {
    // Same as above but proves the frame's ntp payload reached the far side.
    const sim = new Simulation(upstreamTopo());
    sim.runNtpSync("pc", "216.239.35.0");
    expect(sim.events.some((e) => e.deviceName === "Internet" && /NTP/i.test(e.message))).toBe(true);
    expect(sim.events.some((e) => e.message.includes("no listener for UDP"))).toBe(false);
  });

  it("loadFeatureLab('ntp-upstream') builds a working routed-NTP topology", () => {
    useLabStore.getState().newLab();
    useLabStore.getState().loadFeatureLab("ntp-upstream");
    const net = useLabStore.getState().network;
    const pc = Object.values(net.devices).find((d) => d.type === "pc")!;
    expect(new Simulation(net).runNtpSync(pc.id, "216.239.35.0").synced).toBe(true);
  });
});
