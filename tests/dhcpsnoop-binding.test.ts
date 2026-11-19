/**
 * DHCP snooping on the l2-protect lab: snooping on Vlan10, the real server on
 * trusted Ethernet2, a rogue server on untrusted Ethernet1 (a lower port, so
 * without snooping its OFFER reaches the client first).
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { peekSnoopState } from "../lib/protocols/dhcp-snooping";
import { peekDrops } from "../lib/control/drops";
import { resetAll } from "./helpers";
import { S, byName, out } from "./control-helpers";

const id = (n: string) => byName(n).id;
const sh = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"]);
const clientIp = () => byName("Client").interfaces[0].ipv4[0]?.address;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("l2-protect");
});
afterEach(() => vi.useRealTimers());

describe("DHCP snooping", () => {
  it("drops the rogue server's OFFER/ACK on the untrusted port; the client leases from the trusted server", () => {
    expect(sh("Client", "dhclient")).toContain("DHCPACK of 192.168.10.100 from 192.168.10.1");
    expect(clientIp()).toBe("192.168.10.100");
    const drops = peekSnoopState(byName("SW1"))!.drops;
    // Only the rogue OFFER: the REQUEST names server 192.168.10.1, so the rogue stays silent (RFC 2131 4.3.2).
    expect(drops.Ethernet1).toBe(1);
    expect(peekDrops(byName("SW1"))!.Ethernet1.DHCP_SNOOPING).toBe(1);
    const rogueOffers = S().captures.filter((c) => c.deviceId === id("Client") && c.frame.dhcp?.serverIp === "10.66.66.1");
    expect(rogueOffers).toHaveLength(0);
  });

  it("without snooping the rogue answers first and the client takes its lease", () => {
    klish("SW1", ["no ip dhcp snooping"]);
    expect(sh("Client", "dhclient")).toContain("from 10.66.66.1");
    expect(clientIp()).toMatch(/^10\.66\.66\./);
  });

  it("snooping only acts on its VLANs", () => {
    klish("SW1", ["no ip dhcp snooping Vlan10", "ip dhcp snooping Vlan20"]);
    sh("Client", "dhclient");
    expect(clientIp()).toMatch(/^10\.66\.66\./);
  });

  it("builds a binding from the trusted ACK: show ip dhcp snooping binding; clear flushes it", () => {
    sh("Client", "dhclient");
    const mac = byName("Client").interfaces[0].mac.toLowerCase();
    vi.advanceTimersByTime(10_000);
    const o = sh("SW1", "show ip dhcp snooping binding");
    expect(o).toBe(
      [
        "Total number of Dynamic bindings: 1",
        "Total number of Static bindings: 0",
        "Total number of Tentative bindings: 0",
        "MAC Address        IP Address       VLAN   Interface    Type    Lease (Secs)",
        "-----------------  ---------------  -----  -----------  ------  ------------",
        `${mac}  192.168.10.100   10     Ethernet0    DYN     86390`,
      ].join("\n"),
    );
    sh("SW1", "clear ip dhcp snooping binding");
    expect(sh("SW1", "show ip dhcp snooping binding")).toContain("Total number of Dynamic bindings: 0");
  });

  it("the binding ages out with the lease", () => {
    sh("Client", "dhclient");
    vi.advanceTimersByTime(86_401_000);
    expect(sh("SW1", "show ip dhcp snooping binding")).toContain("Total number of Dynamic bindings: 0");
  });

  it("verify mac-address drops client messages whose source MAC differs from chaddr", async () => {
    klish("SW1", ["ip dhcp snooping verify mac-address"]);
    const { buildFrame } = await import("../lib/protocols/ethernet");
    const sw = byName("SW1");
    const atk = byName("Attacker");
    // A DISCOVER from the Attacker's NIC claiming another client's hardware address (starvation/spoofing).
    const frame = buildFrame(
      { srcMac: atk.interfaces[0].mac, dstMac: "FF:FF:FF:FF:FF:FF", etherType: "IPv4", payloadBytes: 328, summary: "DHCP DISCOVER" },
      { ipv4: { srcIp: "0.0.0.0", dstIp: "255.255.255.255", ttl: 64, protocol: "UDP", identification: 0 }, udp: { srcPort: 68, dstPort: 67, length: 308 }, dhcp: { messageType: "discover", clientMac: "02:BA:D0:00:00:01" } },
    );
    const { Simulation } = await import("../lib/engine");
    new Simulation(S().network, { wallBase: Date.now() }).transmit(atk.id, atk.interfaces[0].id, frame);
    expect(peekSnoopState(sw)!.drops.Ethernet3).toBe(1);
    // The client's own DISCOVER (source MAC = chaddr) still passes.
    expect(sh("Client", "dhclient")).toContain("DHCPACK of 192.168.10.");
  });

  it("show ip dhcp snooping reflects the lab config", () => {
    const o = sh("SW1", "show ip dhcp snooping");
    expect(o).toContain("DHCP snooping is Enabled");
    expect(o).toContain("DHCP snooping is enabled on the following VLANs: Vlan10");
    expect(o).toMatch(/Ethernet2\s+Yes/);
  });
});
