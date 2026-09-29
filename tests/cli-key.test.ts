import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/key";
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

describe("sonic-cli key (config-key password-encrypt config-plane)", () => {
  it("shows False before any key is configured", () => {
    const { state, device } = sw();
    expect(run(state, device, ["exec"], "show config-key password-encrypt").text).toContain(
      "Primary encryption key configured : False",
    );
  });

  it("stores a primary encryption key and reflects it on show", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "key config-key password-encrypt Sup3rSecret").stack;
    s = run(state, device, s, "exit").stack;
    expect(run(state, device, s, "show config-key password-encrypt").text).toContain(
      "Primary encryption key configured : True",
    );
  });

  it("no key config-key password-encrypt reverts to the default", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "key config-key password-encrypt Sup3rSecret");
    run(state, device, s, "no key config-key password-encrypt");
    expect(run(state, device, ["exec"], "show config-key password-encrypt").text).toContain(
      "Primary encryption key configured : False",
    );
  });

  it("rejects a passphrase containing a comma", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "key config-key password-encrypt bad,key").text).toContain(
      "% key:",
    );
  });
});
