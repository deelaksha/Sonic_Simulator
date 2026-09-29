import { describe, it, expect, beforeEach } from "vitest";
import { useLabStore } from "../lib/store/lab-store";
import { Simulation } from "../lib/engine";
import { Device } from "../lib/models/device";
import { implementedSonicFeatures } from "../lib/commands/sonic";

const S = () => useLabStore.getState();
const net = () => S().network;
const devicesOfType = (t: string): Device[] => Object.values(net().devices).filter((d) => d.type === t);
const firstPc = () => devicesOfType("pc")[0];

describe("SONiC feature labs (loadFeatureLab)", () => {
  beforeEach(() => S().newLab());

  it("bgp lab converges and cross-AS ping works", () => {
    S().loadFeatureLab("bgp");
    const pc1 = firstPc();
    expect(new Simulation(net()).runPing(pc1.id, "10.2.2.10", { count: 1 }).received).toBe(0);
    const sum = new Simulation(net()).runBgp();
    expect(sum.sessions).toBe(2);
    const after = new Simulation(net()).runPing(pc1.id, "10.2.2.10", { count: 1 });
    expect(after.received).toBe(1);
  });

  it("ospf lab forms adjacencies and cross-router ping works", () => {
    S().loadFeatureLab("ospf");
    const pc1 = firstPc();
    const sum = new Simulation(net()).runOspf();
    expect(sum.adjacencies).toBeGreaterThanOrEqual(2);
    expect(new Simulation(net()).runPing(pc1.id, "10.2.2.10", { count: 1 }).received).toBe(1);
  });

  it("ipv6 lab: ping6 between the two PCs works", () => {
    S().loadFeatureLab("ipvx");
    const pc1 = firstPc();
    expect(new Simulation(net()).runPing6(pc1.id, "2001:db8::2", { count: 1 }).received).toBe(1);
  });

  it("ntp lab: client syncs to the ntp-server", () => {
    S().loadFeatureLab("ntp");
    expect(new Simulation(net()).runNtpSync(firstPc().id, "192.168.100.10").synced).toBe(true);
  });

  it("dhcp lab: client leases an address from the dhcp-server", () => {
    S().loadFeatureLab("dhcp");
    const pc1 = firstPc();
    const r = new Simulation(net()).runDhcp(pc1.id, `${pc1.id}-if0`);
    expect(r.success).toBe(true);
    expect(r.assignedIp).toMatch(/^192\.168\.100\./);
  });

  it("staticroute lab builds two routers and two PCs", () => {
    S().loadFeatureLab("staticroute");
    expect(devicesOfType("router")).toHaveLength(2);
    expect(devicesOfType("pc")).toHaveLength(2);
  });

  it("config-plane features load a sandbox with a relevant device selected", () => {
    S().loadFeatureLab("snmp"); // non-L3 → switch sandbox
    expect(net().devices[S().selectedDeviceId!].type).toBe("switch");
    S().loadFeatureLab("vrf"); // L3 → routing sandbox
    expect(net().devices[S().selectedDeviceId!].type).toBe("router");
  });

  it("every implemented feature loads some lab without throwing", () => {
    for (const id of implementedSonicFeatures()) {
      S().newLab();
      expect(() => S().loadFeatureLab(id)).not.toThrow();
      expect(Object.keys(net().devices).length).toBeGreaterThan(0);
    }
  });
});
