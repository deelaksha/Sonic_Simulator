/** Cross-agent wiring for the protocol-depth round (shared-file edits). */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { longestPrefixMatch6, Route } from "../lib/models/route";
import { generateSonicRunningConfig } from "../lib/sonic/config-export";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

const sh = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));

describe("protocol-depth integration", () => {
  it("IPv6 LPM is per VRF and prefers lower administrative distance", () => {
    const r = (vrf: string | undefined, type: Route["type"], distance: number): Route => ({ destination: "2001:db8:9::", prefix: 48, nextHop: "fe80::1", interfaceId: `if-${vrf}-${type}`, type, metric: 0, distance, vrf });
    const table = [r("Vrf-red", "bgp", 20), r(undefined, "bgp", 200), r(undefined, "ospf", 110)];
    expect(longestPrefixMatch6(table, "2001:db8:9::5")!.route.interfaceId).toBe("if-undefined-ospf");
    expect(longestPrefixMatch6(table, "2001:db8:9::5", "Vrf-red")!.route.interfaceId).toBe("if-Vrf-red-bgp");
    expect(longestPrefixMatch6(table, "2001:db8:9::5", "Vrf-blue")).toBeNull();
  });

  it("ipvx lab: hosts show SLAAC state with `ip -6 addr|route`", () => {
    S().loadFeatureLab("ipvx");
    advance(40_000);
    expect(sh("H1", "ip -6 addr")).toMatch(/inet6 2001:db8:\S+\/64 scope global dynamic/);
    expect(sh("H1", "ip -6 route")).toMatch(/default via fe80::\S+ dev \S+ proto ra metric 1024/);
  });

  it("evpn-irb: VRF routes via a VTEP print FRR's `onlink`", () => {
    S().loadFeatureLab("evpn-irb");
    advance(3000);
    S().execCommand(byName("H1").id, "ping -c 1 10.2.0.22");
    advance(1000);
    expect(sh("LEAF1", "show ip route vrf Vrf-red")).toMatch(/B>\* 10\.2\.0\.22\/32 \[20\/0\] via 10\.0\.0\.2, Vlan500 onlink, weight 1/);
  });

  it("l2-protect: UDLD PDUs take the link-local control path (not learned, not flooded)", () => {
    S().loadFeatureLab("l2-protect");
    advance(20_000);
    const sw2Macs = new Set(byName("SW2").interfaces.map((i) => i.mac.toUpperCase()));
    expect(byName("SW1").macTable.some((m) => sw2Macs.has(m.mac.toUpperCase()))).toBe(false);
    expect(sh("SW1", "show udld neighbors")).toMatch(/Ethernet5/);
  });

  it("ospf-areas: the GUI running-config export handles area types", () => {
    S().loadFeatureLab("ospf-areas");
    const text = generateSonicRunningConfig(byName("S1"));
    expect(text).toContain("network 10.1.12.0/30 area 0.0.0.1");
    expect(text).toContain("area 0.0.0.1 stub");
  });

  it("`config feature state bgp disabled` stops ospfd/bgpd (routes withdrawn) and re-enabling reconverges", () => {
    for (const lab of ["ospf", "bgp"]) {
      resetAll();
      S().loadFeatureLab(lab);
      advance(40_000);
      const s1 = byName("S1").id;
      S().execCommand(s1, "exit");
      const proto = lab === "ospf" ? "ospf" : "bgp";
      expect(byName("S1").routingTable.some((r) => r.type === proto)).toBe(true);
      S().execCommand(s1, "config feature state bgp disabled");
      advance(2_000);
      expect(byName("S1").routingTable.some((r) => r.type === proto)).toBe(false);
      S().execCommand(s1, "config feature state bgp enabled");
      advance(60_000);
      expect(byName("S1").routingTable.some((r) => r.type === proto)).toBe(true);
    }
  });

  it("KLISH `interface PortChannel N mode on` makes a static LAG (no LACPDUs, still forwarding)", () => {
    S().loadFeatureLab("lacp");
    advance(5_000);
    // teamd picks the runner when the LAG is created: build a new static PortChannel 2 (KLISH) and move the members.
    for (const sw of ["S1", "S2"]) {
      S().runCliScript(byName(sw).id, [
        "configure terminal",
        "interface Ethernet 0", "no channel-group", "exit",
        "interface Ethernet 1", "no channel-group", "exit",
        "no interface PortChannel 1",
        "interface PortChannel 2 mode on", "switchport access Vlan 10", "exit",
        "interface Ethernet 0", "channel-group 2", "exit",
        "interface Ethernet 1", "channel-group 2", "exit",
        "end",
      ]);
    }
    advance(3_000);
    const before = S().captures.length;
    advance(5_000);
    expect(S().captures.slice(before).filter((c) => c.dir === "tx" && c.frame.ethernet.typeCode === 0x8809)).toHaveLength(0);
    expect(sh("S1", "show PortChannel summary")).toMatch(/PortChannel2\s+Eth \(U\)\s+STATIC/);
    expect(sh("H1", "ping -c 1 192.168.10.13")).toMatch(/1 received/);
  });
});
