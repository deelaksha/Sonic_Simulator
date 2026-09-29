import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import "../lib/commands/sonic-cli/features/lacp"; // side-effect: registers the handler
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface LacpState {
  portchannels: { name: string; members: string[] }[];
}

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

describe("sonic-cli LACP channel-group (member management)", () => {
  it("channel-group <id> adds the physical interface as a member (delegates Click member add)", () => {
    const { state, device } = sw();
    execute("config portchannel add PortChannel1", ctxFor(state, device)); // LAG created via Click
    const { text } = session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "channel-group 1",
      "exit",
      "exit",
    ]);
    expect(text).toContain("Ethernet0 added to PortChannel1");
    const pc = peekFeatureState<LacpState>(device, "lacp")?.portchannels.find((p) => p.name === "PortChannel1");
    expect(pc?.members).toContain("Ethernet0");
  });

  it("no channel-group removes the interface from its PortChannel (owner looked up from state)", () => {
    const { state, device } = sw();
    execute("config portchannel add PortChannel1", ctxFor(state, device));
    session(state, device, ["exec"], ["configure terminal", "interface Ethernet 0", "channel-group 1", "exit", "exit"]);
    const { text } = session(state, device, ["exec"], ["configure terminal", "interface Ethernet 0", "no channel-group", "exit", "exit"]);
    expect(text).toContain("Ethernet0 removed from PortChannel1");
    const pc = peekFeatureState<LacpState>(device, "lacp")?.portchannels.find((p) => p.name === "PortChannel1");
    expect(pc?.members ?? []).not.toContain("Ethernet0");
  });

  it("channel-group to a non-existent PortChannel surfaces the delegated Click error", () => {
    const { state, device } = sw();
    const { text } = session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "channel-group 5",
      "exit",
      "exit",
    ]);
    expect(text).toContain("PortChannel5 does not exist");
    expect(peekFeatureState<LacpState>(device, "lacp")?.portchannels ?? []).toHaveLength(0);
  });

  it("channel-group without an id is rejected (does not delegate)", () => {
    const { state, device } = sw();
    const r = runSonicCli("channel-group", ["exec", "config", "if-Ethernet0"], ctxFor(state, device));
    expect(r.output.some((o) => o.kind === "error")).toBe(true);
  });
});
