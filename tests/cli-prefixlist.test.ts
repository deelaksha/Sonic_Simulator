import "../lib/commands/sonic-cli/features/prefixlist";
import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
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

/** Run a sequence of modal lines, threading the mode stack; return combined text. */
function session(state: NetworkState, device: Device, start: CliStack, lines: string[]): { stack: CliStack; text: string; toBash: boolean } {
  let stack = start;
  let toBash = false;
  const out: string[] = [];
  for (const l of lines) {
    const r = runSonicCli(l, stack, ctxFor(state, device));
    out.push(...r.output.map((o) => o.text));
    stack = r.toBash ? [] : r.stack;
    if (r.toBash) toBash = true;
  }
  return { stack, text: out.join("\n"), toBash };
}

const showText = (state: NetworkState, device: Device, cmd: string): string =>
  execute(cmd, ctxFor(state, device)).output.map((o) => o.text).join("\n");

describe("sonic-cli prefix-list modal CLI", () => {
  it("ip prefix-list adds an IPv4 entry in config mode (delegates to Click)", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "ip prefix-list AGTPL4 seq 5 permit 10.0.0.0/8",
      "exit",
    ]);
    const show = showText(state, device, "show ip prefix-list AGTPL4");
    expect(show).toContain("IP prefix list AGTPL4:");
    expect(show).toContain("seq 5 permit 10.0.0.0/8");
  });

  it("ip prefix-list preserves ge/le range and name case", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "ip prefix-list MyList seq 10 permit 172.16.0.0/12 ge 20 le 28",
      "exit",
    ]);
    const show = showText(state, device, "show ip prefix-list MyList");
    expect(show).toContain("seq 10 permit 172.16.0.0/12 ge 20 le 28");
  });

  it("no ip prefix-list <name> deletes the whole list", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], [
      "configure terminal",
      "ip prefix-list DropMe seq 5 permit 10.0.0.0/8",
      "no ip prefix-list DropMe",
      "exit",
    ]);
    expect(showText(state, device, "show ip prefix-list DropMe")).toContain("No IP prefix-list configured");
  });

  it("passes the Click validation error through when the mandatory seq keyword is missing", () => {
    const { state, device } = sw();
    const res = session(state, device, ["exec"], [
      "configure terminal",
      "ip prefix-list Bad permit 200.0.0.0/8",
    ]);
    expect(res.text).toContain("% Error: Invalid input detected at '^' marker.");
    // Nothing was stored for the rejected list.
    expect(showText(state, device, "show ip prefix-list Bad")).toContain("No IP prefix-list configured");
  });
});
