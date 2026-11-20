/** Regression tests for the routing bug-fix round (area C). */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { S, advance, byName, out } from "./control-helpers";
import { longestPrefixMatch } from "../lib/models/route";

const run = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(byName(dev).id, lines).map((o) => o.text).join("\n");
/** Run a Click (Linux shell) command on a switch that starts in KLISH. */
const click = (dev: string, cmd: string) => {
  run(dev, "exit");
  const text = run(dev, cmd);
  run(dev, "sonic-cli");
  return text;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bug 1: prefix-list seq reuse (KLISH)", () => {
  it("KLISH rejects a different entry on an existing seq, as sonic-mgmt-common xfmr_prefix_set.go checkDuplicatePrefixSeq does", () => {
    S().loadFeatureLab("vrf");
    advance(1000);
    const t = klish("S1", ["configure terminal", "ip prefix-list PL seq 5 permit 10.0.0.0/8", "ip prefix-list PL seq 5 permit 192.168.0.0/16", "end"]);
    expect(t).toContain("Same sequence-number already exists");
    expect(click("S1", "show ip prefix-list PL")).toContain("seq 5 permit 10.0.0.0/8");
  });
});

describe("bug 2: static route with an unresolvable next hop", () => {
  it("is kept configured, shown inactive, not used for forwarding, and installed once the next hop resolves", () => {
    S().loadFeatureLab("vrf");
    advance(1000);
    const t = klish("S1", ["configure terminal", "ip route 172.16.0.0/16 10.9.9.2", "end"]);
    expect(t).not.toMatch(/no interface on the subnet/);
    const rt = click("S1", "show ip route");
    expect(rt).toMatch(/^S {3}172\.16\.0\.0\/16 \[1\/0\] via 10\.9\.9\.2 inactive, weight 1, \d\d:\d\d:\d\d$/m);
    expect(longestPrefixMatch(byName("S1").routingTable, "172.16.1.1")).toBeNull();
    expect(click("S1", "show runningconfiguration all")).toContain('"172.16.0.0/16"');

    // The next hop becomes reachable (an addressed, cabled port): zebra installs the route.
    const pc = S().addDevice("pc", { x: 0, y: 0 });
    S().connect(pc, `${pc}-if0`, byName("S1").id, `${byName("S1").id}-if3`, { autoDhcp: false });
    klish("S1", ["configure terminal", "interface Ethernet 3", "ip address 10.9.9.1/30", "end"]);
    expect(click("S1", "show ip route")).toMatch(/^S>\* 172\.16\.0\.0\/16 \[1\/0\] via 10\.9\.9\.2, Ethernet3, weight 1/m);
    expect(longestPrefixMatch(byName("S1").routingTable, "172.16.1.1")?.route.nextHop).toBe("10.9.9.2");
  });

  it("an inactive static is removed by `no ip route`", () => {
    S().loadFeatureLab("vrf");
    advance(1000);
    klish("S1", ["configure terminal", "ip route 172.16.0.0/16 10.9.9.2", "no ip route 172.16.0.0/16 10.9.9.2", "end"]);
    expect(click("S1", "show ip route")).not.toContain("172.16.0.0/16");
    expect(click("S1", "show runningconfiguration all")).not.toContain("172.16.0.0/16");
  });
});

describe("bug 3: VRF static route after its exit interface leaves the VRF", () => {
  it("becomes inactive (not S>*) and comes back when the interface is re-bound", () => {
    S().loadFeatureLab("vrf");
    advance(1000);
    expect(click("S1", "show ip route vrf Vrf-red")).toMatch(/^S>\* 192\.168\.3\.0\/24/m);
    klish("S1", ["configure terminal", "interface Ethernet 1", "no ip vrf forwarding Vrf-red", "end"]);
    const rt = click("S1", "show ip route vrf Vrf-red");
    expect(rt).not.toMatch(/^S>\* 192\.168\.3\.0\/24/m);
    expect(rt).toMatch(/^S {3}192\.168\.3\.0\/24 \[1\/0\] via 10\.0\.13\.2 inactive, weight 1/m);
    expect(longestPrefixMatch(byName("S1").routingTable, "192.168.3.10", "Vrf-red")).toBeNull();
    klish("S1", ["configure terminal", "interface Ethernet 1", "ip vrf forwarding Vrf-red", "end"]);
    expect(click("S1", "show ip route vrf Vrf-red")).toMatch(/^S>\* 192\.168\.3\.0\/24 \[1\/0\] via 10\.0\.13\.2, Ethernet1/m);
  });
});

describe("bug 4: OSPFv3 shows", () => {
  it("show ipv6 ospf6 interface <IF> prints the ospf6d interface block", () => {
    S().loadFeatureLab("ipvx");
    advance(45000);
    const t = click("S1", "show ipv6 ospf6 interface Ethernet0");
    expect(t).toMatch(/^Ethernet0 is up, type BROADCAST$/m);
    expect(t).toMatch(/^ {2}Interface ID: \d+$/m);
    expect(t).toMatch(/^ {2}Operating as type POINTOPOINT$/m);
    expect(t).toContain("    inet6: 2001:db8:12::1/64");
    expect(t).toMatch(/^ {2}Instance ID 0, Interface MTU 9100 \(autodetect: 9100\)$/m);
    expect(t).toMatch(/^ {2}Area ID 0\.0\.0\.0, Cost \d+$/m);
    expect(t).toMatch(/^ {2}State PointToPoint, Transmit Delay 1 sec, Priority 1$/m);
    expect(t).toMatch(/^ {3}Hello 10\(\d+\.\d{3}\), Dead 40, Retransmit 5$/m);
    expect(t).toMatch(/^ {2}Number of I\/F scoped LSAs is \d+$/m);
    expect(t).toContain("    0 Pending LSAs for LSUpdate in Time 00:00:00 [thread off]");
    const passive = click("S1", "show ipv6 ospf6 interface Ethernet2");
    expect(passive).toContain("   No Hellos (Passive interface)");
    expect(click("S1", "show ipv6 ospf6 interface Ethernet3")).toContain("   OSPF not enabled on this interface");
    expect(click("S1", "show ipv6 ospf6 interface Ethernet99")).toContain("No such Interface: Ethernet99");
    // without an interface: every interface of the default VRF
    const all = click("S1", "show ipv6 ospf6 interface");
    expect(all).toMatch(/^Ethernet0 is up/m);
    expect(all).toMatch(/^Ethernet2 is up/m);
  });

  it("show ipv6 ospf6 prints the instance summary", () => {
    S().loadFeatureLab("ipvx");
    advance(45000);
    const t = click("S1", "show ipv6 ospf6");
    expect(t).toContain(" OSPFv3 Routing Process (0) with Router-ID 1.1.1.1");
    expect(t).toMatch(/^ Running \d\d:\d\d:\d\d$/m);
    expect(t).toContain(" LSA minimum arrival 1000 msecs");
    expect(t).toContain(" Maximum-paths 256");
    expect(t).toContain(" Administrative distance 110");
    expect(t).toContain(" Initial SPF scheduling delay 0 millisec(s)");
    expect(t).toMatch(/^ SPF algorithm last executed \d\d:\d\d:\d\d ago, reason /m);
    expect(t).toContain(" Number of areas in this router is 1");
    expect(t).toContain(" Adjacency changes are logged");
    expect(t).toMatch(/^ Area 0\.0\.0\.0$/m);
    expect(t).toMatch(/^ {5}Number of Area scoped LSAs is \d+$/m);
    expect(t).toContain("     Interface attached to this area: Ethernet0 Ethernet1 Ethernet2");
    expect(t).toMatch(/^ {5}SPF last executed \d+\.\d+s ago$/m);
  });
});

describe("bug 5: RA suppression is visible", () => {
  it("KLISH show ipv6 nd ra-interfaces lists only interfaces that send RAs", () => {
    S().loadFeatureLab("ipvx");
    advance(5000);
    const t = run("S1", "show ipv6 nd ra-interfaces");
    expect(t).toMatch(/^Interfaces:$/m);
    expect(t).toMatch(/^ {4}Ethernet2$/m);
    expect(t).not.toMatch(/^ {4}Ethernet0$/m); // ipv6 nd suppress-ra
    expect(t).toContain("  ND advertised hop-count limit is 64 hops");
    expect(t).toContain("  ND router advertisements are sent every 180 seconds");
    expect(t).toContain("  Hosts use stateless autoconfig for addresses.");
    expect(run("S1", "show ipv6 nd ra-interfaces Ethernet 0")).not.toContain("Ethernet0");
    expect(run("S1", "show ipv6 nd ra-interfaces Ethernet 2")).toMatch(/^ {4}Ethernet2$/m);
    // lifting the suppression makes Ethernet0 advertise
    klish("S1", ["configure terminal", "interface Ethernet 0", "no ipv6 nd suppress-ra", "end"]);
    expect(run("S1", "show ipv6 nd ra-interfaces")).toMatch(/^ {4}Ethernet0$/m);
  });
});

describe("bug 6: Click show vxlan counters", () => {
  it("renders the tunnelstat -T vxlan table and the per-tunnel view", () => {
    S().loadFeatureLab("evpn-irb");
    advance(30000);
    S().execCommand(byName("H1").id, "ping -c 2 10.1.0.13");
    const t = click("LEAF1", "show vxlan counters");
    const lines = t.split("\n");
    // IFACE is as wide as "EVPN_10.0.0.2"; the other widths follow header + 2 (tunnelstat_test.py layout)
    expect(lines[0]).toBe("        IFACE    RX_PKTS    RX_BYTES    RX_PPS    TX_PKTS    TX_BYTES    TX_PPS");
    expect(lines[1]).toBe("-------------  ---------  ----------  --------  ---------  ----------  --------");
    // one row per tunnel vxlanorch created: EVPN_<dip> per remote VTEP, then the P2MP vtep1
    expect(lines.slice(2).map((l) => l.trim().split(/\s+/)[0])).toEqual(["EVPN_10.0.0.2", "EVPN_10.0.0.3", "vtep1"]);
    const p2p = lines.find((l) => l.includes("EVPN_10.0.0.3"))!.trim().split(/\s+/);
    expect(Number(p2p[4])).toBeGreaterThan(0); // TX_PKTS: H1's pings were encapsulated toward LEAF3
    expect(p2p[3]).toBe("N/A");
    const one = click("LEAF1", "show vxlan counters vtep1");
    expect(one).toMatch(/^vtep1\n-----\n\n {8}RX:\n {8} +\d+ packets\n {8} +\d+ bytes\n {8}TX:\n/);
  });
});
