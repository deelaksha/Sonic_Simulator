import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs";
import { routedTriangle } from "../lib/labs/topologies";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes } from "../lib/sflow/wire";
import { decodeMessages } from "../lib/protocols/bgp-wire";
import { l4Payload } from "../lib/control/packet";
import { formatPacket } from "../lib/commands/tcpdump";
import { nodePacketEngine } from "./packet-engine-node";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";

let engine: ScapyEngine;
beforeAll(async () => {
  engine = await nodePacketEngine();
}, 120_000);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

registerLab("test-bgp6-scapy", (api) => {
  const t = routedTriangle(api);
  api.runCliScript(t.s1, ["configure terminal", "interface Ethernet 1", "ipv6 address 2001:db8:13::1/64", "exit", "router bgp 65001", "neighbor 10.0.13.2", "remote-as 65003", "address-family ipv6 unicast", "activate", "end"]);
  api.runCliScript(t.s3, ["configure terminal", "interface Ethernet 0", "ipv6 address 2001:db8:13::2/64", "exit", "interface Ethernet 2", "ipv6 address 2001:db8:3::1/64", "exit", "router bgp 65003", "neighbor 10.0.13.1", "remote-as 65001", "address-family ipv6 unicast", "activate", "exit", "exit", "address-family ipv6 unicast", "network 2001:db8:3::/64", "end"]);
  api.finish("test", t.s1);
});

/** Last UPDATE `dev` sent towards `dst` that satisfies `pick`. */
function lastUpdate(dev: string, dst: string, pick: (m: ReturnType<typeof decodeMessages>[number]) => boolean) {
  return S()
    .captures.filter((c) => c.deviceId === byName(dev).id && c.dir === "tx" && c.frame.ipv4?.dstIp === dst && c.frame.tcp)
    .filter((c) => decodeMessages(l4Payload(c.frame) ?? new Uint8Array(), true).some(pick))
    .pop()!;
}

describe("BGP policy attributes on the wire, dissected by Scapy (scapy.contrib.bgp)", () => {
  it("COMMUNITY (type 8, optional transitive) carries the route-map's values incl. no-export", async () => {
    S().loadFeatureLab("bgp-policy");
    S().runCliScript(byName("E1").id, ["configure terminal", "route-map TAG permit 10", "set community 65001:100 no-export", "exit", "router bgp 65001", "neighbor 10.0.13.2", "address-family ipv4 unicast", "route-map TAG out", "end"]);
    advance(300);
    const rec = lastUpdate("E1", "10.0.13.2", (m) => m.type === 2 && m.nlri.includes("192.168.1.0/24"));
    const bytes = frameToBytes(rec.frame);
    const d = await engine.dissect(bytes);
    expect(d.layers.map((l) => l.proto)).toContain("BGPUpdate");
    // flags 0xC0 (Optional, Transitive), type 8, values 65001:100 = 4259905636 and NO_EXPORT = 0xFFFFFF01
    expect(d.show).toMatch(/type_code\s*=\s*(COMMUNITY|COMMUNITIES|8)/);
    expect(d.show).toMatch(/type_flags\s*=\s*Transitive\+Optional\n\s*\|\s*type_code\s*=\s*COMMUNITY/);
    expect(d.show).toContain("4259905636");
    expect(d.show).toContain("\\xff\\xff\\xff\\x01"); // second value NO_EXPORT (Scapy's COMMUNITIES layer decodes one, the rest is Raw)
    expect(d.show).toContain("prefix    = 192.168.1.0/24");
    // tcpdump -v decode of the same segment
    expect(formatPacket(rec.frame, { verbose: true }).join("\n")).toMatch(/Community \(8\), length: 8, Flags \[OT\]: 65001:100, NO_EXPORT/);
  }, 60_000);

  it("MP_REACH_NLRI AFI 2/SAFI 1: IPv6 next hop and NLRI over an IPv4 session", async () => {
    S().loadFeatureLab("test-bgp6-scapy");
    advance(1000);
    const rec = lastUpdate("S3", "10.0.13.1", (m) => m.type === 2 && !!m.v6Reach);
    const d = await engine.dissect(frameToBytes(rec.frame));
    expect(d.layers.map((l) => l.proto)).toContain("BGPUpdate");
    expect(d.show).toMatch(/type_code\s*=\s*(MP_REACH_NLRI|14)/);
    expect(d.show).toMatch(/afi\s*=\s*IP6/);
    expect(d.show).toMatch(/safi\s*=\s*.*unicast/);
    expect(d.show).toContain("2001:db8:13::2");
    expect(d.show).toMatch(/nh_addr_len= 32\n.*nh_v6_global= 2001:db8:13::2\n.*nh_v6_link_local= fe80::/); // global + link-local
    expect(d.show).toContain("2001:db8:3::/64");
    expect(formatPacket(rec.frame, { verbose: true }).join("\n")).toMatch(/AFI: IPv6 \(2\), SAFI: Unicast \(1\)\n\t {4}nexthop: 2001:db8:13::2, fe80::[0-9a-f:]+, nh-length: 32, no SNPA\n\t {6}2001:db8:3::\/64/);
  }, 60_000);
});
