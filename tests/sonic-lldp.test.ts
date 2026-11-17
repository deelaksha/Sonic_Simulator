import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes, resetMacCounter } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { runControlTick } from "../lib/control";

/** Drive the control daemons (lldpd) from `fromMs` to `toMs` wall-clock, 100 ms steps. */
function runDaemons(state: NetworkState, toMs: number, fromMs = 0) {
  for (let t = fromMs; t <= toMs; t += 100) runControlTick(new Simulation(state, { wallBase: t }), state, t);
}

function build() {
  resetMacCounter(1);
  resetIds();
  const pc1 = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
  const sw1 = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  pc1.interfaces[0].ipv4 = [{ address: "10.0.0.1", prefix: 24 }];
  rebuildConnectedRoutes(pc1);
  const state: NetworkState = { devices: { pc1, sw1 }, connections: [] };
  linkInterfaces(state, { deviceId: "pc1", interfaceId: "pc1-if0" }, { deviceId: "sw1", interfaceId: "sw1-if0" });
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

const text = (res: { output: { text: string }[] }) => res.output.map((o) => o.text).join("\n");
const hasError = (res: { output: { kind?: string }[] }) => res.output.some((o) => o.kind === "error");

describe("SONiC LLDP feature (source lldp.txt + lldpd model)", () => {
  it("global enable/disable is reflected in `show lldp`", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config lldp disable", ctxFor(state, sw));
    expect(text(execute("show lldp", ctxFor(state, sw)))).toContain("disabled");
    execute("sudo config lldp enable", ctxFor(state, sw)); // sudo passthrough
    expect(text(execute("show lldp", ctxFor(state, sw)))).toContain("enabled");
  });

  it("timer accepts in-range values and shows them; rejects out-of-range, keeping the old value", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config lldp timer 30", ctxFor(state, sw));
    expect(text(execute("show lldp", ctxFor(state, sw)))).toContain("30");
    // below min (5) and above max (254) are rejected (TC-17/18)
    expect(hasError(execute("config lldp timer 4", ctxFor(state, sw)))).toBe(true);
    expect(hasError(execute("config lldp timer 255", ctxFor(state, sw)))).toBe(true);
    // rejected values leave the previously configured timer intact (TC-19)
    expect(text(execute("show lldp", ctxFor(state, sw)))).toContain("30");
    // no-timer restores default (TC-20)
    execute("config lldp no-timer", ctxFor(state, sw));
    expect(text(execute("show lldp", ctxFor(state, sw)))).toContain("default");
  });

  it("multiplier boundary checks (1-10) and removal", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config lldp multiplier 4", ctxFor(state, sw));
    expect(text(execute("show lldp", ctxFor(state, sw)))).toContain("4");
    expect(hasError(execute("config lldp multiplier 0", ctxFor(state, sw)))).toBe(true);
    expect(hasError(execute("config lldp multiplier 11", ctxFor(state, sw)))).toBe(true);
    execute("config lldp no-multiplier", ctxFor(state, sw));
    expect(text(execute("show lldp", ctxFor(state, sw)))).toContain("default");
  });

  it("system-name / system-description set and clear", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config lldp system-name sonic-switch", ctxFor(state, sw));
    execute('config lldp system-description "Broadcom SONiC Switch"', ctxFor(state, sw));
    const shown = text(execute("show lldp", ctxFor(state, sw)));
    expect(shown).toContain("sonic-switch");
    expect(shown).toContain("Broadcom SONiC Switch");
    execute("config lldp no-system-name", ctxFor(state, sw));
    execute("config lldp no-system-description", ctxFor(state, sw));
    expect(text(execute("show lldp", ctxFor(state, sw)))).not.toContain("sonic-switch");
  });

  it("transmit/receive modes are independent and reflected in `show lldp`", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config lldp no-transmit", ctxFor(state, sw));
    expect(text(execute("show lldp", ctxFor(state, sw)))).toContain("rx-only");
    execute("config lldp transmit", ctxFor(state, sw));
    execute("config lldp no-receive", ctxFor(state, sw));
    expect(text(execute("show lldp", ctxFor(state, sw)))).toContain("tx-only");
  });

  it("per-interface enable/disable is stored and rendered; bad port is rejected", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config lldp interface Ethernet0 disable", ctxFor(state, sw));
    const shown = text(execute("show lldp", ctxFor(state, sw)));
    expect(shown).toContain("Ethernet0");
    expect(shown).toContain("disabled");
    expect(hasError(execute("config lldp interface Ethernet99 enable", ctxFor(state, sw)))).toBe(true);
  });

  it("`show lldp table` lists no neighbour behind a host port (hosts do not run lldpd)", () => {
    const state = build(); // PC1 (Ethernet0) <-> SW1
    const sw = state.devices.sw1;
    runDaemons(state, 10_000);
    const res = execute("show lldp table", ctxFor(state, sw));
    const shown = text(res);
    expect(shown).toContain("Capability codes: (R) Router, (B) Bridge, (O) Other");
    expect(shown).toContain("LocalPort");
    expect(shown).not.toContain("PC1"); // never derived from the topology
    expect(shown).toContain("Total entries displayed:  0");
    expect(hasError(res)).toBe(false);
  });

  it("`show lldp neighbors` prints lldpctl output; a port without a neighbour prints nothing", () => {
    const state = build();
    const sw = state.devices.sw1;
    runDaemons(state, 10_000);
    const plural = text(execute("show lldp neighbors", ctxFor(state, sw)));
    expect(plural).toContain("LLDP neighbors:");
    expect(plural).not.toContain("PC1");
    expect(text(execute("show lldp neighbor Ethernet1", ctxFor(state, sw))).trim()).toBe("");
  });

  it("two connected switches learn each other from real LLDPDUs (Bridge+Router)", () => {
    resetMacCounter(1);
    resetIds();
    const swA = createDevice({ id: "swA", type: "switch", name: "SW-A", x: 0, y: 0, ports: 4 });
    const swB = createDevice({ id: "swB", type: "switch", name: "SW-B", x: 0, y: 0, ports: 4 });
    const state: NetworkState = { devices: { swA, swB }, connections: [] };
    linkInterfaces(state, { deviceId: "swA", interfaceId: "swA-if1" }, { deviceId: "swB", interfaceId: "swB-if2" });
    // Before any LLDPDU has been exchanged there is nothing to show.
    expect(text(execute("show lldp table", ctxFor(state, swA)))).not.toContain("SW-B");
    runDaemons(state, 10_000);
    const aTable = text(execute("show lldp table", ctxFor(state, swA)));
    expect(aTable).toMatch(/Ethernet1\s+SW-B\s+Ethernet2\s+BR\s+Ethernet2/);
    expect(text(execute("show lldp table", ctxFor(state, swB)))).toMatch(/Ethernet2\s+SW-A\s+Ethernet1\s+BR/);
    // SW-B stops transmitting: SW-A keeps the entry until its TTL (120 s) runs out.
    execute("config lldp disable", ctxFor(state, swB));
    runDaemons(state, 100_000, 10_000);
    expect(text(execute("show lldp table", ctxFor(state, swA)))).toContain("SW-B");
    runDaemons(state, 140_000, 100_000);
    expect(text(execute("show lldp table", ctxFor(state, swA)))).not.toContain("SW-B");
  });

  it("`show lldp statistics` renders typed zero counters with no crash text", () => {
    const state = build();
    const sw = state.devices.sw1;
    const shown = text(execute("show lldp statistics Ethernet0", ctxFor(state, sw)));
    expect(shown).toContain("LLDP Statistics");
    expect(shown).toContain("Interface: Ethernet0");
    expect(shown).toContain("Transmitted : 0");
    expect(shown).toContain("Received : 0");
    expect(shown).not.toContain("Traceback");
  });
});
