import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/logging";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";
import { logEvent } from "../lib/control/syslog";

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

describe("sonic-cli logging (config-plane)", () => {
  it("stores a logging server and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "logging server 30.1.1.1 remote-port 514 protocol tcp vrf Vrf2 severity info").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show logging servers").text;
    expect(text).toContain("30.1.1.1");
    expect(text).toContain("Vrf2");
    expect(text).toContain("info");
    expect(text).toContain("tcp");
  });

  it("shows nothing when no logging servers are configured", () => {
    const { state, device } = sw();
    expect(run(state, device, ["exec"], "show logging servers").text).toContain("No logging servers configured");
  });

  it("no logging server clears it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "logging server 40.1.1.1 protocol udp");
    run(state, device, s, "no logging server 40.1.1.1");
    expect(run(state, device, ["exec"], "show logging servers").text).toContain("No logging servers configured");
  });

  it("rejects an invalid protocol", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "logging server 50.1.1.1 protocol bogus").text).toContain("protocol must be one of");
  });

  it("show logging [lines N] renders the device syslog; clear logging empties it", () => {
    const { state, device } = sw();
    for (let i = 1; i <= 3; i++) logEvent(device, 1_000_000 + i, "NOTICE", "swss#orchagent", `:- updatePortOperStatus: Port Ethernet${i} oper state set from up to down`);
    const all = run(state, device, ["exec"], "show logging").text.split("\n");
    expect(all).toHaveLength(3);
    expect(all[2]).toMatch(/^\d{4} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\.\d{6} sw1 NOTICE swss#orchagent: :- updatePortOperStatus: Port Ethernet3 oper state set from up to down$/);
    expect(run(state, device, ["exec"], "show logging lines 1").text).toBe(all[2]);
    run(state, device, ["exec"], "clear logging");
    expect(run(state, device, ["exec"], "show logging").text).toBe("");
  });
});
