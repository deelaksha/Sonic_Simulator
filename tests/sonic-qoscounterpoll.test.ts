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

/** Grab the "PORT ..." row (word-boundary, not PORT_BUFFER_DROP) from a show. */
function row(text: string, key: string): string | undefined {
  return text.split("\n").find((l) => new RegExp(`^${key}\\s`).test(l));
}

describe("SONiC counterpoll feature (config counterpoll ...; show counterpoll)", () => {
  it("show counterpoll renders the deterministic 9-row baseline (TC-1)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("show counterpoll", ctxFor(state, sw));
    const text = res.output.map((o) => o.text).join("\n");
    // 9 flex-counter keys for the 7 configurable types (watermark fans out to 3).
    for (const key of [
      "BUFFER_POOL_WATERMARK",
      "FLOW_CNT_TRAP",
      "PG_DROP",
      "PG_WATERMARK",
      "PORT",
      "PORT_BUFFER_DROP",
      "QUEUE",
      "QUEUE_WATERMARK",
      "RIF",
    ]) {
      expect(row(text, key)).toBeDefined();
    }
    expect(text).toContain("Type");
    expect(text).toContain("Interval (in ms)");
    expect(text).toContain("Status");
    // Documented per-type defaults, all enabled (TC-1).
    expect(row(text, "PORT")).toContain("1000");
    expect(row(text, "PORT")).toContain("enable");
    expect(row(text, "QUEUE")).toContain("10000");
    expect(row(text, "PORT_BUFFER_DROP")).toContain("60000");
    // Rows are ordered by key (BUFFER_POOL_WATERMARK first, RIF last).
    const keysInOrder = text
      .split("\n")
      .map((l) => l.split(/\s+/)[0])
      .filter((k) => /^[A-Z_]+$/.test(k) && k !== "Type");
    expect(keysInOrder[0]).toBe("BUFFER_POOL_WATERMARK");
    expect(keysInOrder[keysInOrder.length - 1]).toBe("RIF");
  });

  it("enable a type + set interval -> show reflects it", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config counterpoll port enable", ctxFor(state, sw));
    execute("config counterpoll port interval 5000", ctxFor(state, sw));
    execute("sudo config counterpoll queue interval 20000", ctxFor(state, sw)); // sudo passthrough
    const text = execute("show counterpoll", ctxFor(state, sw)).output.map((o) => o.text).join("\n");
    expect(row(text, "PORT")).toContain("5000");
    expect(row(text, "PORT")).toContain("enable");
    expect(row(text, "QUEUE")).toContain("20000");
  });

  it("disable a type keeps its row but flips status; interval retained (TC-8/TC-31)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config counterpoll port interval 30000", ctxFor(state, sw));
    execute("config counterpoll port disable", ctxFor(state, sw));
    const text = execute("show counterpoll", ctxFor(state, sw)).output.map((o) => o.text).join("\n");
    const portRow = row(text, "PORT")!;
    expect(portRow).toContain("30000"); // interval retained across disable
    expect(portRow).toContain("disable");
  });

  it("enable/disable and interval are independent fields (TC-34/TC-35)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config counterpoll port disable", ctxFor(state, sw));
    execute("config counterpoll port interval 500", ctxFor(state, sw)); // must NOT re-enable
    const text = execute("show counterpoll", ctxFor(state, sw)).output.map((o) => o.text).join("\n");
    const portRow = row(text, "PORT")!;
    expect(portRow).toContain("500");
    expect(portRow).toContain("disable");
  });

  it("watermark fans out to all three watermark keys in one command (TC-9/TC-10)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config counterpoll watermark interval 20000", ctxFor(state, sw));
    execute("config counterpoll watermark disable", ctxFor(state, sw));
    const text = execute("show counterpoll", ctxFor(state, sw)).output.map((o) => o.text).join("\n");
    for (const key of ["QUEUE_WATERMARK", "PG_WATERMARK", "BUFFER_POOL_WATERMARK"]) {
      const r = row(text, key)!;
      expect(r).toContain("20000");
      expect(r).toContain("disable");
    }
    // Non-watermark types untouched by the watermark command.
    expect(row(text, "PORT")).toContain("enable");
  });

  it("rejects out-of-range interval per type, leaving state unchanged (TC-15/TC-21)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const belowMin = execute("config counterpoll port interval 50", ctxFor(state, sw));
    expect(belowMin.output.some((o) => o.kind === "error")).toBe(true);
    expect(belowMin.output[0].text).toContain("Invalid input detected");

    // port-buffer-drop min is 30000, so 1000 is below-min for it (TC-21).
    const pbd = execute("config counterpoll port-buffer-drop interval 1000", ctxFor(state, sw));
    expect(pbd.output.some((o) => o.kind === "error")).toBe(true);

    const aboveMax = execute("config counterpoll port interval 30001", ctxFor(state, sw));
    expect(aboveMax.output.some((o) => o.kind === "error")).toBe(true);

    // State unchanged: PORT still at its default 1000.
    const text = execute("show counterpoll", ctxFor(state, sw)).output.map((o) => o.text).join("\n");
    expect(row(text, "PORT")).toContain("1000");
  });

  it("rejects non-numeric interval and unknown type (TC-29/TC-30)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const nonNumeric = execute("config counterpoll port interval abc", ctxFor(state, sw));
    expect(nonNumeric.output[0].kind).toBe("error");
    expect(nonNumeric.output[0].text).toContain("Invalid input detected");

    const unknown = execute("config counterpoll bogus enable", ctxFor(state, sw));
    expect(unknown.output[0].kind).toBe("error");
    expect(unknown.output[0].text).toContain("Invalid input detected");
  });

  it("distinct error strings for missing value vs truncated command (TC-37/TC-38/TC-39)", () => {
    const state = build();
    const sw = state.devices.sw1;
    const noValue = execute("config counterpoll port interval", ctxFor(state, sw));
    expect(noValue.output[0].text).toBe("% Error: The command is not completed.");

    const noVerb = execute("config counterpoll port", ctxFor(state, sw));
    expect(noVerb.output[0].text).toBe("% Error: Ambiguous command.");

    const trailing = execute("config counterpoll port enable extra_token", ctxFor(state, sw));
    expect(trailing.output[0].text).toContain("Invalid input detected");
  });
});
