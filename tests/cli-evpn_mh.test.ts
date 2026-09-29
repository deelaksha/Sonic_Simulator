import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/evpn_mh";
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

describe("sonic-cli evpn esi-multihoming (config-plane)", () => {
  it("stores ESI-MH timers and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "evpn esi-multihoming").stack;
    s = run(state, device, s, "startup-delay 100").stack;
    s = run(state, device, s, "mac-holdtime 2000").stack;
    s = run(state, device, s, "df-election-time 5").stack;
    s = run(state, device, s, "exit").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show running-configuration evpn-mh").text;
    expect(text).toContain("evpn esi-multihoming");
    expect(text).toContain("startup-delay 100");
    expect(text).toContain("mac-holdtime 2000");
    expect(text).toContain("df-election-time 5");
  });

  it("no <timer> clears a single timer", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "evpn esi-multihoming").stack;
    s = run(state, device, s, "startup-delay 100").stack;
    s = run(state, device, s, "no startup-delay").stack;
    const text = run(state, device, ["exec"], "show running-configuration evpn-mh").text;
    expect(text).toContain("evpn esi-multihoming");
    expect(text).not.toContain("startup-delay");
  });

  it("no evpn esi-multihoming clears the whole config", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "evpn esi-multihoming").stack;
    s = run(state, device, s, "mac-holdtime 2000").stack;
    s = run(state, device, s, "exit").stack; // leave sub-view -> configure-view
    run(state, device, s, "no evpn esi-multihoming");
    expect(run(state, device, ["exec"], "show running-configuration evpn-mh").text).toContain(
      "EVPN ESI-multihoming is not configured",
    );
  });

  it("rejects an out-of-range timer value", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "evpn esi-multihoming").stack;
    expect(run(state, device, s, "startup-delay 5000").text).toContain("range 0..3600");
  });
});
