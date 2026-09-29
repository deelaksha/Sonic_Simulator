import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/telemetry";
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

describe("sonic-cli telemetry / tam (config-plane)", () => {
  it("stores switch-id and enterprise-id and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "tam").stack;
    s = run(state, device, s, "switch-id 1234").stack;
    s = run(state, device, s, "enterprise-id 5678").stack;
    const out = run(state, device, s, "show tam switch").text;
    expect(out).toContain("Switch ID      : 1234");
    expect(out).toContain("Enterprise ID  : 5678");
  });

  it("stores a collector and lists it, then no collector clears it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "tam").stack;
    s = run(state, device, s, "collector c1 ip 1.1.1.1 port 7071 protocol UDP vrf Vrf1").stack;
    const listed = run(state, device, s, "show tam collectors").text;
    expect(listed).toContain("c1");
    expect(listed).toContain("1.1.1.1");
    expect(listed).toContain("7071");
    expect(listed).toContain("Vrf1");

    run(state, device, s, "no collector c1");
    expect(run(state, device, ["exec"], "show tam collectors").text).toContain("No collectors configured");
  });

  it("stores a flow-group and renders configured tuple fields", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "tam").stack;
    s = run(state, device, s, "flow-group f1 src-ip 10.1.1.10/24 protocol TCP priority 100").stack;
    const out = run(state, device, s, "show tam flowgroups").text;
    expect(out).toContain("Flow Group Name    : f1");
    expect(out).toContain("10.1.1.10/24");
    expect(out).toContain("TCP");
    expect(out).toContain("100");
  });

  it("rejects a non-numeric switch-id", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "tam").stack;
    expect(run(state, device, s, "switch-id abc").text).toContain("must be an integer");
  });
});
