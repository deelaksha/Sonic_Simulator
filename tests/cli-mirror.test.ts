import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/mirror";
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

describe("sonic-cli mirror-session (config-plane)", () => {
  it("stores a SPAN mirror session and shows it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "mirror-session Mirror1").stack;
    s = run(state, device, s, "destination Ethernet0 source Ethernet4 direction rx").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show mirror-session").text;
    expect(text).toContain("SPAN Sessions");
    expect(text).toContain("Mirror1");
    expect(text).toContain("Ethernet0");
    expect(text).toContain("Ethernet4");
    expect(text).toContain("rx");
  });

  it("stores an ERSPAN mirror session with its IPs/dscp/gre", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "mirror-session Mirror2").stack;
    s = run(state, device, s, "destination erspan dst-ip 10.1.1.1 src-ip 11.1.1.1 dscp 10 ttl 10 gre 0x88ee queue 10 source Ethernet4 direction rx").stack;
    const text = run(state, device, ["exec"], "show mirror-session Mirror2").text;
    expect(text).toContain("ERSPAN Sessions");
    expect(text).toContain("Mirror2");
    expect(text).toContain("11.1.1.1");
    expect(text).toContain("10.1.1.1");
    expect(text).toContain("0x88ee");
  });

  it("no mirror-session deletes it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "mirror-session Mirror1").stack;
    s = run(state, device, s, "destination Ethernet0 source Ethernet4 direction rx").stack;
    s = run(state, device, s, "exit").stack; // leave sub-view -> configure-view
    run(state, device, s, "no mirror-session Mirror1");
    expect(run(state, device, ["exec"], "show mirror-session").text).toContain("No mirror sessions configured");
  });

  it("rejects mirror-session without a name", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "mirror-session").text).toContain("Mirror session name required");
  });
});
