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

const textOf = (r: { output: { text: string; kind?: string }[] }) => r.output.map((o) => o.text).join("\n");

describe("SONiC PFC / PFCWD feature (qos_pfc_pfcwd.txt)", () => {
  it("baseline: show pfcwd config reports not-started + default polling interval (TC-1)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("show pfcwd config", ctxFor(state, sw));
    const text = textOf(res);
    expect(text).toContain("Not Configured (default 100ms)");
    expect(text).toContain("not started");
  });

  it("config pfcwd start -> show pfcwd config reflects action/detect/restore", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pfcwd start --action drop --restoration-time 400 200 all", ctxFor(state, sw));
    const text = textOf(execute("show pfcwd config", ctxFor(state, sw)));
    expect(text).toContain("started");
    expect(text).toContain("drop");
    expect(text).toContain("200ms"); // detection
    expect(text).toContain("400ms"); // restoration
    expect(text).toContain("all");
  });

  it("start defaults action=drop and restoration=2*detection", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pfcwd start 250 Ethernet0", ctxFor(state, sw));
    const text = textOf(execute("show pfcwd config", ctxFor(state, sw)));
    expect(text).toContain("drop"); // default action
    expect(text).toContain("250ms"); // detection
    expect(text).toContain("500ms"); // 2 * 250 default restoration
    expect(text).toContain("Ethernet0");
  });

  it("warns when restoration-time < 2*detection but still applies (TC-23)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config pfcwd start -r 200 200", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error" && /restore_time is less than 2\*detect_time/.test(o.text))).toBe(true);
    expect(textOf(execute("show pfcwd config", ctxFor(state, sw)))).toContain("started");
  });

  it("rejects non-numeric detection-time (TC-69) and negative restoration-time (TC-70)", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(execute("config pfcwd start abc", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config pfcwd start -r -5 200", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });

  it("config pfcwd stop clears watchdog state (values not retained, TC-25)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pfcwd start --action forward 200 all", ctxFor(state, sw));
    execute("config pfcwd stop", ctxFor(state, sw));
    const text = textOf(execute("show pfcwd config", ctxFor(state, sw)));
    expect(text).toContain("not started");
    expect(text).not.toContain("forward");
  });

  it("config pfcwd interval sets the global polling interval", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pfcwd interval 200", ctxFor(state, sw));
    expect(textOf(execute("show pfcwd config", ctxFor(state, sw)))).toContain("Polling Interval:   200ms");
  });

  it("config pfc asymmetric on -> stored + platform warning (TC-19), show tags NOT APPLIED (TC-22)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const cfg = execute("config pfc asymmetric Ethernet0 on", ctxFor(state, sw));
    expect(cfg.output.some((o) => o.kind === "error" && /not supported by this platform\/SAI/.test(o.text))).toBe(true);
    const show = textOf(execute("show pfc asymmetric Ethernet0", ctxFor(state, sw)));
    expect(show).toContain("Ethernet0");
    expect(show).toContain("on  (NOT APPLIED -- unsupported by platform)");
  });

  it("config pfc asymmetric off -> show reflects off", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pfc asymmetric Ethernet0 on", ctxFor(state, sw));
    execute("config pfc asymmetric Ethernet0 off", ctxFor(state, sw));
    const show = textOf(execute("show pfc asymmetric Ethernet0", ctxFor(state, sw)));
    expect(show).toContain("off");
    expect(show).not.toContain("NOT APPLIED");
  });

  it("config pfc asymmetric rejects an unknown interface", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(execute("config pfc asymmetric Ethernet99 on", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });

  it("config pfc priority adds/removes priorities; rejects out-of-range (TC-67)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pfc priority Ethernet0 3 on", ctxFor(state, sw));
    execute("config pfc priority Ethernet0 4 on", ctxFor(state, sw));
    expect(textOf(execute("show pfc priority Ethernet0", ctxFor(state, sw)))).toContain("3,4");
    execute("config pfc priority Ethernet0 3 off", ctxFor(state, sw));
    expect(textOf(execute("show pfc priority Ethernet0", ctxFor(state, sw)))).toContain("4");
    expect(execute("config pfc priority Ethernet0 8 on", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });

  it("show pfcwd stats does not fabricate storm/drop counters (§32)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pfcwd start 200 all", ctxFor(state, sw));
    const text = textOf(execute("show pfcwd stats", ctxFor(state, sw)));
    expect(text).toContain("not simulated");
    expect(text).not.toMatch(/Storm|Drop\b/);
  });
});
