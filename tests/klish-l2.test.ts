/**
 * KLISH `show` coverage — interfaces / VLANs / L2 (vlan-show, interface-show,
 * transceiver-show, l2-misc-show, stp-extra-show + two-word interface fixes).
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

const cli = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
const cfg = (dev: string, ...cmds: string[]) => ["configure terminal", ...cmds, "end"].forEach((c) => cli(dev, c));
const NOT_SIM = /not simulated in this lab/;

beforeAll(() => setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8"))));
afterEach(() => vi.useRealTimers());
const boot = (lab: string) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab(lab);
  advance(5000);
};

describe("show Vlan (lacp lab)", () => {
  beforeEach(() => boot("lacp"));

  it("renders the device layout, one row per member (snapshot_SW1.txt:75-81)", () => {
    const o = cli("S1", "show Vlan");
    const lines = o.split("\n");
    expect(lines[0]).toBe("Q: A - Access (Untagged), T - Tagged");
    expect(lines[1]).toBe("NUM       Status      Q Ports             ");
    expect(lines[2]).toBe("-".repeat(42));
    expect(lines).toContain("Vlan10    Up          A  Ethernet2        ");
    expect(lines).toContain("Vlan10    Up          A  PortChannel1     ");
    expect(o).not.toMatch(NOT_SIM);
  });

  it("filters by id in both one- and two-word forms; unknown VLAN and count", () => {
    expect(cli("S1", "show Vlan 10")).toBe(cli("S1", "show Vlan10"));
    expect(cli("S1", "show Vlan 99")).toBe("VLAN Vlan99 not found");
    cfg("S1", "vlan 20", "vlan 21");
    expect(cli("S1", "show Vlan count")).toBe("Total Number of Vlan Configured :3\nVLANs Configured :10 20 to 21");
    // A VLAN without members and without an SVI is Down.
    expect(cli("S1", "show Vlan 20")).toContain("Vlan20    Down");
  });

  it("reflects live trunk membership as T", () => {
    cfg("S1", "vlan 30", "interface Ethernet 3", "switchport trunk allowed Vlan 30");
    expect(cli("S1", "show Vlan 30").split("\n")).toContain("Vlan30    Up          T  Ethernet3        ");
  });
});

describe("show interface … (lacp lab)", () => {
  beforeEach(() => boot("lacp"));

  it("show interface Ethernet 0 renders show_interface_id.j2 from live state", () => {
    const o = cli("S1", "show interface Ethernet 0");
    expect(o).toContain("Ethernet0 is up, line protocol is up, reason oper-up");
    expect(o).toMatch(/Hardware is Eth, address is [0-9a-f:]{17}/);
    expect(o).toContain("LineSpeed 25G, Auto-negotiation off");
    const pkts = byName("S1").interfaces.find((i) => i.name === "Ethernet0")!.statistics.rxFrames;
    expect(o).toContain(`        ${pkts} packets,`);
    expect(cli("S1", "show interface Ethernet0")).toBe(o);
    expect(cli("S1", "show interface Ethernet 0-1")).toContain("Ethernet1 is up, line protocol is up");
    expect(cli("S1", "show interface Ethernet 99")).toBe("% Error: Interface Ethernet99 not found");
  });

  it("bare show interface lists Ethernet + PortChannel (show_interface.j2)", () => {
    const o = cli("S1", "show interface");
    expect(o).toContain("Ethernet3 is up, line protocol is up\nHardware is Eth\nInterface index is");
    expect(o).toContain("PortChannel1 is up, line protocol is up\nHardware is PortChannel");
  });

  it("PortChannel (all), vlan-mappings, Management, description, fec, counters", () => {
    expect(cli("S1", "show interface PortChannel")).toContain("Members in this channel: Ethernet0 Ethernet1");
    expect(cli("S1", "show interface PortChannel 1 vlan-mappings")).toContain("Name           Outer       Inner       Mapped Vlan   Priority");
    const m = cli("S1", "show interface Management 0");
    expect(m).toContain("Management0 is up, line protocol is up");
    expect(m).toMatch(/IPV4 address is \d+\.\d+\.\d+\.\d+\/\d+/);
    const d = cli("S1", "show interface description");
    expect(d).toContain("Name                Admin          Oper           Description");
    expect(d).toMatch(/Ethernet2 {11}up {13}up {13}-/);
    expect(cli("S1", "show interface fec status Ethernet 0")).toMatch(/Ethernet0 +none   none   oper-up/);
    expect(cli("S1", "show interface counters PortChannel")).toMatch(/PortChannel1   U         \d+/);
    // `counters Ethernet` (all) no longer filters on the bare keyword
    expect(cli("S1", "show interface counters Ethernet")).toContain("Ethernet3");
  });

  it("L2-only VLAN has no `show interface Vlan` output; transceivers show the simulated DAC", () => {
    expect(cli("S1", "show interface Vlan 10")).toBe("");
    const t = cli("S1", "show interface transceiver");
    expect(t).toContain("Interface    Name                                    Vendor");
    expect(t).toContain("Ethernet0    SFP28 25GBASE-CR-1.0M");
    expect(cli("S1", "show interface transceiver Ethernet 0 dom")).toContain("DOM not supported");
  });

  it("breakout modes / dependencies render from the ports", () => {
    expect(cli("S1", "show interface breakout modes")).toContain("1/1   Ethernet0   1x25G, 1x10G");
    expect(cli("S1", "show interface breakout dependencies port 1/1")).toContain("PORTCHANNEL_MEMBER|PortChannel1|Ethernet0");
    expect(cli("S1", "show interface breakout dependencies port 1/3")).toContain("VLAN_MEMBER|Vlan10|Ethernet2");
  });

  it("every family command answers (no generic not-simulated line)", () => {
    for (const c of [
      "show interface Loopback", "show interface advertise", "show interface link-training", "show interface unreliable-los status",
      "show interface port-locator", "show interface vlan-mappings", "show interface l2proto-tunnel", "show interface counters rif",
      "show interface phy status", "show interface transceiver wattage", "show interface transceiver cmis status",
      "show interface transceiver laser status Ethernet 0", "show interface transceiver diagnostics capability",
      "show link", "show link state", "show port-security", "show mac dampening", "show spanning-tree counters",
      "show spanning-tree bpdu-guard", "show spanning-tree inconsistentports", "show mclag mac", "show mclag mac remote",
    ]) expect(cli("S1", c), c).not.toMatch(NOT_SIM);
    expect(cli("S1", "show link state")).toBe(""); // link_track.xml:479 — no ACTION
  });

  it("port-security reads the interface PMS config", () => {
    cfg("S1", "interface Ethernet 2", "port-security enable", "port-security maximum 5", "port-security violation shutdown");
    expect(cli("S1", "show port-security")).toMatch(/Ethernet2 +5 +\d+ +0 +Shutdown/);
    expect(cli("S1", "show port-security interface Ethernet 2")).toBe(
      "Port Security: Enabled\nViolation mode: Shutdown\nMaximum MAC Addresses: 5\nTotal MAC Addresses: " +
        cli("S1", "show port-security interface Ethernet 2").match(/Total MAC Addresses: (\d+)/)![1] +
        "\nSecurity Violation count: 0",
    );
    expect(cli("S1", "show port-security interface Ethernet 3")).toContain("Port Security: Disabled");
  });

  it("spanning-tree Vlan / interface filters and bpdu-guard", () => {
    const v = cli("S1", "show spanning-tree Vlan 10");
    expect(v).toContain("Ethernet2    Desg");
    expect(v).not.toContain("Ethernet0    ");
    const one = cli("S1", "show spanning-tree Vlan 10 interface Ethernet 3");
    expect(one).toContain("Ethernet3    ");
    expect(one).not.toContain("Ethernet2    ");
    cfg("S1", "interface Ethernet 2", "spanning-tree bpduguard port-shutdown");
    expect(cli("S1", "show spanning-tree bpdu-guard")).toMatch(/Ethernet2 +Yes +No/);
  });

  it("two-word interface arguments (qos, lldp statistics)", () => {
    expect(cli("S1", "show qos interface Ethernet 0")).not.toMatch(/No qos bindings on Ethernet$/m);
    expect(cli("S1", "show lldp statistics Ethernet 0")).toContain("Interface: Ethernet0");
  });
});

describe("SVIs, Loopbacks and MCLAG extras", () => {
  it("show interface Vlan / Loopback on the evpn-irb lab", () => {
    boot("evpn-irb");
    const v = cli("LEAF1", "show interface Vlan 10");
    expect(v).toContain("Vlan10 is up, line protocol is up");
    expect(v).toMatch(/IPV4 address is [\d.]+\/24\nMode of IPV4 address assignment: MANUAL/);
    expect(cli("LEAF1", "show interface Loopback 0")).toMatch(/Loopback0 is up, line protocol is up\nHardware is Loopback/);
  });

  it("mclag interface accepts `PortChannel 1`; separate-ip / peer-gateway list SVIs", () => {
    boot("mclag");
    const a = cli("P1", "show mclag interface 1 10");
    expect(a).toContain("Local/Remote Status  : ");
    expect(cli("P1", "show mclag interface PortChannel 1 10")).toBe(a);
    expect(cli("P1", "show mclag interface PortChannel1 10")).toBe(a);
    cfg("P1", "interface Vlan 10", "mclag-separate-ip");
    expect(cli("P1", "show mclag separate-ip-interfaces")).toBe(
      ["Interface Name", "=".repeat(19), "Vlan10", "=".repeat(19), "Total count : 1", "=".repeat(19)].join("\n"),
    );
    expect(cli("P1", "show mclag peer-gateway-interfaces")).toContain("Total count : 0");
    expect(cli("P1", "show mclag mac remote count")).toMatch(/^Total count : \d+$/);
  });

  it("show mac address-table applies the KLISH Vlan / interface / type filters", () => {
    boot("mclag");
    cli("H1", "ping -c 2 192.168.10.13");
    advance(2000);
    const h1 = byName("H1").interfaces[0].mac.toUpperCase();
    const all = cli("P1", "show mac address-table");
    expect(all).toContain(h1);
    expect(cli("P1", "show mac address-table interface Ethernet 3")).toContain(h1);
    expect(cli("P1", "show mac address-table interface PortChannel 1")).not.toContain(h1);
    expect(cli("P1", "show mac address-table Vlan 10")).toContain(h1);
    expect(cli("P1", "show mac address-table Vlan 99")).toContain("Total number of entries 0");
    expect(cli("P1", "show mac address-table static Vlan 10")).not.toContain(h1);
    expect(cli("P1", "show mac address-table count Vlan 99")).toContain("MAC Entries for Vlan99 :  0");
  });
});

describe("transceiver word order (grammar allows the port before or after the subcommand)", () => {
  it("laser/cmis status and dom/summary accept either order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    resetAll();
    S().loadFeatureLab("lacp");
    const run = (c: string) => out(S().execCommand(byName("S1").id, c));
    expect(run("show interface transceiver laser Ethernet 0 status")).toBe(run("show interface transceiver laser status Ethernet 0"));
    expect(run("show interface transceiver dom Ethernet 0")).toBe(run("show interface transceiver Ethernet 0 dom"));
    expect(run("show interface transceiver laser Ethernet 0 status")).toMatch(/Laser Status/);
    vi.useRealTimers();
  });
});
