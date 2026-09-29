import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, SimEvent, CaptureRecord, resetIds } from "../lib/engine";
import { execute, CommandContext } from "../lib/commands";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface RadiusServer {
  ip: string;
  authType?: string;
  authPort?: number;
}
interface RadiusState {
  servers: RadiusServer[];
  global: Record<string, string>;
}

function build(): { state: NetworkState; sw: Device } {
  resetMacCounter(1);
  resetIds();
  const sw = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  const state: NetworkState = { devices: { sw1: sw }, connections: [] };
  return { state, sw };
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

const textOf = (r: { output: { text: string }[] }) => r.output.map((o) => o.text).join("\n");
const hasError = (r: { output: { kind?: string }[] }) => r.output.some((o) => o.kind === "error");

describe("SONiC RADIUS feature (radius.txt)", () => {
  it("config radius add stores a server in state and show reflects it", () => {
    const { state, sw } = build();
    const res = execute("config radius add 3.3.3.3 -a chap -o 1812 -p 1", ctxFor(state, sw));
    expect(hasError(res)).toBe(false);

    const st = peekFeatureState<RadiusState>(sw, "radius");
    expect(st?.servers.map((s) => s.ip)).toEqual(["3.3.3.3"]);
    expect(st?.servers[0].authType).toBe("chap");
    expect(st?.servers[0].authPort).toBe(1812);

    const text = textOf(execute("show radius", ctxFor(state, sw)));
    expect(text).toContain("3.3.3.3");
    expect(text).toContain("CHAP");
    expect(text).toContain("1812");
  });

  it("config radius delete removes a configured server", () => {
    const { state, sw } = build();
    execute("config radius add 3.3.3.3", ctxFor(state, sw));
    const del = execute("config radius delete 3.3.3.3", ctxFor(state, sw));
    expect(hasError(del)).toBe(false);

    expect(peekFeatureState<RadiusState>(sw, "radius")?.servers.length).toBe(0);
    expect(textOf(execute("show radius", ctxFor(state, sw)))).not.toContain("3.3.3.3");
  });

  it("deleting a non-existent server is rejected", () => {
    const { state, sw } = build();
    expect(hasError(execute("config radius delete 9.9.9.9", ctxFor(state, sw)))).toBe(true);
  });

  it("global settings render in show radius", () => {
    const { state, sw } = build();
    execute("config radius nasip 10.59.100.2", ctxFor(state, sw));
    execute("config radius timeout 3", ctxFor(state, sw));
    execute("config radius authtype chap", ctxFor(state, sw));
    execute("config radius passkey testing123", ctxFor(state, sw));
    execute("config radius retransmit 3", ctxFor(state, sw));

    const text = textOf(execute("show radius", ctxFor(state, sw)));
    expect(text).toContain("nas-ip-addr : 10.59.100.2");
    expect(text).toContain("timeout : 3");
    expect(text).toContain("auth-type : CHAP");
    expect(text).toContain("key configured : Yes");
    expect(text).toContain("retransmit : 3");
  });

  it("rejects the unsupported GLOBAL source-interface form (TC-23)", () => {
    const { state, sw } = build();
    const res = execute("config radius source-interface Ethernet16", ctxFor(state, sw));
    expect(hasError(res)).toBe(true);
    // nothing was stored
    const st = peekFeatureState<RadiusState>(sw, "radius");
    expect(st?.global["source-interface"]).toBeUndefined();
  });

  it("baseline show radius reports empty key/hosts", () => {
    const { state, sw } = build();
    const text = textOf(execute("show radius", ctxFor(state, sw)));
    expect(text).toContain("RADIUS Global Configuration");
    expect(text).toContain("key configured : No");
    expect(text).not.toContain("HOST");
  });

  it("accepts a hostname or IPv6 server address (real device: A.B.C.D | X:X::X:X | hostname)", () => {
    const { state, sw } = build();
    expect(hasError(execute("config radius add radius.example.com", ctxFor(state, sw)))).toBe(false);
    expect(hasError(execute("config radius add 2001:db8::5", ctxFor(state, sw)))).toBe(false);
    expect(peekFeatureState<RadiusState>(sw, "radius")?.servers.length ?? 0).toBe(2);
  });

  it("rejects invalid host IP and out-of-range values", () => {
    const { state, sw } = build();
    expect(hasError(execute("config radius add 999.999.999.999", ctxFor(state, sw)))).toBe(true); // TC-22
    expect(hasError(execute("config radius timeout 0", ctxFor(state, sw)))).toBe(true); // TC-14
    expect(hasError(execute("config radius timeout 61", ctxFor(state, sw)))).toBe(true); // TC-15
    expect(hasError(execute("config radius add 3.3.3.3 -o 0", ctxFor(state, sw)))).toBe(true); // TC-26
    expect(hasError(execute("config radius add 3.3.3.3 -p 65", ctxFor(state, sw)))).toBe(true); // TC-30
    expect(hasError(execute("config radius authtype foobar", ctxFor(state, sw)))).toBe(true); // TC-19
    // none of the rejected commands left state behind
    expect(peekFeatureState<RadiusState>(sw, "radius")?.servers.length ?? 0).toBe(0);
  });

  it("re-adding a host updates it in place (idempotent)", () => {
    const { state, sw } = build();
    execute("config radius add 3.3.3.3 -o 1812", ctxFor(state, sw));
    execute("config radius add 3.3.3.3 -o 1813", ctxFor(state, sw));
    const st = peekFeatureState<RadiusState>(sw, "radius");
    expect(st?.servers.length).toBe(1);
    expect(st?.servers[0].authPort).toBe(1813);
  });
});
