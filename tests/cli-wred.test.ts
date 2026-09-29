import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/wred";
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

describe("sonic-cli wred (config-plane)", () => {
  it("stores a WRED policy with green thresholds + ecn and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "qos wred-policy wred-green").stack;
    s = run(state, device, s, "green minimum-threshold 100 maximum-threshold 200 drop-probability 50").stack;
    s = run(state, device, s, "ecn all").stack;
    const out = run(state, device, s, "show qos wred-policy").text;
    expect(out).toContain("Profile");
    expect(out).toContain("wred-green");
    expect(out).toContain("ecn_all");
    expect(out).toContain("green-min-threshold");
    expect(out).toContain("100");
    expect(out).toContain("green-max-threshold");
    expect(out).toContain("200");
    expect(out).toContain("green-drop-rate");
    expect(out).toContain("50");
  });

  it("no green clears the green thresholds but keeps the policy", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "qos wred-policy p1").stack;
    s = run(state, device, s, "green minimum-threshold 10 maximum-threshold 20 drop-probability 5").stack;
    s = run(state, device, s, "no green").stack;
    const out = run(state, device, ["exec"], "show qos wred-policy p1").text;
    expect(out).toContain("p1");
    expect(out).not.toContain("green-min-threshold");
  });

  it("no qos wred-policy deletes the whole policy", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "qos wred-policy gone").stack;
    s = run(state, device, s, "exit").stack; // back to config-view
    run(state, device, s, "no qos wred-policy gone");
    expect(run(state, device, ["exec"], "show qos wred-policy").text).toContain("No WRED policies configured");
  });

  it("rejects an invalid ecn mode", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "qos wred-policy p2").stack;
    expect(run(state, device, s, "ecn bogus").text).toContain("ecn mode must be one of");
  });
});
