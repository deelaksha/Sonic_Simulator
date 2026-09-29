import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

function sw(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "sw1", type: "switch", name: "sonic", x: 0, y: 0, ports: 4 });
  return { state: { devices: { sw1: device }, connections: [] }, device };
}
function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return { device, network: state, captures, runSim<T>(fn: (s: Simulation) => T) { const s = new Simulation(state); return { value: fn(s), events: s.events as SimEvent[] }; } };
}
function session(state: NetworkState, device: Device, lines: string[]) {
  let stack: CliStack = ["exec"];
  let last: { output: { text: string; kind?: string }[] } = { output: [] };
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    stack = r.toBash ? [] : r.stack;
    last = r;
  }
  return last;
}

describe("generic config-plane fallback (recognized commands are accepted + stored)", () => {
  it("a recognized config command with no handler is accepted silently (no error)", () => {
    const { state, device } = sw();
    const r = session(state, device, ["configure terminal", "router bgp 65001", "timers bgp 10 30"]);
    expect(r.output.some((o) => o.kind === "error")).toBe(false); // accepted, like the device
  });

  it("accepted config-plane commands appear in show running-configuration", () => {
    const { state, device } = sw();
    const r = session(state, device, [
      "configure terminal", "router bgp 65001", "timers bgp 10 30", "exit", "exit",
      "show running-configuration",
    ]);
    expect(r.output.map((o) => o.text).join("\n")).toContain("timers bgp 10 30");
  });

  it("genuinely unknown input is still rejected", () => {
    const { state, device } = sw();
    const r = session(state, device, ["configure terminal", "frobnicate wibble"]);
    expect(r.output.some((o) => o.kind === "error" && o.text.includes("Unrecognized"))).toBe(true);
  });

  it("no <cmd> removes a previously accepted config-plane line", () => {
    const { state, device } = sw();
    const r = session(state, device, [
      "configure terminal", "router bgp 65001", "timers bgp 10 30", "no timers bgp", "exit", "exit",
      "show running-configuration",
    ]);
    // the timers line was removed → not in running-config (or running-config empty)
    expect(r.output.map((o) => o.text).join("\n")).not.toContain("timers bgp 10 30");
  });
});

describe("exec-mode show fallback (recognized show commands degrade gracefully)", () => {
  it("a real device 'show' command with no handler is recognized, not rejected as 'unknown command'", () => {
    const { state, device } = sw();
    const r = session(state, device, ["show object-groups"]);
    const txt = r.output.map((o) => o.text).join("\n");
    expect(txt).not.toMatch(/unknown command/i);
    expect(txt).toMatch(/recognized SONiC command; not simulated/i);
  });

  it("a genuinely bogus (non-show) exec command is still rejected as unrecognized", () => {
    const { state, device } = sw();
    const r = session(state, device, ["frobnicate wibble"]);
    expect(r.output.some((o) => o.kind === "error" && /Unrecognized/i.test(o.text))).toBe(true);
  });

  it("an implemented 'show' command still renders real output (no regression)", () => {
    const { state, device } = sw();
    const r = session(state, device, ["show vlan"]);
    expect(r.output.some((o) => o.kind === "error")).toBe(false);
  });
});
