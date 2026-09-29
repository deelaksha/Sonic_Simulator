import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/mgmt_dhcp";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";
import { MODAL_HANDLERS } from "../lib/commands/sonic-cli/registry";
import { cpList } from "../lib/commands/sonic-cli/config-plane";

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

// The core sonic-cli routes only `show` to enable-view modal handlers, so the
// `renew dhcp-lease` RPC handler is exercised directly through the registry
// (see the feature header for why it is not reachable via runSonicCli yet).
const HANDLER = MODAL_HANDLERS.find((h) => h.id === "mgmt_dhcp" && h.views.includes("enable-view"))!;
function renew(state: NetworkState, device: Device, cmd: string): string {
  const tokens = cmd.trim().split(/\s+/);
  const isNo = tokens[0] === "no";
  const rest = isNo ? tokens.slice(1) : tokens; // rest[0] === "renew"
  const r = HANDLER.run({ ctx: ctxFor(state, device), view: "enable-view", head: "renew", isNo, args: rest.slice(1), raw: cmd, delegate: () => [] });
  return (r?.output ?? []).map((o) => o.text).join("\n");
}

describe("sonic-cli mgmt_dhcp (config-plane, renew RPC)", () => {
  it("records a requested DHCP-lease renewal for the management interface", () => {
    const { state, device } = sw();
    const text = renew(state, device, "renew dhcp-lease interface Management 0");
    expect(text).toContain("Management 0");
    expect(text).toContain("not simulated");
    expect(cpList(device, "mgmt_dhcp", "renewals")).toEqual([{ interface: "Management 0" }]);
  });

  it("`no renew dhcp-lease` clears the recorded request", () => {
    const { state, device } = sw();
    renew(state, device, "renew dhcp-lease interface Management 0");
    renew(state, device, "no renew dhcp-lease interface Management 0");
    expect(cpList(device, "mgmt_dhcp", "renewals")).toEqual([]);
  });

  it("rejects a non-management interface and stores nothing", () => {
    const { state, device } = sw();
    const text = renew(state, device, "renew dhcp-lease interface Ethernet 0");
    expect(text).toContain("management interfaces");
    expect(cpList(device, "mgmt_dhcp", "renewals")).toEqual([]);
  });

  it("grammar recognizes the real `renew dhcp-lease` syntax (RPC not yet routed)", () => {
    const { state, device } = sw();
    expect(run(state, device, ["exec"], "renew dhcp-lease interface Management 0").text).toContain("recognized SONiC command");
  });
});
