import { describe, it, expect, beforeAll } from "vitest";
import { ScapyEngine } from "../lib/packetgen/engine";
import { nodePacketEngine } from "./packet-engine-node";

let engine: ScapyEngine;
beforeAll(async () => {
  engine = await nodePacketEngine();
}, 120_000);

const E = { proto: "Ether", fields: { src: "02:00:00:00:00:01", dst: "02:00:00:00:00:02" } };

describe("Scapy PacketEngine (Pyodide)", () => {
  it("loads every configured layer module and exposes protocol metadata", async () => {
    const { protocols, loadErrors } = await engine.protocols();
    expect(loadErrors).toEqual({});
    const names = new Set(protocols.map((p) => p.proto));
    for (const p of ["Ether", "Dot1Q", "ARP", "IP", "IPv6", "UDP", "TCP", "ICMP", "DNS", "BOOTP", "DHCP", "NTPHeader", "VXLAN", "BGPHeader", "OSPF_Hdr", "LLDPDUChassisID", "LACP", "BFD", "MPLS", "GRE"]) {
      expect(names.has(p), p).toBe(true);
    }
    const ip = await engine.describe("IP");
    expect(ip.fields.find((f) => f.name === "dst")).toMatchObject({ kind: "ipv4" });
    expect(ip.fields.find((f) => f.name === "ttl")).toMatchObject({ kind: "int", default: 64 });
    expect(ip.fields.find((f) => f.name === "flags")?.kind).toBe("flags");
    const udp = await engine.describe("UDP");
    expect(udp.fields.find((f) => f.name === "dport")?.kind).toBe("enum");
  });

  it("builds multi-protocol stacks to wire bytes and dissects them back", async () => {
    const dns = await engine.build([
      E,
      { proto: "Dot1Q", fields: { vlan: 100 } },
      { proto: "IP", fields: { src: "10.0.0.1", dst: "10.0.0.2" } },
      { proto: "UDP", fields: { sport: 40000, dport: 53 } },
      { proto: "DNS", fields: { rd: 1, qd: { proto: "DNSQR", fields: { qname: "example.com" } } } },
    ]);
    expect(dns.layers.map((l) => l.proto)).toEqual(["Ether", "Dot1Q", "IP", "UDP", "DNS"]);
    expect(dns.summary).toContain("DNS Qry");
    expect(dns.bytes[12]).toBe(0x81); // 802.1Q TPID
    const back = await engine.dissect(dns.bytes);
    expect(back.layers.find((l) => l.proto === "Dot1Q")?.fields.find((f) => f.name === "vlan")?.value).toBe("100");

    const vx = await engine.build([
      E,
      { proto: "IP", fields: { src: "10.0.0.1", dst: "10.0.0.2" } },
      { proto: "UDP", fields: { dport: 4789 } },
      { proto: "VXLAN", fields: { vni: 10100 } },
      { proto: "Ether", fields: { src: "02:00:00:00:00:0a", dst: "02:00:00:00:00:0b" } },
      { proto: "IP", fields: { src: "192.168.1.1", dst: "192.168.1.2" } },
      { proto: "ICMP" },
    ]);
    expect(vx.layers.map((l) => l.proto)).toEqual(["Ether", "IP", "UDP", "VXLAN", "Ether", "IP", "ICMP"]);

    const v6 = await engine.build([E, { proto: "IPv6", fields: { src: "2001:db8::1", dst: "2001:db8::2" } }, { proto: "ICMPv6EchoRequest" }]);
    expect(v6.summary).toContain("ICMPv6 Echo Request");
  });

  it("rejects unknown protocols and fields instead of evaluating input", async () => {
    await expect(engine.build([{ proto: "__import__('os')" }])).rejects.toThrow(/unknown protocol/);
    await expect(engine.build([E, { proto: "IP", fields: { nope: 1 } }])).rejects.toThrow(/IP has no field 'nope'/);
    await expect(engine.build([E, { proto: "IP", fields: { dst: "not-an-ip" } }])).rejects.toThrow();
  });
});
