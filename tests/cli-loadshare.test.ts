import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/loadshare";
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

describe("sonic-cli ip load-share (config-plane)", () => {
  it("stores hash seed and offset and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip load-share hash seed 200").stack;
    s = run(state, device, s, "ip load-share hash offset 4").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show ip load-share").text;
    expect(out).toContain("Hash Seed");
    expect(out).toContain("200");
    expect(out).toContain("Hash Offset");
  });

  it("stores ipv4 hash fields (list) and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ip load-share hash ipv4 ipv4-src-ip").stack;
    s = run(state, device, s, "ip load-share hash ipv4 ipv4-dst-ip").stack;
    const out = run(state, device, ["exec"], "show ip load-share").text;
    expect(out).toContain("IPv4 Hash Fields");
    expect(out).toContain("ipv4-src-ip");
    expect(out).toContain("ipv4-dst-ip");
  });

  it("no ip load-share hash seed clears it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ip load-share hash seed 200");
    run(state, device, s, "no ip load-share hash seed");
    expect(run(state, device, ["exec"], "show ip load-share").text).toContain("No IP load-share hash parameters configured");
  });

  it("rejects an out-of-range hash offset", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ip load-share hash offset 99").text).toContain("hash offset must be 0-15 or flow-based");
  });
});
