import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/ospf";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
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

type OspfState = {
  routerId?: string;
  networks?: { network: string; area: string }[];
  areas?: { id: string; type?: string }[];
};

describe("sonic-cli OSPF sub-mode", () => {
  it("router ospf enters config-router-ospf and exit walks back to exec", () => {
    const { state, device } = router();
    const { prompts, stack } = session(state, device, [
      "configure terminal",
      "router ospf",
      "ospf router-id 1.1.1.1", // recorded prompt here is the sub-view
      "exit",
      "exit",
    ]);
    expect(prompts).toContain("r1(config)#");
    expect(prompts).toContain("r1(config-router-ospf)#");
    expect(stack).toEqual(["exec"]); // sub-view -> config -> exec
  });

  it("ospf router-id / network / area apply inside the sub-view (integer area normalizes to dotted)", () => {
    const { state, device } = router();
    session(state, device, [
      "configure terminal",
      "router ospf",
      "ospf router-id 1.1.1.1",
      "network 10.10.3.0/24 area 1",
      "area 1 stub",
      "exit",
      "exit",
    ]);
    const ospf = device.config.features?.ospf as OspfState;
    expect(ospf.routerId).toBe("1.1.1.1");
    expect(ospf.networks).toContainEqual({ network: "10.10.3.0/24", area: "0.0.0.1" });
    expect(ospf.areas).toContainEqual({ id: "0.0.0.1", type: "stub" });
  });

  it("no network withdraws it; no ospf router-id clears the id", () => {
    const { state, device } = router();
    session(state, device, [
      "configure terminal",
      "router ospf",
      "ospf router-id 1.1.1.1",
      "network 10.10.3.0/24 area 1",
      "no network 10.10.3.0/24 area 1",
      "no ospf router-id",
      "exit",
      "exit",
    ]);
    const ospf = device.config.features?.ospf as OspfState;
    expect(ospf.networks ?? []).toHaveLength(0);
    expect(ospf.routerId).toBeUndefined();
  });

  it("ospf router-id 0.0.0.0 is rejected by the delegated Click command", () => {
    const { state, device } = router();
    let stack: CliStack = ["exec"];
    for (const l of ["configure terminal", "router ospf"]) {
      stack = runSonicCli(l, stack, ctxFor(state, device)).stack;
    }
    const r = runSonicCli("ospf router-id 0.0.0.0", stack, ctxFor(state, device));
    expect(r.output.some((o) => o.text.includes("Router ID must be a non-zero IPv4 address"))).toBe(true);
    expect((device.config.features?.ospf as OspfState | undefined)?.routerId).toBeUndefined();
  });
});
