/**
 * IPv4 multicast on the "multicast" lab, store-level on fake time: PIM
 * neighbours, IGMP membership, (*,G) toward the RP, Register, RPT → SPT
 * switchover, Register-Stop, delivery to members only, prune on leave, RPF
 * check, and the FRR / KLISH show layouts.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekPimd } from "../lib/protocols/pim-daemon";
import { peekHostMcast } from "../lib/protocols/mcast-host";
import { Simulation } from "../lib/engine";
import { buildFrame } from "../lib/protocols/ethernet";
import { ipv4Packet, udpSegment, multicastMac } from "../lib/control/packet";

const G = "239.1.1.1";
const SRC = "192.168.1.10";
const id = (dev: string) => byName(dev).id;

function bash(dev: string, cmd: string): string {
  if ((S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "end");
  if ((S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}
function klish(dev: string, cmd: string): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return out(S().execCommand(id(dev), cmd));
}
const host = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const rx = (dev: string) => peekHostMcast(byName(dev))?.groups.find((g) => g.group === G)?.rxPackets ?? 0;
const pim = (dev: string) => peekPimd(byName(dev))!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("multicast");
  advance(2000);
});
afterEach(() => vi.useRealTimers());

function joinBoth(): void {
  host("H3", `mcast join ${G}`);
  host("H4", `mcast join ${G}`);
  advance(500);
}

describe("PIM neighbours and RP", () => {
  it("Hellos form neighbours on every PIM link (FRR show ip pim neighbor layout)", () => {
    expect(pim("S1").nbrs.map((n) => n.addr).sort()).toEqual(["10.0.12.2", "10.0.13.2"]);
    expect(pim("S2").nbrs.map((n) => n.addr).sort()).toEqual(["10.0.12.1", "10.0.23.2"]);
    expect(pim("S3").nbrs.map((n) => n.addr).sort()).toEqual(["10.0.13.1", "10.0.23.1"]);
    const t = bash("S3", "show ip pim neighbor");
    expect(t).toMatch(/^ Interface {2}Neighbor {3}Uptime {4}Holdtime {2}DR Pri$/m);
    expect(t).toMatch(/^ Ethernet0 {2}10\.0\.13\.1 {2}00:00:0\d {2}00:01:4\d {2}1$/m);
    const k = klish("S3", "show ip pim neighbor");
    expect(k).toContain("PIM neighbor information for VRF: default");
    expect(k).toMatch(/Ethernet1 {7}10\.0\.23\.1 {7}00:00:0\d {7}00:01:4\d {9}1/);
  });

  it("show ip pim rp-info: RP 2.2.2.2, OIF toward it, I am RP only on S2", () => {
    expect(bash("S3", "show ip pim rp-info")).toMatch(/ 2\.2\.2\.2 +224\.0\.0\.0\/4 +Ethernet1 +no +Static +ASM/);
    expect(bash("S2", "show ip pim rp-info")).toMatch(/ 2\.2\.2\.2 +224\.0\.0\.0\/4 +Loopback0 +yes +Static +ASM/);
  });
});

describe("IGMP membership and (*,G)", () => {
  it("joins create IGMP groups on S3 Vlan30 and a (*,G) join toward the RP", () => {
    joinBoth();
    const groups = pim("S3").groups.filter((g) => g.group === G);
    expect(groups).toHaveLength(1);
    expect(groups[0].iface).toBe("Vlan30");
    expect(groups[0].version).toBe(2);
    // S2 (RP) has (*,G) join state from S3 on Ethernet1
    expect(pim("S2").ifch.some((c) => c.src === "*" && c.group === G && c.iface === "Ethernet1")).toBe(true);
    const igmp = bash("S3", "show ip igmp groups");
    expect(igmp).toContain("Total IGMP groups: 1");
    expect(igmp).toMatch(/Vlan30 {11}239\.1\.1\.1 {7}---- 00:04:\d\d {4}1 2 00:00:00/);
    expect(bash("S2", "show ip pim join")).toMatch(/ Ethernet1 +10\.0\.23\.1 +\* +239\.1\.1\.1 +JOIN +00:00:00 +03:\d\d +--:--/);
    expect(bash("S3", "show ip mroute")).toMatch(/ \* +239\.1\.1\.1 +SC +IGMP +Ethernet1 +Vlan30 +1 +00:00:00/);
  });
});

describe("Register, RPT → SPT switchover, delivery", () => {
  it("first packet is registered and arrives down the RPT; S3 then joins the SPT", () => {
    joinBoth();
    host("H1", `mcast send ${G} -c 1 -t 16`);
    expect(rx("H3")).toBe(1);
    expect(rx("H4")).toBe(1);
    expect(peekHostMcast(byName("H5"))?.groups.length ?? 0).toBe(0);
    const s1 = pim("S1").sg.find((s) => s.src === SRC && s.group === G)!;
    expect(s1.fhr).toBe(true);
    expect(pim("S1").stats.Ethernet0.regTx).toBe(1);
    // RP joined (S,G) toward S1 and the LHR switched to the SPT
    const s3 = pim("S3").sg.find((s) => s.src === SRC)!;
    expect(s3.sptSwitch).toBe(true);
    expect(s3.sptBit).toBeFalsy();
    expect(pim("S1").ifch.filter((c) => c.src === SRC).map((c) => c.iface).sort()).toEqual(["Ethernet0", "Ethernet1"]);
  });

  it("native packets set the SPT bit, prune (S,G,rpt) at the RP and stop registering", () => {
    joinBoth();
    host("H1", `mcast send ${G} -c 5 -t 16`);
    // 5 packets; the second one reaches the receivers twice (RPT and SPT) during the switchover
    expect(rx("H3")).toBeGreaterThanOrEqual(5);
    expect(rx("H3")).toBeLessThanOrEqual(6);
    expect(rx("H4")).toBe(rx("H3"));
    expect(pim("S3").sg.find((s) => s.src === SRC)!.sptBit).toBe(true);
    expect(pim("S2").rptPrunes.some((p) => p.src === SRC && p.iface === "Ethernet1")).toBe(true);
    // S2 pruned (S,G) toward S1: only the direct SPT link to S3 remains
    expect(pim("S1").ifch.filter((c) => c.src === SRC).map((c) => c.iface)).toEqual(["Ethernet1"]);
    const s1 = pim("S1").sg.find((s) => s.src === SRC)!;
    expect(s1.regState).toBe("Prune"); // Register-Stop received
    expect(pim("S1").stats.Ethernet0.regTx).toBe(1);
    expect(pim("S1").stats.Ethernet0.regStopRx).toBe(1);

    const m3 = bash("S3", "show ip mroute");
    expect(m3).toMatch(/ 192\.168\.1\.10 +239\.1\.1\.1 +ST +STAR +Ethernet0 +Vlan30 +1 /);
    const m1 = bash("S1", "show ip mroute");
    expect(m1).toMatch(/ 192\.168\.1\.10 +239\.1\.1\.1 +SF +PIM +Ethernet2 +Ethernet1 +1 /);
    const m2 = bash("S2", "show ip mroute");
    expect(m2).toMatch(/ 192\.168\.1\.10 +239\.1\.1\.1 +STP +none +Ethernet0 +none +0 +--:--:--/);
    expect(bash("S2", "show ip pim join")).toMatch(/ Ethernet1 +10\.0\.23\.1 +192\.168\.1\.10 +239\.1\.1\.1 +SGRpt\(P\)/);
    // KLISH show ip mroute: installed (S,G) with its outputs
    expect(klish("S3", "show ip mroute")).toMatch(/\* 192\.168\.1\.10 {4}239\.1\.1\.1 {7}Ethernet0 {5}Vlan30 {8}00:00:0\d/);
    expect(klish("S3", "show ip mroute summary")).toContain("(S, G)           1/1");
    expect(klish("S3", "show ip pim topology")).toContain("Incoming interface: Ethernet0, RPF neighbor 10.0.13.1");
  });

  it("multicast with the Linux default TTL 1 is not routed", () => {
    joinBoth();
    host("H1", `mcast send ${G} -c 2`);
    expect(rx("H3")).toBe(0);
  });
});

describe("timers", () => {
  it("state is refreshed by periodic Hellos / Joins / queries; (S,G) ages out after the keep-alive timer", () => {
    joinBoth();
    host("H1", `mcast send ${G} -c 3 -t 16`);
    advance(400_000, 1000);
    expect(pim("S3").nbrs).toHaveLength(2);
    expect(pim("S3").groups.some((g) => g.group === G)).toBe(true); // members answered the queries
    expect(pim("S2").ifch.some((c) => c.src === "*" && c.group === G)).toBe(true); // (*,G) refreshed every 60 s
    for (const d of ["S1", "S2", "S3"]) expect(pim(d).sg).toHaveLength(0); // KAT 210 s without data
    expect(pim("S1").ifch).toHaveLength(0);
  });
});

describe("prune on leave", () => {
  it("the last member leaving removes (*,G) and prunes the tree", () => {
    joinBoth();
    host("H1", `mcast send ${G} -c 3 -t 16`);
    host("H3", `mcast leave ${G}`);
    advance(3000);
    expect(pim("S3").groups.some((g) => g.group === G)).toBe(true); // H4 still a member
    host("H4", `mcast leave ${G}`);
    advance(3000); // 2 group-specific queries, 1 s apart, then the group expires
    expect(pim("S3").groups.some((g) => g.group === G)).toBe(false);
    expect(pim("S2").ifch.some((c) => c.src === "*" && c.group === G)).toBe(false);
    expect(pim("S1").ifch.some((c) => c.src === SRC)).toBe(false);
    const before = rx("H5");
    host("H1", `mcast send ${G} -c 2 -t 16`);
    expect(rx("H3")).toBe(0); // left: no counters any more
    expect(rx("H5")).toBe(before);
  });
});

describe("RPF check", () => {
  it("a packet from the source arriving on the RPT interface after the SPT bit is set is dropped", () => {
    joinBoth();
    host("H1", `mcast send ${G} -c 3 -t 16`);
    const s2 = byName("S2");
    const sim = new Simulation(S().network, { wallBase: Date.now() });
    const payload = udpSegment(SRC, G, 40000, 5001, [0, 0, 0, 99]);
    const raw = ipv4Packet({ src: SRC, dst: G, proto: 17, ttl: 10, payload });
    const f = buildFrame(
      { srcMac: s2.interfaces.find((i) => i.name === "Ethernet1")!.mac, dstMac: multicastMac(G), etherType: "IPv4", payloadBytes: raw.length, summary: "spoofed" },
      { ipv4: { srcIp: SRC, dstIp: G, ttl: 10, protocol: "UDP", identification: 1 }, udp: { srcPort: 40000, dstPort: 5001, length: payload.length } },
    );
    f.rawL3 = raw;
    const before = rx("H3");
    sim.transmit(s2.id, s2.interfaces.find((i) => i.name === "Ethernet1")!.id, f);
    expect(sim.events.some((e) => e.type === "FRAME_DROPPED" && e.deviceName === "S3" && /RPF check failed/.test(e.message))).toBe(true);
    expect(rx("H3")).toBe(before);
  });
});
