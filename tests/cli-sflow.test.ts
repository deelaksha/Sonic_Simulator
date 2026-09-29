import "../lib/commands/sonic-cli/features/sflow"; // side-effect: register the sflow modal handler
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

/** Run a sequence of modal lines, threading the mode stack. */
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

function showSflow(state: NetworkState, device: Device): string {
  return execute("show sflow", ctxFor(state, device)).output.map((o) => o.text).join("\n");
}

describe("sonic-cli sFlow", () => {
  it("sflow enable / no sflow enable toggle the global admin state", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "sflow enable", "exit"]);
    expect(showSflow(state, device)).toMatch(/sFlow Admin State: up/);
    session(state, device, ["exec"], ["configure terminal", "no sflow enable", "exit"]);
    expect(showSflow(state, device)).toMatch(/sFlow Admin State: down/);
  });

  it("sflow collector <ip> port <n> adds a collector; no sflow collector removes it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "sflow collector 1.1.1.1 port 4451", "exit"]);
    expect(showSflow(state, device)).toMatch(/Name: 1\.1\.1\.1 IP addr: 1\.1\.1\.1 UDP port: 4451/);
    session(state, device, ["exec"], ["configure terminal", "no sflow collector 1.1.1.1", "exit"]);
    expect(showSflow(state, device)).toMatch(/0 Collectors configured/);
  });

  it("sflow agent-id / polling-interval update global config and reset with no", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "sflow agent-id Ethernet0", "sflow polling-interval 30", "exit"]);
    const show = showSflow(state, device);
    expect(show).toMatch(/sFlow AgentID: Ethernet0/);
    expect(show).toMatch(/sFlow Polling Interval: 30/);
    session(state, device, ["exec"], ["configure terminal", "no sflow agent-id", "exit"]);
    expect(showSflow(state, device)).toMatch(/sFlow AgentID: default/);
  });

  it("interface sflow enable + sampling-rate configure the per-interface session", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "interface Ethernet 0",
      "sflow enable",
      "sflow sampling-rate 4000",
      "exit",
      "exit",
    ]);
    const show = execute("show sflow interface", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toMatch(/\|\s*Ethernet0\s*\|\s*up\s*\|\s*4000\s*\|/);
  });
});
