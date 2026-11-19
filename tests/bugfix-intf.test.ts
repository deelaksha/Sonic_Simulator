/** Area (B) regressions: KLISH interface / VLAN / LAG / ARP commands. */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { vlanMembers } from "../lib/models/vlan-ops";
import { lagConfigs } from "../lib/protocols/lacp-daemon";
import { vrfOf } from "../lib/models/vrf";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

const sh = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
const klish = (dev: string, lines: string[]) => lines.map((l) => sh(dev, l)).join("\n");

describe("bugfix area B", () => {
  it("no interface PortChannel N is refused while members exist, deletes it once empty", () => {
    S().loadFeatureLab("lacp");
    advance(5000);
    const o = klish("S1", ["configure terminal", "no interface PortChannel 1"]);
    expect(o).toContain("%Error: Cannot delete PortChannel with member interfaces. Remove members first");
    expect(o).toContain("%Error: Interface: PortChannel1");
    expect(lagConfigs(byName("S1")).map((l) => l.name)).toEqual(["PortChannel1"]);
    expect(byName("S1").interfaces.some((i) => i.name === "PortChannel1")).toBe(true);

    const o2 = klish("S1", ["interface Ethernet 0", "no channel-group", "exit", "interface Ethernet 1", "no channel-group", "exit", "no interface PortChannel 1", "end"]);
    expect(o2).not.toMatch(/Error/);
    advance(3000);
    expect(lagConfigs(byName("S1"))).toEqual([]);
    expect(byName("S1").interfaces.some((i) => i.name === "PortChannel1")).toBe(false);
    expect(sh("S1", "show PortChannel summary")).toContain("No PortChannels configured");
  });

  it("static-LAG single-line form still works after delete/recreate", () => {
    S().loadFeatureLab("lacp");
    advance(5000);
    klish("S2", ["configure terminal", "interface Ethernet 0", "no channel-group", "exit", "interface Ethernet 1", "no channel-group", "exit", "no interface PortChannel 1", "interface PortChannel 1 mode on", "end"]);
    expect(lagConfigs(byName("S2")).find((l) => l.name === "PortChannel1")?.static).toBe(true);
  });

  it("no switchport access Vlan removes the access VLAN", () => {
    S().loadFeatureLab("lacp");
    const o = klish("S1", ["configure terminal", "interface Ethernet 2", "no switchport access Vlan", "end"]);
    expect(o).not.toMatch(/%/);
    expect(vlanMembers(byName("S1"), 10).map((m) => m.port)).not.toContain("Ethernet2");
  });

  it("no ip arp <ip> <mac> deletes a static ARP entry (interface view)", () => {
    S().loadFeatureLab("arpnd");
    klish("SW1", ["configure terminal", "interface Vlan 10", "ip arp 192.168.10.12 00:11:22:33:44:55", "end"]);
    expect(byName("SW1").arpTable.some((e) => e.ip === "192.168.10.12")).toBe(true);
    const o = klish("SW1", ["configure terminal", "interface Vlan 10", "no ip arp 192.168.10.12 00:11:22:33:44:55", "end"]);
    expect(o).not.toMatch(/%/);
    expect(byName("SW1").arpTable.some((e) => e.ip === "192.168.10.12" && e.mac.toLowerCase() === "00:11:22:33:44:55")).toBe(false);
  });

  it("Click: sonic-clear arp <ip> deletes a static entry (ip -4 neigh del)", () => {
    S().loadFeatureLab("arpnd");
    klish("SW1", ["configure terminal", "interface Vlan 10", "ip arp 192.168.10.12 00:11:22:33:44:55", "end", "exit"]);
    sh("SW1", "sudo sonic-clear arp 192.168.10.12");
    expect(byName("SW1").arpTable.some((e) => e.mac.toLowerCase() === "00:11:22:33:44:55")).toBe(false);
  });

  it("ip vrf forwarding works on a Loopback interface", () => {
    S().loadFeatureLab("lacp");
    const o = klish("S1", ["configure terminal", "ip vrf Vrf-red", "interface Loopback 0", "ip vrf forwarding Vrf-red", "end"]);
    expect(o).not.toMatch(/Unrecognized/);
    const lo = byName("S1").interfaces.find((i) => i.name === "Loopback0");
    expect(vrfOf(byName("S1"), lo)).toBe("Vrf-red");
  });

  it("show ipv6 interfaces renders the device layout (ipv6.xml:593)", () => {
    S().loadFeatureLab("lacp");
    klish("S1", ["configure terminal", "interface Ethernet 2", "no switchport access Vlan", "ipv6 address 2001:db8::1/64", "end"]);
    const o = sh("S1", "show ipv6 interfaces");
    expect(o).toMatch(/^Interface\s+IPv6 address\/mask\s+Master\s+Admin\/Oper\s+BGP Neighbor\s+Neighbor IP\s+Flags/m);
    expect(o).toMatch(/^Ethernet2\s+2001:db8::1\/64\s+up\/up\s+N\/A\s+N\/A/m);
    expect(o).toMatch(/^\s+fe80::\S+\/64$/m);
  });
});
