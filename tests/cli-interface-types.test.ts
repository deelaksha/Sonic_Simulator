import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext } from "../lib/commands";
import { runSonicCli, cliPrompt, CliStack } from "../lib/commands/sonic-cli";
import { Device } from "../lib/models/device";

function sw(): { state: NetworkState; device: Device } {
  resetMacCounter(1);
  resetIds();
  const device = createDevice({ id: "sw1", type: "switch", name: "sonic", x: 0, y: 0, ports: 4 });
  return { state: { devices: { sw1: device }, connections: [] }, device };
}
function ctxFor(state: NetworkState, device: Device): CommandContext {
  const captures: CaptureRecord[] = [];
  return { device, network: state, captures, runSim<T>(fn: (s: Simulation) => T) { const s = new Simulation(state); return { value: fn(s), events: s.events as SimEvent[] }; } };
}
/** Run a script, returning the sub-view prompt seen just before the Nth line (for assertions). */
function session(state: NetworkState, device: Device, lines: string[]): { prompts: string[]; last: string } {
  let stack: CliStack = ["exec"];
  const prompts: string[] = [];
  let last = "";
  for (const l of lines) {
    prompts.push(cliPrompt(stack, "sonic"));
    const r = runSonicCli(l, stack, ctxFor(state, device));
    stack = r.toBash ? [] : r.stack;
    last = r.output.map((o) => o.text).join("\n");
  }
  return { prompts, last };
}
const iface = (d: Device, name: string) => d.interfaces.find((i) => i.name === name);

describe("sonic-cli interface types (Ethernet / Vlan / Loopback / PortChannel)", () => {
  it("interface Ethernet <n> enters config-if and configures an IP (physical, pre-existing)", () => {
    const { state, device } = sw();
    const { prompts } = session(state, device, ["configure terminal", "interface Ethernet 0", "ip address 10.0.0.1/24", "exit", "exit"]);
    expect(prompts).toContain("sonic(config-if-Ethernet0)#");
    expect(iface(device, "Ethernet0")?.ipv4[0]?.address).toBe("10.0.0.1");
  });

  it("interface Vlan <id> creates the SVI (+VLAN) and configures an IP", () => {
    const { state, device } = sw();
    const { prompts } = session(state, device, ["configure terminal", "interface Vlan 10", "ip address 10.10.10.1/24", "exit", "exit"]);
    expect(prompts).toContain("sonic(config-if-Vlan10)#");
    const svi = iface(device, "Vlan10");
    expect(svi?.logical).toBe(true);
    expect(svi?.ipv4[0]?.address).toBe("10.10.10.1");
    expect(device.config.vlans?.some((v) => v.id === 10)).toBe(true);
  });

  it("interface Loopback <id> creates the loopback and configures an IP", () => {
    const { state, device } = sw();
    const { prompts } = session(state, device, ["configure terminal", "interface Loopback 0", "ip address 1.1.1.1/32", "exit", "exit"]);
    expect(prompts).toContain("sonic(config-if-Loopback0)#");
    expect(iface(device, "Loopback0")?.logical).toBe(true);
    expect(iface(device, "Loopback0")?.ipv4[0]?.address).toBe("1.1.1.1");
  });

  it("interface PortChannel <id> creates the LAG and configures an IP", () => {
    const { state, device } = sw();
    const { prompts } = session(state, device, ["configure terminal", "interface PortChannel 1", "ip address 20.0.0.1/24", "exit", "exit"]);
    expect(prompts).toContain("sonic(config-if-PortChannel1)#");
    expect(iface(device, "PortChannel1")?.logical).toBe(true);
    expect(iface(device, "PortChannel1")?.ipv4[0]?.address).toBe("20.0.0.1");
  });

  it("no interface deletes a logical interface but refuses a physical one", () => {
    const { state, device } = sw();
    session(state, device, ["configure terminal", "interface Loopback 5", "exit"]);
    expect(iface(device, "Loopback5")).toBeDefined();
    const { last } = session(state, device, ["configure terminal", "no interface Loopback 5"]);
    expect(iface(device, "Loopback5")).toBeUndefined();
    const { last: physErr } = session(state, device, ["configure terminal", "no interface Ethernet 0"]);
    expect(physErr).toContain("Cannot delete physical interface");
  });

  it("show ip interface lists physical + logical interfaces with IPs", () => {
    const { state, device } = sw();
    const { last } = session(state, device, [
      "configure terminal", "interface Loopback 0", "ip address 1.1.1.1/32", "exit",
      "interface Vlan 30", "ip address 30.0.0.1/24", "exit", "exit", "show ip interface",
    ]);
    expect(last).toContain("Loopback0");
    expect(last).toContain("1.1.1.1/32");
    expect(last).toContain("Vlan30");
  });
});
