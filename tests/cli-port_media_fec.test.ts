import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/port_media_fec";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli } from "../lib/commands/sonic-cli";
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
// sub-view entry BEFORE consulting feature handlers, so `interface media-fec ...`
// config is dispatched through runModalHandlers directly — exactly how configMode
// hands configure-view commands to feature handlers.
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

describe("sonic-cli port media-fec (config-plane)", () => {
  it("stores a port media-fec mode and shows it", () => {
    const { state, device } = sw();
    expect(cfg(state, device, "interface media-fec port 1/1 mode custom")).toContain("in-progress");
    const shown = show(state, device, "show media-fec");
    expect(shown).toContain("1/1");
    expect(shown).toContain("custom");
  });

  it("no interface media-fec port clears it", () => {
    const { state, device } = sw();
    cfg(state, device, "interface media-fec port 1/1 mode ieee");
    cfg(state, device, "no interface media-fec port 1/1");
    expect(show(state, device, "show media-fec")).toContain("No media-fec configured");
  });

  it("rejects an invalid media-fec mode", () => {
    const { state, device } = sw();
    expect(cfg(state, device, "interface media-fec port 1/1 mode bogus")).toContain("media-fec mode must be one of");
    expect(show(state, device, "show media-fec")).toContain("No media-fec configured");
  });

  it("ignores non-media-fec interface commands (returns null)", () => {
    const { state, device } = sw();
    const r = runModalHandlers({ ctx: ctxFor(state, device), view: "configure-view", head: "interface", isNo: false, args: ["Ethernet0"], raw: "interface Ethernet0", delegate: () => [] });
    expect(r).toBeNull();
  });
});
