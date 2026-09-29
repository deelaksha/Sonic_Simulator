import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/dynamic_port_breakout";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { runModalHandlers } from "../lib/commands/sonic-cli/registry";
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

// The modal core (sonic-cli.ts) special-cases the bare "interface" keyword for
// sub-view entry BEFORE consulting feature handlers, so `interface breakout ...`
// config is dispatched through runModalHandlers directly — exactly as configMode
// hands configure-view commands to feature handlers (cf. cli-port_media_fec.test).
function cfg(state: NetworkState, device: Device, raw: string): string {
  const tokens = raw.split(/\s+/);
  const isNo = tokens[0].toLowerCase() === "no";
  const rest = isNo ? tokens.slice(1) : tokens;
  const head = rest[0].toLowerCase();
  const args = rest.slice(1);
  const r = runModalHandlers({ ctx: ctxFor(state, device), view: "configure-view", head, isNo, args, raw, delegate: () => [] });
  return (r?.output ?? []).map((o) => o.text).join("\n");
}
function show(state: NetworkState, device: Device, cmd: string): string {
  return runSonicCli(cmd, ["exec"], ctxFor(state, device)).output.map((o) => o.text).join("\n");
}

describe("sonic-cli dynamic_port_breakout (config-plane)", () => {
  it("stores a per-port breakout config and shows it", () => {
    const { state, device } = sw();
    expect(cfg(state, device, "interface breakout port 1/1 mode 4x25G total-lane-count 4 owner testowner")).toContain("in-progress");
    const shown = show(state, device, "show interface breakout");
    expect(shown).toContain("1/1");
    expect(shown).toContain("4x25G");
    expect(show(state, device, "show interface breakout detail")).toContain("testowner");
  });

  it("no interface breakout clears the stored config", () => {
    const { state, device } = sw();
    cfg(state, device, "interface breakout port 1/1 mode 4x25G");
    cfg(state, device, "no interface breakout port 1/1");
    expect(show(state, device, "show interface breakout")).toContain("No port breakout configured");
  });

  it("enables global auto-breakout through configure + show via runSonicCli", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = runSonicCli("configure terminal", s, ctxFor(state, device)).stack;
    s = runSonicCli("auto-breakout", s, ctxFor(state, device)).stack;
    expect(show(state, device, "show interface breakout")).toContain("Auto-breakout: ENABLE");
  });

  it("rejects an invalid breakout mode", () => {
    const { state, device } = sw();
    expect(cfg(state, device, "interface breakout port 1/1 mode bogus")).toContain("breakout mode must be one of");
    expect(show(state, device, "show interface breakout")).toContain("No port breakout configured");
  });
});
