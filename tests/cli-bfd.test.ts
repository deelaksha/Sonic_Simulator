import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/bfd";
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

interface BfdPeer { peer: string; interface?: string; multiplier?: number; rxInterval?: number; txInterval?: number; shutdown?: boolean }
function bfdOf(device: Device): { peers: BfdPeer[] } {
  return (device.config.features?.bfd ?? { peers: [] }) as { peers: BfdPeer[] };
}

describe("sonic-cli BFD sub-mode", () => {
  it("bfd enters the BFD view and peer <ip> creates it + enters the peer view", () => {
    const { state, device } = router();
    const { prompts } = session(state, device, [
      "configure terminal",
      "bfd",
      "peer 10.10.10.1 interface Ethernet0", // recorded prompt here is config-bfd
      "detect-multiplier 5", // recorded prompt here is config-bfd-peer
    ]);
    expect(prompts).toContain("r1(config-bfd)#");
    expect(prompts).toContain("r1(config-bfd-peer)#");
    expect(bfdOf(device).peers[0]).toMatchObject({ peer: "10.10.10.1", interface: "Ethernet0" });
  });

  it("detect-multiplier / receive-interval / transmit-interval / shutdown apply in the peer view", () => {
    const { state, device } = router();
    session(state, device, [
      "configure terminal",
      "bfd",
      "peer 10.10.10.1 interface Ethernet0",
      "detect-multiplier 5",
      "receive-interval 200",
      "transmit-interval 250",
      "shutdown",
      "exit",
      "exit",
      "exit",
    ]);
    expect(bfdOf(device).peers[0]).toMatchObject({
      multiplier: 5,
      rxInterval: 200,
      txInterval: 250,
      shutdown: true,
    });
  });

  it("no shutdown administratively re-enables the peer", () => {
    const { state, device } = router();
    session(state, device, [
      "configure terminal",
      "bfd",
      "peer 10.10.10.1 interface Ethernet0",
      "shutdown",
      "no shutdown",
      "exit",
      "exit",
      "exit",
    ]);
    expect(bfdOf(device).peers[0].shutdown).toBe(false);
  });

  it("no peer removes it in the BFD view; exit walks views back to exec", () => {
    const { state, device } = router();
    const { stack } = session(state, device, [
      "configure terminal",
      "bfd",
      "peer 10.10.10.1 interface Ethernet0",
      "exit", // leave peer view -> config-bfd
      "no peer 10.10.10.1",
      "exit", // config-bfd -> config
      "exit", // config -> exec
    ]);
    expect(bfdOf(device).peers).toHaveLength(0);
    expect(stack).toEqual(["exec"]);
  });
});
