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

function showText(state: NetworkState, sw: Device): string {
  return execute("show tacacs", ctxFor(state, sw))
    .output.map((o) => o.text)
    .join("\n");
}

describe("SONiC TACACS+ feature (source: tacacs.txt)", () => {
  it("show tacacs on a clean device reports no global config and no servers", () => {
    const state = build();
    const sw = state.devices.sw1;
    const text = showText(state, sw);
    expect(text).toContain("No TACACS+ global configuration found.");
    expect(text).toContain("No TACACS+ servers configured.");
  });

  it("config tacacs add creates a server that show tacacs reflects", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config tacacs add 10.10.10.10 -a chap -o 49 -p 5 -m", ctxFor(state, sw));
    const text = showText(state, sw);
    expect(text).toContain("10.10.10.10");
    expect(text).toContain("CHAP");
    expect(text).toContain("MGMT"); // -m => mgmt vrf
    expect(text).not.toContain("No TACACS+ servers configured.");
  });

  it("sudo passthrough works and per-host defaults render (pap/49/1/5/default)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("sudo config tacacs add 5.5.5.5 -k TestKey5", ctxFor(state, sw));
    const text = showText(state, sw);
    // key-only host: defaults type pap, port 49, priority 1, timeout 5, vrf default.
    const row = text.split("\n").find((l) => l.startsWith("5.5.5.5"))!;
    expect(row).toContain("PAP");
    expect(row).toContain("Yes"); // key configured
    expect(row).toContain("49");
    expect(row).toContain("DEFAULT");
  });

  it("config tacacs delete removes the server", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config tacacs add 10.10.10.20 -t 10 -k secret", ctxFor(state, sw));
    expect(showText(state, sw)).toContain("10.10.10.20");
    const del = execute("config tacacs delete 10.10.10.20", ctxFor(state, sw));
    expect(del.output.some((o) => o.kind === "error")).toBe(false);
    expect(showText(state, sw)).not.toContain("10.10.10.20");
  });

  it("re-adding an existing host is an idempotent update (multi-instance independence)", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config tacacs add 3.3.3.3 -a pap -o 1 -p 1 -t 1", ctxFor(state, sw));
    execute("config tacacs add 4.4.4.4 -a mschap -o 65535 -p 64 -t 60 -m", ctxFor(state, sw));
    execute("config tacacs add 3.3.3.3 -a login -p 7 -t 30 -o 2", ctxFor(state, sw));
    const text = showText(state, sw);
    const a = text.split("\n").find((l) => l.startsWith("3.3.3.3"))!;
    const b = text.split("\n").find((l) => l.startsWith("4.4.4.4"))!;
    expect(a).toContain("LOGIN");
    expect(a).toContain("30");
    // 4.4.4.4 untouched by the 3.3.3.3 update.
    expect(b).toContain("MSCHAP");
    expect(b).toContain("65535");
  });

  it("rejects an invalid IPv4 address without creating a server", () => {
    const state = build();
    const sw = state.devices.sw1;
    const res = execute("config tacacs add 999.999.999.999", ctxFor(state, sw));
    expect(res.output.some((o) => o.kind === "error")).toBe(true);
    expect(showText(state, sw)).toContain("No TACACS+ servers configured.");
  });

  it("accepts a hostname or IPv6 server address (real device: A.B.C.D | X:X::X:X | hostname)", () => {
    const state = build();
    const sw = state.devices.sw1;
    expect(execute("config tacacs add tacacs.corp.local", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(false);
    expect(execute("config tacacs add 2001:db8::10", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(false);
    expect(showText(state, sw)).toContain("tacacs.corp.local");
  });

  it("rejects out-of-range host port / priority / timeout and invalid auth-type", () => {
    const state = build();
    const sw = state.devices.sw1;
    const bad = [
      "config tacacs add 6.6.6.6 -o 65536",
      "config tacacs add 6.6.6.6 -o 0",
      "config tacacs add 6.6.6.6 -p 65",
      "config tacacs add 6.6.6.6 -t 61",
      "config tacacs add 6.6.6.6 -a foo",
    ];
    for (const cmd of bad) {
      const res = execute(cmd, ctxFor(state, sw));
      expect(res.output.some((o) => o.kind === "error")).toBe(true);
    }
    // none of the rejected commands created 6.6.6.6.
    expect(showText(state, sw)).not.toContain("6.6.6.6");
  });

  it("global settings: authtype, passkey, timeout render and validate", () => {
    const state = build();
    const sw = state.devices.sw1;
    execute("config tacacs authtype chap", ctxFor(state, sw));
    execute("config tacacs timeout 15", ctxFor(state, sw));
    execute("config tacacs passkey mysecretkey", ctxFor(state, sw));
    const text = showText(state, sw);
    expect(text).toContain("Authentication Type : CHAP");
    expect(text).toContain("Global Timeout : 15");
    expect(text).toContain("Key Configured : Yes");
    expect(text).not.toContain("No TACACS+ global configuration found.");

    // negative: invalid global auth-type and out-of-range timeout rejected.
    expect(execute("config tacacs authtype foo", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config tacacs timeout 61", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
    expect(execute("config tacacs timeout 0", ctxFor(state, sw)).output.some((o) => o.kind === "error")).toBe(true);
  });
});
