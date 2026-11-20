/**
 * KLISH `show` coverage — L3 / routing protocols (klish-l3-show, klish-evpn-show,
 * klish-mcast-show, klish-ospfv3-show + show ip/ipv6 route form parsing).
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

const cli = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
const cfg = (dev: string, ...cmds: string[]) => ["configure terminal", ...cmds, "end"].forEach((c) => cli(dev, c));
const NOT_SIM = /not simulated in this lab|Unrecognized command/;

beforeAll(() => setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8"))));
afterEach(() => vi.useRealTimers());
const boot = (lab: string, ms = 30_000) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab(lab);
  advance(ms);
};

describe("action-less container commands print nothing", () => {
  it("show ip / ipv6 / ip dhcp / bfd / vxlan / vxlan remote / bgp l2vpn / evpn mac …", () => {
    boot("ospf", 5000);
    for (const c of ["show ip", "show ipv6", "show ip dhcp", "show ipv6 dhcp", "show bfd", "show vxlan", "show vxlan remote", "show bgp l2vpn", "show evpn mac", "show evpn rmac", "show evpn next-hops", "show evpn arp-cache"]) {
      expect(cli("S1", c), c).toBe("");
    }
  });
});

describe("show ip route / show ipv6 route forms", () => {
  it("protocol filter, summary, address lookup (ospf lab)", () => {
    boot("ospf");
    const o = cli("S1", "show ip route ospf");
    expect(o).toMatch(/^O>\* /m);
    expect(o).not.toMatch(/^C>\* /m);
    const c = cli("S1", "show ip route connected");
    expect(c).toMatch(/^C>\* 10\.0\.12\.0\/30 is directly connected, Ethernet0/m);
    expect(c).not.toMatch(/^O/m);
    const s = cli("S1", "show ip route summary").split("\n");
    expect(s[0]).toBe("Route Source         Routes               FIB  (vrf default)");
    expect(s).toContain("------");
    expect(s.some((l) => /^ospf {17}\d+/.test(l))).toBe(true);
    expect(cli("S1", "show ip route 10.0.12.1")).toMatch(/^L>\* 10\.0\.12\.1\/32 is directly connected, Ethernet0/m);
    expect(cli("S1", "show ip route 10.0.12.2")).toMatch(/^C>\* 10\.0\.12\.0\/30 is directly connected, Ethernet0/m);
    expect(cli("S1", "show ip route vrf all summary")).toMatch(/\(vrf default\)/);
    expect(cli("S1", "show ip route static")).toContain("IPv4 unicast VRF default:");
  });

  it("ipv6 route vrf / summary / protocol forms (ipvx lab)", () => {
    boot("ipvx", 60_000);
    expect(cli("S1", "show ipv6 route vrf default")).toContain("IPv6 unicast VRF default:");
    expect(cli("S1", "show ipv6 route connected")).toMatch(/^C>\* 2001:db8:12::\/64 is directly connected, Ethernet0/m);
    expect(cli("S1", "show ipv6 route ospfv3")).toMatch(/^O>\* 2001:db8:23::\/64 \[110\/\d+\] via fe80::/m);
    const s = cli("S1", "show ipv6 route summary");
    expect(s).toMatch(/^ospf6 {16}6 /m);
    expect(cli("S1", "show ipv6 route vrf Nope")).toBe("% VRF Nope not found");
  });
});

describe("show ipv6 ospfv3 (ipvx lab)", () => {
  it("neighbor table in the KLISH template layout", () => {
    boot("ipvx", 60_000);
    const l = cli("S1", "show ipv6 ospfv3 neighbor").split("\n");
    expect(l[0]).toBe("VRF Name: default");
    expect(l[1]).toBe("Neighbor ID     Pri    DeadTime      State/IfState      Duration         Interface[State]");
    expect(l.some((x) => /^2\.2\.2\.2 {9}1 {6}00:00:\d\d {6}Full\/- {13}\S+ +Ethernet0\[PointToPoint\]/.test(x))).toBe(true);
    expect(cli("S1", "show ipv6 ospfv3 neighbor Ethernet 1")).not.toContain("Ethernet0[");
    expect(cli("S1", "show ipv6 ospfv3 route")).toMatch(/^\*N IA 2001:db8:23::\/64 +fe80::/m);
    expect(cli("S1", "show ipv6 ospfv3 interface Ethernet 0")).toMatch(/^Ethernet0 is up/);
  });
  it("no instance", () => {
    boot("ospf", 5000);
    expect(cli("S1", "show ipv6 ospfv3")).toBe("% OSPFv3 instance not found");
  });
});

describe("show evpn (evpn-irb lab)", () => {
  it("summary counts the L2 / L3 VNIs", () => {
    boot("evpn-irb", 60_000);
    const l = cli("LEAF1", "show evpn").split("\n");
    expect(l[0]).toBe("L2 VNIs: 1");
    expect(l[1]).toBe("L3 VNIs: 1");
    expect(l).toContain("Duplicate address detection: Enable");
    expect(l).toContain("EVPN MH:");
    expect(l).toContain("  startup-delay: 300s, start-delay-timer: --:--:--");
  });
  it("es-evi lists a multihomed PortChannel per VNI; l2-nh header; vni not found", () => {
    boot("evpn-irb", 30_000);
    cfg("LEAF1", "interface PortChannel 1", "exit", "interface Ethernet 1", "channel-group 1", "exit", "interface PortChannel 1", "switchport access Vlan 10", "evpn ethernet-segment 00:11:22:33:44:55:66:77:88:99", "end");
    const o = cli("LEAF1", "show evpn es-evi").split("\n");
    expect(o[0]).toBe("Type: L local, R remote");
    expect(o[1]).toBe("VNI      ESI                            Type");
    expect(o).toContain("10010    00:11:22:33:44:55:66:77:88:99  L   ");
    expect(cli("LEAF1", "show evpn es-evi detail")).toContain("VNI 10010 ESI: 00:11:22:33:44:55:66:77:88:99");
    expect(cli("LEAF1", "show evpn es-evi vni 999")).toBe("VNI 999 not found");
    expect(cli("LEAF1", "show evpn l2-nh").split("\n")[0]).toBe("VTEP             NH id      #ES");
    expect(cli("LEAF1", "show vxlan remote nexthop-group")).toContain("   NHG      Remote VTEPs  Local Members ");
  });
});

describe("show bgp forms", () => {
  it("vrf-qualified AF forms and show bgp all neighbors (evpn-irb lab)", () => {
    boot("evpn-irb", 60_000);
    expect(cli("LEAF1", "show bgp ipv4 unicast vrf default summary")).toMatch(/10\.0\.11\.2/);
    expect(cli("LEAF1", "show bgp ipv4 unicast vrf Vrf-red summary")).not.toMatch(/Malformed/);
    const all = cli("LEAF1", "show bgp ipv4 unicast vrf all summary");
    expect(all).toContain("Instance default:");
    expect(all).toContain("Instance Vrf-red:");
    expect(cli("LEAF1", "show bgp all neighbors")).toMatch(/BGP neighbor is 10\.0\.11\.2/);
    expect(cli("LEAF1", "show bgp all vrf default neighbors 10.0.11.2")).toMatch(/BGP neighbor is 10\.0\.11\.2/);
  });
  it("ext-community-list from the stored config (show_bgp_extcom.j2)", () => {
    boot("bgp", 5000);
    cfg("S1", "bgp extcommunity-list standard EC1 permit rt 65000:100");
    const o = cli("S1", "show bgp ext-community-list");
    expect(o.split("\n")).toEqual(["Standard extended community list EC1:  match: ANY", "     permit rt:65000:100"]);
    expect(cli("S1", "show bgp ext-community-list nope")).toBe("");
  });
});

describe("BFD profiles", () => {
  it("show bfd profile renders configured profiles (show_bfd_profile.j2)", () => {
    boot("bfd", 5000);
    expect(cli("S1", "show bfd profile")).toBe("No BFD profiles configured");
    cfg("S1", "bfd", "profile fast", "transmit-interval 100", "receive-interval 150", "detect-multiplier 5", "echo-mode", "exit", "exit");
    const l = cli("S1", "show bfd profile").split("\n");
    expect(l[1]).toBe("Profile Name      Enabled  TxInterval  RxInterval  Multiplier  Passive  Echo");
    expect(l[3]).toBe("fast              Yes      100ms       150ms       5           No       Yes  ");
    expect(l[5]).toBe("Total: 1 profile(s)");
    expect(cli("S1", "show bfd profile fast")).toContain("fast ");
    expect(cli("S1", "show bfd profile other")).toBe("");
  });
});

describe("services: hosts, rest/telemetry, helper-address, dhcp snooping statistics", () => {
  it("show hosts / show ip rest / show ip telemetry", () => {
    boot("ospf", 5000);
    expect(cli("S1", "show hosts")).toBe("");
    cfg("S1", "ip name-server 8.8.8.8", "ip rest port 8443", "ip telemetry log-level 5");
    expect(cli("S1", "show hosts")).toBe("Name servers are: 8.8.8.8");
    const r = cli("S1", "show ip rest").split("\n");
    expect(r).toContain("Port is 8443");
    expect(r).toContain("Client authentication mode is password,jwt");
    expect(r).toContain("vrf is not-set");
    expect(cli("S1", "show ip rest port").trim()).toBe("Port is 8443");
    const t = cli("S1", "show ip telemetry").split("\n");
    expect(t).toContain("Log level is 5");
    expect(t).toContain("Port is 8080");
    expect(t).toContain("JWT valid is 0 seconds");
  });

  it("show ip helper-address [statistics] [<if>] from the interface config", () => {
    boot("ospf", 5000);
    cfg("S1", "interface Ethernet 0", "ip helper-address 1.1.1.1", "ip helper-address vrf Vrf1 2.2.2.2", "exit");
    const l = cli("S1", "show ip helper-address").split("\n");
    expect(l[0]).toBe("Interface    Vrf    Relay Address");
    expect(l).toContain("  Ethernet0           1.1.1.1");
    expect(l).toContain("               Vrf1   2.2.2.2");
    expect(cli("S1", "show ip helper-address Ethernet 0")).toContain("Ethernet0");
    expect(cli("S1", "show ip helper-address Ethernet 4")).not.toContain("1.1.1.1");
    const s = cli("S1", "show ip helper-address statistics Ethernet 0").split("\n");
    expect(s[0]).toBe("Ethernet0");
    expect(s).toContain("  Packets relayed                          : 0");
  });

  it("show ip dhcp snooping statistics [detail]", () => {
    boot("ospf", 5000);
    const l = cli("S1", "show ip dhcp snooping statistics").split("\n");
    expect(l[1]).toBe("Interface        MAC Verify   Client Ifc   DHCP Server");
    expect(l[3]).toBe("---------------  ----------   ----------   -----------");
    expect(l).toContain("Ethernet0        0            0            0          ");
    const d = cli("S1", "show ipv6 dhcp snooping statistics detail");
    expect(d).toContain("      DHCPv6 Snooping Detailed Statistics");
    expect(d).toContain("  Number of DHCP messages intercepted                              : 0");
  });
});

describe("PIM / IGMP (multicast lab, S3)", () => {
  it("show ip pim interface / traffic / ssm / rp / multicast", () => {
    boot("multicast");
    const l = cli("S3", "show ip pim interface").split("\n");
    expect(l[1]).toBe("PIM interface information for VRF: default");
    expect(l.some((x) => /^Vlan30 {17}up {8}192\.168\.30\.1 {6}0 {11}192\.168\.30\.1 {6}30 {16}1/.test(x))).toBe(true);
    expect(cli("S3", "show ip pim interface Vlan 30")).not.toContain("Ethernet0");
    expect(cli("S3", "show ip pim interface traffic")).toMatch(/^Ethernet0 {7}\d+\/\d+ /m);
    expect(cli("S3", "show ip pim ssm")).toContain("SSM group range: 232.0.0.0/8");
    expect(cli("S3", "show ip pim rp")).toMatch(/^224\.0\.0\.0\/4 {7}2\.2\.2\.2/m);
    expect(cli("S3", "show ip pim rp mapping")).toContain("RP:2.2.2.2, v2");
    expect(cli("S3", "show ip pim multicast")).toContain("Upstream Join Timer in secs :60");
    expect(cli("S3", "show ip pim vrf default rpf")).toContain("PIM RPF information for VRF: default");
  });
  it("show ip igmp interface [detail] / sources / statistics / join", () => {
    boot("multicast");
    const l = cli("S3", "show ip igmp interface").split("\n");
    expect(l[1]).toBe("IGMP interface information for VRF: default");
    expect(l.some((x) => /^Vlan30 {17}up {8}192\.168\.30\.1 {6}2 {11}local/.test(x))).toBe(true);
    const d = cli("S3", "show ip igmp interface Vlan 30");
    expect(d).toContain("Interface : Vlan30");
    expect(d).toContain("Query Interval                 : 125s");
    expect(d).toContain("Version   : 2");
    expect(cli("S3", "show ip igmp statistics")).toContain("IGMP RX statistics");
    expect(cli("S3", "show ip igmp vrf default sources")).toContain("VRF : default");
    expect(cli("S3", "show ip igmp join")).toBe("");
    cfg("S3", "interface Vlan 30", "ip igmp join 232.1.1.1 192.168.1.10", "exit");
    expect(cli("S3", "show ip igmp join")).toMatch(/^Vlan30 {9}192\.168\.30\.1 {3}192\.168\.1\.10 {3}232\.1\.1\.1/m);
  });
});

describe("no NS fallback across the family", () => {
  it.each([
    ["evpn-irb", "LEAF1"],
    ["ospf", "S1"],
    ["multicast", "S3"],
  ])("%s", (lab, dev) => {
    boot(lab, 10_000);
    for (const c of [
      "show evpn",
      "show evpn es-evi",
      "show evpn l2-nh",
      "show hosts",
      "show bfd profile",
      "show ip rest",
      "show ip telemetry",
      "show ip helper-address",
      "show ip dhcp snooping statistics",
      "show ip pim interface",
      "show ip pim rpf",
      "show ip igmp interface",
      "show ip igmp sources",
      "show ipv6 ospfv3",
      "show ip route summary",
      "show ipv6 route summary",
      "show vxlan remote nexthop-group",
    ]) {
      expect(cli(dev, c), `${lab}: ${c}`).not.toMatch(NOT_SIM);
    }
  });
});
