import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device, DeviceType } from "../lib/models/device";

function lab(clientHasIp: boolean) {
  resetMacCounter(1);
  resetIds();
  const mk = (id: string, type: DeviceType, name: string) => createDevice({ id, type, name, x: 0, y: 0 });
  const pc = mk("pc1", "pc", "PC1");
  const sw = mk("sw1", "switch", "SW1");
  const ntp = mk("ntp1", "ntp-server", "NTP1");
  const dhcp = mk("dh1", "dhcp-server", "DHCP1");
  if (clientHasIp) pc.interfaces[0].ipv4 = [{ address: "192.168.1.10", prefix: 24 }];
  ntp.interfaces[0].ipv4 = [{ address: "192.168.1.5", prefix: 24 }];
  dhcp.interfaces[0].ipv4 = [{ address: "192.168.1.1", prefix: 24 }];
  [pc, ntp, dhcp].forEach(rebuildConnectedRoutes);
  const state: NetworkState = { devices: { pc1: pc, sw1: sw, ntp1: ntp, dh1: dhcp }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
  linkInterfaces(state, { deviceId: "ntp1", interfaceId: "ntp1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if1" });
  linkInterfaces(state, { deviceId: "dh1", interfaceId: "dh1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if2" });
  return state;
}

function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (sim: Simulation) => T): { value: T; events: SimEvent[] } {
      const sim = new Simulation(state);
      const value = fn(sim);
      captures.push(...sim.captures);
      return { value, events: sim.events };
    },
  };
}

describe("NTP packet-plane (spec §23)", () => {
  it("syncs against an NTP server over UDP/123 with real ARP + routing", () => {
    const state = lab(true);
    const sim = new Simulation(state);
    const r = sim.runNtpSync("pc1", "192.168.1.5");
    expect(r.synced).toBe(true);
    expect(r.stratum).toBe(2);
    expect(typeof r.offsetMs).toBe("number");
    expect(sim.events.some((e) => e.type === "NTP_REQUEST")).toBe(true);
    expect(sim.events.some((e) => e.type === "NTP_RESPONSE")).toBe(true);
    // a real UDP/123 datagram crossed the wire
    expect(sim.events.some((e) => e.frame?.udp?.dstPort === 123)).toBe(true);
  });

  it("fails cleanly when the target does not run NTP / is unreachable", () => {
    const state = lab(true);
    const r = new Simulation(state).runNtpSync("pc1", "192.168.1.99");
    expect(r.synced).toBe(false);
    expect(r.reason).toBe("arp-failed"); // no host at .99 → next-hop ARP fails
  });

  it("ntpdate command reports offset/stratum", () => {
    const state = lab(true);
    const res = execute("ntpdate 192.168.1.5", ctxFor(state, state.devices.pc1));
    const text = res.output.map((o) => o.text).join("\n");
    expect(text).toContain("stratum 2");
    expect(text).toContain("offset");
  });
});

describe("DHCP DORA packet-plane (spec §22)", () => {
  it("assigns an address via Discover/Offer/Request/Ack and applies it", () => {
    const state = lab(false); // PC1 has no IP
    const sim = new Simulation(state);
    const r = sim.runDhcp("pc1", "pc1-if0");
    expect(r.success).toBe(true);
    expect(r.assignedIp).toBe("192.168.1.100");
    expect(r.gateway).toBe("192.168.1.1");
    expect(state.devices.pc1.interfaces[0].ipv4[0]).toEqual({ address: "192.168.1.100", prefix: 24 });
    // full DORA present
    for (const t of ["DHCP_DISCOVER", "DHCP_OFFER", "DHCP_REQUEST", "DHCP_ACK"]) {
      expect(sim.events.some((e) => e.type === t)).toBe(true);
    }
    // after DHCP the client can route (default gateway installed)
    expect(state.devices.pc1.config.defaultGateway).toBe("192.168.1.1");
  });

  it("fails with no-offer when there is no DHCP server on the LAN", () => {
    const state = lab(false);
    delete state.devices.dh1; // remove the DHCP server
    state.connections = state.connections.filter((c) => c.a.deviceId !== "dh1" && c.b.deviceId !== "dh1");
    const r = new Simulation(state).runDhcp("pc1", "pc1-if0");
    expect(r.success).toBe(false);
    expect(r.reason).toBe("no-offer");
  });

  it("dhclient command binds the interface", () => {
    const state = lab(false);
    const res = execute("dhclient eth0", ctxFor(state, state.devices.pc1));
    const text = res.output.map((o) => o.text).join("\n");
    expect(text).toContain("bound to 192.168.1.100");
  });
});
