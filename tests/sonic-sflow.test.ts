import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

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

describe("SONiC sFlow feature (config-plane, sflow.txt)", () => {
  it("show sflow renders the disabled baseline (TC-1)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const t = text(execute("show sflow", ctxFor(state, sw)));
    expect(t).toContain("sFlow Admin State: down");
    expect(t).toContain("sFlow Polling Interval: default");
    expect(t).toContain("sFlow AgentID: default");
    expect(t).toContain("0 Collectors configured:");
    expect(t).not.toContain("Error");
  });

  it("config sflow enable/disable flips global admin state (TC-2/3/4/5)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow enable", ctxFor(state, sw));
    expect(peekFeatureState<{ enabled: boolean }>(sw, "sflow")?.enabled).toBe(true);
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow Admin State: up");
    execute("config sflow disable", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow Admin State: down");
  });

  it("config sflow collector add is reflected in show sflow (TC-8/9)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow enable", ctxFor(state, sw));
    execute("config sflow collector add col1 10.10.10.10", ctxFor(state, sw));
    const t = text(execute("show sflow", ctxFor(state, sw)));
    expect(t).toContain("1 Collector configured:");
    expect(t).toContain("Name: col1 IP addr: 10.10.10.10 UDP port: 6343 VRF: default");
  });

  it("collector --port overrides the default UDP port (TC-12/13)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow collector add col1 10.10.10.10 --port 6364", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("UDP port: 6364");
  });

  it("accepts an IPv6 collector (TC-16/17)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config sflow collector add c6 2001:db::100", ctxFor(state, sw));
    expect(hasError(res)).toBe(false);
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("2001:db::100");
  });

  it("config sflow collector del removes it (TC-10/11)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow collector add col1 10.10.10.10", ctxFor(state, sw));
    execute("config sflow collector del col1", ctxFor(state, sw));
    const t = text(execute("show sflow", ctxFor(state, sw)));
    expect(t).toContain("0 Collectors configured:");
    expect(t).not.toContain("10.10.10.10");
  });

  it("rejects a 3rd collector (max 2, TC-69) and an invalid IP", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow collector add c1 4.4.4.4", ctxFor(state, sw));
    execute("config sflow collector add c2 5.5.5.5", ctxFor(state, sw));
    const third = execute("config sflow collector add c3 3.3.3.3", ctxFor(state, sw));
    expect(hasError(third)).toBe(true);
    expect(text(third)).toContain("Max elements limit 2 reached");
    expect(hasError(execute("config sflow collector add cx not-an-ip", ctxFor(state, sw)))).toBe(true);
  });

  it("rejects out-of-range collector ports (TC-73/74)", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(hasError(execute("config sflow collector add c1 6.6.6.6 --port 0", ctxFor(state, sw)))).toBe(true);
    expect(hasError(execute("config sflow collector add c1 6.6.6.6 --port 65536", ctxFor(state, sw)))).toBe(true);
  });

  it("agent-id add/del updates show sflow (TC-20/21/24/25)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow agent-id add Ethernet0", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow AgentID: Ethernet0");
    execute("config sflow agent-id del", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow AgentID: default");
  });

  it("polling-interval accepts 0/5-300 and rejects out-of-range (TC-38/40/42/44/45)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow polling-interval 20", ctxFor(state, sw));
    expect(text(execute("show sflow", ctxFor(state, sw)))).toContain("sFlow Polling Interval: 20");
    expect(hasError(execute("config sflow polling-interval 0", ctxFor(state, sw)))).toBe(false);
    expect(hasError(execute("config sflow polling-interval 300", ctxFor(state, sw)))).toBe(false);
    expect(hasError(execute("config sflow polling-interval 4", ctxFor(state, sw)))).toBe(true);
    expect(hasError(execute("config sflow polling-interval 301", ctxFor(state, sw)))).toBe(true);
  });

  it("interface enable/disable and sample-rate render in show sflow interface (TC-26/28/29/31/58/59)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow interface enable Ethernet0", ctxFor(state, sw));
    let t = text(execute("show sflow interface Ethernet0", ctxFor(state, sw)));
    expect(t).toContain("| Ethernet0 | up | 4294967295 |");

    execute("config sflow interface sample-rate Ethernet0 8000", ctxFor(state, sw));
    t = text(execute("show sflow interface Ethernet0", ctxFor(state, sw)));
    expect(t).toContain("| Ethernet0 | up | 8000 |");

    execute("config sflow interface disable Ethernet0", ctxFor(state, sw));
    t = text(execute("show sflow interface Ethernet0", ctxFor(state, sw)));
    expect(t).toContain("| Ethernet0 | down | 8000 |");
  });

  it("rejects an unknown interface and out-of-range sample-rate (TC-62/63)", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(hasError(execute("config sflow interface enable Ethernet999", ctxFor(state, sw)))).toBe(true);
    execute("config sflow interface enable Ethernet0", ctxFor(state, sw));
    expect(hasError(execute("config sflow interface sample-rate Ethernet0 255", ctxFor(state, sw)))).toBe(true);
    expect(hasError(execute("config sflow interface sample-rate Ethernet0 8388609", ctxFor(state, sw)))).toBe(true);
  });

  it("show sflow interface with no config prints the empty message (TC-97)", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(text(execute("show sflow interface", ctxFor(state, sw)))).toContain("No sFlow interfaces configured");
  });

  it("two interfaces are configured independently (TC-86/87/88/91)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config sflow interface enable Ethernet0", ctxFor(state, sw));
    execute("config sflow interface sample-rate Ethernet0 4000", ctxFor(state, sw));
    execute("config sflow interface enable Ethernet1", ctxFor(state, sw));
    execute("config sflow interface sample-rate Ethernet1 16000", ctxFor(state, sw));
    execute("config sflow interface sample-rate Ethernet0 32000", ctxFor(state, sw));
    const all = text(execute("show sflow interface", ctxFor(state, sw)));
    expect(all).toContain("| Ethernet0 | up | 32000 |");
    expect(all).toContain("| Ethernet1 | up | 16000 |");
  });
});
