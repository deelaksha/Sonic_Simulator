import { describe, it, expect } from "vitest";
import "../lib/commands/sonic-cli/features/dns"; // side-effect: register the DNS modal handler
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

/** Nameservers stored in the simulated CONFIG_DB (feature-state). */
function nameservers(device: Device): string[] {
  return (device.config.features?.dns as { nameservers: string[] } | undefined)?.nameservers ?? [];
}

describe("sonic-cli DNS modal CLI", () => {
  it("ip name-server adds nameservers reflected in device state and `show dns nameserver`", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "ip name-server 8.8.8.8",
      "ip name-server 1.1.1.1",
      "exit",
    ]);
    expect(nameservers(device)).toEqual(["8.8.8.8", "1.1.1.1"]);
    const show = execute("show dns nameserver", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("8.8.8.8");
    expect(show).toContain("1.1.1.1");
  });

  it("no ip name-server deletes a configured nameserver", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "ip name-server 8.8.8.8",
      "ip name-server 1.1.1.1",
      "no ip name-server 8.8.8.8",
      "exit",
    ]);
    expect(nameservers(device)).toEqual(["1.1.1.1"]);
  });

  it("rejects an invalid nameserver IP via the delegated Click command", () => {
    const { state, device } = sw();
    const r = runSonicCli("ip name-server 999.999.999.999", ["exec", "config"], ctxFor(state, device));
    expect(r.output.some((o) => o.kind === "error")).toBe(true);
    expect(nameservers(device)).toEqual([]);
  });

  it("ip name-server <ip> vrf mgmt still adds the nameserver (vrf not modelled)", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "ip name-server 9.9.9.9 vrf mgmt",
      "exit",
    ]);
    expect(nameservers(device)).toEqual(["9.9.9.9"]);
  });
});
