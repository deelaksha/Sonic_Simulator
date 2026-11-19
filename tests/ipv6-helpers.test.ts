/** IPv6 helpers: EUI-64 / SLAAC math, unsolicited NA (for VRRPv3), connected routes on switches. */
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, resetIds } from "../lib/engine";
import { linkLocalFromMac, slaacAddress, isMulticast6 } from "../lib/models/ipv6";
import { sendUnsolicitedNa, syncConnected6, multicastMac6 } from "../lib/protocols/ipv6";

describe("IPv6 helpers", () => {
  it("modified EUI-64 link-local and SLAAC addresses (RFC 4291 App. A, RFC 4862)", () => {
    expect(linkLocalFromMac("52:54:00:12:34:56")).toBe("fe80::5054:ff:fe12:3456");
    expect(slaacAddress("2001:db8:1::", "52:54:00:12:34:56")).toBe("2001:db8:1:0:5054:ff:fe12:3456"); // RFC 5952: a lone zero group stays
    expect(multicastMac6("ff02::5")).toBe("33:33:00:00:00:05");
    expect(isMulticast6("ff02::1")).toBe(true);
    expect(isMulticast6("fe80::1")).toBe(false);
  });

  it("sendUnsolicitedNa updates every neighbour's NDP cache to the new MAC", () => {
    resetMacCounter(1);
    resetIds();
    const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
    const pc2 = createDevice({ id: "pc2", type: "pc", name: "PC2", x: 0, y: 0 });
    const sw = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
    pc2.ndpTable = [{ ip: "2001:db8::1", mac: "AA:AA:AA:AA:AA:AA", interfaceId: "pc2-if0", state: "reachable" }];
    const state: NetworkState = { devices: { pc1, pc2, sw1: sw }, connections: [] };
    linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
    linkInterfaces(state, { deviceId: "pc2", interfaceId: "pc2-if0" }, { deviceId: "sw1", interfaceId: "sw1-if1" });
    const sim = new Simulation(state);
    sendUnsolicitedNa(sim, pc1, pc1.interfaces[0], "2001:db8::1", "00:00:5E:00:02:01");
    expect(pc2.ndpTable[0]).toMatchObject({ ip: "2001:db8::1", mac: "00:00:5E:00:02:01", state: "reachable" });
    expect(sim.events.some((e) => e.type === "NDP_ADVERTISEMENT" && e.frame?.ipv6?.dstIp === "ff02::1")).toBe(true);
  });

  it("syncConnected6 installs connected routes on a switch and keeps protocol routes", () => {
    resetMacCounter(1);
    const sw = createDevice({ id: "s", type: "switch", name: "S", x: 0, y: 0, ports: 2 });
    sw.interfaces[0].ipv6 = [{ address: "2001:db8:12::1", prefix: 64 }];
    sw.routingTable6 = [{ destination: "2001:db8:3::", prefix: 64, nextHop: "fe80::1", interfaceId: sw.interfaces[0].id, type: "bgp", metric: 0 }];
    expect(syncConnected6(sw)).toBe(true);
    expect(sw.routingTable6.map((r) => [r.type, r.destination])).toEqual([["connected", "2001:db8:12::"], ["bgp", "2001:db8:3::"]]);
    expect(syncConnected6(sw)).toBe(false);
  });
});
