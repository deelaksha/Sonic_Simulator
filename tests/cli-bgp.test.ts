import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/bgp";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, cliPrompt, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

function router(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "r1", type: "router", name: "R1", x: 0, y: 0, ports: 2 });
  return { state: { devices: { r1: device }, connections: [] }, device };
}
function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (s: Simulation) => T): { value: T; events: SimEvent[] } {
      const s = new Simulation(state);
      return { value: fn(s), events: s.events };
    },
  };
}
function session(state: NetworkState, device: Device, lines: string[]): { stack: CliStack; prompts: string[] } {
  let stack: CliStack = ["exec"];
  const prompts: string[] = [];
  for (const l of lines) {
    prompts.push(cliPrompt(stack, "r1"));
    const r = runSonicCli(l, stack, ctxFor(state, device));
    stack = r.toBash ? [] : r.stack;
  }
  return { stack, prompts };
}

describe("sonic-cli BGP sub-mode (reference)", () => {
  it("router bgp <as> sets the AS and enters config-router-bgp", () => {
    const { state, device } = router();
    const { prompts } = session(state, device, ["configure terminal", "router bgp 65001"]);
    expect(prompts).toContain("r1(config)#");
    // after `router bgp 65001` the next prompt is the sub-view
    const feat = device.config.features?.bgp as { localAs?: number } | undefined;
    expect(feat?.localAs).toBe(65001);
  });

  it("neighbor / network / router-id apply inside the sub-view", () => {
    const { state, device } = router();
    session(state, device, [
      "configure terminal",
      "router bgp 65001",
      "router-id 1.1.1.1",
      "neighbor 10.0.0.2 remote-as 65002",
      "network 10.1.1.0/24",
      "exit",
      "exit",
    ]);
    const bgp = device.config.features?.bgp as { routerId?: string; neighbors?: { peer: string; remoteAs?: number }[]; networks?: string[] };
    expect(bgp.routerId).toBe("1.1.1.1");
    expect(bgp.neighbors?.[0]).toMatchObject({ peer: "10.0.0.2", remoteAs: 65002 });
    expect(bgp.networks).toContain("10.1.1.0/24");
  });

  it("prompt shows the sub-view and exit returns to config then exec", () => {
    const { state, device } = router();
    const { prompts, stack } = session(state, device, [
      "configure terminal",
      "router bgp 65001",
      "network 10.1.1.0/24", // recorded prompt here is the sub-view
      "exit",
      "exit",
    ]);
    expect(prompts).toContain("r1(config-router-bgp)#");
    expect(stack).toEqual(["exec"]); // sub-view -> config -> exec
  });

  it("no neighbor removes it", () => {
    const { state, device } = router();
    session(state, device, [
      "configure terminal",
      "router bgp 65001",
      "neighbor 10.0.0.2 remote-as 65002",
      "no neighbor 10.0.0.2",
      "exit",
      "exit",
    ]);
    const bgp = device.config.features?.bgp as { neighbors?: unknown[] };
    expect(bgp.neighbors ?? []).toHaveLength(0);
  });
});
