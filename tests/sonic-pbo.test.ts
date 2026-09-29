import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext, CommandResult } from "../lib/commands";
import { Device } from "../lib/models/device";

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

const text = (res: CommandResult): string => res.output.map((o) => o.text).join("\n");
const hasError = (res: CommandResult): boolean => res.output.some((o) => o.kind === "error");

describe("SONiC PBO (Port Breakout / DPB) feature", () => {
  it("config pbo port ... mode ... stores breakout and show pbo reflects it", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pbo port 1/3 mode 4x200G", ctxFor(state, sw));
    const res = execute("show pbo", ctxFor(state, sw));
    const t = text(res);
    expect(t).toContain("1/3");
    expect(t).toContain("4x200G");
  });

  it("sudo passthrough and case-insensitive mode (8x100g -> 8x100G)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("sudo config pbo port 1/5 mode 8x100g", ctxFor(state, sw));
    const res = execute("show pbo port 1/5", ctxFor(state, sw));
    expect(text(res)).toContain("8x100G");
  });

  it("num-lanes and mode(lanes) qualifier are parsed, stored and shown", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pbo port 1/5 mode 1x400G num-lanes 4", ctxFor(state, sw));
    execute("config pbo port 1/6 mode 1x400G(4) force", ctxFor(state, sw));
    const p5 = text(execute("show pbo port 1/5", ctxFor(state, sw)));
    expect(p5).toContain("1x400G");
    expect(p5).toContain("Num Lanes     : 4");
    const p6 = text(execute("show pbo port 1/6", ctxFor(state, sw)));
    expect(p6).toContain("1x400G(4)");
  });

  it("force keyword is accepted and reported", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config pbo port 1/8 mode 1x800G force", ctxFor(state, sw));
    expect(text(res)).toContain("(forced)");
    expect(hasError(res)).toBe(false);
  });

  it("re-issuing a breakout on the same port overwrites (idempotent, one entry)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pbo port 1/4 mode 2x400G", ctxFor(state, sw));
    execute("config pbo port 1/4 mode 1x800G", ctxFor(state, sw));
    const t = text(execute("show pbo", ctxFor(state, sw)));
    expect(t).toContain("1x800G");
    expect(t).not.toContain("2x400G");
  });

  it("config pbo no port removes the breakout (show reflects removal)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config pbo port 1/2 mode 4x200G force", ctxFor(state, sw));
    execute("config pbo no port 1/2", ctxFor(state, sw));
    expect(text(execute("show pbo", ctxFor(state, sw)))).toContain("No breakout configured");
  });

  it("resetting a port with no breakout is a silent no-op", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config pbo no port 1/9", ctxFor(state, sw));
    expect(hasError(res)).toBe(false);
    expect(text(res).toLowerCase()).toContain("no breakout");
  });

  it("rejects an invalid port form", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(hasError(execute("config pbo port Ethernet0 mode 4x200G", ctxFor(state, sw)))).toBe(true);
  });

  it("rejects a malformed breakout mode", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(hasError(execute("config pbo port 1/2 mode banana", ctxFor(state, sw)))).toBe(true);
  });

  it("requires the 'mode' keyword", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(hasError(execute("config pbo port 1/2 4x200G", ctxFor(state, sw)))).toBe(true);
  });

  it("rejects non-numeric num-lanes", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(hasError(execute("config pbo port 1/2 mode 1x400G num-lanes x", ctxFor(state, sw)))).toBe(true);
  });

  it("hardware-specific views print a SIMULATION LIMITATION note", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(text(execute("show pbo modes", ctxFor(state, sw)))).toContain("SIMULATION LIMITATION");
    expect(text(execute("show pbo resources", ctxFor(state, sw)))).toContain("SIMULATION LIMITATION");
    expect(text(execute("show pbo dependencies port 1/1", ctxFor(state, sw)))).toContain("SIMULATION LIMITATION");
  });

  it("show pbo port for an unconfigured port reports no breakout", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(text(execute("show pbo port 1/7", ctxFor(state, sw)))).toContain("has no breakout configured");
  });
});
