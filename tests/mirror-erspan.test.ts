/**
 * ERSPAN on the l2-protect lab: SW1 mirrors the Attacker's port (Ethernet3, rx)
 * to the Collector 10.10.10.2 behind the routed port Ethernet6. The copies are
 * IPv4/GRE (proto 47, gre_type) / ERSPAN type II / original frame, with TOS =
 * dscp << 2 and the session TTL (mirrororch.cpp:992-1036) — dissected by Scapy.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes, inetChecksum } from "../lib/sflow/wire";
import { nodePacketEngine } from "./packet-engine-node";
import { resetAll } from "./helpers";
import { S, byName, out } from "./control-helpers";

let engine: ScapyEngine;
beforeAll(async () => {
  engine = await nodePacketEngine();
}, 120_000);

const id = (n: string) => byName(n).id;
const sh = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"]);
const greToCollector = () => S().captures.filter((c) => c.deviceId === id("Collector") && c.dir === "rx" && c.frame.ipv4?.protocolNumber === 47);

type D = { layers: { proto: string; fields: { name: string; value: string }[] }[] };
const field = (d: D, proto: string, name: string, nth = 0) => d.layers.filter((l) => l.proto === proto)[nth]?.fields.find((f) => f.name === name)?.value;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("l2-protect");
});
afterEach(() => vi.useRealTimers());

describe("ERSPAN", () => {
  it("KLISH session: GRE 0x88be / ERSPAN II / inner ARP, TOS from dscp, TTL, sequence numbers", async () => {
    klish("SW1", ["mirror-session ER1", "destination erspan dst-ip 10.10.10.2 src-ip 10.10.10.1 dscp 10 ttl 64 gre 0x88be source Ethernet3 direction rx"]);
    expect(sh("SW1", "show mirror-session ER1")).toMatch(/ER1\s+active\s+10\.10\.10\.1\s+10\.10\.10\.2\s+0x88be/);
    sh("Attacker", "arping -b -c 2 192.168.10.1");
    const gre = greToCollector();
    expect(gre.length).toBe(2);
    const bytes = frameToBytes(gre[0].frame);
    const d = (await engine.dissect(bytes)) as D;
    expect(d.layers.map((l) => l.proto).slice(0, 5)).toEqual(["Ether", "IP", "GRE", "ERSPAN_II", "Ether"]);
    expect(d.layers.some((l) => l.proto === "ARP")).toBe(true);
    expect(field(d, "IP", "src")).toBe("10.10.10.1");
    expect(field(d, "IP", "dst")).toBe("10.10.10.2");
    expect(field(d, "IP", "tos")).toBe("0x28"); // dscp 10 << 2
    expect(field(d, "IP", "ttl")).toBe("64");
    expect(field(d, "IP", "proto")).toBe("47");
    expect(field(d, "GRE", "proto")).toBe("0x88be");
    expect(Number(field(d, "IP", "len"))).toBe(20 + 8 + 8 + 60); // IP + GRE(seq) + ERSPAN II + 60-byte ARP frame
    expect(field(d, "GRE", "seqnum_present")).toBe("1");
    expect(field(d, "GRE", "sequence_number")).toBe("0x1");
    expect(field(d, "ERSPAN_II", "ver")).toBe("1");
    expect(field(d, "Ether", "dst", 1)).toBe("ff:ff:ff:ff:ff:ff");
    expect(field(d, "ARP", "psrc")).toBe("192.168.10.66");
    expect(inetChecksum(Array.from(bytes.slice(14, 34)))).toBe(0); // outer IPv4 header checksum
    const d2 = (await engine.dissect(frameToBytes(gre[1].frame))) as D;
    expect(field(d2, "GRE", "sequence_number")).toBe("0x2");
  });

  it("Click erspan add uses the orchagent defaults when no gre_type is given; tcpdump decodes GRE/ERSPAN", () => {
    S().execCommand(id("SW1"), "exit");
    sh("SW1", "sudo config mirror_session erspan add E2 10.10.10.1 10.10.10.2 8 255 0x88be 0 Ethernet3 rx");
    const o = sh("SW1", "show mirror_session E2");
    expect(o).toContain("E2      active    10.10.10.1  10.10.10.2  35006");
    expect(o).toMatch(/Ethernet6\s+Ethernet3\s+rx/); // monitor port = route to 10.10.10.2
    S().execCommand(id("Collector"), "tcpdump -i eth0 -nn");
    sh("Attacker", "arping -b -c 1 192.168.10.1");
    S().stopLiveCapture(id("Collector"));
    const lines = (S().terminals[id("Collector")] ?? []).map((l) => l.text).join("\n");
    expect(lines).toMatch(/10\.10\.10\.1 > 10\.10\.10\.2: GREv0, seq 1, proto ERSPAN \(0x88be\), length \d+: ERSPAN v2, session 0, vlan 0/);
    expect(lines).toMatch(/> ff:ff:ff:ff:ff:ff, ethertype ARP \(0x0806\), length 60: Request who-has 192\.168\.10\.1 tell 192\.168\.10\.66/);
  });
});
