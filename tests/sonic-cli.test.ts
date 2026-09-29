import { describe, it, expect } from "vitest";
import { createDevice, resetMacCounter } from "../lib/models/factory";
import { NetworkState } from "../lib/models/topology";
import { Simulation, CaptureRecord, resetIds, SimEvent } from "../lib/engine";
import { CommandContext, execute } from "../lib/commands";
import { runSonicCli, cliPrompt, cliModeFor, CliStack } from "../lib/commands/sonic-cli";
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

describe("sonic-cli modal CLI", () => {
  it("switches boot into sonic-cli; PCs stay in bash", () => {
    const { device } = sw();
    expect(cliModeFor(device, undefined)).toEqual(["exec"]);
    const pc = createDevice({ id: "pc1", type: "pc", name: "PC1", x: 0, y: 0 });
    expect(cliModeFor(pc, undefined)).toEqual([]);
  });

  it("prompt reflects the mode stack", () => {
    expect(cliPrompt(["exec"], "sonic")).toBe("sonic#");
    expect(cliPrompt(["exec", "config"], "sonic")).toBe("sonic(config)#");
    expect(cliPrompt(["exec", "config", "if-Ethernet0"], "sonic")).toBe("sonic(config-if-Ethernet0)#");
  });

  it("configure terminal / exit navigate the mode stack", () => {
    const { state, device } = sw();
    let r = runSonicCli("configure terminal", ["exec"], ctxFor(state, device));
    expect(r.stack).toEqual(["exec", "config"]);
    r = runSonicCli("exit", ["exec", "config"], ctxFor(state, device));
    expect(r.stack).toEqual(["exec"]);
    r = runSonicCli("exit", ["exec"], ctxFor(state, device));
    expect(r.toBash).toBe(true); // exit from exec drops to bash
  });

  it("creates VLANs (single + range) in config mode, matching vlan.txt", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "vlan 10", "vlan 200-205", "exit"]);
    const show = execute("show vlan", ctxFor(state, device)).output.map((o) => o.text).join("\n");
    expect(show).toMatch(/\|\s*10\s*\|/);
    expect(show).toMatch(/\|\s*200\s*\|/);
    expect(show).toMatch(/\|\s*205\s*\|/);
    expect((device.config.vlans ?? []).map((v) => v.id)).toEqual([10, 200, 201, 202, 203, 204, 205]);
  });

  it("no vlan deletes a VLAN", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "vlan 10", "vlan 20", "no vlan 10", "exit"]);
    expect((device.config.vlans ?? []).map((v) => v.id)).toEqual([20]);
  });

  it("interface Ethernet + switchport access assigns a member; rejects non-existent ports", () => {
    const { state, device } = sw();
    const res = session(state, device, ["exec"], [
      "configure terminal",
      "vlan 10",
      "interface Ethernet 0",
      "switchport access Vlan 10",
      "exit",
      "exit",
    ]);
    // Ethernet0 is now an untagged (access) member of VLAN 10.
    const eth0 = device.interfaces.find((i) => i.name === "Ethernet0");
    expect(eth0?.vlan.mode).toBe("access");
    expect(eth0?.vlan.accessVlan).toBe(10);
    // A port that does not exist cannot be entered.
    const bad = runSonicCli("interface Ethernet 24", ["exec", "config"], ctxFor(state, device));
    expect(bad.output.some((o) => o.kind === "error")).toBe(true);
    expect(bad.stack).toEqual(["exec", "config"]); // did not enter
    expect(res.stack).toEqual(["exec"]);
  });

  it("show and unknown commands: show delegates, junk is rejected", () => {
    const { state, device } = sw();
    const showR = runSonicCli("show vlan", ["exec"], ctxFor(state, device));
    expect(showR.output.length).toBeGreaterThan(0);
    const junk = runSonicCli("frobnicate", ["exec", "config"], ctxFor(state, device));
    expect(junk.output[0].text).toContain("Unrecognized");
  });

  it("shutdown / no shutdown toggle a port admin state", () => {
    const { state, device } = sw();
    session(state, device, ["exec"], ["configure terminal", "interface Ethernet 1", "shutdown", "exit", "exit"]);
    expect(device.interfaces.find((i) => i.name === "Ethernet1")?.adminState).toBe("down");
    session(state, device, ["exec"], ["configure terminal", "interface Ethernet 1", "no shutdown", "exit", "exit"]);
    expect(device.interfaces.find((i) => i.name === "Ethernet1")?.adminState).toBe("up");
  });
});
