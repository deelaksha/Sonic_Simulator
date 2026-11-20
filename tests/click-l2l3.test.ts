/**
 * Click `show` commands of the L2/L3 families at the bash prompt (sonic-utilities show/
 * interfaces, show/stp.py, show/main.py ip/ipv6/bfd/subinterfaces, show/nat.py,
 * show/bgp_frr_v6.py, show/bgp_cli.py): real headers / layouts, rendered from live state.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs";
import { routedTriangle } from "../lib/labs/topologies";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

const sh = (d: string, cmd: string) => out(S().execCommand(byName(d).id, cmd));
const cli = (d: string, lines: string[]) => S().runCliScript(byName(d).id, ["configure terminal", ...lines, "end"]);

function boot(lab: string, ms = 5000) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab(lab);
  advance(ms);
}
const toBash = (...devs: string[]) => devs.forEach((d) => S().execCommand(byName(d).id, "exit"));

// routedTriangle with an MP-BGP IPv6 unicast session over the S1–S3 IPv4 link.
registerLab("test-click-bgp6", (api) => {
  const t = routedTriangle(api);
  const v6 = (n: number, a: string) => [`interface Ethernet ${n}`, `ipv6 address ${a}`, "exit"];
  api.runCliScript(t.s1, ["configure terminal", ...v6(1, "2001:db8:13::1/64"), ...v6(2, "2001:db8:1::1/64"), "end"]);
  api.runCliScript(t.s3, ["configure terminal", ...v6(0, "2001:db8:13::2/64"), ...v6(2, "2001:db8:3::1/64"), "end"]);
  const bgp = (as: number, rid: string, peer: string, ras: number, net: string) => [
    "configure terminal",
    `router bgp ${as}`,
    `router-id ${rid}`,
    `neighbor ${peer}`,
    `remote-as ${ras}`,
    "address-family ipv6 unicast",
    "activate",
    "exit",
    "exit",
    "address-family ipv6 unicast",
    `network ${net}`,
    "end",
  ];
  api.runCliScript(t.s1, bgp(65001, "1.1.1.1", "10.0.13.2", 65003, "2001:db8:1::/64"));
  api.runCliScript(t.s3, bgp(65003, "3.3.3.3", "10.0.13.1", 65001, "2001:db8:3::/64"));
  api.finish("test click bgp6", t.s1);
});

afterEach(() => vi.useRealTimers());

describe("show interfaces <sub> (lacp lab, S1)", () => {
  beforeEach(() => {
    boot("lacp");
    toBash("S1");
  });

  it("bare group prints Click usage; an unknown sub-command is a Click error, not the status table", () => {
    const g = sh("S1", "show interfaces");
    expect(g).toMatch(/^Usage: show interfaces \[OPTIONS\] COMMAND \[ARGS\]\.\.\.\n\n {2}Show details of the network interfaces\n/);
    expect(g).toMatch(/^ {2}transceiver +Show SFP Transceiver information$/m);
    const e = sh("S1", "show interfaces bogus");
    expect(e).toContain('Error: No such command "bogus".');
    expect(e).not.toContain("IPv4 address/mask");
  });

  it("alias: Name/Alias of the front-panel ports", () => {
    expect(sh("S1", "show interfaces alias")).toBe(
      ["Name       Alias", "---------  -------", "Ethernet0  etp1", "Ethernet1  etp2", "Ethernet2  etp3", "Ethernet3  etp4"].join("\n"),
    );
    expect(sh("S1", "show interfaces alias Ethernet9")).toContain("Error: Invalid interface name Ethernet9");
  });

  it("description: intfutil columns, right-aligned, peer from the cabling; follows admin state", () => {
    const d = sh("S1", "show interfaces description");
    expect(d.split("\n").slice(0, 2)).toEqual(["  Interface    Oper    Admin    Alias    Description", "-----------  ------  -------  -------  -------------"]);
    expect(d).toMatch(/^ {2}Ethernet0 +up +up +etp1 +S2:Ethernet0$/m);
    expect(d).toMatch(/^ {2}Ethernet2 +up +up +etp3 +H1:eth0$/m);
    S().execCommand(byName("S1").id, "config interface shutdown Ethernet3");
    expect(sh("S1", "show interfaces description Ethernet3")).toMatch(/^ {2}Ethernet3 +down +down +etp4 +H2:eth0$/m);
  });

  it("switchport config/status: modes and members from the VLAN config, LAG members folded into the LAG", () => {
    const c = sh("S1", "show interfaces switchport config");
    expect(c.split("\n")[0]).toBe("Interface     Mode      Untagged  Tagged");
    expect(c).toMatch(/^Ethernet2 +access +10$/m);
    expect(c).toMatch(/^PortChannel1 +access +10$/m);
    expect(c).not.toMatch(/^Ethernet0 /m); // PortChannel1 member
    S().execCommand(byName("S1").id, "config vlan add 20");
    S().execCommand(byName("S1").id, "config vlan member add 20 Ethernet3");
    // (the model turns the port into a trunk; its tagged VLAN lands in the Tagged column)
    expect(sh("S1", "show interfaces switchport config")).toMatch(/^Ethernet3 +trunk {15}20$/m);
    expect(sh("S1", "show interfaces switchport status")).toMatch(/^Ethernet3 +trunk$/m);
  });

  it("tpid / fec / autoneg / transceiver presence + eeprom", () => {
    expect(sh("S1", "show interfaces tpid")).toMatch(/^PortChannel1 +N\/A +up +up +0x8100$/m);
    expect(sh("S1", "show interfaces fec status").split("\n")[0]).toBe("  Interface    FEC Oper    FEC Admin");
    expect(sh("S1", "show interfaces autoneg status").split("\n")[0]).toBe(
      "  Interface    Auto-Neg Mode    Speed    Adv Speeds    Rmt Adv Speeds    Type    Adv Types    Oper    Admin",
    );
    expect(sh("S1", "show interfaces transceiver presence")).toMatch(/^Port +Presence\n-+ +-+\nEthernet0 +Present$/m);
    const e = sh("S1", "show interfaces transceiver eeprom Ethernet0");
    expect(e).toMatch(/^Ethernet0: SFP EEPROM detected\n {8}Connector: No separable connector$/m);
    expect(e).toContain("        Vendor Name: SIMULATED");
  });
});

describe("show spanning-tree <sub> (running STP)", () => {
  beforeEach(() => {
    boot("lacp");
    cli("S1", ["interface Ethernet 2", "spanning-tree bpduguard port-shutdown", "spanning-tree guard root", "exit", "interface Ethernet 3", "spanning-tree bpduguard", "exit"]);
    advance(2000);
    toBash("S1");
  });

  it("bpdu_guard / root_guard from the STP_PORT config", () => {
    expect(sh("S1", "show spanning-tree bpdu_guard")).toBe(
      [
        "PortNum          Shutdown     Port Shut",
        "                 Configured   due to BPDU guard",
        "-------------------------------------------",
        "Ethernet2        Yes          No",
        "Ethernet3        No           NA",
      ].join("\n"),
    );
    expect(sh("S1", "show spanning-tree root_guard")).toBe(
      ["Root guard timeout: 30 secs", "", "Port             VLAN   Current State", "-------------------------------------------", "Ethernet2        10     Consistent state"].join("\n"),
    );
  });

  it("statistics [vlan] carry the daemon's BPDU counters; vlan <id> shows the bridge in hex", () => {
    const st = sh("S1", "show spanning-tree statistics vlan 10");
    expect(st).toMatch(/^VLAN 10 - STP instance \d+$/m);
    expect(st).toContain("PortNum          BPDU Tx        BPDU Rx        TCN Tx         TCN Rx");
    const m = /^Ethernet2 +(\d+) +(\d+)/m.exec(st);
    expect(Number(m?.[1])).toBeGreaterThan(0);
    const v = sh("S1", "show spanning-tree vlan 10");
    expect(v).toContain("STP Bridge Parameters:");
    expect(v).toMatch(/^800a[0-9a-f]{12} +20 +2 +15 +1 +0 +0$/m);
    expect(v).toMatch(/^Ethernet2 +128 +\d+ +N +N +FORWARDING/m);
    expect(sh("S1", "show spanning-tree vlan 10 interface Ethernet3")).not.toMatch(/^Ethernet2 /m);
    expect(sh("S1", "show spanning-tree vlan")).toContain('Error: Missing argument "<vlanid>".');
  });
});

describe("IPv6 BGP (Click show ipv6 bgp …)", () => {
  beforeEach(() => {
    boot("test-click-bgp6", 1000);
    advance(30000);
    toBash("S1");
  });

  it("summary lists the IPv6-activated peer with its prefix count; network shows the v6 table", () => {
    const s = sh("S1", "show ipv6 bgp summary");
    expect(s).toContain("IPv6 Unicast Summary:");
    expect(s).toContain("BGP router identifier 1.1.1.1, local AS number 65001 VRF default");
    expect(s).toMatch(/^10\.0\.13\.2 +4 +65003 .* +1 +\d+ N\/A$/m);
    expect(sh("S1", "show ipv6 bgp network")).toContain("2001:db8:3::/64");
    expect(sh("S1", "show ipv6 bgp network 2001:db8:3::/64")).toContain("BGP routing table entry for 2001:db8:3::/64");
    expect(sh("S1", "show ipv6 bgp neighbors 10.0.13.2")).toContain("Error: 10.0.13.2 is not valid ipv6 address");
    expect(sh("S1", "show ipv6 bgp vrf default summary")).toContain("IPv6 Unicast Summary:");
    expect(sh("S1", "show ipv6 bgp")).toMatch(/^Usage: show ipv6 bgp \[OPTIONS\] COMMAND/);
  });

  it("ip bgp network without an argument is the whole table; ipv6 fib holds the BGP route", () => {
    expect(sh("S1", "show ip bgp network")).not.toContain("Malformed");
    expect(sh("S1", "show bgp device-global")).toBe("No configuration is present in CONFIG DB");
    const fib = sh("S1", "show ipv6 fib");
    expect(fib.split("\n")[0]).toMatch(/^ +No\. +Vrf +Route +Nexthop +Ifname$/);
    expect(fib).toMatch(/2001:db8:3::\/64 +fe80:\S+ +Ethernet1$/m);
    expect(sh("S1", "show ipv6 interfaces")).toMatch(/^Ethernet1 +2001:db8:13::1\/64 +up\/up +N\/A +N\/A$/m);
  });
});

describe("NAT config (l3-services lab)", () => {
  beforeEach(() => {
    boot("l3-services");
    toBash("S1");
  });

  it("show nat config <section> renders natconfig tables from the KLISH nat config", () => {
    expect(sh("S1", "show nat config globalvalues")).toBe(["", "Admin Mode     : enabled", "Global Timeout : 600 secs", "TCP Timeout    : 86400 secs", "UDP Timeout    : 300 secs", ""].join("\n"));
    const st = sh("S1", "show nat config static");
    expect(st).toContain("Nat Type    IP Protocol    Global IP      Global Port  Local IP        Local Port   Twice-NAT Id");
    expect(st).toMatch(/^dnat +TCP +100\.64\.0\.1 +8080 +192\.168\.1\.10 +80 +---$/m);
    expect(sh("S1", "show nat config pool")).toMatch(/^INET +100\.64\.0\.1 +20000-29999$/m);
    expect(sh("S1", "show nat config bindings")).toMatch(/^LAN +INET +--- +snat +---$/m);
    const z = sh("S1", "show nat config zones");
    expect(z).toMatch(/^Ethernet0 +1$/m);
    expect(z).toMatch(/^Ethernet2 +0$/m);
    expect(sh("S1", "show nat config")).toContain("Pool Name    Global IP Range    Global Port Range");
    expect(sh("S1", "show nat")).toMatch(/^ {2}translations +Show NAT translations$/m);
  });
});

describe("bare Click groups", () => {
  beforeEach(() => {
    boot("lacp");
    toBash("S1");
  });

  it("ip / ipv6 / bfd / vxlan / acl / subinterfaces print their group help", () => {
    for (const [g, help] of [
      ["ip", "Show IP (IPv4) commands"],
      ["ipv6", "Show IPv6 commands"],
      ["bfd", "Show details of the bfd sessions"],
      ["vxlan", "Show vxlan related information"],
      ["acl", "Show ACL related information"],
      ["subinterfaces", "Show details of the sub port interfaces"],
    ]) {
      const o = sh("S1", `show ${g}`);
      expect(o.split("\n").slice(0, 3)).toEqual([`Usage: show ${g} [OPTIONS] COMMAND [ARGS]...`, "", `  ${help}`]);
      expect(o).toContain("Commands:");
    }
    expect(sh("S1", "show bfd summary").split("\n")[0]).toBe("Total number of BFD sessions: 0");
    expect(sh("S1", "show ipv6 protocol")).toMatch(/^bgp {23}: none$/m);
  });
});
