import "../lib/commands/sonic-cli/features/tacacs"; // side-effect: registers the tacacs modal handler
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";
import { peekFeatureState } from "../lib/models/feature-state";

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
    stack = r.stack;
  }
  return { stack, text: out.join("\n") };
}

interface TacacsServer {
  ip: string;
  key?: string;
  priority?: number;
  type?: string;
  timeout?: number;
  port?: number;
  vrf?: string;
}
interface TacacsState {
  servers: TacacsServer[];
  globalKey?: string;
  authType?: string;
  timeout?: number;
}

describe("sonic-cli tacacs modal CLI", () => {
  it("tacacs-server host with all options delegates to config tacacs add", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "tacacs-server host 10.0.0.1 port 4949 timeout 20 priority 5 type chap key sec1 vrf mgmt",
      "exit",
    ]);
    const st = peekFeatureState<TacacsState>(device, "tacacs");
    expect(st?.servers).toEqual([
      { ip: "10.0.0.1", port: 4949, timeout: 20, priority: 5, type: "chap", key: "sec1", vrf: "mgmt" },
    ]);
    // A delegated `show tacacs` reflects the new server.
    const show = execute("show tacacs", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toMatch(/10\.0\.0\.1/);
    expect(show).toMatch(/CHAP/);
    expect(show).toMatch(/MGMT/);
  });

  it("global timeout / auth-type / key set the global TACACS+ config", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "tacacs-server timeout 15",
      "tacacs-server auth-type mschap",
      "tacacs-server key topsecret",
      "exit",
    ]);
    const st = peekFeatureState<TacacsState>(device, "tacacs");
    expect(st?.timeout).toBe(15);
    expect(st?.authType).toBe("mschap");
    expect(st?.globalKey).toBe("topsecret");
  });

  it("no tacacs-server host deletes the server", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "tacacs-server host 10.0.0.1",
      "tacacs-server host 10.0.0.2",
      "no tacacs-server host 10.0.0.1",
      "exit",
    ]);
    const st = peekFeatureState<TacacsState>(device, "tacacs");
    expect(st?.servers.map((s) => s.ip)).toEqual(["10.0.0.2"]);
  });

  it("invalid auth-type surfaces the Click validation error", () => {
    const { state, device } = sw();
    const res = session(state, device, ["exec"], [
      "configure terminal",
      "tacacs-server auth-type bogus",
    ]);
    expect(res.text).toMatch(/must be one of pap\|chap/);
    const st = peekFeatureState<TacacsState>(device, "tacacs");
    expect(st?.authType).toBeUndefined();
  });
});
