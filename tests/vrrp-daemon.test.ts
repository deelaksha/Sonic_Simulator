/**
 * VRRP as a running protocol (FRR vrrpd model) on the "vrrp" lab, store-level on
 * fake time: election, periodic adverts (Scapy-dissected), failover after
 * Master_Down_Interval, GARP, preemption, priority-0 fast handover, show output.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { nodePacketEngine } from "./packet-engine-node";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes, inetChecksum } from "../lib/sflow/wire";
import { formatPacket } from "../lib/commands/tcpdump";
import { ipPayload } from "../lib/control/packet";
import { runtimeOf } from "../lib/protocols/vrrp";
import { CaptureRecord } from "../lib/engine";

const VIP = "192.168.10.1";
const VMAC = "00:00:5E:00:01:0A";
const id = (dev: string) => byName(dev).id;
const rt = (dev: string) => runtimeOf(byName(dev), "Vlan10", 10);
const role = (dev: string) => rt(dev)?.state;
const vlan10 = (dev: string) => byName(dev).interfaces.find((i) => i.name === "Vlan10")!.id;

function klish(dev: string, ...lines: string[]): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return lines.map((l) => out(S().execCommand(id(dev), l))).join("\n");
}
function bash(dev: string, cmd: string): string {
  if ((S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "end");
  if ((S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}
const ping = (dev: string, ip: string) => out(S().execCommand(id(dev), `ping -c 2 ${ip}`));

/** Advance in 100 ms steps until pred() holds; returns elapsed ms (or Infinity). */
function until(pred: () => boolean, maxMs: number): number {
  for (let t = 100; t <= maxMs; t += 100) {
    advance(100);
    if (pred()) return t;
  }
  return Infinity;
}

/** VRRP advertisements a device sent out of its Vlan10 SVI (optionally after a time). */
const adverts = (dev: string, after = 0): CaptureRecord[] =>
  S().captures.filter((c) => c.deviceId === id(dev) && c.interfaceId === vlan10(dev) && c.dir === "tx" && c.frame.ipv4?.protocolNumber === 112 && c.timeMs > after);
const prio = (c: CaptureRecord) => ipPayload(c.frame)![2];

let engine: ScapyEngine;
beforeAll(async () => {
  engine = await nodePacketEngine();
}, 120_000);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("vrrp");
});
afterEach(() => vi.useRealTimers());

describe("VRRP election and advertisements", () => {
  it("both start as Backup; S1 (priority 120) becomes Master after its Master_Down_Interval (3530 ms)", () => {
    advance(100);
    expect(role("S1")).toBe("Backup");
    expect(role("S2")).toBe("Backup");
    const t = until(() => role("S1") === "Master", 5000);
    // first tick (100 ms) starts the FSM; MDI = 3 × 1000 + (256-120)×1000/256 = 3530 ms
    expect(t + 100).toBeGreaterThanOrEqual(3600);
    expect(t + 100).toBeLessThanOrEqual(3700);
    expect(role("S2")).toBe("Backup");
    expect(rt("S2")!.masterIp).toBe("192.168.10.2");
    advance(3000);
    expect(role("S2")).toBe("Backup"); // S1's adverts keep resetting S2's Master_Down_Timer
    expect(rt("S2")!.adverRx).toBeGreaterThanOrEqual(3);
  });

  it("the Master advertises every 1 s: VRRPv3 to 224.0.0.18, TTL 255, from the vMAC — Scapy dissects it", async () => {
    advance(10_000);
    const a = adverts("S1");
    expect(a.length).toBeGreaterThanOrEqual(6);
    const gaps = a.slice(1).map((c, i) => c.timeMs - a[i].timeMs);
    expect(gaps.every((g) => g === 1000)).toBe(true);
    expect(adverts("S2")).toHaveLength(0); // Backups are silent

    const f = a[a.length - 1].frame;
    expect(f.ethernet.srcMac).toBe(VMAC);
    expect(f.ethernet.dstMac).toBe("01:00:5E:00:00:12");
    expect(formatPacket(f)[0]).toBe("IP 192.168.10.2 > 224.0.0.18: VRRPv3, Advertisement, vrid 10, prio 120, intvl 100cs, length 12");
    expect(formatPacket(f, { verbose: true })[0]).toContain("length 12, addrs: 192.168.10.1");

    const bytes = frameToBytes(f);
    expect(inetChecksum(Array.from(bytes.slice(14, 34)))).toBe(0); // IPv4 header checksum
    const d = await engine.dissect(bytes);
    const field = (p: string, n: string) => d.layers.find((l) => l.proto === p)?.fields.find((x) => x.name === n)?.value;
    expect(d.layers.map((l) => l.proto).slice(0, 3)).toEqual(["Ether", "IP", "VRRPv3"]); // + Padding to 60 bytes
    expect(field("IP", "ttl")).toBe("255");
    expect(field("IP", "proto")).toMatch(/112|vrrp/);
    expect(field("VRRPv3", "version")).toBe("3");
    expect(field("VRRPv3", "vrid")).toBe("10");
    expect(field("VRRPv3", "priority")).toBe("120");
    expect(field("VRRPv3", "ipcount")).toBe("1");
    expect(field("VRRPv3", "adv")).toBe("100");
    expect(field("VRRPv3", "addrlist")).toContain("192.168.10.1");
    // Scapy computes the RFC 5798 checksum (IPv4 pseudo-header) itself: identical bytes.
    const ref = await engine.build([
      { proto: "IP", fields: { src: "192.168.10.2", dst: "224.0.0.18", ttl: 255 } },
      { proto: "VRRPv3", fields: { vrid: 10, priority: 120, adv: 100, addrlist: ["192.168.10.1"] } },
    ]);
    expect(Array.from(ref.bytes.slice(20))).toEqual(Array.from(ipPayload(f)!));
  }, 60_000);

  it("VRRPv2 (version 2): tcpdump shows authtype/interval in seconds; Scapy VRRP dissects it", async () => {
    for (const dev of ["S1", "S2"]) klish(dev, "configure terminal", "interface Vlan 10", "vrrp 10 address-family ipv4", "version 2", "end");
    advance(12_000);
    expect(role("S1")).toBe("Master");
    expect(role("S2")).toBe("Backup");
    const f = adverts("S1").at(-1)!.frame;
    expect(formatPacket(f)[0]).toBe("IP 192.168.10.2 > 224.0.0.18: VRRPv2, Advertisement, vrid 10, prio 120, authtype none, intvl 1s, length 20");
    const d = await engine.dissect(frameToBytes(f));
    const field = (n: string) => d.layers.find((l) => l.proto === "VRRP")?.fields.find((x) => x.name === n)?.value;
    expect(field("version")).toBe("2");
    expect(field("authtype")).toBe("0");
    expect(field("adv")).toBe("1");
    const ref = await engine.build([{ proto: "VRRP", fields: { vrid: 10, priority: 120, adv: 1, addrlist: ["192.168.10.1"] } }]);
    expect(Array.from(ref.bytes)).toEqual(Array.from(ipPayload(f)!));
  }, 60_000);
});

describe("VRRP data plane", () => {
  it("only the Master answers ARP for the VIP (with the vMAC); H1 pings the VIP and routes through it", () => {
    advance(45_000); // VRRP + OSPF converged
    expect(ping("H1", VIP)).toContain("2 received");
    expect(byName("H1").arpTable.find((e) => e.ip === VIP)?.mac).toBe(VMAC);
    const vipReplies = S().captures.filter((c) => c.dir === "tx" && c.frame.arp?.op === "reply" && c.frame.arp.senderIp === VIP);
    expect(vipReplies.length).toBeGreaterThan(0);
    expect(vipReplies.some((c) => c.deviceId === id("S1"))).toBe(true);
    expect(vipReplies.some((c) => c.deviceId === id("S2"))).toBe(false); // the Backup stays silent
    expect(vipReplies.every((c) => c.frame.arp!.senderMac === VMAC && c.frame.ethernet.srcMac === VMAC)).toBe(true);
    expect(ping("H1", "192.168.20.100")).toContain("2 received");
  });
});

describe("VRRP failover", () => {
  it("Master link down → S2 takes over Master_Down_Interval (3600 ms) after S1's last advert; GARP moves the vMAC; traffic continues", () => {
    advance(45_000);
    expect(ping("H1", "192.168.20.100")).toContain("2 received");
    const acc = byName("ACC");
    expect(acc.macTable.find((e) => e.mac === VMAC)?.interfaceId).toBe(`${acc.id}-if1`); // toward S1

    advance(400); // shut between two adverts
    const lastAdv = adverts("S1").at(-1)!.timeMs;
    const shutAt = Date.now();
    S().setAdminState(id("S1"), `${id("S1")}-if0`, false);
    S().setAdminState(id("S1"), `${id("S1")}-if1`, false);
    until(() => role("S2") === "Master", 5000);
    const takeover = adverts("S2", shutAt)[0].timeMs;
    expect(takeover - lastAdv).toBeGreaterThanOrEqual(3600); // 3×1000 + (256-100)×1000/256 = 3600
    expect(takeover - lastAdv).toBeLessThanOrEqual(3700); // + at most one 100 ms tick
    expect(role("S1")).toBe("Initialize");

    // Gratuitous ARP for the VIP from the vMAC (vrrp_arp.c) — ACC now points the vMAC at S2.
    const garp = S().captures.find((c) => c.deviceId === id("S2") && c.dir === "tx" && c.frame.arp?.senderIp === VIP && c.frame.arp.targetIp === VIP && c.timeMs >= takeover);
    expect(garp?.frame.ethernet.srcMac).toBe(VMAC);
    expect(garp?.frame.ethernet.dstMac).toBe("FF:FF:FF:FF:FF:FF");
    expect(byName("ACC").macTable.find((e) => e.mac === VMAC)?.interfaceId).toBe(`${acc.id}-if2`);

    // Same gateway (IP and MAC) for H1: the VIP answers and routed traffic flows via S2.
    expect(ping("H1", VIP)).toContain("2 received");
    advance(2000);
    expect(ping("H1", "192.168.20.100")).toContain("2 received");
    expect(byName("H1").arpTable.find((e) => e.ip === VIP)?.mac).toBe(VMAC);
  });

  it("original Master returns → preempts after its own Master_Down_Interval (3530 ms)", () => {
    advance(10_000);
    S().setAdminState(id("S1"), `${id("S1")}-if0`, false);
    until(() => role("S2") === "Master", 5000);
    const upAt = Date.now();
    S().setAdminState(id("S1"), `${id("S1")}-if0`, true);
    advance(100);
    expect(role("S1")).toBe("Backup"); // startup
    const t = until(() => role("S1") === "Master", 5000);
    expect(t + 100).toBeGreaterThanOrEqual(3530);
    expect(t + 100).toBeLessThanOrEqual(3700);
    expect(role("S2")).toBe("Backup"); // S1's prio-120 advert demoted S2
    expect(adverts("S1", upAt)[0].timeMs - upAt).toBeLessThanOrEqual(3700);
    const acc = byName("ACC");
    expect(acc.macTable.find((e) => e.mac === VMAC)?.interfaceId).toBe(`${acc.id}-if1`);
    expect(ping("H1", VIP)).toContain("2 received");
    expect(rt("S1")!.transitions).toBe(5); // Init→Backup→Master→Init→Backup→Master
  });

  it("with `no preempt` the returning higher-priority router stays Backup", () => {
    advance(10_000);
    klish("S1", "configure terminal", "interface Vlan 10", "vrrp 10 address-family ipv4", "no preempt", "end");
    S().setAdminState(id("S1"), `${id("S1")}-if0`, false);
    until(() => role("S2") === "Master", 5000);
    S().setAdminState(id("S1"), `${id("S1")}-if0`, true);
    advance(10_000);
    expect(role("S1")).toBe("Backup");
    expect(role("S2")).toBe("Master");
  });

  it("`no vrrp` on the Master sends priority 0 → S2 takes over after Skew_Time (600 ms)", () => {
    advance(10_000);
    klish("S1", "configure terminal", "interface Vlan 10", "no vrrp 10 address-family ipv4", "end");
    until(() => role("S2") === "Master", 2000);
    const zero = adverts("S1").filter((c) => prio(c) === 0);
    expect(zero).toHaveLength(1);
    expect(formatPacket(zero[0].frame)[0]).toContain("vrid 10, prio 0,");
    const takeover = adverts("S2")[0].timeMs;
    expect(takeover - zero[0].timeMs).toBeGreaterThanOrEqual(600); // (256-100)×1000/256 cs → 600 ms
    expect(takeover - zero[0].timeMs).toBeLessThan(700);
    expect(rt("S1")).toBeUndefined();
    expect(ping("H1", VIP)).toContain("2 received");
  });

  it("`shutdown` in the VRRP sub-mode: priority 0 + fast takeover; `no shutdown` preempts back", () => {
    advance(10_000);
    klish("S1", "configure terminal", "interface Vlan 10", "vrrp 10 address-family ipv4", "shutdown", "end");
    const t = until(() => role("S2") === "Master", 2000);
    expect(t).toBeLessThanOrEqual(800);
    expect(role("S1")).toBe("Initialize");
    expect(adverts("S1").filter((c) => prio(c) === 0)).toHaveLength(1);
    klish("S1", "configure terminal", "interface Vlan 10", "vrrp 10 address-family ipv4", "no shutdown", "end");
    expect(until(() => role("S1") === "Master", 5000)).toBeLessThanOrEqual(3700);
    expect(role("S2")).toBe("Backup");
  });
});

describe("show vrrp", () => {
  it("KLISH brief table, Click FRR detail block and summary reflect the live state", () => {
    advance(10_000);
    const brief = klish("S1", "show vrrp");
    expect(brief.split("\n")[0]).toBe("          Interface  VRID   State Virtual Address  Cfg_Prio  Curr_Prio   Version     Address");
    expect(brief).toContain("             Vlan10    10  Master    192.168.10.1       120        120         3 192.168.10.2");
    expect(klish("S2", "show vrrp")).toMatch(/Vlan10 +10 +Backup +192\.168\.10\.1 +100 +100 +3 +192\.168\.10\.3/);

    const detail = bash("S1", "show vrrp");
    expect(detail).toContain(" Virtual Router ID                       10");
    expect(detail).toContain(" Status (v4)                             Master");
    expect(detail).toContain(" Virtual MAC (v4)                        00:00:5e:00:01:0a");
    expect(detail).toContain(" Primary IP (v4)                         192.168.10.2");
    expect(detail).toContain(" Skew Time (v4)                          530 ms");
    expect(detail).toContain(" Master Down Interval (v4)               3530 ms");
    expect(detail).toContain(" Advertisement Interval                  1000 ms");
    expect(detail).toContain(" Preempt Mode                            Yes");
    expect(detail).toContain(" ..................................      192.168.10.1");
    expect(detail).toMatch(/Advertisements Tx \(v4\) +([6-9]|\d\d)\n/);
    expect(detail).toContain(" State transitions (v4)                  2");
    expect(bash("S2", "show vrrp interface Vlan10 10")).toContain(" Status (v4)                             Backup");
    expect(bash("S2", "show vrrp vrid 10")).toContain(" Master Down Interval (v4)               3600 ms");
    expect(bash("S2", "show vrrp interface Vlan99")).toBe("");

    const sum = bash("S1", "show vrrp summary").split("\n");
    expect(sum[1]).toBe(" Interface   VRID   Priority   IPv4   IPv6   State (v4)   State (v6)");
    expect(sum[2]).toMatch(/^ -+$/);
    expect(sum[3]).toBe(" Vlan10      10     120        1      0      Master       Backup");

    expect(klish("S1", "show vrrp interface Vlan 10 vrid 10")).toContain(" Status (v4)                             Master");
  });
});
