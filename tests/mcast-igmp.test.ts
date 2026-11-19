/**
 * Host IGMP (Linux model) and IGMP snooping on S3 Vlan30 of the "multicast" lab:
 * join/leave packets, querier, report forwarding to router ports only,
 * restricted flooding, fast-leave, `show ip igmp snooping groups`.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekHostMcast } from "../lib/protocols/mcast-host";
import { decodeIgmp, encodeIgmp, l3Payload } from "../lib/protocols/mcast-wire";
import { CaptureRecord } from "../lib/engine";
import { formatPacket } from "../lib/commands/tcpdump";

const G = "239.1.1.1";
const id = (dev: string) => byName(dev).id;
const host = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
function klish(dev: string, ...cmds: string[]): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return cmds.map((c) => out(S().execCommand(id(dev), c))).join("\n");
}
const caps = (dev: string, dir: "rx" | "tx", pred: (c: CaptureRecord) => boolean = () => true) =>
  S().captures.filter((c) => c.deviceId === id(dev) && c.dir === dir && pred(c));
const igmp = (c: CaptureRecord) => c.frame.ipv4?.protocolNumber === 2;
const udpTo = (g: string) => (c: CaptureRecord) => c.frame.ipv4?.dstIp === g && !!c.frame.udp;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("multicast");
  advance(2000);
});
afterEach(() => vi.useRealTimers());

describe("host IGMP", () => {
  it("S3 is the IGMPv2 querier on Vlan30: General Query to 224.0.0.1 with Router Alert, TTL 1", () => {
    const q = caps("H5", "rx", igmp)[0];
    expect(q.frame.ipv4!.srcIp).toBe("192.168.30.1");
    expect(q.frame.ipv4!.dstIp).toBe("224.0.0.1");
    expect(q.frame.ethernet.dstMac).toBe("01:00:5E:00:00:01");
    const raw = q.frame.rawL3!;
    expect(raw[0]).toBe(0x46); // IHL 6: Router Alert option
    expect(raw.slice(20, 24)).toEqual([0x94, 0x04, 0, 0]);
    expect(raw[8]).toBe(1);
    expect(decodeIgmp(l3Payload(q.frame)!)).toEqual({ kind: "query", version: 2, maxRespDs: 100, group: "0.0.0.0" });
    expect(formatPacket(q.frame).join("")).toBe("IP 192.168.30.1 > 224.0.0.1: igmp query v2");
  });

  it("join: IGMPv2 report to the group (v2 querier present), group MAC 01:00:5e + low 23 bits", () => {
    expect(host("H3", "mcast join 239.129.1.1")).toContain("01:00:5e:01:01:01");
    const r = caps("H3", "tx", igmp).pop()!;
    expect(r.frame.ipv4!.dstIp).toBe("239.129.1.1");
    expect(r.frame.ethernet.dstMac).toBe("01:00:5E:01:01:01");
    expect(formatPacket(r.frame).join("")).toBe("IP 192.168.30.10 > 239.129.1.1: igmp v2 report 239.129.1.1");
    // one unsolicited retransmission after 10 s (IGMPv2 unsolicited report interval)
    advance(10_100);
    expect(caps("H3", "tx", (c) => igmp(c) && c.frame.ipv4!.dstIp === "239.129.1.1").length).toBe(2);
    expect(host("H3", "mcast maddr dev eth0")).toContain("\tinet  239.129.1.1");
  });

  it("leave: IGMPv2 Leave Group to 224.0.0.2", () => {
    host("H3", `mcast join ${G}`);
    host("H3", `mcast leave ${G}`);
    const l = caps("H3", "tx", igmp).pop()!;
    expect(l.frame.ipv4!.dstIp).toBe("224.0.0.2");
    expect(formatPacket(l.frame).join("")).toBe(`IP 192.168.30.10 > 224.0.0.2: igmp leave ${G}`);
    // the querier answers with a group-specific query
    advance(200);
    expect(caps("H3", "rx", (c) => igmp(c) && c.frame.ipv4!.dstIp === G).length).toBeGreaterThanOrEqual(1);
  });

  it("members answer the periodic General Query (startup queries every qi/4)", () => {
    host("H3", `mcast join ${G}`);
    const before = caps("H3", "tx", igmp).length;
    advance(32_000); // second startup query at 125/4 s, reports within 10 s
    expect(caps("H3", "tx", igmp).length).toBeGreaterThan(before);
  });

  it("without any querier the host uses IGMPv3: TO_EX {} report to 224.0.0.22", () => {
    host("H1", `mcast join ${G}`);
    const r = caps("H1", "tx", igmp).pop()!;
    expect(r.frame.ipv4!.dstIp).toBe("224.0.0.22");
    expect(decodeIgmp(l3Payload(r.frame)!)).toEqual({ kind: "v3report", records: [{ type: 4, group: G, sources: [] }] });
    expect(formatPacket(r.frame).join("")).toBe("IP 192.168.1.10 > 224.0.0.22: igmp v3 report, 1 group record(s)");
  });

  it("IGMP encode/decode round trip (v3 query, v3 report records)", () => {
    expect(decodeIgmp(Uint8Array.from(encodeIgmp({ kind: "query", version: 3, maxRespDs: 100, group: "0.0.0.0", qrv: 2, qqic: 125 })))).toEqual({ kind: "query", version: 3, maxRespDs: 100, group: "0.0.0.0", qrv: 2, qqic: 125 });
    const rep = { kind: "v3report" as const, records: [{ type: 2, group: G, sources: [] }, { type: 1, group: "232.1.1.1", sources: ["10.0.0.1"] }] };
    expect(decodeIgmp(Uint8Array.from(encodeIgmp(rep)))).toEqual(rep);
  });
});

describe("IGMP snooping (S3 Vlan30)", () => {
  it("learns member ports from reports and shows them", () => {
    host("H3", `mcast join ${G}`);
    host("H4", `mcast join ${G}`);
    const t = klish("S3", "show ip igmp snooping groups");
    expect(t).toContain("Vlan ID: 30");
    expect(t).toContain(`1 (*, ${G})`);
    expect(t).toContain("  Outgoing Ports: Ethernet2,Ethernet3");
    expect(t).toContain("Total number of entries: 1");
  });

  it("reports are forwarded to router ports only (other hosts never see them)", () => {
    host("H3", `mcast join ${G}`);
    expect(caps("H4", "rx", (c) => igmp(c) && c.frame.ipv4!.srcIp === "192.168.30.10")).toHaveLength(0);
    expect(caps("H5", "rx", (c) => igmp(c) && c.frame.ipv4!.srcIp === "192.168.30.10")).toHaveLength(0);
  });

  it("the stream reaches member ports only; the non-member H5 never receives it", () => {
    host("H3", `mcast join ${G}`);
    host("H4", `mcast join ${G}`);
    host("H1", `mcast send ${G} -c 4 -t 16`);
    expect(caps("H3", "rx", udpTo(G)).length).toBeGreaterThanOrEqual(4);
    expect(caps("H5", "rx", udpTo(G))).toHaveLength(0);
    expect(host("H3", "mcast show")).toMatch(/eth0 +239\.1\.1\.1 +\d+ +[45] +\d+ +192\.168\.1\.10/);
  });

  it("unknown multicast is flooded only to mrouter ports when snooping is on", () => {
    host("H3", "mcast send 239.9.9.9 -c 1");
    expect(caps("H4", "rx", udpTo("239.9.9.9"))).toHaveLength(0);
    expect(caps("H5", "rx", udpTo("239.9.9.9"))).toHaveLength(0);
    // snooping off: flooded to every port in the VLAN
    klish("S3", "configure terminal", "interface Vlan 30", "no ip igmp snooping", "end");
    host("H3", "mcast send 239.9.9.9 -c 1");
    expect(caps("H5", "rx", udpTo("239.9.9.9"))).toHaveLength(1);
  });

  it("without fast-leave the port ages 2 × last-member-query-interval after a Leave; with fast-leave at once", () => {
    host("H3", `mcast join ${G}`);
    host("H4", `mcast join ${G}`);
    host("H3", `mcast leave ${G}`);
    expect(klish("S3", "show ip igmp snooping groups")).toContain("Outgoing Ports: Ethernet2,Ethernet3");
    advance(2100);
    expect(klish("S3", "show ip igmp snooping groups")).toContain("Outgoing Ports: Ethernet3");
    klish("S3", "configure terminal", "interface Vlan 30", "ip igmp snooping fast-leave", "end");
    host("H4", `mcast leave ${G}`);
    expect(klish("S3", "show ip igmp snooping groups")).toContain("Total number of entries: 0");
    expect(peekHostMcast(byName("H4"))!.groups).toHaveLength(0);
  });

  it("snooping querier: General Queries from the switch when no other querier exists", () => {
    // S1 Ethernet2 is routed; build an L2 case on S3: a second VLAN with querier enabled
    klish("S3", "configure terminal", "interface Vlan 40", "ip igmp snooping", "ip igmp snooping querier", "end");
    S().setAccessVlan(id("S3"), `${id("S3")}-if4`, 40);
    advance(300);
    const q = caps("H5", "rx", (c) => igmp(c) && c.frame.ipv4!.dstIp === "224.0.0.1" && c.frame.ipv4!.srcIp === "0.0.0.0");
    expect(q.length).toBeGreaterThanOrEqual(1);
    expect(decodeIgmp(l3Payload(q[0].frame)!)?.kind).toBe("query");
  });
});
