import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

// Click `config sflow` / `show sflow` — expectations from sonic-utilities
// config/main.py + show/sflow.py (sonic-buildimage 202505-smci-dev-oc).

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

const text = (r: { output: { text: string }[] }) => r.output.map((o) => o.text).join("\n");
const hasError = (r: { output: { kind?: string }[] }) => r.output.some((o) => o.kind === "error");

describe("SONiC sFlow — Click config/show (sonic-utilities)", () => {
  it("show sflow renders the disabled baseline with ljust(30) labels", () => {
    const state = build();
    const t = text(execute("show sflow", ctxFor(state, state.devices.sw1)));
    expect(t).toContain("sFlow Global Information:");
    expect(t).toContain("  sFlow Admin State:          down");
    expect(t).toContain("  sFlow Sample Direction:     rx");
    expect(t).toContain("  sFlow Polling Interval:     default");
    expect(t).toContain("  sFlow AgentID:              default");
    expect(t).toContain("  0 Collectors configured:");
  });

  it("config sflow enable/disable flips global admin state", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow enable", ctxFor(state, sw));
    expect(peekFeatureState<{ enabled: boolean }>(sw, "sflow")?.enabled).toBe(true);
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow Admin State:          up");
    execute("config sflow disable", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow Admin State:          down");
  });

  it("collector add renders Name/IP/port/VRF columns (default port 6343, vrf default)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow collector add col1 10.10.10.10", ctxFor(state, sw));
    execute("config sflow collector add col2 10.10.10.11 --port 6364 --vrf mgmt", ctxFor(state, sw));
    const t = text(execute("show sflow", ctxFor(state, sw)));
    expect(t).toContain("  2 Collectors configured:");
    expect(t).toContain("    Name: col1                IP addr: 10.10.10.10     UDP port: 6343   VRF: default");
    expect(t).toContain("    Name: col2                IP addr: 10.10.10.11     UDP port: 6364   VRF: mgmt");
  });

  it("accepts an IPv6 collector; collector del removes it; unknown name errors", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(hasError(execute("config sflow collector add c6 2001:db::100", ctxFor(state, sw)))).toBe(false);
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("2001:db::100");
    execute("config sflow collector del c6", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("0 Collectors configured:");
    expect(text(execute("config sflow collector del nope", ctxFor(state, sw)))).toContain("Invalid collector name nope");
  });

  it("enforces max 2 collectors, name length, IP, port 0-65535 and vrf", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow collector add c1 4.4.4.4", ctxFor(state, sw));
    execute("config sflow collector add c2 5.5.5.5", ctxFor(state, sw));
    expect(text(execute("config sflow collector add c3 3.3.3.3", ctxFor(state, sw)))).toContain(
      "Only 2 collectors can be configured, please delete one",
    );
    execute("config sflow collector del c2", ctxFor(state, sw));
    expect(text(execute("config sflow collector add abcdefghijklmnopq 3.3.3.3", ctxFor(state, sw)))).toContain(
      "Collector name must not exceed 16 characters",
    );
    expect(hasError(execute("config sflow collector add cx not-an-ip", ctxFor(state, sw)))).toBe(true);
    expect(hasError(execute("config sflow collector add c3 6.6.6.6 --port 0", ctxFor(state, sw)))).toBe(false);
    expect(hasError(execute("config sflow collector add c3 6.6.6.6 --port 65536", ctxFor(state, sw)))).toBe(true);
    expect(text(execute("config sflow collector add c3 6.6.6.6 --vrf red", ctxFor(state, sw)))).toContain(
      "VRF name must be either default or mgmt",
    );
  });

  it("agent-id add/del; re-adding requires a delete first", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow agent-id add Ethernet0", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow AgentID:              Ethernet0");
    expect(text(execute("config sflow agent-id add Ethernet1", ctxFor(state, sw)))).toContain(
      "Agent already configured. Please delete it first.",
    );
    execute("config sflow agent-id del", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow AgentID:              default");
  });

  it("polling-interval accepts 0/5-300 and rejects out-of-range", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow polling-interval 20", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow Polling Interval:     20");
    expect(hasError(execute("config sflow polling-interval 0", ctxFor(state, sw)))).toBe(false);
    expect(hasError(execute("config sflow polling-interval 300", ctxFor(state, sw)))).toBe(false);
    const bad = execute("config sflow polling-interval 4", ctxFor(state, sw));
    expect(text(bad)).toContain("Polling interval must be between 5-300 (0 to disable)");
    expect(hasError(execute("config sflow polling-interval 301", ctxFor(state, sw)))).toBe(true);
  });

  it("show sflow interface lists APPL_DB sessions: none while sFlow is globally disabled", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow interface enable Ethernet0", ctxFor(state, sw));
    const t = text(execute("show sflow interface", ctxFor(state, sw)));
    expect(t).toContain("| Interface   | Admin State   | Sampling Rate   | Sampling Direction   |");
    expect(t).not.toContain("Ethernet0");
  });

  it("global enable auto-enables every port at its speed (sflowmgrd 'all' + findSamplingRate)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow enable", ctxFor(state, sw));
    const t = text(execute("show sflow interface", ctxFor(state, sw)));
    for (const p of ["Ethernet0", "Ethernet1", "Ethernet2", "Ethernet3"]) {
      expect(t).toMatch(new RegExp(`\\| ${p}\\s+\\| up\\s+\\|\\s+1000 \\| rx\\s+\\|`));
    }
  });

  it("per-port sample-rate, disable, 'default' revert, and 'interface disable all'", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow enable", ctxFor(state, sw));
    execute("config sflow interface sample-rate Ethernet0 8000", ctxFor(state, sw));
    execute("config sflow interface disable Ethernet1", ctxFor(state, sw));
    let t = text(execute("show sflow interface", ctxFor(state, sw)));
    expect(t).toMatch(/\| Ethernet0\s+\| up\s+\|\s+8000 \|/);
    expect(t).toMatch(/\| Ethernet1\s+\| down\s+\|\s+1000 \|/);
    execute("config sflow interface sample-rate Ethernet0 default", ctxFor(state, sw));
    t = text(execute("show sflow interface", ctxFor(state, sw)));
    expect(t).toMatch(/\| Ethernet0\s+\| up\s+\|\s+1000 \|/);
    // With 'all' disabled only ports with a local admin "up" keep a session.
    execute("config sflow interface disable all", ctxFor(state, sw));
    execute("config sflow interface enable Ethernet2", ctxFor(state, sw));
    t = text(execute("show sflow interface", ctxFor(state, sw)));
    expect(t).toContain("Ethernet2");
    expect(t).not.toContain("Ethernet0");
    expect(t).not.toContain("Ethernet1");
  });

  it("rejects an unknown interface and out-of-range sample-rate", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(hasError(execute("config sflow interface enable Ethernet999", ctxFor(state, sw)))).toBe(true);
    const r = execute("config sflow interface sample-rate Ethernet0 255", ctxFor(state, sw));
    expect(text(r)).toContain("Error: Sample rate must be between 256 and 8388608 or default");
    expect(hasError(execute("config sflow interface sample-rate Ethernet0 8388609", ctxFor(state, sw)))).toBe(true);
  });
});
