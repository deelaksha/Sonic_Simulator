/**
 * VRRP depth on the "vrrp" lab: interface tracking (priority decrement → failover
 * and preempt back), VRRPv3 for IPv6 (adverts to ff02::12 from a link-local,
 * vMAC 00:00:5e:00:02:0a, unsolicited NA, NS answered with the vMAC, show vrrp6,
 * Scapy decode), and `config feature state bgp disabled` stopping vrrpd.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { nodePacketEngine } from "./packet-engine-node";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes } from "../lib/sflow/wire";
import { runtimeOf, VrrpFamily } from "../lib/protocols/vrrp";
import { useLabStore } from "../lib/store/lab-store";
import { rebuildConnectedRoutes6 } from "../lib/models/factory";

const VIP6 = "2001:db8:10::1";
const VMAC6 = "00:00:5E:00:02:0A";
const id = (dev: string) => byName(dev).id;
const role = (dev: string, fam: VrrpFamily = "v4") => runtimeOf(byName(dev), "Vlan10", 10, fam)?.state;

function klish(dev: string, ...lines: string[]): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return lines.map((l) => out(S().execCommand(id(dev), l))).join("\n");
}
function bash(dev: string, cmd: string): string {
  if ((S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "end");
  if ((S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}
function until(pred: () => boolean, maxMs: number): number {
  for (let t = 100; t <= maxMs; t += 100) {
    advance(100);
    if (pred()) return t;
  }
  return Infinity;
}
const v6On = (dev: string) =>
  klish(dev, "configure terminal", "interface Vlan 10", "vrrp 10 address-family ipv6", `vip ${VIP6}`, "end");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetAll();
  S().loadFeatureLab("vrrp");
  advance(5000);
  expect(role("S1")).toBe("Master");
});
afterEach(() => vi.useRealTimers());

describe("VRRP interface tracking", () => {
  it("tracked uplink down lowers S1 to 90 < 100: S2 takes over; uplink up: S1 preempts back", () => {
    klish("S1", "configure terminal", "interface Vlan 10", "vrrp 10 address-family ipv4", "track-interface Ethernet 1 weight 30", "end");
    klish("S1", "configure terminal", "interface Ethernet 1", "shutdown", "end");
    const t = until(() => role("S2") === "Master", 6000);
    expect(t).toBeGreaterThan(3000); // S2 waits Master_Down_Interval (it discards the lower-priority adverts)
    expect(t).toBeLessThan(4300);
    advance(200);
    expect(role("S1")).toBe("Backup");
    expect(bash("S1", "show vrrp")).toMatch(/Effective Priority \(v4\)\s+90/);
    klish("S1", "configure terminal", "interface Ethernet 1", "no shutdown", "end");
    expect(until(() => role("S1") === "Master", 6000)).toBeLessThan(4300);
    advance(200);
    expect(role("S2")).toBe("Backup");
  });

  it("Click track_interface add/remove (VRRP_TRACK, priority_increment 10-50)", () => {
    expect(bash("S1", "sudo config interface vrrp track_interface add Vlan10 10 Ethernet1 60")).toContain("is not in the range 10<=x<=50");
    expect(bash("S1", "sudo config interface vrrp track_interface add Vlan10 10 Ethernet1 40")).toBe("");
    bash("S1", "sudo config interface shutdown Ethernet1");
    expect(until(() => role("S2") === "Master", 6000)).toBeLessThan(4300);
    expect(bash("S1", "sudo config interface vrrp track_interface remove Vlan10 10 Ethernet1")).toBe("");
    expect(until(() => role("S1") === "Master", 6000)).toBeLessThan(4300); // back to 120 although Ethernet1 is still down
  });
});

describe("VRRPv3 for IPv6", () => {
  beforeEach(() => {
    v6On("S1");
    v6On("S2");
    advance(5000);
  });

  it("S1 (priority 120) is IPv6 Master: adverts to ff02::12 from a link-local with the v6 vMAC; unsolicited NA", () => {
    expect(role("S1", "v6")).toBe("Master");
    expect(role("S2", "v6")).toBe("Backup");
    const adv = S().captures.filter((c) => c.deviceId === id("S1") && c.dir === "tx" && c.frame.ipv6?.dstIp === "ff02::12");
    expect(adv.length).toBeGreaterThan(2);
    const f = adv[adv.length - 1].frame;
    expect(f.ethernet.srcMac).toBe(VMAC6);
    expect(f.ethernet.dstMac).toBe("33:33:00:00:00:12");
    expect(f.ipv6!.srcIp).toMatch(/^fe80::/);
    expect(f.ipv6!.hopLimit).toBe(255);
    // Unsolicited NA from the vMAC → H1 (no IPv6 config needed to learn it).
    const h1Nd = byName("H1").ndpTable?.find((e) => e.ip === VIP6);
    expect(h1Nd?.mac).toBe(VMAC6);
    // show vrrp6 (Click) — the FRR detail block's v6 half.
    const t = bash("S1", "show vrrp6");
    expect(t).toMatch(/Status \(v6\)\s+Master/);
    expect(t).toMatch(/Virtual MAC \(v6\)\s+00:00:5e:00:02:0a/);
    expect(t).toMatch(/VRRP interface \(v6\)\s+vrrp6-10-[0-9a-f]{4}/);
    expect(t).toMatch(/Primary IP \(v6\)\s+fe80::/);
    expect(t).toMatch(/Neigh\. Adverts Tx \(v6\)\s+1/);
    expect(t).toMatch(/IPv6 Addresses\s+1\n \.{34}\s+2001:db8:10::1/);
    expect(bash("S2", "show vrrp6 summary")).toMatch(/Vlan10\s+10\s+100\s+1\s+1\s+Backup\s+Backup/);
    // KLISH show vrrp6 brief.
    expect(klish("S1", "show vrrp6")).toMatch(/Vlan10\s+10\s+Master\s+2001:db8:10::1\s+120\s+120\s+3\s+fe80::/);
  });

  it("H1's Neighbor Solicitation for the VIP is answered by the Master only, with the v6 vMAC", () => {
    useLabStore.setState((s) => {
      const n = structuredClone(s.network);
      const h1 = n.devices[id("H1")];
      h1.ndpTable = [];
      h1.interfaces[0].ipv6 = [{ address: "2001:db8:10::100", prefix: 64 }];
      rebuildConnectedRoutes6(h1);
      return { network: n };
    });
    klish("S1", "configure terminal", "interface Vlan 10", "ipv6 address 2001:db8:10::2/64", "end"); // SVI's own address: return route to H1
    const ping = S().execCommand(id("H1"), `ping6 -c 1 ${VIP6}`).output.map((l) => l.text).join("\n");
    expect(ping).toMatch(/1 received/); // the Master answers echo to the VIP (frames to the vMAC)
    expect(byName("H1").ndpTable?.find((e) => e.ip === VIP6)?.mac).toBe(VMAC6);
    const nas = S().captures.filter((c) => c.dir === "tx" && c.frame.icmp6?.type === "neighbor-advertisement" && c.frame.icmp6.targetAddr === VIP6 && c.frame.ipv6?.dstIp === "2001:db8:10::100");
    expect(nas.length).toBeGreaterThan(0);
    expect(nas.every((c) => c.frame.ethernet.srcMac === VMAC6)).toBe(true);
    expect(nas.some((c) => c.deviceId === id("S2"))).toBe(false); // the Backup's macvlan is protodown
  });

  it("S1 down → S2 IPv6 Master (priority-0 handover) and S2 announces the VIP with an unsolicited NA", () => {
    klish("S1", "configure terminal", "interface Vlan 10", "no vrrp 10 address-family ipv6", "end");
    expect(until(() => role("S2", "v6") === "Master", 2000)).toBeLessThan(1000); // Skew_Time after priority 0
    expect(role("S1")).toBe("Master"); // IPv4 family untouched
    const una = S().captures.filter((c) => c.deviceId === id("S2") && c.dir === "tx" && c.frame.icmp6?.type === "neighbor-advertisement" && c.frame.ipv6?.dstIp === "ff02::1");
    expect(una.length).toBeGreaterThan(0);
    expect(una[0].frame.ethernet.srcMac).toBe(VMAC6);
    expect(una[0].frame.icmp6!.targetAddr).toBe(VIP6);
  });

  it("tracking for the IPv6 family (VRRP6_TRACK) moves only the IPv6 Master", () => {
    expect(bash("S1", "sudo config interface vrrp6 track_interface add Vlan10 10 Ethernet1 30")).toBe("");
    bash("S1", "sudo config interface shutdown Ethernet1");
    expect(until(() => role("S2", "v6") === "Master", 6000)).toBeLessThan(4300);
    expect(role("S1")).toBe("Master");
  });
});

describe("feature bgp disabled stops vrrpd", () => {
  it("S1's routers shut down with priority 0 (S2 Master after Skew_Time); runtime cleared; re-enable restores", () => {
    bash("S1", "sudo config feature state bgp disabled");
    expect(until(() => role("S2") === "Master", 2000)).toBeLessThan(1000);
    expect(runtimeOf(byName("S1"), "Vlan10", 10)).toBeUndefined();
    const tx = () => S().captures.filter((c) => c.deviceId === id("S1") && c.dir === "tx" && c.frame.ipv4?.dstIp === "224.0.0.18").length;
    const n = tx();
    advance(3000);
    expect(tx()).toBe(n);
    bash("S1", "sudo config feature state bgp enabled");
    expect(until(() => role("S1") === "Master", 6000)).toBeLessThan(4300);
  });
});

describe("Scapy decodes VRRPv3 over IPv6 and the unsolicited NA", () => {
  let engine: ScapyEngine;
  beforeAll(async () => {
    engine = await nodePacketEngine();
  }, 120_000);

  it("IPv6/VRRPv3 advert and ICMPv6 NA (R, O, target link-layer = vMAC)", async () => {
    v6On("S1");
    advance(5000);
    const adv = S().captures.find((c) => c.deviceId === id("S1") && c.dir === "tx" && c.frame.ipv6?.dstIp === "ff02::12")!;
    const d = await engine.dissect(frameToBytes(adv.frame));
    expect(d.layers.map((l) => l.proto)).toEqual(["Ether", "IPv6", "VRRPv3"]);
    expect(d.show).toMatch(/vrid\s+=\s+10/);
    expect(d.show).toMatch(/priority\s+=\s+120/);
    expect(d.show).toMatch(/hlim\s+=\s+255/);
    expect(d.show).toContain("2001:db8:10::1");
    expect(d.show).toMatch(/chksum\s+=\s+0x[0-9a-f]+/);
    const na = S().captures.find((c) => c.deviceId === id("S1") && c.dir === "tx" && c.frame.icmp6?.type === "neighbor-advertisement" && c.frame.ipv6?.dstIp === "ff02::1")!;
    const n = await engine.dissect(frameToBytes(na.frame));
    expect(n.layers.map((l) => l.proto)).toContain("ICMPv6ND_NA");
    expect(n.show).toMatch(/R\s+=\s+1/);
    expect(n.show).toMatch(/O\s+=\s+1/);
    expect(n.show).toMatch(/lladdr\s+=\s+00:00:5e:00:02:0a/);
  }, 60_000);
});
