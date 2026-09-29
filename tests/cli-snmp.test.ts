import "../lib/commands/sonic-cli/features/snmp"; // side-effect: registers the SNMP modal handler
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

describe("sonic-cli SNMP modal behaviour", () => {
  it("snmp-server location / contact set device state; `no` clears it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "snmp-server location Lab1-Rack10",
      "snmp-server contact NetOps",
      "exit",
    ]);
    const feat = device.config.features?.snmp as { location?: string; contact?: string };
    expect(feat.location).toBe("Lab1-Rack10");
    expect(feat.contact).toBe("NetOps");
    // A delegated `show snmp` reflects the stored state.
    const show = execute("show snmp", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toMatch(/Location\s*:\s*Lab1-Rack10/);
    expect(show).toMatch(/Contact\s*:\s*NetOps/);

    session(state, device, ["exec"], ["configure terminal", "no snmp-server location", "no snmp-server contact", "exit"]);
    const cleared = device.config.features?.snmp as { location?: string; contact?: string };
    expect(cleared.location).toBeUndefined();
    expect(cleared.contact).toBeUndefined();
  });

  it("snmp-server community adds a community; no snmp-server community removes it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "snmp-server community comm1", "snmp-server community comm2", "exit"]);
    let communities = (device.config.features?.snmp as { communities: { name: string }[] }).communities;
    expect(communities.map((c) => c.name).sort()).toEqual(["comm1", "comm2"]);
    const show = execute("show snmp community", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toMatch(/comm1/);

    session(state, device, ["exec"], ["configure terminal", "no snmp-server community comm1", "exit"]);
    communities = (device.config.features?.snmp as { communities: { name: string }[] }).communities;
    expect(communities.map((c) => c.name)).toEqual(["comm2"]);
  });

  it("snmp-server community optional `group` is accepted; community still created (group dropped)", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "snmp-server community labcomm group group-lab", "exit"]);
    const communities = (device.config.features?.snmp as { communities: { name: string }[] }).communities;
    expect(communities.map((c) => c.name)).toEqual(["labcomm"]);
  });

  it("snmp-server user adds a user; no snmp-server user removes it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "snmp-server user user1", "exit"]);
    let users = (device.config.features?.snmp as { users: { name: string }[] }).users;
    expect(users.map((u) => u.name)).toEqual(["user1"]);

    session(state, device, ["exec"], ["configure terminal", "no snmp-server user user1", "exit"]);
    users = (device.config.features?.snmp as { users: { name: string }[] }).users;
    expect(users).toEqual([]);
  });
});
