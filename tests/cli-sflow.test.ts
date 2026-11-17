import "../lib/commands/sonic-cli/features/sflow"; // side-effect: register the sflow modal handlers
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

// KLISH sFlow — expectations from sonic-mgmt-framework sflow.xml,
// sonic_cli_sflow.py and templates/show_sflow*.j2 (202505-smci-dev-oc).

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

function session(state: NetworkState, device: Device, lines: string[], start: CliStack = ["exec"]): string {
  let stack = start;
  const out: string[] = [];
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    out.push(...r.output.map((o) => o.text));
    stack = r.toBash ? [] : r.stack;
  }
  return out.join("\n");
}

const show = (state: NetworkState, device: Device, cmd = "show sflow") => session(state, device, [cmd]);

describe("sonic-cli sFlow (KLISH)", () => {
  it("sflow enable / no sflow enable toggle the admin state (show_sflow.j2 layout)", () => {
    const { state, device } = sw();
    session(state, device, ["configure terminal", "sflow enable", "exit"]);
    const t = show(state, device);
    expect(t).toContain("sFlow Global Information:");
    expect(t).toContain("  sFlow Admin State:          up");
    expect(t).toContain("  0 Collectors configured:");
    session(state, device, ["configure terminal", "no sflow enable", "exit"]);
    expect(show(state, device)).toContain("  sFlow Admin State:          down");
  });

  it("sflow collector <ip> [<port>] [vrf] is keyed {ip}_{port}_{vrf}; no-form removes by key", () => {
    const { state, device } = sw();
    session(state, device, ["configure terminal", "sflow collector 192.168.200.16 6343", "sflow collector 10.1.1.100 4451 vrf mgmt", "exit"]);
    let t = show(state, device);
    expect(t).toContain("  2 Collectors configured:");
    expect(t).toContain("    Name: 192.168.200.16_6343_default    IP addr: 192.168.200.16    UDP port: 6343   VRF: default");
    expect(t).toContain("    Name: 10.1.1.100_4451_mgmt    IP addr: 10.1.1.100    UDP port: 4451   VRF: mgmt");
    session(state, device, ["configure terminal", "no sflow collector 10.1.1.100 4451 vrf mgmt", "exit"]);
    t = show(state, device);
    expect(t).toContain("  1 Collector configured:");
    expect(t).not.toContain("10.1.1.100");
  });

  it("the old `port <n>` keyword form is rejected (commit ccbe1d0: bare UDP port)", () => {
    const { state, device } = sw();
    const t = session(state, device, ["configure terminal", "sflow collector 1.1.1.1 port 4451", "exit"]);
    expect(t).toContain("Invalid input detected");
    expect(show(state, device)).toContain("0 Collectors configured:");
  });

  it("a third collector is rejected (YANG max-elements 2)", () => {
    const { state, device } = sw();
    const t = session(state, device, ["configure terminal", "sflow collector 1.1.1.1", "sflow collector 2.2.2.2", "sflow collector 3.3.3.3", "exit"]);
    expect(t).toContain("Max elements limit 2 reached");
  });

  it("agent-id, polling-interval and global sampling-rate update show sflow and reset with no", () => {
    const { state, device } = sw();
    session(state, device, ["configure terminal", "sflow agent-id Ethernet 0", "sflow polling-interval 30", "sflow sampling-rate 256", "exit"]);
    let t = show(state, device);
    expect(t).toContain("  sFlow AgentID:              Ethernet0");
    expect(t).toContain("  sFlow Polling Interval:     30");
    expect(t).toContain("  sFlow Sampling Rate:        256");
    session(state, device, ["configure terminal", "no sflow agent-id", "no sflow polling-interval", "no sflow sampling-rate", "exit"]);
    t = show(state, device);
    expect(t).toContain("  sFlow AgentID:              default");
    expect(t).toContain("  sFlow Polling Interval:     default");
    expect(t).not.toContain("Sampling Rate:");
  });

  it("rejects out-of-range polling-interval and sampling-rate", () => {
    const { state, device } = sw();
    const t = session(state, device, ["configure terminal", "sflow polling-interval 3", "sflow sampling-rate 100", "exit"]);
    expect(t).toContain("Invalid input detected");
    expect(t).toContain("Error: Sampling rate must be between 256 and 8388608");
  });

  it("global sampling-rate is NOT applied to sessions; ports keep their speed rate", () => {
    const { state, device } = sw();
    session(state, device, ["configure terminal", "sflow enable", "sflow sampling-rate 256", "exit"]);
    const t = show(state, device, "show sflow interface");
    expect(t).toContain("| Ethernet0   | up            |            1000 |");
    expect(t).not.toContain("256");
  });

  it("interface sflow sampling-rate / no sflow enable / no sflow sampling-rate", () => {
    const { state, device } = sw();
    session(state, device, [
      "configure terminal",
      "sflow enable",
      "interface Ethernet 0",
      "sflow sampling-rate 4000",
      "exit",
      "interface Ethernet 1",
      "no sflow enable",
      "exit",
      "exit",
    ]);
    let t = show(state, device, "show sflow interface");
    expect(t).toContain("| Ethernet0   | up            |            4000 |");
    expect(t).toContain("| Ethernet1   | down          |            1000 |");
    session(state, device, ["configure terminal", "interface Ethernet 0", "no sflow sampling-rate", "exit", "exit"]);
    t = show(state, device, "show sflow interface Ethernet 0");
    expect(t).toContain("| Ethernet0   | up            |            1000 |");
    expect(t).not.toContain("Ethernet1");
  });

  it("show sflow interface with sFlow disabled prints the empty message", () => {
    const { state, device } = sw();
    expect(show(state, device, "show sflow interface")).toContain("No sFlow interfaces configured");
  });
});
