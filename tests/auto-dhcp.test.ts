/** PCs cabled in the topology editor get an address by DHCP unless set by hand (lib/models/auto-dhcp.ts). */
import { describe, it, expect, beforeEach } from "vitest";
import { useLabStore } from "../lib/store/lab-store";
import { Simulation } from "../lib/engine";
import { resetAll } from "./helpers";

const S = () => useLabStore.getState();
const dev = (id: string) => S().network.devices[id];
const ip = (id: string) => dev(id).interfaces[0].ipv4[0];

beforeEach(() => {
  resetAll();
  S().newLab();
});

describe("automatic DHCP for cabled PCs", () => {
  it("no DHCP server: PCs on one switch get addresses in the same fresh /24, and can ping", () => {
    const sw = S().addDevice("switch", { x: 0, y: 0 }, 4);
    const pc1 = S().addDevice("pc", { x: 0, y: 0 });
    const pc2 = S().addDevice("pc", { x: 0, y: 0 });
    S().connect(pc1, `${pc1}-if0`, sw, dev(sw).interfaces.find((i) => !i.management)!.id, { autoDhcp: true });
    S().connect(pc2, `${pc2}-if0`, sw, dev(sw).interfaces.filter((i) => !i.management)[1].id, { autoDhcp: true });
    expect(ip(pc1)).toEqual({ address: "192.168.1.10", prefix: 24 });
    expect(ip(pc2)).toEqual({ address: "192.168.1.11", prefix: 24 });
    expect(new Simulation(S().network).runPing(pc1, "192.168.1.11", { count: 1 }).received).toBe(1);
    expect(S().terminals[pc1].map((l) => l.text).join("\n")).toMatch(/lab DHCP \(simulated\) assigned 192\.168\.1\.10\/24/);
  });

  it("a router on the segment: address from its subnet, gateway set", () => {
    const r1 = S().addDevice("router", { x: 0, y: 0 }, 2);
    S().setInterfaceIp(r1, `${r1}-if0`, "10.5.5.1", 24);
    const pc = S().addDevice("pc", { x: 0, y: 0 });
    S().connect(pc, `${pc}-if0`, r1, `${r1}-if0`, { autoDhcp: true });
    expect(ip(pc)).toEqual({ address: "10.5.5.10", prefix: 24 });
    expect(dev(pc).config.defaultGateway).toBe("10.5.5.1");
  });

  it("a real DHCP server answers first (a real DISCOVER/OFFER/REQUEST/ACK exchange)", () => {
    const dh = S().addDevice("dhcp-server", { x: 0, y: 0 });
    S().setInterfaceIp(dh, `${dh}-if0`, "192.168.100.1", 24);
    const pc = S().addDevice("pc", { x: 0, y: 0 });
    S().connect(pc, `${pc}-if0`, dh, `${dh}-if0`, { autoDhcp: true });
    expect(ip(pc).address).toMatch(/^192\.168\.100\./);
    expect(S().events.some((e) => /DHCP/i.test(e.message))).toBe(true); // the exchange is on the timeline / animation
    expect(S().terminals[pc].map((l) => l.text).join("\n")).toMatch(/DHCPACK of 192\.168\.100\./);
  });

  it("manual addresses win: a static port is never touched; labs (no autoDhcp) are unaffected", () => {
    const sw = S().addDevice("switch", { x: 0, y: 0 }, 4);
    const pc = S().addDevice("pc", { x: 0, y: 0 });
    S().setInterfaceIp(pc, `${pc}-if0`, "172.16.0.5", 16);
    S().connect(pc, `${pc}-if0`, sw, dev(sw).interfaces.find((i) => !i.management)!.id, { autoDhcp: true });
    expect(ip(pc)).toEqual({ address: "172.16.0.5", prefix: 16 });
    const pc2 = S().addDevice("pc", { x: 0, y: 0 });
    S().connect(pc2, `${pc2}-if0`, sw, dev(sw).interfaces.filter((i) => !i.management)[1].id); // lab-style connect
    expect(dev(pc2).interfaces[0].ipv4).toEqual([]);
  });
});
