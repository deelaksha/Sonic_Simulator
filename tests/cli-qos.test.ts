import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/qos";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, cliPrompt, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

function sw(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
  return { state: { devices: { sw1: device }, connections: [] }, device };
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
    prompts.push(cliPrompt(stack, "sw1"));
    const r = runSonicCli(l, stack, ctxFor(state, device));
    stack = r.toBash ? [] : r.stack;
  }
  return { stack, prompts };
}

interface QosMap { name: string; entries: { key: number; value: number }[] }
interface QosState {
  dscpTcMaps: QosMap[];
  tcQueueMaps: QosMap[];
  wredPolicies: { name: string; colors: { color: string; min: number; max: number; prob: number }[] }[];
  interfaces: Record<string, { dscpTc?: string; tcQueue?: string; schedulerPolicy?: string }>;
}
const qos = (device: Device): QosState => device.config.features?.qos as QosState;

describe("sonic-cli QoS sub-modes", () => {
  it("qos map dscp-tc enters the sub-view and dscp/traffic-class add entries", () => {
    const { state, device } = sw();
    const { prompts } = session(state, device, [
      "configure terminal",
      "qos map dscp-tc dmap",
      "dscp 10 traffic-class 3",
      "dscp 20 traffic-class 5",
      "exit",
      "exit",
    ]);
    // recorded prompt before line 3 is the sub-view
    expect(prompts).toContain("sw1(config-dscp-tc-map)#");
    const map = qos(device).dscpTcMaps.find((m) => m.name === "dmap");
    expect(map?.entries).toEqual([
      { key: 10, value: 3 },
      { key: 20, value: 5 },
    ]);
  });

  it("qos map tc-queue: traffic-class/queue add entries; no qos map deletes it", () => {
    const { state, device } = sw();
    session(state, device, [
      "configure terminal",
      "qos map tc-queue tqm",
      "traffic-class 3 queue 5",
      "exit",
    ]);
    expect(qos(device).tcQueueMaps.find((m) => m.name === "tqm")?.entries).toEqual([{ key: 3, value: 5 }]);
    session(state, device, ["configure terminal", "no qos map tc-queue tqm", "exit"]);
    expect(qos(device).tcQueueMaps.find((m) => m.name === "tqm")).toBeUndefined();
  });

  it("qos wred-policy: color thresholds apply inside the sub-view", () => {
    const { state, device } = sw();
    const { prompts } = session(state, device, [
      "configure terminal",
      "qos wred-policy wp1",
      "green minimum-threshold 1000 maximum-threshold 2000 drop-probability 5",
      "exit",
      "exit",
    ]);
    expect(prompts).toContain("sw1(config-wred)#");
    const wp = qos(device).wredPolicies.find((p) => p.name === "wp1");
    expect(wp?.colors).toEqual([{ color: "green", min: 1000, max: 2000, prob: 5 }]);
  });

  it("interface qos-map binds a map; no qos-map unbinds it", () => {
    const { state, device } = sw();
    session(state, device, [
      "configure terminal",
      "qos map dscp-tc dmap",
      "dscp 0 traffic-class 0",
      "exit",
      "interface Ethernet 0",
      "qos-map dscp-tc dmap",
      "exit",
      "exit",
    ]);
    expect(qos(device).interfaces["Ethernet0"]?.dscpTc).toBe("dmap");
    session(state, device, ["configure terminal", "interface Ethernet 0", "no qos-map dscp-tc", "exit", "exit"]);
    expect(qos(device).interfaces["Ethernet0"]).toBeUndefined();
  });
});
