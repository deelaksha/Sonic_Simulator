import "../lib/commands/sonic-cli/features/staticroute";
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
  // Give Ethernet0 an address so the next hop 192.168.200.1 is directly reachable
  // (config route add resolves the egress interface by the next hop's subnet).
  device.interfaces.find((i) => i.name === "Ethernet0")!.ipv4.push({ address: "192.168.200.2", prefix: 24 });
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

const staticRoutes = (device: Device) => device.routingTable.filter((r) => r.type === "static");

describe("sonic-cli static-route modal", () => {
  it("ip route <prefix> <nexthop> installs an IPv4 static route (default VRF)", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "ip route 100.1.1.0/24 192.168.200.1", "exit"]);
    expect(staticRoutes(device)).toEqual([
      expect.objectContaining({ destination: "100.1.1.0", prefix: 24, nextHop: "192.168.200.1", type: "static" }),
    ]);
    // The delegated `show ip route` reflects the new route.
    const show = execute("show ip route", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("100.1.1.0/24 via 192.168.200.1");
  });

  it("no ip route <prefix> <nexthop> removes the static route", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "ip route 100.1.1.0/24 192.168.200.1",
      "no ip route 100.1.1.0/24 192.168.200.1",
      "exit",
    ]);
    expect(staticRoutes(device)).toEqual([]);
  });

  it("ip route with an unreachable next hop is rejected by the delegated Click command", () => {
    const { state, device } = sw();
    // 10.10.10.1 is on no interface's subnet, so config route add refuses it.
    const res = session(state, device, ["exec"], ["configure terminal", "ip route 100.1.1.0/24 10.10.10.1", "exit"]);
    expect(res.text).toMatch(/no interface on the subnet/i);
    expect(staticRoutes(device)).toEqual([]);
  });

  it("ip route vrf <name> ... is not wired (Click has no VRF support) and adds nothing", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "ip route vrf Vrf1 100.1.1.0/24 192.168.200.1", "exit"]);
    expect(staticRoutes(device)).toEqual([]);
  });
});
