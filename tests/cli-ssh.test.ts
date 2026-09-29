import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/ssh";
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

describe("sonic-cli ssh (config-plane)", () => {
  it("stores global SSHD options and renders show ip ssh", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip ssh max-auth-retries 5").stack;
    s = run(state, device, s, "ip ssh permit-root-login true").stack;
    s = run(state, device, s, "ip ssh ciphers aes128-ctr,aes192-ctr").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show ip ssh").text;
    expect(out).toContain("SSH Global Information");
    expect(out).toContain("Max-auth-retries               : 5");
    expect(out).toContain("Permit-root-login              : True");
    expect(out).toContain("Ciphers                        : aes128-ctr,aes192-ctr");
  });

  it("stores client options and renders show ip ssh client", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip ssh client ciphers aes256-ctr").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show ip ssh client").text;
    expect(out).toContain("SSH Client Configuration Parameters");
    expect(out).toContain("Ciphers              : aes256-ctr");
    // global show must not leak the client value
    expect(run(state, device, s, "show ip ssh").text).toContain("No SSH global parameters configured");
  });

  it("no ip ssh <opt> clears the stored value", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ip ssh permit-root-login true");
    run(state, device, s, "no ip ssh permit-root-login");
    expect(run(state, device, ["exec"], "show ip ssh").text).toContain("No SSH global parameters configured");
  });

  it("rejects an out-of-range max-auth-retries and a bad bool", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ip ssh max-auth-retries 99").text).toContain("must be an integer 0-10");
    expect(run(state, device, s, "ip ssh permit-root-login yes").text).toContain("must be true|false");
  });
});
