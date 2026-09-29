import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/errdisable";
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

describe("sonic-cli errdisable (config-plane)", () => {
  it("stores a recovery cause and shows it enabled", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "errdisable recovery cause udld").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show errdisable recovery").text;
    expect(text).toContain("udld");
    expect(text).toContain("enabled");
    // interval defaults to 300 when never configured
    expect(text).toContain("Timeout for Auto-recovery:  300 seconds");
  });

  it("stores the recovery interval and renders it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "errdisable recovery interval 200").stack;
    s = run(state, device, s, "exit").stack;
    expect(run(state, device, s, "show errdisable recovery").text).toContain("Timeout for Auto-recovery:  200 seconds");
  });

  it("clears a cause and resets the interval with 'no'", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "errdisable recovery cause udld");
    run(state, device, s, "errdisable recovery interval 200");
    run(state, device, s, "no errdisable recovery cause udld");
    run(state, device, s, "no errdisable recovery interval");
    const text = run(state, device, ["exec"], "show errdisable recovery").text;
    expect(text).not.toContain("enabled"); // udld back to disabled, nothing enabled
    expect(text).toContain("Timeout for Auto-recovery:  300 seconds"); // interval reset to default
  });

  it("rejects an invalid cause and an out-of-range interval", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "errdisable recovery cause bogus").text).toContain("cause must be one of");
    expect(run(state, device, s, "errdisable recovery interval 5").text).toContain("30..65535");
  });
});
