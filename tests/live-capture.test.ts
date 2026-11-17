import "../lib/commands/sonic-cli/features"; // register KLISH handlers (as the app does)
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useLabStore } from "../lib/store/lab-store";
import { peekCollector } from "../lib/sflow/collector";
import { peekSflowRuntime } from "../lib/sflow/agent";
import { compileFilter } from "../lib/commands/bpf";
import { resetAll } from "./helpers";

const S = () => useLabStore.getState();
const term = (id: string) => (S().terminals[id] ?? []).map((l) => l.text);
const byName = (name: string) => Object.values(S().network.devices).find((d) => d.name === name)!;

describe("pcap filter subset", () => {
  it("parses tcpdump-style expressions", () => {
    expect(() => compileFilter("udp port 6343")).not.toThrow();
    expect(() => compileFilter("icmp and (src host 10.0.0.1 or dst net 10.1.0.0/16) and not arp")).not.toThrow();
    expect(() => compileFilter("tcp dst portrange 1-1024 || ether host 02:00:00:00:00:01")).not.toThrow();
    expect(() => compileFilter("port")).toThrow(/syntax error/);
    expect(() => compileFilter("(udp")).toThrow(/syntax error/);
  });
});

describe("interactive tcpdump + traffic generator (store)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAll();
    S().loadFeatureLab("sflow");
  });
  afterEach(() => {
    S().stopTraffic();
    vi.useRealTimers();
  });

  it("tcpdump without sudo on the switch is refused like the real admin user", () => {
    const sw = byName("SW1").id;
    const r = S().execCommand(sw, "tcpdump -i Ethernet0 -nn");
    expect(r.output.map((o) => o.text).join("\n")).toMatch(/You don't have permission/);
    expect(S().liveCaptures[sw]).toBeUndefined();
  });

  it("streams packets as they arrive, honours the filter, and stops on Ctrl+C", () => {
    const sw = byName("SW1").id;
    const h1 = byName("PC1").id;
    const r = S().execCommand(sw, "sudo tcpdump -i Ethernet1 -nn udp");
    expect(r.output.map((o) => o.text)).toContain("listening on Ethernet1, link-type EN10MB (Ethernet), snapshot length 262144 bytes");
    expect(S().liveCaptures[sw]).toBeDefined();
    expect(term(sw).filter((t) => / UDP, length/.test(t))).toHaveLength(0); // waits: nothing yet

    expect(S().startTraffic({ srcDeviceId: h1, dstIp: "192.168.100.12", protocol: "udp", srcPort: 40000, dstPort: 5001, size: 100, count: 20, intervalMs: 100, continuous: false })).toBeNull();
    vi.advanceTimersByTime(450); // first packets only
    const early = term(sw).filter((t) => / UDP, length 100$/.test(t)).length;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(20);
    vi.advanceTimersByTime(3000);
    const lines = term(sw).filter((t) => / UDP, length 100$/.test(t));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{6} IP 192\.168\.100\.11\.40000 > 192\.168\.100\.12\.5001: UDP, length 100$/);
    expect(term(sw).some((t) => /ARP/.test(t))).toBe(false); // filtered out
    expect(S().traffic).toMatchObject({ sent: 20, failed: 0, running: false });

    S().stopLiveCapture(sw);
    expect(S().liveCaptures[sw]).toBeUndefined();
    expect(term(sw)).toContain("20 packets captured");
    expect(term(sw)).toContain("0 packets dropped by kernel");
  });

  it("-c N exits by itself; -i any shows direction per interface", () => {
    const sw = byName("SW1").id;
    const h1 = byName("PC1").id;
    S().execCommand(sw, "sudo tcpdump -i any -nn -c 4 icmp");
    S().startTraffic({ srcDeviceId: h1, dstIp: "192.168.100.12", protocol: "icmp", srcPort: 1, dstPort: 1, size: 56, count: 3, intervalMs: 0, continuous: false });
    vi.advanceTimersByTime(500);
    expect(S().liveCaptures[sw]).toBeUndefined();
    const pk = term(sw).filter((t) => /ICMP echo/.test(t));
    expect(pk).toHaveLength(4);
    expect(pk[0]).toMatch(/ Ethernet0 In  IP 192\.168\.100\.11 > 192\.168\.100\.12: ICMP echo request, id 1, seq 1, length 64$/);
    expect(pk[1]).toMatch(/ Ethernet1 Out IP 192\.168\.100\.11 > 192\.168\.100\.12: ICMP echo request/);
    expect(term(sw)).toContain("4 packets captured");
  });

  it("full workflow: KLISH config → traffic → sFlow datagrams on eth0 → collector decodes FLOW + COUNTER", () => {
    const sw = byName("SW1").id;
    const h1 = byName("PC1").id;
    const col = byName("COLLECTOR").id;
    const errors = S().runCliScript(sw, [
      "configure terminal",
      "sflow enable",
      "sflow collector 192.168.200.16 6343",
      "sflow polling-interval 5",
      "interface Ethernet 0",
      "sflow sampling-rate 256",
      "exit",
      "end",
    ]);
    expect(errors).toEqual([]);
    S().execCommand(sw, "sudo tcpdump -i any -nn port 6343");

    S().startTraffic({ srcDeviceId: h1, dstIp: "192.168.100.12", protocol: "udp", srcPort: 40000, dstPort: 5001, size: 100, count: 3000, intervalMs: 0, continuous: false });
    for (let s = 0; s < 12; s++) {
      vi.advanceTimersByTime(1000);
      S().sflowTick(); // the page drives this every second
    }
    expect(S().traffic?.sent).toBe(3000);
    const rt = peekSflowRuntime(S().network.devices[sw])!;
    expect(rt.stats.sampledPortPackets).toBeGreaterThanOrEqual(3000);
    expect(rt.stats.flowSamples).toBeGreaterThan(0);

    const c = peekCollector(S().network.devices[col])!;
    expect(c.datagrams).toBeGreaterThan(0);
    expect(c.flowSamples).toBe(rt.stats.flowSamples);
    expect(c.counterSamples).toBeGreaterThan(0);
    const sflowLines = term(sw).filter((t) => /sFlowv5/.test(t));
    expect(sflowLines.length).toBeGreaterThan(0);
    expect(sflowLines[0]).toMatch(/ eth0  Out IP 192\.168\.200\.204\.\d+ > 192\.168\.200\.16\.6343: sFlowv5, IPv4 agent 192\.168\.200\.204, agent-id 100000, length \d+$/);
  });
});
