import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext, CommandResult } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface NtpState {
  servers: string[];
  sourceInterface: string | undefined;
  vrf: string | undefined;
}

function build(): NetworkState {
  resetMacCounter(1);
  resetIds();
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { devices: { sw1 }, connections: [] };
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

const textOf = (res: CommandResult): string => res.output.map((o) => o.text).join("\n");

describe("SONiC NTP feature (config-plane)", () => {
  it("config ntp add stores the server in device state; show ntp renders it", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config ntp add 10.0.0.10", ctxFor(state, sw));

    expect(peekFeatureState<NtpState>(sw, "ntp")!.servers).toEqual(["10.0.0.10"]);
    expect(textOf(execute("show ntp", ctxFor(state, sw)))).toContain("10.0.0.10");
  });

  it("config ntp del removes a configured server", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config ntp add 10.0.0.10", ctxFor(state, sw));
    execute("config ntp del 10.0.0.10", ctxFor(state, sw));

    expect(peekFeatureState<NtpState>(sw, "ntp")!.servers).toEqual([]);
    expect(textOf(execute("show ntp", ctxFor(state, sw)))).not.toContain("10.0.0.10");
  });

  it("tracks multiple servers and errors on deleting an unconfigured one", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config ntp add 10.0.0.1", ctxFor(state, sw));
    execute("config ntp add 10.0.0.2", ctxFor(state, sw));
    expect(peekFeatureState<NtpState>(sw, "ntp")!.servers).toEqual(["10.0.0.1", "10.0.0.2"]);

    const res = execute("config ntp del 10.0.0.99", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
  });

  it("rejects an invalid IPv4 server and stores nothing", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config ntp add 999.999.999.999", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<NtpState>(sw, "ntp")?.servers ?? []).toEqual([]);
  });

  it("sets and clears the source interface (KLISH two-token port form joins)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config ntp source-interface Ethernet 0", ctxFor(state, sw));
    expect(peekFeatureState<NtpState>(sw, "ntp")!.sourceInterface).toBe("Ethernet0");
    expect(textOf(execute("show ntp", ctxFor(state, sw)))).toContain("Ethernet0");

    execute("config ntp source-interface del", ctxFor(state, sw));
    expect(peekFeatureState<NtpState>(sw, "ntp")!.sourceInterface).toBeUndefined();
  });

  it("sets and clears the VRF", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config ntp vrf mgmt", ctxFor(state, sw));
    expect(peekFeatureState<NtpState>(sw, "ntp")!.vrf).toBe("mgmt");
    expect(textOf(execute("show ntp", ctxFor(state, sw)))).toContain("mgmt");

    execute("config ntp vrf del", ctxFor(state, sw));
    expect(peekFeatureState<NtpState>(sw, "ntp")!.vrf).toBeUndefined();
  });

  it("show ntp associations lists servers with a live reachability table", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config ntp add 10.0.0.10", ctxFor(state, sw));
    const text = textOf(execute("show ntp associations", ctxFor(state, sw)));
    expect(text).toContain("10.0.0.10");
    expect(text).toMatch(/reach/); // real association table (reach/st/offset columns)
  });

  it("show ntp associations reports none when no servers are configured", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(textOf(execute("show ntp associations", ctxFor(state, sw)))).toContain("No NTP associations");
  });
});
