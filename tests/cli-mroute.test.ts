import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/mroute";
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

// mroute is a SHOW-ONLY feature on the real box (no config commands exist), and
// its routing table is runtime multicast state the sim does not simulate. These
// tests assert the real render FORMAT with an honest, empty (never fabricated)
// route set.
describe("sonic-cli mroute (config-plane show-only)", () => {
  it("renders the empty IP multicast routing table for the default VRF", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    // Round-trip config mode: there is no mroute config command, so nothing is
    // ever stored — the table stays honestly empty.
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show ip mroute").text;
    expect(text).toContain("IP multicast routing table for VRF: default");
    expect(text).toContain("* -> indicates installed route");
    expect(text).toContain("Source");
    expect(text).toContain("Group");
    // Never fabricate runtime routes: no example rows, no installed-route marker.
    expect(text).not.toContain("71.0.0.11");
    expect(text.split("\n").some((l) => l.startsWith("* 7"))).toBe(false);
  });

  it("renders a summary with zero installed/total routes", () => {
    const { state, device } = sw();
    const text = run(state, device, ["exec"], "show ip mroute summary").text;
    expect(text).toContain("IP multicast routing table summary for VRF: default");
    expect(text).toContain("(S, G)");
    expect(text).toContain("0/0");
  });

  it("reflects the requested VRF name in the output", () => {
    const { state, device } = sw();
    const text = run(state, device, ["exec"], "show ip mroute vrf blue summary").text;
    expect(text).toContain("IP multicast routing table summary for VRF: blue");
    expect(text).toContain("0/0");
  });

  it("rejects `vrf` with no VRF name", () => {
    const { state, device } = sw();
    const text = run(state, device, ["exec"], "show ip mroute vrf").text;
    expect(text).toContain("VRF name required");
  });
});
