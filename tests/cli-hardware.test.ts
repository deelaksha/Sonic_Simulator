import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/hardware";
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

describe("sonic-cli hardware (config-plane)", () => {
  it("stores a TCAM key-profile and renders it in show output", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "hardware").stack;
    s = run(state, device, s, "tcam").stack;
    s = run(state, device, s, "ip-acl ingress key-profile pac").stack;
    expect(run(state, device, ["exec"], "show running-configuration hardware tcam").text).toContain(
      "ip-acl ingress key-profile pac",
    );
    expect(run(state, device, ["exec"], "show hardware tcam key-profile").text).toContain("L3_ACL");
  });

  it("stores the ACL counter mode and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "hardware").stack;
    s = run(state, device, s, "access-list").stack;
    s = run(state, device, s, "counters per-entry").stack;
    expect(run(state, device, ["exec"], "show running-configuration hardware access-list").text).toContain(
      "counters per-entry",
    );
  });

  it("no <feature> ... key-profile removes the stored TCAM binding", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "hardware").stack;
    s = run(state, device, s, "tcam").stack;
    run(state, device, s, "ip-acl ingress key-profile pac");
    run(state, device, s, "no ip-acl ingress key-profile");
    expect(run(state, device, ["exec"], "show running-configuration hardware").text).toContain(
      "No hardware configuration",
    );
  });

  it("rejects an invalid stage", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "hardware").stack;
    s = run(state, device, s, "tcam").stack;
    expect(run(state, device, s, "ip-acl sideways key-profile pac").text).toContain("stage must be one of");
  });
});
