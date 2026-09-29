import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features";
import { Simulation, resetIds, CaptureRecord, SimEvent } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { useLabStore } from "../lib/store/lab-store";
import { Device } from "../lib/models/device";
import { NetworkState } from "../lib/models/topology";
import { electMaster } from "../lib/protocols/vrrp";

function vrrpLab(): NetworkState {
  useLabStore.getState().newLab();
  useLabStore.getState().loadFeatureLab("vrrp");
  resetIds();
  return useLabStore.getState().network;
}
const dev = (net: NetworkState, name: string): Device => Object.values(net.devices).find((d) => d.name === name)!;
const ctxFor = (net: NetworkState, d: Device): CommandContext => ({
  device: d, network: net, captures: [] as CaptureRecord[],
  runSim<T>(fn: (s: Simulation) => T) { const s = new Simulation(net); return { value: fn(s), events: s.events as SimEvent[] }; },
});
const downLan = (r: Device) => { r.interfaces[0].adminState = "down"; r.interfaces[0].operState = "down"; r.interfaces[1].adminState = "down"; r.interfaces[1].operState = "down"; };

describe("VRRP gateway redundancy + failover (packet-plane)", () => {
  it("highest priority is Master; ping to the VIP is answered by the Master", () => {
    const net = vrrpLab();
    expect(electMaster(net, "10.0.0.1")?.device.name).toBe("R1");
    const pc = dev(net, "PC1");
    expect(new Simulation(net).runPing(pc.id, "10.0.0.1", { count: 1 }).received).toBe(1);
  });

  it("forwards through the virtual gateway to the server", () => {
    const net = vrrpLab();
    const pc = dev(net, "PC1");
    expect(new Simulation(net).runPing(pc.id, "10.9.9.9", { count: 1 }).received).toBe(1);
  });

  it("FAILOVER: when the Master's interfaces go down, the Backup takes over the VIP", () => {
    const net = vrrpLab();
    const pc = dev(net, "PC1");
    new Simulation(net).runPing(pc.id, "10.0.0.1", { count: 1 }); // prime (R1 master, switch learns vMAC→R1)
    downLan(dev(net, "R1"));
    expect(electMaster(net, "10.0.0.1")?.device.name).toBe("R2"); // re-elected
    // gratuitous ARP on failover keeps the same VIP reachable + forwarding works
    expect(new Simulation(net).runPing(pc.id, "10.0.0.1", { count: 1 }).received).toBe(1);
    expect(new Simulation(net).runPing(pc.id, "10.9.9.9", { count: 1 }).received).toBe(1);
  });

  it("FAILBACK: restoring the higher-priority router preempts back to Master", () => {
    const net = vrrpLab();
    const r1 = dev(net, "R1");
    downLan(r1);
    expect(electMaster(net, "10.0.0.1")?.device.name).toBe("R2");
    r1.interfaces.forEach((i) => { i.adminState = "up"; i.operState = "up"; });
    expect(electMaster(net, "10.0.0.1")?.device.name).toBe("R1");
    expect(new Simulation(net).runPing(dev(net, "PC1").id, "10.0.0.1", { count: 1 }).received).toBe(1);
  });

  it("emits a VRRP_FAILOVER event in the timeline when the master changes", () => {
    const net = vrrpLab();
    execute("vrrp", ctxFor(net, dev(net, "R1"))); // initial election records R1 as master
    downLan(dev(net, "R1"));
    const res = execute("vrrp", ctxFor(net, dev(net, "R2")));
    const failover = (res.events ?? []).find((e) => e.type === "VRRP_FAILOVER");
    expect(failover).toBeTruthy();
    expect(failover!.message).toMatch(/R1.*R2/); // R1 down → R2 takes over
  });

  it("`show vrrp` reflects the local router's role and flips on failover", () => {
    const net = vrrpLab();
    expect(execute("show vrrp", ctxFor(net, dev(net, "R1"))).output.map((o) => o.text).join("\n")).toContain("Master");
    expect(execute("show vrrp", ctxFor(net, dev(net, "R2"))).output.map((o) => o.text).join("\n")).toContain("Backup");
    downLan(dev(net, "R1"));
    expect(execute("show vrrp", ctxFor(net, dev(net, "R2"))).output.map((o) => o.text).join("\n")).toContain("Master");
  });
});
