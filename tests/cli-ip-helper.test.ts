import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/ip-helper";
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

describe("sonic-cli ip-helper (config-plane)", () => {
  it("stores global forwarding config and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip forward-protocol udp enable").stack;
    s = run(state, device, s, "ip forward-protocol udp rate-limit 2000").stack;
    s = run(state, device, s, "ip forward-protocol udp include tftp").stack;
    s = run(state, device, s, "ip forward-protocol udp include 12200").stack;
    s = run(state, device, s, "ip forward-protocol udp exclude ntp").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show ip forward-protocol").text;
    expect(out).toContain("UDP forwarding  : Enabled");
    expect(out).toContain("UDP rate limit  : 2000 pps");
    expect(out).toContain("UDP forwarding enabled on the ports: TFTP, 12200");
    expect(out).toContain("UDP forwarding disabled on the ports: NTP");
  });

  it("no ip forward-protocol udp enable disables forwarding", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ip forward-protocol udp enable");
    run(state, device, s, "no ip forward-protocol udp enable");
    expect(run(state, device, ["exec"], "show ip forward-protocol").text).toContain("UDP forwarding  : Disabled");
  });

  it("include then exclude of the same port moves it (never both lists)", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ip forward-protocol udp include dns");
    run(state, device, s, "ip forward-protocol udp exclude dns");
    const out = run(state, device, ["exec"], "show ip forward-protocol").text;
    expect(out).toContain("UDP forwarding disabled on the ports: DNS");
    expect(out).not.toContain("UDP forwarding enabled on the ports:");
  });

  it("rejects an out-of-range rate limit", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ip forward-protocol udp rate-limit 50").text).toContain("must be an integer between 600 and 10000");
  });
});
