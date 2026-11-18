import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes, inetChecksum } from "../lib/sflow/wire";
import { decodeMessages, UpdateMsg } from "../lib/protocols/bgp-wire";
import { l4Payload } from "../lib/control/packet";
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
  S().loadFeatureLab("vxlan");
});
afterEach(() => vi.useRealTimers());

type D = { layers: { proto: string; fields: { name: string; value: string }[] }[]; show: string };
const field = (d: D, proto: string, name: string, nth = 0) => d.layers.filter((l) => l.proto === proto)[nth]?.fields.find((f) => f.name === name)?.value;

function evpnUpdateFrame(sw: string, pick: (u: UpdateMsg) => boolean) {
  const id = byName(sw).id;
  return S().captures.find(
    (c) => c.deviceId === id && c.dir === "tx" && c.frame.tcp && decodeMessages(l4Payload(c.frame) ?? new Uint8Array(), true).some((m) => m.type === 2 && pick(m)),
  )!.frame;
}

describe("VXLAN and BGP EVPN wire format dissected by Scapy", () => {
  it("VXLAN packets: Ether/IP/UDP 4789/VXLAN (I flag, VNI 10100)/inner Ether/ARP|IP/ICMP", async () => {
    advance(3000);
    S().execCommand(byName("H1").id, "ping -c 1 172.16.100.12");
    const l1 = byName("LEAF1").id;
    const vx = S().captures.filter((c) => c.deviceId === l1 && c.dir === "tx" && c.frame.udp?.dstPort === 4789);
    const arp = (await engine.dissect(frameToBytes(vx[0].frame))) as D;
    expect(arp.layers.map((l) => l.proto).slice(0, 6)).toEqual(["Ether", "IP", "UDP", "VXLAN", "Ether", "ARP"]);
    expect(field(arp, "VXLAN", "flags")).toBe("Instance");
    expect(Number(field(arp, "VXLAN", "vni"))).toBe(10100);
    expect(field(arp, "UDP", "dport")).toBe("4789");
    expect(field(arp, "UDP", "chksum")).toBe("0x0");
    expect(field(arp, "IP", "ttl")).toBe("64");
    expect(field(arp, "Ether", "dst", 1)).toBe("ff:ff:ff:ff:ff:ff");
    expect(field(arp, "ARP", "pdst")).toBe("172.16.100.12");
    const icmp = (await engine.dissect(frameToBytes(vx[1].frame))) as D;
    expect(icmp.layers.map((l) => l.proto).slice(0, 7)).toEqual(["Ether", "IP", "UDP", "VXLAN", "Ether", "IP", "ICMP"]);
    expect(field(icmp, "IP", "dst", 1)).toBe("172.16.100.12");
    expect(field(icmp, "ICMP", "type")).toMatch(/echo-request|8/);
    // outer IPv4 header checksum valid; outer IP length = 20 + 8 + 8 + inner frame
    const b = frameToBytes(vx[1].frame);
    expect(inetChecksum(Array.from(b.slice(14, 34)))).toBe(0);
    expect(Number(field(icmp, "IP", "len"))).toBe(20 + 8 + 8 + 98);
  });

  it("EVPN UPDATEs: MP_REACH AFI 25/SAFI 70, ext-communities (encap VXLAN, RT 65001:10100), PMSI, MP_UNREACH", async () => {
    advance(3000);
    S().execCommand(byName("H1").id, "ping -c 1 172.16.100.12");
    advance(500);
    S().removeDevice(byName("H1").id); // H1's MAC then ages; withdraw follows
    advance(700_000, 1000);
    const t3 = (await engine.dissect(frameToBytes(evpnUpdateFrame("LEAF1", (u) => u.evpnReach?.nlri[0].type === 3)))) as D;
    expect(t3.layers.map((l) => l.proto)).toEqual(["Ether", "IP", "TCP", "BGPHeader", "BGPUpdate"]);
    expect(t3.show).toContain("type_code = MP_REACH_NLRI");
    expect(t3.show).toContain("afi       = AFI for L2VPN information");
    expect(t3.show).toContain("safi      = BGP EVPNs");
    expect(t3.show).toContain("nh_addr_len= 4");
    expect(t3.show).toContain("type_low  = Encapsulation Extended Community");
    expect(t3.show).toContain("value     = b'\\x00\\x00\\x00\\x00\\x00\\x08'"); // tunnel type 8 = VXLAN
    expect(t3.show).toMatch(/type_low {2}= Route Target[\s\S]*global_administrator= 65001\s+\|\s+\|\s+\|\s+\|\s+local_administrator= 10100/);
    expect(t3.show).toContain("type_code = PMSI_TUNNEL");
    expect(t3.show).toContain("attr_len  = 9");
    // every attribute after MP_REACH parsed in place: the MP_REACH length framing is right
    expect(t3.show).toContain("type_code = ORIGIN");
    const t2 = (await engine.dissect(frameToBytes(evpnUpdateFrame("LEAF1", (u) => u.evpnReach?.nlri[0].type === 2)))) as D;
    expect(t2.show).toContain("type_code = MP_REACH_NLRI");
    expect(t2.show).not.toContain("PMSI_TUNNEL");
    expect(t2.show).toContain("type_code = EXTENDED COMMUNITIES");
    const wd = (await engine.dissect(frameToBytes(evpnUpdateFrame("LEAF1", (u) => !!u.evpnUnreach)))) as D;
    expect(wd.show).toContain("type_code = MP_UNREACH_NLRI");
    expect(wd.show).toContain("afi       = AFI for L2VPN information");
  }, 60_000);
});
