import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/mclag";
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

describe("sonic-cli mclag (config-plane)", () => {
  it("stores MCLAG domain fields and shows them in `show mclag brief`", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "mclag domain 10").stack; // enters config-mclag-domain
    s = run(state, device, s, "source-ip 1.1.1.1").stack;
    s = run(state, device, s, "peer-ip 1.1.1.2").stack;
    s = run(state, device, s, "peer-link PortChannel2").stack;
    s = run(state, device, s, "keepalive-interval 1").stack;
    s = run(state, device, s, "mclag-system-mac 00:bb:bb:bb:cc:cc").stack;
    s = run(state, device, s, "exit").stack; // back to config
    s = run(state, device, s, "exit").stack; // back to exec
    const out = run(state, device, s, "show mclag brief").text;
    expect(out).toContain("Domain ID");
    expect(out).toContain("1.1.1.1");
    expect(out).toContain("1.1.1.2");
    expect(out).toContain("PortChannel2");
    expect(out).toContain("1 secs");
    expect(out).toContain("00:bb:bb:bb:cc:cc");
  });

  it("no source-ip clears just that field, leaving the domain", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "mclag domain 10").stack;
    s = run(state, device, s, "source-ip 1.1.1.1").stack;
    s = run(state, device, s, "no source-ip").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show mclag brief").text;
    expect(out).toContain("Domain ID");
    expect(out).not.toContain("1.1.1.1");
  });

  it("no mclag domain removes the whole domain", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "mclag domain 10").stack;
    s = run(state, device, s, "source-ip 1.1.1.1").stack;
    s = run(state, device, s, "exit").stack; // back to config
    run(state, device, s, "no mclag domain 10");
    expect(run(state, device, ["exec"], "show mclag brief").text).toContain("No MCLAG domains configured");
  });

  it("rejects a non-numeric MCLAG domain ID", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "mclag domain abc").text).toContain("MCLAG domain ID must be an integer");
  });
});
