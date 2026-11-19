/** Regression tests for area D1: DHCP NAK/release, NAT ICMP errors, lab hints, MAC determinism, simctl. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

const id = (n: string) => byName(n).id;
const sh = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"]);
/** Linux shell on a switch (terminals start in KLISH). */
const bash = (dev: string, cmd: string) => {
  if ((S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return sh(dev, cmd);
};
const clientIp = () => byName("Client").interfaces[0].ipv4[0]?.address;
const serverLeases = (dev: string) => (byName(dev).config.features?.dhcpServer as { leases: Record<string, string> }).leases;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("bug 1: DHCP server NAKs addresses outside its pool (RFC 2131 4.3.2)", () => {
  beforeEach(() => S().loadFeatureLab("l2-protect"));

  it("a REQUEST for another server's offer is ignored, not ACKed", () => {
    klish("SW1", ["no ip dhcp snooping"]);
    expect(sh("Client", "dhclient")).toContain("from 10.66.66.1");
    expect(clientIp()).toBe("10.66.66.100");
    // The legitimate server saw the broadcast REQUEST (server-id 10.66.66.1) but must not lease 10.66.66.100.
    expect(Object.values(serverLeases("DHCP"))).not.toContain("10.66.66.100");
  });

  it("INIT-REBOOT for the rogue lease is NAKed; the client restarts discovery and leases from the real server", () => {
    klish("SW1", ["no ip dhcp snooping"]);
    sh("Client", "dhclient");
    expect(clientIp()).toBe("10.66.66.100");
    klish("SW1", ["ip dhcp snooping"]);
    const o = sh("Client", "dhclient");
    expect(o).toContain("DHCPREQUEST for 10.66.66.100 on eth0 to 255.255.255.255 port 67");
    expect(o).toContain("DHCPNAK from 192.168.10.1");
    expect(o).toContain("DHCPACK of 192.168.10.100 from 192.168.10.1");
    expect(clientIp()).toBe("192.168.10.100");
  });

  it("INIT-REBOOT for the client's own lease is ACKed", () => {
    sh("Client", "dhclient");
    const o = sh("Client", "dhclient");
    expect(o).toContain("DHCPREQUEST for 192.168.10.100");
    expect(o).toContain("DHCPACK of 192.168.10.100 from 192.168.10.1");
    expect(o).not.toContain("DHCPNAK");
  });
});

describe("bug 2: dhclient -r and ip addr flush", () => {
  beforeEach(() => S().loadFeatureLab("l2-protect"));

  it("dhclient -r sends DHCPRELEASE, removes the address and the default route; the server frees the lease", () => {
    sh("Client", "dhclient");
    expect(byName("Client").routingTable.some((r) => r.type === "default")).toBe(true);
    const o = sh("Client", "dhclient -r");
    expect(o).toContain("DHCPRELEASE of 192.168.10.100 on eth0 to 192.168.10.1 port 67");
    expect(clientIp()).toBeUndefined();
    expect(byName("Client").routingTable.some((r) => r.type === "default")).toBe(false);
    expect(byName("Client").config.defaultGateway).toBeUndefined();
    expect(Object.values(serverLeases("DHCP"))).not.toContain("192.168.10.100");
    expect(S().captures.some((c) => c.deviceId === id("DHCP") && c.dir === "rx" && c.frame.dhcp?.messageType === "release")).toBe(true);
  });

  it("ip addr flush dev eth0 removes every IPv4 address and the routes through it", () => {
    sh("Client", "dhclient");
    expect(sh("Client", "ip addr flush dev eth0")).toBe("");
    expect(clientIp()).toBeUndefined();
    expect(byName("Client").routingTable).toHaveLength(0);
    expect(sh("Client", "ip addr flush dev eth9")).toContain('Device "eth9" does not exist.');
  });
});

describe("bug 3: NAT reverse-translates ICMP errors (RFC 5508)", () => {
  it("traceroute from an inside host shows the hop beyond the NAT", () => {
    S().loadFeatureLab("l3-services");
    advance(6000);
    const o = sh("H1", "traceroute 203.0.113.10");
    expect(o).toMatch(/^ 1 {2}192\.168\.1\.1 /m);
    expect(o).toMatch(/^ 2 {2}10\.0\.12\.2 /m);
    expect(o).toMatch(/^ 3 {2}203\.0\.113\.10 /m);
    expect(o).not.toContain("* * *");
    // The error reaching H1 carries the inside addresses in its embedded header.
    const te = S().captures.find((c) => c.deviceId === id("H1") && c.dir === "rx" && c.frame.icmp?.type === "time-exceeded" && c.frame.ipv4?.srcIp === "10.0.12.2")!;
    expect(te.frame.ipv4!.dstIp).toBe("192.168.1.10");
    expect(te.frame.icmp!.original?.srcIp).toBe("192.168.1.10");
  });
});

describe("bug 4: lab hints", () => {
  it("KLISH show ip vrf (vrf.xml, show_vrf.j2)", () => {
    S().loadFeatureLab("vrf");
    expect(sh("S1", "show ip vrf")).toBe(["VRF          Interfaces", "--------     ------------", "Vrf-red      Ethernet2", "             Ethernet1"].join("\n"));
    expect(sh("S1", "show ip vrf Vrf-red")).toContain("Vrf-red      Ethernet2");
    expect(sh("S1", "show ip vrf Vrf-blue")).toBe("No VRFs configured");
  });

  it("ipvx is dual-stack: H1 reaches H3 over IPv4 too (OSPFv2)", () => {
    S().loadFeatureLab("ipvx");
    advance(45_000, 500);
    expect(sh("H1", "ping -c 2 192.168.3.10")).toContain("2 received");
  });
});

describe("bug 5: MACs are deterministic per lab load", () => {
  it("loading the same lab twice gives identical MACs, whatever ran before", () => {
    S().loadFeatureLab("l2-protect");
    const first = byName("Client").interfaces[0].mac;
    S().loadFeatureLab("ospf");
    S().loadFeatureLab("l2-protect");
    expect(byName("Client").interfaces[0].mac).toBe(first);
  });

  it("devices added after an import never reuse an imported MAC", () => {
    S().loadFeatureLab("l2-protect");
    const json = S().exportLab();
    S().newLab();
    S().addDevice("pc");
    expect(S().importLab(json)).toBe(true);
    const used = new Set(Object.values(S().network.devices).flatMap((d) => d.interfaces.map((i) => i.mac)));
    const added = S().addDevice("switch", undefined, 4);
    for (const i of S().network.devices[added].interfaces) expect(used.has(i.mac)).toBe(false);
  });
});

describe("bug 6: simctl dataplane (simulator-only)", () => {
  it("switches the data-plane mode from a switch terminal", () => {
    S().loadFeatureLab("l2-protect");
    const mode = () => (byName("SW1").config.features?.["dataplane-mode"] as { mode?: string } | undefined)?.mode ?? "vs";
    expect(bash("SW1", "simctl dataplane")).toContain("vs");
    bash("SW1", "simctl dataplane hardware");
    expect(mode()).toBe("hardware");
    expect(bash("SW1", "simctl dataplane")).toContain("hardware");
    bash("SW1", "simctl dataplane vs");
    expect(mode()).toBe("vs");
    expect(bash("SW1", "simctl dataplane asic")).toMatch(/usage/i);
    expect(sh("Client", "simctl dataplane hardware")).toMatch(/only.*switch/i);
    expect(bash("SW1", "help simctl")).toMatch(/simulator-only/i);
  });
});
