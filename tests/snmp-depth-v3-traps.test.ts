/**
 * SNMP depth on the "snmp" lab: SNMPv1 traps (trapsink), SNMPv3 USM requests
 * (noAuthNoPriv / authNoPriv HMAC-MD5/SHA / authPriv AES) from the net-snmp
 * client tools, SNMPv3 traps (trapsess / snmp_linktrapd v3) received by snmptrapd,
 * Scapy decode, and `config feature state snmp disabled`.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { nodePacketEngine } from "./packet-engine-node";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes } from "../lib/sflow/wire";
import { peekAgent } from "../lib/protocols/snmp-config";
import { localizedKey } from "../lib/protocols/snmp-usm";
import { md5, sha1 } from "../lib/protocols/snmp-crypto";
import { l4Payload } from "../lib/control/packet";
import { decodeMessage, messageVersion } from "../lib/protocols/snmp-ber";

const isV1 = (b: Uint8Array) => messageVersion(b) === 0 && decodeMessage(b).pdu.type === 0xa4;

const nms = () => byName("NMS").id;
const run = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
let inBash = new Set<string>();
const bash = (dev: string, cmd: string) => {
  if (!inBash.has(dev)) S().execCommand(byName(dev).id, "exit");
  inBash.add(dev);
  return run(dev, cmd);
};
const trapLog = () => out(S().execCommand(nms(), "snmptrapd -l"));

beforeEach(() => {
  inBash = new Set();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetAll();
  S().loadFeatureLab("snmp");
  advance(3000);
});
afterEach(() => vi.useRealTimers());

describe("USM key localization (RFC 3414 A.3 test vectors)", () => {
  it("maplesyrup + engine 000000000000000000000002", () => {
    const eid = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
    const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(localizedKey("MD5", "maplesyrup", eid))).toBe("526f5eed9fcce26f8964c2930787d82b");
    expect(hex(localizedKey("SHA", "maplesyrup", eid))).toBe("6695febc9288e36282235fc7151f128497b38f3f");
    expect(md5.length + sha1.length).toBeGreaterThan(0);
  });
});

describe("SNMPv1 traps (SNMP_TRAP_CONFIG v1TrapDest → trapsink)", () => {
  it("config snmptrap modify 1 → coldStart arrives as an SNMPv1 Trap-PDU in snmptrapd's v1 format", () => {
    bash("S1", "sudo config snmptrap modify 1 192.168.100.250 -c v1comm");
    advance(500);
    const log = trapLog();
    expect(log).toMatch(/\[192\.168\.100\.1\] \(via UDP: \[192\.168\.100\.1\]:\d+->\[192\.168\.100\.250\]:162\) TRAP, SNMP v1, community v1comm\n\t.*(netSnmpAgentOIDs\.10|1\.3\.6\.1\.4\.1\.8072\.3\.2\.10) Cold Start Trap \(0\) Uptime: \d+:\d\d:\d\d\.\d\d/);
    // the restart also sent nsNotifyShutdown to the OLD sinks (v2c) — v1 got only the new coldStart
    const rx = S().captures.filter((c) => c.deviceId === nms() && c.dir === "rx" && c.frame.udp?.dstPort === 162).map((c) => l4Payload(c.frame)!);
    expect(rx.some(isV1)).toBe(true); // version INTEGER 0, Trap-PDU [4]
  });
});

describe("SNMPv3 requests (USM)", () => {
  beforeEach(() => {
    bash("S1", "sudo config snmp user add nmsro noAuthNoPriv RO");
    bash("S1", "sudo config snmp user add authmd5 AuthNoPriv RO MD5 md5secret1");
    bash("S1", "sudo config snmp user add privsha Priv RW SHA shasecret1 AES aessecret1");
    advance(200);
  });

  it("show snmp user / Click validation messages", () => {
    expect(bash("S1", "sudo config snmp user add bad AuthNoPriv RO")).toBe("User auth type is missing.  Must be MD5, SHA, or HMAC-SHA-2");
    expect(bash("S1", "sudo config snmp user add nmsro noAuthNoPriv RO")).toBe("SNMP user nmsro is already configured");
    expect(bash("S1", "show runningconfiguration snmp user")).toMatch(/privsha\s+RW\s+Priv\s+SHA\s+shasecret1\s+AES\s+aessecret1/);
  });

  it("noAuthNoPriv, authNoPriv (MD5) and authPriv (SHA/AES) GETs succeed after engine discovery", () => {
    expect(run("NMS", "snmpget -v3 -u nmsro -l noAuthNoPriv 192.168.100.1 sysName.0")).toBe('SNMPv2-MIB::sysName.0 = STRING: S1');
    expect(run("NMS", "snmpget -v3 -u authmd5 -l authNoPriv -a MD5 -A md5secret1 192.168.100.1 sysName.0")).toBe('SNMPv2-MIB::sysName.0 = STRING: S1');
    expect(run("NMS", "snmpget -v3 -u privsha -l authPriv -a SHA -A shasecret1 -x AES -X aessecret1 192.168.100.1 sysName.0")).toBe('SNMPv2-MIB::sysName.0 = STRING: S1');
    const walk = run("NMS", "snmpwalk -v3 -u privsha -l authPriv -a SHA -A shasecret1 -x AES -X aessecret1 192.168.100.1 system");
    expect(walk).toContain("SNMPv2-MIB::sysLocation.0 = STRING: Lab-Row1-Rack1");
    // RW user may SET sysName; the response is encrypted on the wire.
    expect(run("NMS", "snmpset -v3 -u privsha -l authPriv -a SHA -A shasecret1 -x AES -X aessecret1 192.168.100.1 sysName.0 s core-1")).toBe('SNMPv2-MIB::sysName.0 = STRING: core-1');
    const resp = S().captures.filter((c) => c.deviceId === nms() && c.dir === "rx" && c.frame.udp?.srcPort === 161).map((c) => Array.from(l4Payload(c.frame)!));
    const last = resp[resp.length - 1];
    expect(String.fromCharCode(...last)).not.toContain("core-1"); // scoped PDU is AES-encrypted
  });

  it("USM errors: unknown user, wrong password, level too high, VACM level too low", () => {
    expect(run("NMS", "snmpget -v3 -u nobody -l noAuthNoPriv 192.168.100.1 sysName.0")).toBe("snmpget: Unknown user name");
    expect(run("NMS", "snmpget -v3 -u authmd5 -l authNoPriv -a MD5 -A wrongpass1 192.168.100.1 sysName.0")).toBe("snmpget: Authentication failure (incorrect password, community or key)");
    expect(run("NMS", "snmpget -v3 -u authmd5 -l authPriv -a MD5 -A md5secret1 -x AES -X whatever12 192.168.100.1 sysName.0")).toBe("snmpget: Unsupported security level");
    expect(run("NMS", "snmpget -v3 -u authmd5 -l noAuthNoPriv 192.168.100.1 sysName.0")).toMatch(/Error in packet\nReason: authorizationError/);
    expect(run("NMS", "snmpget -v3 -u authmd5 -l authNoPriv -a MD5 -A short 192.168.100.1 sysName.0")).toBe("Error: passphrase chosen is below the length requirements of the USM (min=8).");
    const st = peekAgent(byName("S1"))!.stats;
    expect(st.usmStatsUnknownUserNames).toBe(1);
    expect(st.usmStatsWrongDigests).toBe(1);
    expect(st.usmStatsUnknownEngineIDs).toBeGreaterThanOrEqual(4);
  });
});

describe("SNMPv3 traps (SNMP_TRAP v3 → trapsess, snmp_linktrapd v3)", () => {
  beforeEach(() => {
    bash("S1", "sudo config snmp user add trapuser Priv RO SHA trapauth1 AES trappriv1");
    S().runCliScript(byName("S1").id, ["configure terminal", "snmp-server host 192.168.100.250 port 1162 user trapuser", "end"]);
    run("NMS", "snmptrapd stop");
    run("NMS", "snmptrapd -p 1162");
    run("NMS", "snmptrapd clear");
  });

  it("without the USM user snmptrapd drops them; with createUser it logs coldStart and linkDown", () => {
    advance(3000);
    expect(trapLog()).toContain("no notifications");
    run("NMS", "snmptrapd createUser trapuser SHA trapauth1 AES trappriv1");
    run("S1", "sudo config snmp location add Lab-Row9"); // restart → coldStart to the v3 sink
    advance(300);
    S().runCliScript(byName("S1").id, ["configure terminal", "interface Ethernet 0", "shutdown", "end"]);
    advance(300);
    const log = trapLog();
    expect(log).toContain("SNMPv2-MIB::snmpTrapOID.0 = OID: SNMPv2-MIB::coldStart");
    expect(log).toMatch(/SNMPv2-MIB::snmpTrapOID\.0 = OID: IF-MIB::linkDown\tIF-MIB::ifIndex\.1 = INTEGER: 1/);
  });
});

describe("feature snmp disabled", () => {
  it("snmpd stops (nsNotifyShutdown), requests time out; re-enable → coldStart and answers again", () => {
    bash("S1", "sudo config feature state snmp disabled");
    advance(200);
    expect(peekAgent(byName("S1"))).toBeUndefined();
    expect(trapLog()).toContain("NET-SNMP-AGENT-MIB::nsNotifyShutdown");
    expect(run("NMS", "snmpget -v2c -c public -r 0 192.168.100.1 sysName.0")).toBe("Timeout: No Response from 192.168.100.1.");
    run("S1", "sudo config feature state snmp enabled");
    advance(200);
    expect(run("NMS", "snmpget -v2c -c public 192.168.100.1 sysName.0")).toBe("SNMPv2-MIB::sysName.0 = STRING: S1");
    expect(trapLog().match(/SNMPv2-MIB::coldStart/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Scapy decodes SNMPv1 traps and SNMPv3 messages", () => {
  let engine: ScapyEngine;
  beforeAll(async () => {
    engine = await nodePacketEngine();
  }, 120_000);

  it("SNMPtrap (v1) and SNMPv3 GET/Report", async () => {
    bash("S1", "sudo config snmptrap modify 1 192.168.100.250");
    advance(500);
    const v1 = S().captures.filter((c) => c.deviceId === nms() && c.dir === "rx" && c.frame.udp?.dstPort === 162).map((c) => c.frame).find((f) => isV1(l4Payload(f)!));
    const t = await engine.dissect(frameToBytes(v1!));
    expect(t.layers.map((l) => l.proto)).toEqual(["Ether", "IP", "UDP", "SNMP"]);
    expect(t.show).toMatch(/version\s+=\s+'v1' 0x0/);
    expect(t.show).toContain("SNMPtrapv1");
    expect(t.show).toMatch(/generic_trap\s*=\s*'cold_start' 0x0|generic_trap\s*=\s*0x0/);
    expect(t.show).toContain("192.168.100.1");

    bash("S1", "sudo config snmp user add nmsro noAuthNoPriv RO");
    advance(200);
    run("NMS", "snmpget -v3 -u nmsro -l noAuthNoPriv 192.168.100.1 sysName.0");
    const v3 = S().captures.filter((c) => c.deviceId === nms() && c.dir === "tx" && c.frame.udp?.dstPort === 161).map((c) => c.frame);
    const d = await engine.dissect(frameToBytes(v3[v3.length - 1]));
    expect(d.layers.map((l) => l.proto)).toContain("UDP");
    // Scapy has no SNMPv3 dissector: it leaves the BER as Raw/SNMP-less payload; check the framing bytes instead.
    const raw = Array.from(l4Payload(v3[v3.length - 1])!);
    expect(raw.slice(0, 1)).toEqual([0x30]);
    expect(raw.slice(2, 5)).toEqual([0x02, 0x01, 0x03]); // msgVersion 3
  }, 60_000);
});
