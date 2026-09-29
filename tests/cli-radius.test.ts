import { describe, it, expect } from "vitest";
import "../lib/commands/sonic-cli/features/radius"; // side-effect: register handler
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

interface RadiusServer {
  ip: string;
  key?: string;
  authType?: string;
  authPort?: number;
  priority?: number;
  timeout?: number;
  retransmit?: number;
  sourceInterface?: string;
  vrf?: string;
}
interface RadiusState {
  servers: RadiusServer[];
  global: Record<string, string>;
}

function sw(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { state: { devices: { sw1: device }, connections: [] }, device };
}

function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (s: Simulation) => T): { value: T; events: SimEvent[] } {
      const s = new Simulation(state);
      return { value: fn(s), events: s.events };
    },
  };
}

/** Run a sequence of modal lines, threading the mode stack; return combined text. */
function session(state: NetworkState, device: Device, start: CliStack, lines: string[]): { stack: CliStack; text: string } {
  let stack = start;
  const out: string[] = [];
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    out.push(...r.output.map((o) => o.text));
    stack = r.toBash ? [] : r.stack;
  }
  return { stack, text: out.join("\n") };
}

function radius(device: Device): RadiusState {
  return peekFeatureState<RadiusState>(device, "radius") ?? { servers: [], global: {} };
}

describe("sonic-cli radius modal CLI", () => {
  it("configures global RADIUS settings via radius-server ... in config mode", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "radius-server nas-ip 10.59.100.2",
      "radius-server timeout 3",
      "radius-server retransmit 2",
      "radius-server auth-type chap",
      "radius-server key testing123",
      "radius-server statistics enable",
      "exit",
    ]);
    const g = radius(device).global;
    expect(g["nas-ip"]).toBe("10.59.100.2");
    expect(g["timeout"]).toBe("3");
    expect(g["retransmit"]).toBe("2");
    expect(g["auth-type"]).toBe("chap");
    expect(g["key"]).toBe("testing123");
    expect(g["statistics"]).toBe("enable");
  });

  it("radius-server host adds a server with its attributes; delegated show reflects it", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "radius-server host 10.1.1.1 auth-port 1812 auth-type pap key secret priority 5 retransmit 4 timeout 6",
      "exit",
    ]);
    const s = radius(device).servers.find((x) => x.ip === "10.1.1.1");
    expect(s).toBeDefined();
    expect(s?.authPort).toBe(1812);
    expect(s?.authType).toBe("pap");
    expect(s?.key).toBe("secret");
    expect(s?.priority).toBe(5);
    expect(s?.retransmit).toBe(4);
    expect(s?.timeout).toBe(6);

    const show = execute("show radius", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toMatch(/10\.1\.1\.1/);
  });

  it("no radius-server host <ip> deletes the server", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "radius-server host 10.2.2.2 key foo",
      "radius-server host 10.3.3.3 key bar",
      "no radius-server host 10.2.2.2",
      "exit",
    ]);
    const ips = radius(device).servers.map((x) => x.ip);
    expect(ips).toEqual(["10.3.3.3"]);
  });

  it("rejects an invalid host IP via the delegated Click validation", () => {
    const { state, device } = sw();
    const r = runSonicCli(
      "radius-server host 999.1.1.1 key foo",
      ["exec", "config"],
      ctxFor(state, device),
    );
    expect(r.output.some((o) => o.kind === "error")).toBe(true);
    expect(radius(device).servers.length).toBe(0);
  });
});
