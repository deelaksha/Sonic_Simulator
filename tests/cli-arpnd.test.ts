import "../lib/commands/sonic-cli/features/arpnd"; // register the arpnd modal handler
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

function sw(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { state: { devices: { sw1: device }, connections: [] }, device };
}

function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (s: Simulation) => T): { value: T; events: SimEvent[] } {
      const s = new Simulation(state);
      return { value: fn(s), events: s.events };
    },
  };
}

/** Run a sequence of modal lines, threading the mode stack; return combined text. */
function session(state: NetworkState, device: Device, start: CliStack, lines: string[]): { stack: CliStack; text: string } {
  let stack = start;
  const out: string[] = [];
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    out.push(...r.output.map((o) => o.text));
    stack = r.toBash ? [] : r.stack;
  }
  return { stack, text: out.join("\n") };
}

describe("sonic-cli arpnd (static ARP)", () => {
  it("ip arp <ip> <mac> adds a static ARP entry on the current interface", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "ip arp 10.0.0.5 00:11:22:33:44:55",
      "exit",
      "exit",
    ]);
    const eth0 = device.interfaces.find((i) => i.name === "Ethernet0");
    const entry = device.arpTable.find((e) => e.ip === "10.0.0.5");
    expect(entry).toBeDefined();
    expect(entry?.mac).toBe("00:11:22:33:44:55");
    expect(entry?.interfaceId).toBe(eth0?.id);
    expect(entry?.state).toBe("reachable");
  });

  it("the static entry is reflected by the delegated `show ip arp`", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "ip arp 192.168.1.9 aa:bb:cc:dd:ee:ff",
    ]);
    const show = execute("show ip arp", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("192.168.1.9");
    expect(show).toContain("aa:bb:cc:dd:ee:ff");
  });

  it("no ip arp is not wired (Click has no per-entry delete) and leaves the entry intact", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "ip arp 10.0.0.5 00:11:22:33:44:55",
      "no ip arp 10.0.0.5 00:11:22:33:44:55",
    ]);
    // per-entry delete has no Click equivalent, so the entry must still be present
    expect(device.arpTable.some((e) => e.ip === "10.0.0.5")).toBe(true);
  });
});
