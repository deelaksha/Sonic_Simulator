import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/pki";
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

describe("sonic-cli pki (config-plane)", () => {
  it("stores a trust-store and security-profile and renders show crypto", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "crypto trust-store trust_store ca-cert rsa.ca.cert").stack;
    s = run(state, device, s, "crypto security-profile rsa_security_profile").stack;
    s = run(state, device, s, "crypto security-profile trust-store rsa_security_profile trust_store").stack;
    s = run(state, device, s, "crypto security-profile certificate rsa_security_profile rsacert").stack;
    s = run(state, device, s, "exit").stack;

    const ts = run(state, device, s, "show crypto trust-store").text;
    expect(ts).toContain("Trust Store: trust_store");
    expect(ts).toContain("CA Certificate: rsa.ca.cert");

    const sp = run(state, device, s, "show crypto security-profile").text;
    expect(sp).toContain("Security Profile: rsa_security_profile");
    expect(sp).toContain("Trust Store");
    expect(sp).toContain("trust_store");
    expect(sp).toContain("Certificate");
    expect(sp).toContain("rsacert");
  });

  it("stores optional checks and renders them as True/False", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    s = run(state, device, s, "crypto security-profile p1 key-usage-check true revocation-check false vrf mgmt").stack;
    s = run(state, device, s, "exit").stack;
    const out = run(state, device, s, "show crypto security-profile p1").text;
    expect(out).toMatch(/Key Usage Check\s+: True/);
    expect(out).toMatch(/Revocation Check\s+: False/);
    expect(out).toMatch(/VRF\s+: mgmt/);
  });

  it("no crypto clears the stored trust-store and security-profile", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    run(state, device, s, "crypto trust-store ts1 ca-cert ca1");
    run(state, device, s, "crypto security-profile sp1");
    run(state, device, s, "no crypto trust-store ts1");
    run(state, device, s, "no crypto security-profile sp1");
    expect(run(state, device, ["exec"], "show crypto trust-store").text).toContain("No trust stores configured");
    expect(run(state, device, ["exec"], "show crypto security-profile").text).toContain("No security profiles configured");
  });

  it("rejects a bad bool and a trust-store without a ca-cert", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    s = run(state, device, s, "configure terminal").stack;
    expect(run(state, device, s, "crypto security-profile p1 key-usage-check maybe").text).toContain("must be true|false");
    expect(run(state, device, s, "crypto trust-store ts1").text).toContain("usage: crypto trust-store");
  });
});
