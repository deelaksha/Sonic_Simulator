import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";

function build() {
  resetMacCounter(1);
  resetIds();
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  const state: NetworkState = { devices: { sw1 }, connections: [] };
  return state;
}

function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (sim: Simulation) => T): { value: T; events: SimEvent[] } {
      const sim = new Simulation(state);
      const value = fn(sim);
      captures.push(...sim.captures);
      return { value, events: sim.events };
    },
  };
}

function textOf(res: { output: { text: string }[] }): string {
  return res.output.map((o) => o.text).join("\n");
}

describe("SONiC platform feature (task §41)", () => {
  it("show platform summary renders honest simulated identity + live port count", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("show platform summary", ctxFor(state, sw));
    const text = textOf(res);
    expect(text).toContain("Platform: networklab-sim");
    expect(text).toContain("HwSKU: simulated");
    expect(text).toContain("ASIC: simulated");
    // Port count is taken from the live device (data ports only, excluding the
    // out-of-band eth0 management port), not fabricated.
    const dataPorts = sw.interfaces.filter((i) => !i.management);
    expect(text).toContain(`Ports: ${dataPorts.length}`);
    expect(dataPorts.length).toBe(4);
    // The switch also carries a single eth0 management interface with an IP.
    const mgmt = sw.interfaces.filter((i) => i.management);
    expect(mgmt).toHaveLength(1);
    expect(mgmt[0].name).toBe("eth0");
    expect(mgmt[0].ipv4[0]?.address).toBe("192.168.100.1");
  });

  it("does not fabricate hardware sensor readings for hardware-only queries", () => {
    const state = build();
    const sw = state.devices.sw1;
    for (const cmd of [
      "show platform syseeprom",
      "show platform psustatus",
      "show platform fanstatus",
      "show platform temperature",
      "show platform ssdhealth",
      "show platform firmware version",
    ]) {
      const res = execute(cmd, ctxFor(state, sw));
      const text = textOf(res);
      expect(text).toContain("SIMULATION LIMITATION");
      expect(text).toContain("not modeled in the simulator");
      // No invented numeric sensor values (RPM, degrees, volts, percentages).
      expect(text).not.toMatch(/\d+\s*(RPM|rpm|°C|degrees|V\b|%)/);
    }
  });

  it("show platform psustatus explicitly refuses to invent PSU readings", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("show platform psustatus", ctxFor(state, sw));
    const text = textOf(res);
    expect(text).toContain("SIMULATION LIMITATION: PSU status is hardware-specific and not modeled in the simulator.");
  });

  it("bare show platform prints usage listing the subcommands", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("show platform", ctxFor(state, sw));
    const text = textOf(res);
    expect(text.toLowerCase()).toContain("usage");
    expect(text).toContain("summary");
    expect(text).toContain("ssdhealth");
  });
});
