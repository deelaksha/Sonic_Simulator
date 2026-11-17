import "../lib/commands/sonic-cli/features"; // register KLISH handlers (as the app does)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLabStore } from "../lib/store/lab-store";
import { peekCollector } from "../lib/sflow/collector";
import { decodeDatagram } from "../lib/sflow/datagram";
import { sflowSessions } from "../lib/sflow/agent";
import { peekTrafficSink } from "../lib/protocols/traffic";
import { resetAll } from "./helpers";

const S = () => useLabStore.getState();
const byName = (name: string) => Object.values(S().network.devices).find((d) => d.name === name)!;
const out = (r: { output: { text: string }[] }) => r.output.map((o) => o.text).join("\n");

beforeEach(() => {
  vi.useFakeTimers();
  resetAll();
  S().loadFeatureLab("sflow");
});
afterEach(() => {
  S().stopTraffic();
  vi.useRealTimers();
});

describe("switch L3 (SVI gateway, inter-VLAN routing, switch-originated ping)", () => {
  it("hosts in different VLANs reach each other through SVI gateways; the switch pings its collector", () => {
    const sw = byName("SW1").id;
    const h1 = byName("PC1").id;
    const h2 = byName("PC2").id;
    // Move H2 to VLAN 200 / 192.168.20.0/24 and give both VLANs an SVI gateway.
    S().setAccessVlan(sw, `${sw}-if1`, 200);
    S().setInterfaceIp(h2, `${h2}-if0`, "192.168.20.12", 24);
    S().setDefaultGateway(h1, "192.168.100.1");
    S().setDefaultGateway(h2, "192.168.20.1");
    const errs = S().runCliScript(sw, [
      "configure terminal",
      "interface Vlan 100",
      "ip address 192.168.100.1/24",
      "exit",
      "interface Vlan 200",
      "ip address 192.168.20.1/24",
      "end",
    ]);
    expect(errs).toEqual([]);

    expect(out(S().execCommand(h1, "ping -c 2 192.168.100.1"))).toMatch(/2 received/); // ping the gateway
    expect(out(S().execCommand(h1, "ping -c 2 192.168.20.12"))).toMatch(/2 received/); // routed across VLANs
    expect(out(S().execCommand(h1, "traceroute 192.168.20.12"))).toMatch(/192\.168\.100\.1/);

    S().execCommand(sw, "exit"); // sonic-cli → bash
    expect(out(S().execCommand(sw, "ping -c 1 192.168.200.16"))).toMatch(/1 received/); // collector over eth0
  });

  it("traffic run reports where packets are lost (destination moved to another VLAN, no gateway)", () => {
    const sw = byName("SW1").id;
    const h1 = byName("PC1").id;
    S().setAccessVlan(sw, `${sw}-if1`, 200);
    S().startTraffic({ srcDeviceId: h1, dstIp: "192.168.100.12", protocol: "udp", srcPort: 40000, dstPort: 5001, size: 100, count: 3, intervalMs: 0, continuous: false });
    vi.advanceTimersByTime(200);
    const t = S().traffic!;
    expect(t.sent).toBe(0);
    expect(t.failed).toBe(3);
    expect(t.lastFailure).toBe("arp-failed");
    expect(peekTrafficSink(byName("PC2"))?.udp.packets ?? 0).toBe(0);
  });
});

describe("sFlow sample direction (egress sampling)", () => {
  it("Click sample-direction tx samples egress frames with output = egress ifIndex", () => {
    const sw = byName("SW1").id;
    const h1 = byName("PC1").id;
    S().execCommand(sw, "exit");
    for (const c of [
      "sudo config sflow enable",
      "sudo config sflow collector add c1 192.168.200.16",
      "sudo config sflow interface sample-direction Ethernet1 tx",
      "sudo config sflow interface sample-rate Ethernet1 256",
      "sudo config sflow interface sample-rate Ethernet0 256",
      "sudo config sflow interface disable Ethernet0",
    ]) {
      expect(S().execCommand(sw, c).output.filter((o) => o.kind === "error")).toEqual([]);
    }
    expect(sflowSessions(S().network.devices[sw]).find((s) => s.port === "Ethernet1")?.direction).toBe("tx");
    expect(out(S().execCommand(sw, "show sflow interface"))).toMatch(/\| Ethernet1\s+\| up\s+\|\s+256 \| tx\s+\|/);

    S().startTraffic({ srcDeviceId: h1, dstIp: "192.168.100.12", protocol: "udp", srcPort: 40000, dstPort: 5001, size: 100, count: 3000, intervalMs: 0, continuous: false });
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1000);
      S().sflowTick();
    }
    const flows = peekCollector(byName("COLLECTOR"))!.recent.flatMap((d) => decodeDatagram(d.bytes).samples).filter((s) => s.kind === "flow");
    expect(flows.length).toBeGreaterThan(0);
    for (const f of flows) if (f.kind === "flow") expect([f.dsIndex, f.input, f.output]).toEqual([2, 0, 2]);
    expect(out(S().execCommand(sw, "sudo config sflow sample-direction sideways"))).toContain("Error: Direction sideways is invalid");
  });
});

describe("KLISH show running-configuration sflow", () => {
  it("renders global, collector (vrf always shown, port only if not 6343) and interface blocks", () => {
    const sw = byName("SW1").id;
    S().runCliScript(sw, [
      "configure terminal",
      "sflow enable",
      "sflow polling-interval 5",
      "sflow collector 192.168.200.16",
      "sflow collector 10.1.1.1 4451 vrf mgmt",
      "interface Ethernet 0",
      "sflow sampling-rate 256",
      "exit",
      "interface Ethernet 1",
      "no sflow enable",
      "end",
    ]);
    expect(out(S().execCommand(sw, "show running-configuration sflow"))).toBe(
      [
        "sflow enable",
        "sflow polling-interval 5",
        "sflow collector 192.168.200.16 vrf default",
        "sflow collector 10.1.1.1 4451 vrf mgmt",
        "interface Ethernet0",
        " sflow enable",
        " sflow sampling-rate 256",
        "!",
      ].join("\n"),
    );
  });
});

describe("tcpdump hints", () => {
  it("explains sudo and KLISH-style interface names instead of just failing", () => {
    const sw = byName("SW1").id;
    expect(out(S().execCommand(sw, "tcpdump -i Ethernet0"))).toContain("hint: the switch login is the unprivileged admin user — run: sudo tcpdump -i Ethernet0");
    expect(out(S().execCommand(sw, "sudo tcpdump -i Ethernet 0 -nn"))).toContain("hint: Linux interface names have no space — use -i Ethernet0");
    expect(out(S().execCommand(sw, "sudo tcpdump -i Eth1/1"))).toMatch(/hint: interfaces on SW1: Ethernet0, Ethernet1, Ethernet2, Ethernet3, eth0/);
  });
});
