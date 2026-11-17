import { describe, it, expect } from "vitest";
import { createDevice, rebuildConnectedRoutes } from "../lib/models/factory";
import { NetworkState, linkInterfaces } from "../lib/models/topology";
import { Simulation } from "../lib/engine";
import { Device } from "../lib/models/device";
import { addVlan, addMember } from "../lib/models/vlan-ops";
import { sflowState, sflowSessions, sflowAgentTick, sflowIfIndex, selectAgentAddress, peekSflowRuntime } from "../lib/sflow/agent";
import { startCollector, peekCollector } from "../lib/sflow/collector";
import { decodeDatagram, decodeEthernetHeader, encodeDatagram, encodeSample, CounterSample } from "../lib/sflow/datagram";
import { frameToBytes, inetChecksum } from "../lib/sflow/wire";
import { sendTrafficPacket, peekTrafficSink, TrafficSpec } from "../lib/protocols/traffic";
import { resetAll } from "./helpers";

/**
 * H1 ─ Ethernet0 ┐            ┌ eth0 (mgmt 192.168.200.204) ─ COLLECTOR 192.168.200.16
 *                SW (VLAN 100)
 * H2 ─ Ethernet1 ┘
 * Mirrors the live SONiC-VS setup used to capture the reference behaviour.
 */
function lab(): { state: NetworkState; h1: Device; h2: Device; sw: Device; col: Device } {
  resetAll();
  const h1 = createDevice({ id: "h1", type: "pc", name: "H1", x: 0, y: 0 });
  const h2 = createDevice({ id: "h2", type: "pc", name: "H2", x: 0, y: 0 });
  const col = createDevice({ id: "col", type: "server", name: "COLLECTOR", x: 0, y: 0 });
  const sw = createDevice({ id: "sw", type: "switch", name: "SW", x: 0, y: 0, ports: 2 });
  for (const p of sw.interfaces) if (!p.management) p.speed = 25000;
  sw.interfaces.find((i) => i.management)!.ipv4 = [{ address: "192.168.200.204", prefix: 24 }];
  h1.interfaces[0].ipv4 = [{ address: "192.168.100.11", prefix: 24 }];
  h2.interfaces[0].ipv4 = [{ address: "192.168.100.12", prefix: 24 }];
  col.interfaces[0].ipv4 = [{ address: "192.168.200.16", prefix: 24 }];
  [h1, h2, col].forEach(rebuildConnectedRoutes);
  addVlan(sw, 100);
  addMember(sw, 100, "Ethernet0", false);
  addMember(sw, 100, "Ethernet1", false);
  const state: NetworkState = { devices: { h1, h2, sw, col }, connections: [] };
  linkInterfaces(state, { deviceId: "h1", interfaceId: "h1-if0" }, { deviceId: "sw", interfaceId: "sw-if0" });
  linkInterfaces(state, { deviceId: "h2", interfaceId: "h2-if0" }, { deviceId: "sw", interfaceId: "sw-if1" });
  linkInterfaces(state, { deviceId: "col", interfaceId: "col-if0" }, { deviceId: "sw", interfaceId: "sw-mgmt" });
  startCollector(col, 6343);
  return { state, h1, h2, sw, col };
}

const udp = (count = 1): TrafficSpec => ({
  srcDeviceId: "h1",
  dstIp: "192.168.100.12",
  protocol: "udp",
  srcPort: 40000,
  dstPort: 5001,
  size: 100,
  count,
  intervalMs: 0,
  continuous: false,
});

describe("sFlow v5 wire format", () => {
  it("round-trips flow and counter samples through encode/decode", () => {
    const counter: CounterSample = {
      kind: "counter",
      seq: 104,
      dsClass: 0,
      dsIndex: 48,
      portName: "Ethernet47",
      otherRecords: [],
      generic: {
        ifIndex: 48, ifType: 6, ifSpeed: 25_000_000_000, ifDirection: 0, ifStatus: 0,
        inOctets: 5_000_000_000, inUcast: 1, inMulticast: 2, inBroadcast: 3, inDiscards: 0, inErrors: 0, inUnknownProtos: 0,
        outOctets: 7, outUcast: 4, outMulticast: 5, outBroadcast: 6, outDiscards: 0, outErrors: 0, promiscuous: 0,
      },
    };
    const enc = encodeSample(counter);
    // Live capture: "expanded counter sample (4), length 136 … records 2" (+8 tag/length)
    expect(enc.length).toBe(8 + 136);
    const d = decodeDatagram(encodeDatagram({ version: 5, agentIp: "192.168.200.204", subAgentId: 100000, seq: 831, uptimeMs: 520336 }, [enc]));
    expect(d).toMatchObject({ version: 5, agentIp: "192.168.200.204", subAgentId: 100000, seq: 831, uptimeMs: 520336 });
    expect(d.samples[0]).toEqual(counter);
  });

  it("serializes frames with a valid IPv4 header checksum", () => {
    const { state, h1 } = lab();
    const sim = new Simulation(state);
    sendTrafficPacket(sim, h1, udp(), 1);
    const frame = sim.captures.find((c) => c.frame.udp)!.frame;
    const bytes = Array.from(frameToBytes(frame));
    expect(bytes.length).toBe(14 + 20 + 8 + 100);
    expect(inetChecksum(bytes.slice(14, 34))).toBe(0);
    const h = decodeEthernetHeader(Uint8Array.from(bytes));
    expect(h).toMatchObject({ srcIp: "192.168.100.11", dstIp: "192.168.100.12", protocol: "UDP", srcPort: 40000, dstPort: 5001 });
  });
});

describe("sflowmgrd session model", () => {
  it("global enable auto-enables every port at port speed; global sample_rate is not applied", () => {
    const { sw } = lab();
    const st = sflowState(sw);
    st.enabled = true;
    st.sampleRate = 256;
    expect(sflowSessions(sw).map((s) => [s.port, s.adminState, s.sampleRate])).toEqual([
      ["Ethernet0", "up", 25000],
      ["Ethernet1", "up", 25000],
    ]);
    st.interfaces.Ethernet0 = { sampleRate: 256 };
    expect(sflowSessions(sw)[0]).toMatchObject({ port: "Ethernet0", sampleRate: 256, rateSource: "configured" });
    st.enabled = false;
    expect(sflowSessions(sw)).toEqual([]);
  });

  it("ifIndex follows port_util (EthernetN→N+1, VlanN→N+2000, ethN→N+10000)", () => {
    expect(sflowIfIndex("Ethernet0")).toBe(1);
    expect(sflowIfIndex("Ethernet47")).toBe(48);
    expect(sflowIfIndex("Vlan100")).toBe(2100);
    expect(sflowIfIndex("eth0")).toBe(10000);
  });

  it("agent address: eth0 RFC1918 by default; agent-id pins it; missing address suppresses", () => {
    const { sw } = lab();
    expect(selectAgentAddress(sw)).toEqual({ ip: "192.168.200.204", iface: "eth0" });
    sflowState(sw).agentId = "Ethernet0";
    expect(selectAgentAddress(sw).ip).toBeUndefined();
    expect(selectAgentAddress(sw).reason).toMatch(/no IPv4 address/);
  });
});

describe("end-to-end: traffic → switch → sFlow agent → collector", () => {
  it("generated UDP traverses Ethernet0 → Ethernet1 and reaches H2", () => {
    const { state, h1 } = lab();
    const sim = new Simulation(state);
    for (let i = 1; i <= 20; i++) expect(sendTrafficPacket(sim, h1, udp(), i).ok).toBe(true);
    expect(peekTrafficSink(state.devices.h2)?.udp.packets).toBe(20);
    const swRx = sim.captures.filter((c) => c.deviceId === "sw" && c.interfaceId === "sw-if0" && c.dir === "rx" && c.frame.udp);
    const swTx = sim.captures.filter((c) => c.deviceId === "sw" && c.interfaceId === "sw-if1" && c.dir === "tx" && c.frame.udp);
    expect(swRx.length).toBe(20);
    expect(swTx.length).toBe(20);
  });

  it("TCP SYN to a closed port is answered with RST,ACK through the switch", () => {
    const { state, h1 } = lab();
    const sim = new Simulation(state);
    sendTrafficPacket(sim, h1, { ...udp(), protocol: "tcp", dstPort: 80 }, 1);
    const rst = sim.captures.find((c) => c.deviceId === "h1" && c.dir === "rx" && c.frame.tcp?.flags.includes("RST"));
    expect(rst?.frame.tcp).toMatchObject({ srcPort: 80, dstPort: 40000, ack: 1001 });
  });

  it("FLOW samples at 1-in-N on the ingress port reach the collector, decoded", () => {
    const { state, h1, sw } = lab();
    const st = sflowState(sw);
    st.enabled = true;
    st.collectors.push({ name: "192.168.200.16_6343_default", ip: "192.168.200.16", port: 6343, vrf: "default" });
    st.interfaces.Ethernet0 = { sampleRate: 256 };
    // One Simulation per 200 packets, as the store's traffic generator batches them.
    for (let b = 0; b < 2560; b += 200) {
      const batch = new Simulation(state, { wallBase: 1_000_000 });
      for (let i = b + 1; i <= Math.min(b + 200, 2560); i++) sendTrafficPacket(batch, h1, udp(), i);
    }
    const sim = new Simulation(state, { wallBase: 1_000_000 });
    const rt = peekSflowRuntime(sw)!;
    // Sampling is random 1/256 (tc sample): ~10 expected from 2560 frames.
    expect(rt.stats.flowSamples).toBeGreaterThan(2);
    expect(rt.stats.flowSamples).toBeLessThan(30);

    const r = sflowAgentTick(sim, sw, 1_001_000);
    expect(r.errors).toEqual([]);
    expect(r.datagrams).toBeGreaterThan(0);
    const col = peekCollector(state.devices.col)!;
    expect(col.flowSamples).toBe(rt.stats.flowSamples);

    // uptime is ms since the agent started (first sampled frame), not an epoch value.
    expect(decodeDatagram(col.recent[0].bytes).uptimeMs).toBeLessThan(5000);
    const flows = col.recent.flatMap((d) => decodeDatagram(d.bytes).samples).filter((s) => s.kind === "flow");
    const f = flows[0];
    expect(f).toMatchObject({ dsIndex: 1, input: 1, output: 0, samplingRate: 256, drops: 0 });
    if (f.kind !== "flow") throw new Error("unreachable");
    expect(f.samplePool).toBe(f.seq * 256);
    expect(f.header).toMatchObject({ protocol: 1, stripped: 4, frameLength: 14 + 20 + 8 + 100 + 4 });
    expect(decodeEthernetHeader(f.header!.bytes)).toMatchObject({ srcIp: "192.168.100.11", dstIp: "192.168.100.12", srcPort: 40000, dstPort: 5001 });
    // The datagram went out the management port (as on the live switch).
    expect(sim.captures.some((c) => c.deviceId === "sw" && c.interfaceId === "sw-mgmt" && c.dir === "tx" && c.frame.sflow)).toBe(true);
  });

  it("COUNTER samples arrive every polling interval with the port counters", () => {
    const { state, h1, sw } = lab();
    const st = sflowState(sw);
    st.enabled = true;
    st.pollingInterval = 5;
    st.collectors.push({ name: "c", ip: "192.168.200.16", port: 6343, vrf: "default" });
    const sim = new Simulation(state, { wallBase: 0 });
    for (let i = 1; i <= 20; i++) sendTrafficPacket(sim, h1, udp(), i);
    let t = 10_000;
    for (let s = 0; s < 12; s++, t += 1000) sflowAgentTick(sim, sw, t); // 12 s of agent time
    const col = peekCollector(state.devices.col)!;
    const counters = col.recent.flatMap((d) => decodeDatagram(d.bytes).samples).filter((s) => s.kind === "counter");
    // two ports × at least two polls in 12 s at a 5 s interval
    expect(counters.length).toBeGreaterThanOrEqual(4);
    const e0 = counters.filter((c) => c.kind === "counter" && c.portName === "Ethernet0").pop();
    if (e0?.kind !== "counter") throw new Error("no Ethernet0 counter sample");
    expect(e0.generic).toMatchObject({ ifIndex: 1, ifType: 6, ifSpeed: 25_000_000_000, ifStatus: 3 });
    expect(e0.generic!.inUcast).toBeGreaterThanOrEqual(20);
  });

  it("diagnoses why nothing reaches the collector", () => {
    const { state, sw, col } = lab();
    const st = sflowState(sw);
    st.enabled = true;
    st.pollingInterval = 5;
    const sim = new Simulation(state);
    let errs: string[] = [];
    for (let t = 0; t <= 10_000; t += 1000) errs = errs.concat(sflowAgentTick(sim, sw, t).errors);
    expect(errs.join("\n")).toMatch(/no sFlow collector configured/);

    st.collectors.push({ name: "c", ip: "10.9.9.9", port: 6343, vrf: "default" });
    errs = [];
    for (let t = 11_000; t <= 22_000; t += 1000) errs = errs.concat(sflowAgentTick(sim, sw, t).errors);
    expect(errs.join("\n")).toMatch(/no route to collector 10\.9\.9\.9/);

    // Collector process not running: datagrams arrive but nobody listens.
    st.collectors = [{ name: "c", ip: "192.168.200.16", port: 6343, vrf: "default" }];
    peekCollector(col)!.listening = false;
    for (let t = 23_000; t <= 34_000; t += 1000) sflowAgentTick(sim, sw, t);
    expect(peekCollector(col)!.datagrams).toBe(0);
    expect(sim.events.some((e) => e.type === "FRAME_DROPPED" && /no UDP listener on port 6343/.test(e.message))).toBe(true);
  });
});
