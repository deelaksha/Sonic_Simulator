/** 3D switch view model: faceplate state is derived from the live network (lib/switch3d/model.ts). */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { portViews, cpuView, recentFrames, frontPorts, fmtBps } from "../lib/switch3d/model";
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
});
