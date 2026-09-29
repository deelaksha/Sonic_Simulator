import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/ipsla";
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

describe("sonic-cli ip sla (config-plane)", () => {
  it("stores an ICMP-echo instance and renders summary + detail", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip sla 10").stack;
    s = run(state, device, s, "frequency 45").stack;
    s = run(state, device, s, "icmp-echo 30.30.1.2").stack;
    s = run(state, device, s, "source-address 30.30.1.1").stack;
    s = run(state, device, s, "end").stack;

    const summary = run(state, device, s, "show ip sla").text;
    expect(summary).toContain("10");
    expect(summary).toContain("ICMP-echo");
    expect(summary).toContain("30.30.1.2");

    const detail = run(state, device, s, "show ip sla 10").text;
    expect(detail).toContain("IP SLA Operation Number: 10");
    expect(detail).toContain("ICMP destination IP address: 30.30.1.2");
    expect(detail).toContain("ICMP source IP address: 30.30.1.1");
    expect(detail).toContain("Operation frequency (sec): 45");
  });

  it("stores a TCP-connect instance with destination port and source port", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip sla 20").stack;
    s = run(state, device, s, "tcp-connect 40.40.1.2 port 100").stack;
    s = run(state, device, s, "source-port 200").stack;
    s = run(state, device, s, "end").stack;

    expect(run(state, device, s, "show ip sla").text).toContain("40.40.1.2(100)");
    const detail = run(state, device, s, "show ip sla 20").text;
    expect(detail).toContain("Type of Operation: TCP-connect");
    expect(detail).toContain("TCP destination port: 100");
    expect(detail).toContain("TCP source port: 200");
  });

  it("no ip sla <id> removes the instance", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip sla 10").stack;
    s = run(state, device, s, "exit").stack; // back to configure-view
    run(state, device, s, "no ip sla 10");
    expect(run(state, device, ["exec"], "show ip sla").text).toContain("No IP SLA instances configured");
  });

  it("rejects an out-of-range SLA ID", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ip sla 999").text).toContain("IP SLA ID must be an integer (1-255)");
  });
});
