import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/link_track";
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

describe("sonic-cli link state tracking (config-plane)", () => {
  it("stores a group with description/timeout/downstream/threshold and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "link state track FooBar").stack; // enter sub-view
    s = run(state, device, s, "description mlag-uplinks").stack;
    s = run(state, device, s, "timeout 120").stack;
    s = run(state, device, s, "downstream all-mclag").stack;
    s = run(state, device, s, "threshold type percentage up 70 down 40").stack;
    s = run(state, device, s, "exit").stack; // sub-view -> config
    s = run(state, device, s, "exit").stack; // config -> exec
    const text = run(state, device, s, "show link state tracking").text;
    expect(text).toContain("Name: FooBar");
    expect(text).toContain("Description: mlag-uplinks");
    expect(text).toContain("Timeout: 120 seconds");
    expect(text).toContain("Downstream: all-mclag");
    expect(text).toContain("Threshold: type percentage up 70 down 40");
  });

  it("no link state track <group> deletes the group", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "link state track Grp1").stack; // sub-view
    s = run(state, device, s, "exit").stack; // back to config
    run(state, device, s, "no link state track Grp1");
    expect(run(state, device, ["exec"], "show link state tracking").text).toContain("No link state tracking groups configured");
  });

  it("binds an upstream interface and reflects it on show", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "link state track FooBar").stack; // create group
    s = run(state, device, s, "exit").stack; // sub-view -> config
    s = run(state, device, s, "interface Ethernet 0").stack; // if-view
    s = run(state, device, s, "link state track FooBar upstream").stack;
    s = run(state, device, s, "exit").stack; // if-view -> config
    s = run(state, device, s, "exit").stack; // config -> exec
    const text = run(state, device, s, "show link state tracking FooBar").text;
    expect(text).toContain("Upstream Interfaces:");
    expect(text).toContain("Ethernet0");
  });

  it("rejects an invalid group name", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "link state track bad!name").text).toContain("Invalid group name");
  });
});
