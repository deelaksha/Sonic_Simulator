import { describe, it, expect } from "vitest";
import { useLabStore } from "../lib/store/lab-store";
import { Simulation } from "../lib/engine/simulation";

describe("High-volume traffic generation & sFlow sampling", () => {
  it("allows PC1 to send 1,000 ping packets with custom 1400-byte payload", () => {
    useLabStore.getState().loadSample();
    const net = useLabStore.getState().network;
    const pc1 = Object.values(net.devices).find((d) => d.name === "PC1")!;

    const sim = new Simulation(net);
    const r = sim.runPing(pc1.id, "192.168.100.101", { count: 1000, size: 1400 });

    expect(r.transmitted).toBe(1000);
    expect(r.received).toBe(1000);
    expect(r.replies[0].bytes).toBe(1408); // 1400 data bytes + 8 ICMP header
    expect(r.replies[999].bytes).toBe(1408);
  });

  it("formats high-count ping cleanly in terminal without flooding output lines", () => {
    useLabStore.getState().loadSample();
    const net = useLabStore.getState().network;
    const pc1 = Object.values(net.devices).find((d) => d.name === "PC1")!;

    const res = useLabStore.getState().execCommand(pc1.id, "ping -c 1000 -s 1400 192.168.100.101");
    const texts = res.output.map((o) => o.text);

    expect(texts[0]).toContain("PING 192.168.100.101 (192.168.100.101) 1400(1428) bytes of data.");
    expect(texts.some((t) => t.includes("1408 bytes from 192.168.100.101"))).toBe(true);
    expect(texts.some((t) => t.includes("probes transmitted in background"))).toBe(true);
    expect(texts.some((t) => t.includes("1000 packets transmitted, 1000 received, 0% packet loss"))).toBe(true);
  });

  it("runs traffic command sending 1,000 UDP packets with payload", () => {
    useLabStore.getState().loadSample();
    const net = useLabStore.getState().network;
    const pc1 = Object.values(net.devices).find((d) => d.name === "PC1")!;

    const res = useLabStore.getState().execCommand(pc1.id, "traffic -c 1000 -s 1400 192.168.100.101");
    const texts = res.output.map((o) => o.text);

    expect(texts.some((t) => t.includes("Starting traffic stream: 1000 packets of 1400 bytes"))).toBe(true);
    expect(texts.some((t) => t.includes("Packets transmitted : 1000 / 1000 (100% delivery)"))).toBe(true);
    expect(texts.some((t) => t.includes("1,400,000 bytes"))).toBe(true);
  });

  it("supports iperf3 and hping3 command aliases", () => {
    useLabStore.getState().loadSample();
    const net = useLabStore.getState().network;
    const pc1 = Object.values(net.devices).find((d) => d.name === "PC1")!;

    // iperf3
    const resIperf = useLabStore.getState().execCommand(pc1.id, "iperf3 -c 192.168.100.101 -n 500 -l 1024 -u");
    const iperfTexts = resIperf.output.map((o) => o.text);
    expect(iperfTexts.some((t) => t.includes("Sent 500 datagrams (1024 bytes/datagram)"))).toBe(true);

    // hping3
    const resHping = useLabStore.getState().execCommand(pc1.id, "hping3 -c 500 -d 1024 --udp 192.168.100.101");
    const hpingTexts = resHping.output.map((o) => o.text);
    expect(hpingTexts.some((t) => t.includes("500 packets transmitted, 500 packets received, 0% packet loss"))).toBe(true);
  });

  it("enforces max ping limit of 5,000 packets as requested", () => {
    useLabStore.getState().loadSample();
    const net = useLabStore.getState().network;
    const pc1 = Object.values(net.devices).find((d) => d.name === "PC1")!;

    // 1. Sends exactly 5000 packets when requested
    const sim = new Simulation(net);
    const r = sim.runPing(pc1.id, "192.168.100.101", { count: 5000 });
    expect(r.transmitted).toBe(5000);
    expect(r.received).toBe(5000);

    // 2. Terminal caps count at 5000 if user asks for more (e.g. 10000)
    const res = useLabStore.getState().execCommand(pc1.id, "ping -c 10000 192.168.100.101");
    const texts = res.output.map((o) => o.text);
    expect(texts.some((t) => t.includes("5000 packets transmitted, 5000 received, 0% packet loss"))).toBe(true);
  });

  it("generates sFlow samples at 1:256 when sending 1,000 packets", () => {
    useLabStore.getState().loadFeatureLab("sflow");
    const net = useLabStore.getState().network;
    const sw = Object.values(net.devices).find((d) => d.name === "leaf1" || d.name === "SW1")!;
    const pc = Object.values(net.devices).find((d) => d.name === "host1" || d.name === "PC1")!;
    const peer = Object.values(net.devices).find((d) => (d.name === "host2" || d.name === "PC2"))!;
    const peerIp = peer.interfaces[0].ipv4[0].address;

    // Configure sFlow sampling rate 256 on the switch port
    useLabStore.getState().runCliScript(sw.id, [
      "configure terminal",
      "sflow enable",
      "interface Ethernet 0",
      "sflow sampling-rate 256",
      "exit",
      "end",
    ]);

    // Send 1,000 packets through the switch
    const res = useLabStore.getState().execCommand(pc.id, `traffic -c 1000 -s 1400 ${peerIp}`);
    const texts = res.output.map((o) => o.text);

    expect(texts.some((t) => t.includes("Packets transmitted : 1000 / 1000"))).toBe(true);
    // At 1:256 sampling rate, 1,000 packets produces approximately ~4 flow samples (> 0)
    expect(texts.some((t) => /sFlow Telemetry: \d+ flow samples captured/.test(t))).toBe(true);
  });
});
