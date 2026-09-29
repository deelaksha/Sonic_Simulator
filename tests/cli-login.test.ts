import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/login";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

function sw(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { state: { devices: { sw1: device }, connections: [] }, device };
}
function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return { device, network: state, captures, runSim<T>(fn: (s: Simulation) => T) { const s = new Simulation(state); return { value: fn(s), events: s.events as SimEvent[] }; } };
}
function run(state: NetworkState, device: Device, stack: CliStack, cmd: string): { stack: CliStack; text: string } {
  const r = runSonicCli(cmd, stack, ctxFor(state, device));
  return { stack: r.toBash ? [] : r.stack, text: r.output.map((o) => o.text).join("\n") };
}

describe("sonic-cli login (config-plane)", () => {
  it("stores login attributes and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "login concurrent-session limit 2").stack;
    s = run(state, device, s, "login exec-timeout 60").stack;
    s = run(state, device, s, "login lockout max-retries 10").stack;
    s = run(state, device, s, "login lockout console-exempt").stack;
    s = run(state, device, s, "login password-attribute min-length 10").stack;
    s = run(state, device, s, "login password-attribute character-restriction lower 3").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show login").text;
    expect(out).toContain("Concurrent session limit");
    expect(out).toContain("2");
    expect(out).toContain("Exec-timeout");
    expect(out).toContain("60");
    expect(out).toContain("Lockout max-retries");
    expect(out).toContain("10");
    expect(out).toContain("Lockout console-exempt");
    expect(out).toContain("enabled");
    expect(out).toContain("Password min-length");
    expect(out).toContain("Password min lower-case");
    expect(out).toContain("3");
  });

  it("no login concurrent-session limit clears it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "login concurrent-session limit 5");
    run(state, device, s, "no login concurrent-session limit");
    expect(run(state, device, ["exec"], "show login").text).toContain("No login configuration");
  });

  it("no login clears all login configuration", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "login exec-timeout 120");
    run(state, device, s, "login lockout period 5");
    run(state, device, s, "no login");
    expect(run(state, device, ["exec"], "show login").text).toContain("No login configuration");
  });

  it("rejects an out-of-range concurrent-session limit", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "login concurrent-session limit 99").text).toContain("must be 1-12");
    // nothing stored on rejection
    expect(run(state, device, ["exec"], "show login").text).toContain("No login configuration");
  });
});
