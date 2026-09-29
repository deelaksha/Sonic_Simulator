import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/routemap";
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

type RouteMapStatement = { seq: number; action: string; match: string[]; set: string[] };
type RouteMapState = { maps: Record<string, RouteMapStatement[]> };
function routemap(device: Device): RouteMapState {
  return (device.config.features?.routemap as RouteMapState) ?? { maps: {} };
}

describe("sonic-cli route-map sub-mode", () => {
  it("route-map <name> permit <seq> creates the statement and enters config-route-map", () => {
    const { state, device } = router();
    const { prompts } = session(state, device, ["configure terminal", "route-map RM1 permit 10", "match metric 12"]);
    // the prompt recorded before `match metric 12` is the sub-view prompt.
    expect(prompts).toContain("r1(config-route-map)#");
    const stmt = routemap(device).maps["RM1"]?.[0];
    expect(stmt).toMatchObject({ seq: 10, action: "permit" });
  });

  it("match / set clauses apply inside the sub-view", () => {
    const { state, device } = router();
    session(state, device, [
      "configure terminal",
      "route-map RM1 permit 10",
      "match metric 12",
      "match local-preference 40",
      "set metric 75",
      "set ip next-hop 15.10.10.3",
      "exit",
      "exit",
    ]);
    const stmt = routemap(device).maps["RM1"]?.[0];
    expect(stmt?.match).toEqual(["metric 12", "local-preference 40"]);
    expect(stmt?.set).toEqual(["metric 75", "ip next-hop 15.10.10.3"]);
  });

  it("no set removes a set clause inside the sub-view", () => {
    const { state, device } = router();
    session(state, device, [
      "configure terminal",
      "route-map RM1 permit 10",
      "set metric 75",
      "no set metric",
      "exit",
      "exit",
    ]);
    const stmt = routemap(device).maps["RM1"]?.[0];
    expect(stmt?.set ?? []).toHaveLength(0);
  });

  it("no route-map deletes the whole map; exit unwinds to exec", () => {
    const { state, device } = router();
    const { stack } = session(state, device, [
      "configure terminal",
      "route-map RM1 permit 10",
      "set metric 75",
      "exit",
      "no route-map RM1",
      "exit",
    ]);
    expect(routemap(device).maps["RM1"]).toBeUndefined();
    expect(stack).toEqual(["exec"]);
  });
});
