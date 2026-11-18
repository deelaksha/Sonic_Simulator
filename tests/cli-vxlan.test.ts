import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar, subViewFrame } from "../lib/sonic/grammar";
setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));
import "../lib/commands/sonic-cli/features/vxlan";
import "../lib/commands/sonic-cli/features/bgp";
import "../lib/commands/sonic-cli/features/interface";
import { execute } from "../lib/commands";
import { vxlanConfig } from "../lib/protocols/vxlan";
import { getBgpConfig } from "../lib/protocols/bgp";
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
  return {
    device,
    network: state,
    captures,
    runSim<T>(fn: (s: Simulation) => T) {
      const s = new Simulation(state);
      return { value: fn(s), events: s.events as SimEvent[] };
    },
  };
}

function run(state: NetworkState, device: Device, stack: CliStack, cmd: string): { stack: CliStack; text: string } {
  const r = runSonicCli(cmd, stack, ctxFor(state, device));
  return { stack: r.toBash ? [] : r.stack, text: r.output.map((o) => o.text).join("\n") };
}

// The entry line `interface vxlan <name>` is normalised by the shared core before
// feature handlers run, so we enter the sub-view via the same generic frame the core
// produces (subViewFrame carries the VTEP name in as `viewctx`).
function enterVtep(state: NetworkState, device: Device, name: string): CliStack {
  let s: CliStack = ["exec"];
  s = run(state, device, s, "configure terminal").stack;
  return [...s, subViewFrame("configure-vxlan-view", name)];
}

describe("sonic-cli vxlan (config-plane)", () => {
  it("stores VTEP source-ip + qos-mode and renders show vxlan interface", () => {
    const { state, device } = sw();
    let s = enterVtep(state, device, "vtep1");
    s = run(state, device, s, "source-ip 1.1.1.1").stack;
    s = run(state, device, s, "qos-mode pipe dscp 5").stack;
    const out = run(state, device, s, "show vxlan interface").text;
    expect(out).toContain("vtep1");
    expect(out).toContain("1.1.1.1");
    expect(out).toContain("pipe (dscp:5)");
  });

  it("stores VNI maps and renders vlanvnimap / vrfvnimap with counts", () => {
    const { state, device } = sw();
    let s = enterVtep(state, device, "vtep1");
    s = run(state, device, s, "map vni 100 vlan 100 count 2").stack;
    s = run(state, device, s, "map vni 600 vrf Vrf1").stack;
    const vlan = run(state, device, s, "show vxlan vlanvnimap").text;
    expect(vlan).toContain("Vlan100");
    expect(vlan).toContain("Vlan101");
    expect(vlan).toContain("Total count : 2");
    const vrf = run(state, device, s, "show vxlan vrfvnimap").text;
    expect(vrf).toContain("Vrf1");
    expect(vrf).toContain("600");
  });

  it("`no source-ip` clears the stored source and `no map` removes a mapping", () => {
    const { state, device } = sw();
    let s = enterVtep(state, device, "vtep1");
    s = run(state, device, s, "source-ip 2.2.2.2").stack;
    s = run(state, device, s, "map vni 100 vlan 100").stack;
    s = run(state, device, s, "no source-ip").stack;
    s = run(state, device, s, "no map vni 100 vlan 100").stack;
    expect(run(state, device, s, "show vxlan interface").text).not.toContain("2.2.2.2");
    expect(run(state, device, s, "show vxlan vlanvnimap").text).toContain("No VLAN VNI mappings configured");
  });

  it("rejects an invalid qos-mode", () => {
    const { state, device } = sw();
    const s = enterVtep(state, device, "vtep1");
    expect(run(state, device, s, "qos-mode bogus").text).toContain("qos-mode must be uniform | pipe");
  });
});

const click = (state: NetworkState, device: Device, cmd: string) => execute(cmd, ctxFor(state, device)).output.map((o) => o.text).join("\n");

describe("Click config vxlan / show vxlan (sonic-utilities config/vxlan.py, show/vxlan.py)", () => {
  it("add / evpn_nvo / map with the real validations, then show interface | vlanvnimap | tunnel", () => {
    const { state, device } = sw();
    device.config.vlans = [{ id: 100, name: "Vlan100" }];
    expect(click(state, device, "config vxlan add vtep1 1.1.1.300")).toBe("Error: 1.1.1.300 invalid src ip address");
    expect(click(state, device, "config vxlan add vtep1 1.1.1.1")).toBe("");
    expect(click(state, device, "config vxlan add vtep2 2.2.2.2")).toBe("Error: VTEP already configured.");
    expect(click(state, device, "config vxlan evpn_nvo add nvo1 vtepX")).toBe("Error: VTEP vtepX not configured");
    expect(click(state, device, "config vxlan evpn_nvo add nvo1 vtep1")).toBe("");
    expect(click(state, device, "config vxlan map add vtep1 200 10200")).toBe("Error: Vlan200 not configured");
    expect(click(state, device, "config vxlan map add vtep1 100 16777216")).toBe("Error: Invalid VNI 16777216. Valid range [1 to 16777215].");
    expect(click(state, device, "config vxlan map add vtep1 100 10100")).toBe("");
    expect(click(state, device, "config vxlan map add vtep1 100 10101")).toBe("Error:  Vlan Id already mapped ");
    expect(click(state, device, "config vxlan del vtep1")).toBe("Error: Please delete the EVPN NVO configuration.");
    expect(click(state, device, "show vxlan interface")).toBe("VTEP Information:\n\n\tVTEP Name : vtep1, SIP  : 1.1.1.1\n\tNVO Name  : nvo1,  VTEP : vtep1\n\tSource interface  : Not Configured");
    expect(click(state, device, "show vxlan vlanvnimap")).toBe(["+---------+-------+", "| VLAN    |   VNI |", "+=========+=======+", "| Vlan100 | 10100 |", "+---------+-------+", "Total count : 1", ""].join("\n"));
    expect(click(state, device, "show vxlan tunnel")).toBe(
      [
        "vxlan tunnel name    source ip    destination ip    tunnel map name    tunnel map mapping(vni -> vlan)",
        "-------------------  -----------  ----------------  -----------------  ---------------------------------",
        "vtep1                1.1.1.1                        map_10100_Vlan100  10100 -> Vlan100",
      ].join("\n"),
    );
    expect(click(state, device, "show vxlan remotevtep")).toContain("Total count : 0");
    expect(click(state, device, "show vxlan remotemac 1.2.3")).toBe("Remote VTEP IP 1.2.3 invalid format");
    expect(vxlanConfig(device)).toMatchObject({ vtep: "vtep1", sourceIp: "1.1.1.1", nvo: "nvo1", maps: [{ vlan: 100, vni: 10100 }] });
  });

  it("KLISH VTEP with a Loopback source: the source IP resolves through the interface, NVO is implicit", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    for (const l of ["configure terminal", "interface Loopback 0", "ip address 10.0.0.1/32", "exit"]) s = run(state, device, s, l).stack;
    s = [...s, subViewFrame("configure-vxlan-view", "vtep1")];
    s = run(state, device, s, "source-ip Loopback 0").stack;
    s = run(state, device, s, "map vni 10100 vlan 100").stack;
    expect(vxlanConfig(device)).toMatchObject({ vtep: "vtep1", sourceIp: "10.0.0.1", sourceIface: "Loopback0", nvo: "nvo1", maps: [{ vlan: 100, vni: 10100 }] });
  });

  it("KLISH router bgp: address-family l2vpn evpn → advertise-all-vni, neighbor activate (both forms)", () => {
    const { state, device } = sw();
    let s: CliStack = ["exec"];
    for (const l of ["configure terminal", "router bgp 65001", "neighbor 10.0.11.2", "remote-as 65100", "address-family l2vpn evpn", "activate", "exit", "exit", "neighbor 10.0.12.2", "remote-as 65100", "exit", "address-family l2vpn evpn"]) {
      const r = run(state, device, s, l);
      expect(r.text).not.toMatch(/%|rror/);
      s = r.stack;
    }
    expect(s[s.length - 1]).toContain("configure-router-bgp-l2vpn-view|config-router-bgp-af");
    s = run(state, device, s, "advertise-all-vni").stack;
    s = run(state, device, s, "neighbor 10.0.12.2 activate").stack;
    const cfg = getBgpConfig(device)!;
    expect(cfg.advertiseAllVni).toBe(true);
    expect(cfg.neighbors.map((n) => [n.peer, !!n.evpn])).toEqual([["10.0.11.2", true], ["10.0.12.2", true]]);
    s = run(state, device, s, "no advertise-all-vni").stack;
    run(state, device, s, "no neighbor 10.0.12.2 activate");
    expect(getBgpConfig(device)!.advertiseAllVni).toBeUndefined();
    expect(getBgpConfig(device)!.neighbors[1].evpn).toBeUndefined();
  });
});
