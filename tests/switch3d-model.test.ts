/** 3D switch view model: faceplate state is derived from the live network (lib/switch3d/model.ts). */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { portViews, cpuView, recentFrames, frontPorts, fmtBps, chassisKind, hostView, routeRows } from "../lib/switch3d/model";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 19, 9, 0, 0));
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("switch3d model", () => {
  it("ports: link LED, cable peer, VLAN/IP, counters follow the network", () => {
    S().loadFeatureLab("ospf");
    advance(20_000);
    const s1 = byName("S1");
    const ports = portViews(s1, S().network);
    expect(ports.map((p) => p.name)).toEqual(frontPorts(s1).map((i) => i.name));
    const e0 = ports.find((p) => p.name === "Ethernet0")!;
    expect(e0).toMatchObject({ label: 1, oper: "up", led: "green", kind: "sfp", speedLabel: "25G", vlan: "routed" });
    expect(e0.peer).toMatchObject({ deviceName: "S2", ifName: "Ethernet0", deviceType: "switch" });
    expect(e0.ipv4).toEqual(["10.0.12.1/30"]);
    expect(e0.stats.txFrames).toBeGreaterThan(0); // OSPF hellos
    expect(e0.lldp?.sysName).toBeTruthy();
    // an unused port: no cable, no light
    const free = ports.find((p) => !p.peer)!;
    expect(free).toMatchObject({ oper: "down", led: "off" });
  });

  it("shutdown turns the LED off and is reported as admin down", () => {
    S().loadFeatureLab("ospf");
    S().runCliScript(byName("S1").id, ["configure terminal", "interface Ethernet 0", "shutdown", "end"]);
    const e0 = portViews(byName("S1"), S().network).find((p) => p.name === "Ethernet0")!;
    expect(e0).toMatchObject({ admin: "down", oper: "down", led: "off" });
  });

  it("LAG membership, drops and CPU trap counters come from the daemons", () => {
    S().loadFeatureLab("lacp");
    advance(5_000);
    const lagPort = portViews(byName("S1"), S().network).find((p) => p.lag);
    expect(lagPort?.lag).toMatchObject({ name: "PortChannel1", selected: true, static: false });
    const cpu = cpuView(byName("S1"));
    expect(cpu.totalTrapped).toBeGreaterThan(0); // LACPDUs / LLDPDUs trapped to the CPU
    expect(cpu.groups.some((g) => g.group.includes("lacp"))).toBe(true);
    expect(cpu.containers.map((c) => c.name)).toContain("teamd");
  });

  it("recent frames on a port, newest first", () => {
    S().loadFeatureLab("ospf");
    S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10");
    const s1 = byName("S1");
    const host = s1.interfaces.find((i) => i.name === "Ethernet2")!;
    const frames = recentFrames(S().captures, s1.id, host.id);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.some((f) => /ICMP|echo/i.test(f.frame.meta.summary))).toBe(true);
    expect(fmtBps(125_000)).toBe("1.00 Mb/s");
  });

  it("routers and hosts: chassis kind, host OS view and routing table", () => {
    expect([chassisKind("switch"), chassisKind("router"), chassisKind("firewall"), chassisKind("pc"), chassisKind("dhcp-server"), chassisKind("internet")]).toEqual(["switch", "router", "router", "pc", "server", "internet"]);
    S().loadFeatureLab("ospf");
    advance(20_000);
    S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10");
    const h1 = byName("H1");
    const hv = hostView(h1);
    expect(hv.addresses).toEqual(["192.168.1.10/24 (eth0)"]);
    expect(hv.gateway).toBe("192.168.1.1");
    expect(hv.arp.map((a) => a.ip)).toContain("192.168.1.1"); // learned while pinging
    const nic = portViews(h1, S().network)[0];
    expect(nic).toMatchObject({ name: "eth0", kind: "rj45", led: "green", oper: "up" }); // 1G NIC: green link LED
    expect(nic.peer?.deviceName).toBe("S1");
    const rr = routeRows(byName("S1"));
    expect(rr.some((r) => r.dest === "192.168.3.0/24" && r.type === "ospf")).toBe(true);
  });
});

describe("packet animation hops", () => {
  it("a ping across the OSPF lab yields ordered hops with ARP, request and reply styles", async () => {
    const { packetHops } = await import("../lib/switch3d/model");
    vi.useFakeTimers();
    resetAll();
    S().loadFeatureLab("ospf");
    advance(20_000);
    S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10");
    const hops = packetHops(S().events);
    const labels = hops.map((h) => h.label);
    expect(labels).toContain("ping request");
    expect(labels).toContain("ping reply");
    // the request leaves H1 first-ish and the reply ends at H1
    const firstReq = hops.find((h) => h.label === "ping request")!;
    expect(S().network.devices[firstReq.fromDeviceId].name).toBe("H1");
    const lastReply = [...hops].reverse().find((h) => h.label === "ping reply")!;
    expect(S().network.devices[lastReply.toDeviceId].name).toBe("H1");
    // every hop references a real connection
    const conns = S().network.connections;
    for (const h of hops) expect(conns.some((c) => [c.a.interfaceId, c.b.interfaceId].includes(h.fromIfaceId) && [c.a.interfaceId, c.b.interfaceId].includes(h.toIfaceId))).toBe(true);
    vi.useRealTimers();
  });
});

describe("packet path inside a device", () => {
  it("switch CPU only for frames to/from itself; transit stays in the ASIC; hosts always use the CPU", async () => {
    const { packetHops, hopUsesCpu } = await import("../lib/switch3d/model");
    vi.useFakeTimers();
    resetAll();
    S().loadFeatureLab("ospf");
    advance(20_000);
    S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10");
    const s1 = byName("S1");
    const h1 = byName("H1");
    const hops = packetHops(S().events);
    const arpIn = hops.find((h) => h.label === "ARP who-has" && h.toDeviceId === s1.id)!;
    const arpOut = hops.find((h) => h.label === "ARP reply" && h.fromDeviceId === s1.id)!;
    const transit = hops.find((h) => h.label === "ping request" && h.toDeviceId === s1.id)!;
    expect(hopUsesCpu(s1, arpIn, "in")).toBe(true); // ARP for S1's own 192.168.1.1
    expect(hopUsesCpu(s1, arpOut, "out")).toBe(true); // S1's CPU answers
    expect(hopUsesCpu(s1, transit, "in")).toBe(false); // routed by the ASIC towards S3
    expect(hopUsesCpu(h1, transit, "out")).toBe(true); // a host always sends from its OS
    vi.useRealTimers();
  });
});

describe("shared packet animation state", () => {
  it("one state for every view: start/advance/stop, speed and the replay counter", () => {
    resetAll();
    const a0 = S().packetAnim;
    S().startPacketAnim();
    expect(S().packetAnim).toMatchObject({ index: 0, run: a0.run + 1 });
    S().advancePacketAnim();
    S().advancePacketAnim();
    expect(S().packetAnim.index).toBe(2);
    S().setPacketSpeed(2);
    S().startPacketAnim(); // Replay from any view restarts it for all, keeping the speed
    expect(S().packetAnim).toMatchObject({ index: 0, speed: 2, run: a0.run + 2 });
    S().stopPacketAnim();
    expect(S().packetAnim.index).toBe(-1);
  });
});

describe("route summary", () => {
  it("ping across the OSPF triangle reads as the real paths", async () => {
    const { packetHops, routeSummary } = await import("../lib/switch3d/model");
    vi.useFakeTimers();
    resetAll();
    S().loadFeatureLab("ospf");
    advance(20_000);
    S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10");
    const name = (id: string) => S().network.devices[id].name;
    const r = routeSummary(packetHops(S().events), name);
    const of = (l: string) => r.find((x) => x.label === l)!.paths;
    expect(of("ping request")).toEqual(["H1 → S1 → S3 → H3"]);
    expect(of("ping reply")).toEqual(["H3 → S3 → S1 → H1"]);
    expect(of("ARP who-has")).toEqual(expect.arrayContaining(["H1 → S1"]));
    vi.useRealTimers();
  });
});

describe("cable colours", () => {
  it("a chosen colour is stored on the connection, shown on the port, kept by export/import, and Auto resets it", () => {
    resetAll();
    S().loadFeatureLab("ospf");
    const s1 = byName("S1");
    const e0 = portViews(s1, S().network).find((p) => p.name === "Ethernet0")!;
    const id = e0.peer!.connectionId!;
    expect(e0.peer!.cableColor).toBeUndefined(); // automatic by default
    S().setCableColor(id, "#f97316");
    expect(S().network.connections.find((c) => c.id === id)!.color).toBe("#f97316");
    expect(portViews(byName("S1"), S().network).find((p) => p.name === "Ethernet0")!.peer!.cableColor).toBe("#f97316");
    const json = S().exportLab();
    S().newLab();
    expect(S().importLab(json)).toBe(true);
    expect(S().network.connections.find((c) => c.id === id)!.color).toBe("#f97316");
    S().setCableColor(id, undefined);
    expect(S().network.connections.find((c) => c.id === id)!.color).toBeUndefined();
  });
});
