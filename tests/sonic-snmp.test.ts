import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface SnmpState {
  communities: { name: string; access: string }[];
  location: string | undefined;
  contact: string | undefined;
  users: { name: string; permission: string }[];
}

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

function text(res: { output: { text: string }[] }): string {
  return res.output.map((o) => o.text).join("\n");
}

describe("SONiC SNMP feature", () => {
  it("config snmp community add stores the community with its access type", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config snmp community add public ro", ctxFor(state, sw));
    execute("sudo config snmp community add private rw", ctxFor(state, sw)); // sudo passthrough
    const st = peekFeatureState<SnmpState>(sw, "snmp")!;
    expect(st.communities.map((c) => `${c.name}:${c.access}`).sort()).toEqual(["private:RW", "public:RO"]);
  });

  it("show snmp community renders configured communities as RO/RW, sorted", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config snmp community add public ro", ctxFor(state, sw));
    execute("config snmp community add private rw", ctxFor(state, sw));
    const out = text(execute("show snmp community", ctxFor(state, sw)));
    expect(out).toContain("Community Name");
    expect(out).toContain("public");
    expect(out).toContain("RO");
    expect(out).toContain("private");
    expect(out).toContain("RW");
    // sorted: private before public
    expect(out.indexOf("private")).toBeLessThan(out.indexOf("public"));
  });

  it("empty community view prints the SONiC no-communities message", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(text(execute("show snmp community", ctxFor(state, sw)))).toContain("No SNMP communities configured");
  });

  it("same-name community re-add overwrites access and is not an error", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config snmp community add AGENT_COMM ro", ctxFor(state, sw));
    const res = execute("config snmp community add AGENT_COMM rw", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(false);
    const st = peekFeatureState<SnmpState>(sw, "snmp")!;
    expect(st.communities.filter((c) => c.name === "AGENT_COMM")).toHaveLength(1);
    expect(st.communities[0].access).toBe("RW");
  });

  it("rejects a community name shorter than the 4-char minimum", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config snmp community add AB ro", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(peekFeatureState<SnmpState>(sw, "snmp")?.communities ?? []).toHaveLength(0);
  });

  it("config snmp community del removes it (and delete of a missing one is a silent no-op)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config snmp community add public ro", ctxFor(state, sw));
    execute("config snmp community del public", ctxFor(state, sw));
    expect(peekFeatureState<SnmpState>(sw, "snmp")?.communities ?? []).toHaveLength(0);
    const noop = execute("config snmp community del NOSUCHCOMM", ctxFor(state, sw));
    expect(noop.output.some((o) => o.kind === "error")).toBe(false);
  });

  it("location and contact are configured, shown in show snmp, then cleared", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config snmp contact add Network Operations Team", ctxFor(state, sw));
    execute('config snmp location add "Data Center 1, Rack 42"', ctxFor(state, sw));
    let out = text(execute("show snmp", ctxFor(state, sw)));
    expect(out).toContain("Contact");
    expect(out).toContain("Network Operations Team");
    expect(out).toContain("Location");
    expect(out).toContain("Data Center 1, Rack 42");

    execute("config snmp location del", ctxFor(state, sw));
    execute("config snmp contact del", ctxFor(state, sw));
    out = text(execute("show snmp", ctxFor(state, sw)));
    expect(out).toContain("No SNMP contact or location configured");
    const st = peekFeatureState<SnmpState>(sw, "snmp")!;
    expect(st.location).toBeUndefined();
    expect(st.contact).toBeUndefined();
  });

  it("config snmp user add/del is reflected in show snmp user", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config snmp user add admin7 ro", ctxFor(state, sw));
    let out = text(execute("show snmp user", ctxFor(state, sw)));
    expect(out).toContain("admin7");
    expect(out).toContain("RO");

    execute("config snmp user del admin7", ctxFor(state, sw));
    out = text(execute("show snmp user", ctxFor(state, sw)));
    expect(out).toContain("No SNMP users configured");
  });
});
