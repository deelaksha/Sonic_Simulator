/**
 * The SNMP datagrams on the simulated wire are real BER: Scapy (scapy.layers.snmp)
 * dissects the GetRequest, the GetResponse, a GetBulk and the SNMPv2-Trap exactly.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes } from "../lib/sflow/wire";
import { nodePacketEngine } from "./packet-engine-node";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";

let engine: ScapyEngine;
beforeAll(async () => {
  engine = await nodePacketEngine();
}, 120_000);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetAll();
  S().loadFeatureLab("snmp");
  advance(3000);
});
afterEach(() => vi.useRealTimers());

const nmsId = () => byName("NMS").id;
const rx = (pred: (f: { udp?: { srcPort: number; dstPort: number } }) => boolean) =>
  S().captures.filter((c) => c.deviceId === nmsId() && pred(c.frame)).map((c) => frameToBytes(c.frame));

describe("SNMP wire format (Scapy)", () => {
  it("GetRequest / GetResponse / GetBulk / SNMPv2-Trap dissect as SNMP", async () => {
    S().execCommand(nmsId(), "snmpget -v2c -c public 192.168.100.1 sysName.0 IF-MIB::ifOperStatus.1");
    S().execCommand(nmsId(), "snmpbulkwalk -v2c -c public -Cr3 192.168.100.1 system");

    const [get] = rx((f) => f.udp?.dstPort === 161);
    const g = await engine.dissect(get);
    expect(g.layers.map((l) => l.proto)).toEqual(["Ether", "IP", "UDP", "SNMP"]);
    expect(g.show).toMatch(/version\s+=\s+'v2c' 0x1/);
    expect(g.show).toMatch(/community\s+=\s+<ASN1_STRING\[b?'public'\]>/);
    expect(g.show).toContain("SNMPget");
    expect(g.show).toContain("'.1.3.6.1.2.1.1.5.0'");
    expect(g.show).toContain("'.1.3.6.1.2.1.2.2.1.8.1'");

    const [resp] = rx((f) => f.udp?.srcPort === 161);
    const r = await engine.dissect(resp);
    expect(r.show).toContain("SNMPresponse");
    expect(r.show).toMatch(/value\s+=\s+<ASN1_STRING\[b?'S1'\]>/);
    expect(r.show).toMatch(/value\s+=\s+0x1 <ASN1_INTEGER\[1\]>/);

    const bulk = rx((f) => f.udp?.dstPort === 161)[1];
    const b = await engine.dissect(bulk);
    expect(b.show).toContain("SNMPbulk");
    expect(b.show).toMatch(/max_repetitions\s*=\s*0x3 <ASN1_INTEGER\[3\]>/);

    // linkDown trap from S1 to the NMS (UDP 162).
    S().execCommand(byName("S1").id, "exit");
    S().execCommand(byName("S1").id, "sudo config interface shutdown Ethernet0");
    advance(200);
    const traps = rx((f) => f.udp?.dstPort === 162);
    const t = await engine.dissect(traps[traps.length - 1]);
    expect(t.layers.map((l) => l.proto)).toEqual(["Ether", "IP", "UDP", "SNMP"]);
    expect(t.show).toContain("SNMPtrapv2");
    expect(t.show).toContain("'.1.3.6.1.6.3.1.1.4.1.0'");
    expect(t.show).toContain("'.1.3.6.1.6.3.1.1.5.3'");
    expect(t.show).toMatch(/ASN1_TIME_TICKS\[\d+\]/);
  }, 60_000);
});
