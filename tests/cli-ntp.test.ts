import "../lib/commands/sonic-cli/features/ntp"; // side-effect: register the ntp modal handler
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface NtpState {
  servers: string[];
  sourceInterface: string | undefined;
  vrf: string | undefined;
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

function ntp(device: Device): NtpState | undefined {
  return peekFeatureState<NtpState>(device, "ntp");
}

describe("sonic-cli ntp modal handler", () => {
  it("ntp server <ip> adds a server; no ntp server <ip> removes it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "ntp server 10.11.0.1",
      "ntp server 10.11.0.2",
      "exit",
    ]);
    expect(ntp(device)?.servers).toEqual(["10.11.0.1", "10.11.0.2"]);

    session(state, device, ["exec"], ["configure terminal", "no ntp server 10.11.0.1", "exit"]);
    expect(ntp(device)?.servers).toEqual(["10.11.0.2"]);
  });

  it("delegated `show ntp` reflects the configured servers", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "ntp server 10.11.0.1", "exit"]);
    const show = execute("show ntp", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toContain("10.11.0.1");
  });

  it("ntp source-interface joins the two KLISH tokens; `no` clears it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "ntp source-interface Ethernet 0", "exit"]);
    expect(ntp(device)?.sourceInterface).toBe("Ethernet0");

    session(state, device, ["exec"], ["configure terminal", "no ntp source-interface Ethernet 0", "exit"]);
    expect(ntp(device)?.sourceInterface).toBeUndefined();
  });

  it("ntp vrf sets the vrf; `no ntp vrf` clears it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "ntp vrf mgmt", "exit"]);
    expect(ntp(device)?.vrf).toBe("mgmt");

    session(state, device, ["exec"], ["configure terminal", "no ntp vrf", "exit"]);
    expect(ntp(device)?.vrf).toBeUndefined();
  });
});
