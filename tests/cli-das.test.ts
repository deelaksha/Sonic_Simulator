import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/das";
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

describe("sonic-cli das (RADIUS dynamic-authorization, config-plane)", () => {
  it("stores DAS global + client config and renders it in show", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "aaa server radius dynamic-author").stack; // enter config-radius-da sub-mode
    s = run(state, device, s, "port 8989").stack;
    s = run(state, device, s, "auth-type session-key").stack;
    s = run(state, device, s, "request-timeout 10").stack;
    s = run(state, device, s, "vrf mgmt").stack;
    s = run(state, device, s, "server-key GlobalSecret1").stack;
    s = run(state, device, s, "client 7.7.7.7 server-key ClientSecret7").stack;
    s = run(state, device, s, "end").stack;

    const out = run(state, device, s, "show radius-server dynamic-author").text;
    expect(out).toContain("Admin Mode");
    expect(out).toContain("Enabled");
    expect(out).toContain("8989");
    expect(out).toContain("session-key");
    expect(out).toContain("mgmt");
    expect(out).toContain("GlobalSecret1");
    expect(out).toContain("7.7.7.7");
    expect(out).toContain("ClientSecret7");
  });

  it("reflects `authentication command bounce-port ignore` (CoA Bounce-Host-Port)", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "authentication command bounce-port ignore").stack;
    s = run(state, device, s, "aaa server radius dynamic-author").stack;
    s = run(state, device, s, "end").stack;
    const out = run(state, device, s, "show radius-server dynamic-author").text;
    expect(out).toContain("CoA Bounce-Host-Port");
    expect(out).toContain("Ignore");
  });

  it("`no aaa server radius dynamic-author` clears the whole DAS config", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "aaa server radius dynamic-author").stack;
    s = run(state, device, s, "port 8989").stack;
    s = run(state, device, s, "exit").stack; // back to config view
    s = run(state, device, s, "no aaa server radius dynamic-author").stack;
    s = run(state, device, s, "end").stack;
    expect(run(state, device, s, "show radius-server dynamic-author").text).toContain("Dynamic authorization is not configured");
  });

  it("rejects an out-of-range port", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "aaa server radius dynamic-author").stack;
    expect(run(state, device, s, "port 99999").text).toContain("port must be an integer in the range 1025-65535");
  });
});
