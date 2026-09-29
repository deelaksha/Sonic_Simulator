import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/ldap";
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

describe("sonic-cli ldap-server (config-plane)", () => {
  it("stores global + nss options and shows them", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ldap-server binddn dc=sji,dc=example,dc=com").stack;
    s = run(state, device, s, "ldap-server nss ssl start_tls").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show ldap-server").text;
    expect(text).toContain("LDAP Global Configuration");
    expect(text).toContain("dc=sji,dc=example,dc=com");
    expect(text).toContain("LDAP NSS Configuration");
    expect(text).toContain("start_tls");
  });

  it("stores a host and renders the host table row", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "ldap-server host 1.1.1.1 use-type nss priority 1 ssl start_tls retry 2").stack;
    s = run(state, device, s, "exit").stack;
    const text = run(state, device, s, "show ldap-server").text;
    expect(text).toContain("HOST");
    // use-type / ssl are upper-cased in the table like the real box.
    expect(text).toMatch(/1\.1\.1\.1\s+NSS\s+-\s+1\s+START_TLS\s+2/);
  });

  it("no ldap-server binddn clears it", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "ldap-server binddn dc=example");
    run(state, device, s, "no ldap-server binddn");
    const text = run(state, device, ["exec"], "show ldap-server").text;
    expect(text).not.toContain("dc=example");
    expect(text).toContain("No LDAP configuration");
  });

  it("rejects an unknown ldap-server option", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "ldap-server bogus 5").text).toContain('Unknown ldap-server option "bogus"');
  });
});
