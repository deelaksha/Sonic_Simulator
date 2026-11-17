import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { useLabStore } from "../lib/store/lab-store";
import { ScapyEngine, LayerSpec } from "../lib/packetgen/engine";
import { peekTrafficSink } from "../lib/protocols/traffic";
import { peekCollector } from "../lib/sflow/collector";
import { decodeDatagram } from "../lib/sflow/datagram";
import { frameToBytes, inetChecksum } from "../lib/sflow/wire";
import { nodePacketEngine } from "./packet-engine-node";
import { resetAll } from "./helpers";

const S = () => useLabStore.getState();
const dev = (name: string) => Object.values(S().network.devices).find((d) => d.name === name)!;
let engine: ScapyEngine;

beforeAll(async () => {
  engine = await nodePacketEngine();
}, 120_000);
beforeEach(() => {
  vi.useFakeTimers();
  resetAll();
  S().loadFeatureLab("sflow");
});
afterEach(() => {
  S().stopTraffic();
  vi.useRealTimers();
});

async function run(stack: LayerSpec[], count: number) {
  const built = await engine.build(stack);
  const err = S().startTraffic({
    srcDeviceId: dev("PC1").id, dstIp: "", protocol: "engine", srcPort: 0, dstPort: 0, size: 0,
    count, intervalMs: 0, continuous: false, packet: { bytes: Array.from(built.bytes), summary: built.summary },
  });
  expect(err).toBeNull();
  vi.advanceTimersByTime(60 * Math.ceil(count / 200) + 60);
  return built;
}

const pc1 = () => dev("PC1").interfaces[0];
const ether = () => ({ proto: "Ether", fields: { src: pc1().mac.toLowerCase(), dst: "ff:ff:ff:ff:ff:ff" } });

describe("engine-built packets cross the simulated data plane", () => {
  it("a Scapy DNS query is switched to H2, shows in tcpdump, and sFlow samples its real bytes", async () => {
    const sw = dev("SW1").id;
    S().runCliScript(sw, ["configure terminal", "sflow enable", "sflow collector 192.168.200.16", "interface Ethernet 0", "sflow sampling-rate 256", "end"]);
    S().execCommand(sw, "sudo tcpdump -i Ethernet1 -nn -c 1 udp port 53");
    const built = await run(
      [
        ether(),
        { proto: "IP", fields: { src: "192.168.100.11", dst: "192.168.100.12" } },
        { proto: "UDP", fields: { sport: 33333, dport: 53 } },
        { proto: "DNS", fields: { rd: 1, qd: { proto: "DNSQR", fields: { qname: "example.com" } } } },
      ],
      1500,
    );
    expect(S().traffic).toMatchObject({ sent: 1500, failed: 0 });
    expect(peekTrafficSink(dev("PC2"))?.udp.packets).toBe(1500);
    const lines = (S().terminals[sw] ?? []).map((l) => l.text);
    expect(lines.some((t) => / IP 192\.168\.100\.11\.33333 > 192\.168\.100\.12\.53: UDP, length 29$/.test(t))).toBe(true);

    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(1000);
      S().sflowTick();
    }
    const flows = peekCollector(dev("COLLECTOR"))!.recent.flatMap((d) => decodeDatagram(d.bytes).samples).filter((s) => s.kind === "flow");
    expect(flows.length).toBeGreaterThan(0);
    const hdr = flows.find((f) => f.kind === "flow" && f.header && f.header.bytes[23] === 17);
    if (hdr?.kind !== "flow") throw new Error("no sampled UDP header");
    // Bytes after the Ethernet header are exactly what Scapy built (ARP resolved the dst MAC).
    expect(Array.from(hdr.header!.bytes.slice(14))).toEqual(Array.from(built.bytes.slice(14, hdr.header!.bytes.length)));
    const decoded = await engine.dissect(hdr.header!.bytes);
    expect(decoded.summary).toContain("DNS Qry");
  }, 60_000);

  it("routed across VLANs via the SVI: TTL decremented, IPv4 checksum still valid", async () => {
    const sw = dev("SW1").id;
    const h2 = dev("PC2").id;
    S().setAccessVlan(sw, `${sw}-if1`, 200);
    S().setInterfaceIp(h2, `${h2}-if0`, "192.168.20.12", 24);
    S().setDefaultGateway(dev("PC1").id, "192.168.100.1");
    S().setDefaultGateway(h2, "192.168.20.1");
    S().runCliScript(sw, ["configure terminal", "interface Vlan 100", "ip address 192.168.100.1/24", "exit", "interface Vlan 200", "ip address 192.168.20.1/24", "end"]);
    S().execCommand(h2, "tcpdump -i eth0 -nn -c 1 -X udp");
    await run(
      [
        ether(),
        { proto: "IP", fields: { src: "192.168.100.11", dst: "192.168.20.12", ttl: 64 } },
        { proto: "UDP", fields: { sport: 1234, dport: 4789 } },
        { proto: "VXLAN", fields: { vni: 10100 } },
        { proto: "Ether", fields: { src: "02:00:00:00:00:0a", dst: "02:00:00:00:00:0b" } },
        { proto: "IP", fields: { src: "10.1.1.1", dst: "10.1.1.2" } },
        { proto: "ICMP" },
      ],
      1,
    );
    expect(peekTrafficSink(dev("PC2"))?.udp.packets).toBe(1);
    const rx = S().captures.find((c) => c.deviceId === h2 && c.dir === "rx" && c.frame.udp?.dstPort === 4789)!;
    expect(rx.frame.ipv4?.ttl).toBe(63);
    const bytes = frameToBytes(rx.frame);
    expect(inetChecksum(Array.from(bytes.slice(14, 34)))).toBe(0);
    const d = await engine.dissect(bytes);
    expect(d.layers.map((l) => l.proto)).toEqual(["Ether", "IP", "UDP", "VXLAN", "Ether", "IP", "ICMP"]);
  }, 60_000);

  it("a non-IP protocol (LLDP) leaves the host exactly as built and is flooded in the VLAN", async () => {
    const before = dev("PC2").interfaces[0].statistics.rxFrames;
    const built = await run(
      [
        { proto: "Ether", fields: { src: pc1().mac.toLowerCase(), dst: "01:80:c2:00:00:0e" } },
        { proto: "LLDPDUChassisID", fields: { subtype: 4, id: pc1().mac.toLowerCase() } },
        { proto: "LLDPDUPortID", fields: { subtype: 3, id: pc1().mac.toLowerCase() } },
        { proto: "LLDPDUTimeToLive", fields: { ttl: 120 } },
        { proto: "LLDPDUEndOfLLDPDU" },
      ],
      3,
    );
    expect(S().traffic).toMatchObject({ sent: 3, failed: 0 });
    expect(dev("PC2").interfaces[0].statistics.rxFrames - before).toBe(3);
    const rx = S().captures.filter((c) => c.deviceId === dev("PC2").id && c.dir === "rx" && c.frame.ethernet.typeCode === 0x88cc);
    expect(rx).toHaveLength(3);
    expect(Array.from(frameToBytes(rx[0].frame)).slice(0, built.bytes.length)).toEqual(Array.from(built.bytes));
  }, 60_000);
});
