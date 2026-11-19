/**
 * The IGMP and PIM packets on the simulated wire are real bytes: Scapy
 * (scapy.contrib.igmp / scapy.contrib.pim) dissects the IGMPv2 report / leave /
 * query, the PIM Hello, Join/Prune and Register exactly; checksums verify.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes, inetChecksum } from "../lib/sflow/wire";
import { nodePacketEngine } from "./packet-engine-node";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { CaptureRecord } from "../lib/engine";
import { l3Payload } from "../lib/protocols/mcast-wire";
import { formatPacket } from "../lib/commands/tcpdump";

const G = "239.1.1.1";
const id = (dev: string) => byName(dev).id;
const host = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const caps = (dev: string, dir: "rx" | "tx", pred: (c: CaptureRecord) => boolean) => S().captures.filter((c) => c.deviceId === id(dev) && c.dir === dir && pred(c));
const proto = (n: number) => (c: CaptureRecord) => c.frame.ipv4?.protocolNumber === n;
const pimType = (t: number) => (c: CaptureRecord) => proto(103)(c) && (l3Payload(c.frame)![0] & 0x0f) === t;

let engine: ScapyEngine;
beforeAll(async () => {
  engine = await nodePacketEngine();
}, 120_000);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("multicast");
  advance(2000);
});
afterEach(() => vi.useRealTimers());

describe("IGMP wire format (Scapy scapy.contrib.igmp)", () => {
  it("IGMPv2 report, leave and query", async () => {
    host("H3", `mcast join ${G}`);
    host("H3", `mcast leave ${G}`);
    const [rep, leave] = caps("H3", "tx", proto(2)).slice(-2);
    for (const c of [rep, leave]) expect(inetChecksum(Array.from(l3Payload(c.frame)!))).toBe(0);
    const r = await engine.dissect(frameToBytes(rep.frame));
    expect(r.layers.map((l) => l.proto)).toEqual(["Ether", "IP", "IGMPv2_MR", "Padding"]); // min-frame padding
    expect(r.show).toMatch(/type\s+=\s+Version 2 - Membership Report/);
    expect(r.show).toMatch(/gaddr\s+=\s+239\.1\.1\.1/);
    expect(r.show).toMatch(/ttl\s+=\s+1\n/);
    expect(r.show).toMatch(/proto\s+=\s+2\n/);
    expect(r.show).toMatch(/tos\s+=\s+0xc0/);
    expect(r.show).toMatch(/option\s+=\s+router_alert/);
    const l = await engine.dissect(frameToBytes(leave.frame));
    expect(l.show).toMatch(/type\s+=\s+Leave Group/);
    expect(l.show).toMatch(/dst\s+=\s+224\.0\.0\.2/);
    const q = caps("H5", "rx", proto(2))[0];
    const d = await engine.dissect(frameToBytes(q.frame));
    expect(d.show).toMatch(/type\s+=\s+Group Membership Query/);
    expect(d.show).toContain("IGMPv1/v2 Membership Query");
    expect(d.show).toMatch(/mrcode\s+=\s+100/);
  });
});

describe("PIM wire format (Scapy scapy.contrib.pim)", () => {
  it("Hello: holdtime 105, LAN prune delay 500/2500, DR priority 1, generation id; TTL 1 to 224.0.0.13", async () => {
    const h = caps("S3", "tx", (c) => pimType(0)(c) && c.frame.ipv4!.srcIp === "10.0.13.2")[0];
    expect(h.frame.ipv4!.dstIp).toBe("224.0.0.13");
    expect(inetChecksum(Array.from(l3Payload(h.frame)!))).toBe(0);
    expect(formatPacket(h.frame).join("")).toMatch(/^IP 10\.0\.13\.2 > 224\.0\.0\.13: PIMv2, Hello, length 34$/);
    const d = await engine.dissect(frameToBytes(h.frame));
    expect(d.layers.map((l) => l.proto).slice(0, 4)).toEqual(["Ether", "IP", "PIMv2Hdr", "PIMv2Hello"]);
    expect(d.show).toMatch(/holdtime\s+=\s+105/);
    expect(d.show).toMatch(/propagation_delay\s*=\s*500/);
    expect(d.show).toMatch(/override_interval\s*=\s*2500/);
    expect(d.show).toMatch(/dr_priority\s*=\s*1\n/);
    expect(d.show).toMatch(/generation_id\s*=\s*\d+/);
  });

  it("(*,G) Join toward the RP and (S,G,rpt) prune / (S,G) join", async () => {
    host("H3", `mcast join ${G}`);
    host("H1", `mcast send ${G} -c 3 -t 16`);
    const jps = caps("S3", "tx", pimType(3));
    expect(jps.length).toBeGreaterThanOrEqual(3);
    for (const c of jps) expect(inetChecksum(Array.from(l3Payload(c.frame)!))).toBe(0);
    const star = await engine.dissect(frameToBytes(jps[0].frame));
    expect(star.layers.map((l) => l.proto)).toContain("PIMv2JoinPrune");
    expect(star.show).toMatch(/up_neighbor_ip\s*=\s*10\.0\.23\.1/);
    expect(star.show).toMatch(/holdtime\s*=\s*210/);
    expect(star.show).toMatch(/gaddr\s*=\s*239\.1\.1\.1/);
    expect(star.show).toMatch(/sparse\s*=\s*1\n\s*.*wildcard\s*=\s*1\n\s*.*rpt\s*=\s*1\n\s*.*mask_len\s*=\s*32\n\s*.*src_ip\s*=\s*2\.2\.2\.2/);
    // the (S,G) SPT join toward S1 and the (S,G,rpt) prune toward the RP
    const all = await Promise.all(jps.map((c) => engine.dissect(frameToBytes(c.frame))));
    expect(all.some((d) => /up_neighbor_ip\s*=\s*10\.0\.13\.1/.test(d.show) && /src_ip\s*=\s*192\.168\.1\.10/.test(d.show))).toBe(true);
    expect(all.some((d) => /PIMv2 Prune/.test(d.show) && /rpt\s*=\s*1\n\s*.*mask_len\s*=\s*32\n\s*.*src_ip\s*=\s*192\.168\.1\.10/.test(d.show))).toBe(true);
  });

  it("Register: unicast to the RP, PIM type 1, checksum over 8 bytes, inner packet intact; Register-Stop back", async () => {
    host("H3", `mcast join ${G}`);
    host("H1", `mcast send ${G} -c 2 -t 16`);
    const reg = caps("S1", "tx", pimType(1))[0];
    expect(reg.frame.ipv4!.srcIp).toBe("10.0.12.1");
    expect(reg.frame.ipv4!.dstIp).toBe("2.2.2.2");
    expect(reg.frame.rawL3![8]).toBe(64);
    const pim = Array.from(l3Payload(reg.frame)!);
    expect(inetChecksum(pim.slice(0, 8))).toBe(0);
    expect(formatPacket(reg.frame).join("")).toMatch(/PIMv2, Register, length \d+/);
    const d = await engine.dissect(frameToBytes(reg.frame));
    expect(d.layers.map((l) => l.proto).slice(0, 3)).toEqual(["Ether", "IP", "PIMv2Hdr"]);
    expect(d.show).toMatch(/type\s*=\s*Register/);
    const inner = await engine.dissect(Uint8Array.from(pim.slice(8)), "IP");
    expect(inner.layers.map((l) => l.proto).slice(0, 2)).toEqual(["IP", "UDP"]);
    expect(inner.show).toMatch(/src\s*=\s*192\.168\.1\.10/);
    expect(inner.show).toMatch(/dst\s*=\s*239\.1\.1\.1/);
    expect(inner.show).toMatch(/ttl\s*=\s*16/);
    const stop = caps("S1", "rx", pimType(2))[0];
    expect(stop.frame.ipv4!.srcIp).toBe("2.2.2.2");
    expect(inetChecksum(Array.from(l3Payload(stop.frame)!))).toBe(0);
    expect(formatPacket(stop.frame).join("")).toMatch(/PIMv2, Register Stop, length 18/);
  });
});
