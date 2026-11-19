import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes } from "../lib/sflow/wire";
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
  S().loadFeatureLab("evpn-irb");
});
afterEach(() => vi.useRealTimers());

type D = { layers: { proto: string; fields: { name: string; value: string }[] }[]; show: string };
const field = (d: D, proto: string, name: string, nth = 0) => d.layers.filter((l) => l.proto === proto)[nth]?.fields.find((f) => f.name === name)?.value;
const rmac = (sw: string) => byName(sw).interfaces.find((i) => i.name === "Vlan500")!.mac.toLowerCase();

describe("Symmetric IRB on the wire (Scapy)", () => {
  it("routed packet: Ether/IP/UDP 4789/VXLAN vni 50000/inner Ether (router MAC → router MAC)/IP ttl 63/ICMP", async () => {
    advance(3000);
    S().execCommand(byName("H1").id, "ping -c 1 10.2.0.22");
    advance(1000);
    const since = S().captures.length;
    S().execCommand(byName("H1").id, "ping -c 1 10.2.0.22");
    const l1 = byName("LEAF1").id;
    const c = S().captures.slice(since).find((x) => x.deviceId === l1 && x.dir === "tx" && x.frame.udp?.dstPort === 4789)!;
    const d = (await engine.dissect(frameToBytes(c.frame))) as D;
    expect(d.layers.map((l) => l.proto).slice(0, 7)).toEqual(["Ether", "IP", "UDP", "VXLAN", "Ether", "IP", "ICMP"]);
    expect(field(d, "VXLAN", "flags")).toBe("Instance");
    expect(Number(field(d, "VXLAN", "vni"))).toBe(50000);
    expect([field(d, "IP", "src"), field(d, "IP", "dst")]).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(field(d, "Ether", "src", 1)).toBe(rmac("LEAF1"));
    expect(field(d, "Ether", "dst", 1)).toBe(rmac("LEAF2"));
    expect([field(d, "IP", "src", 1), field(d, "IP", "dst", 1), field(d, "IP", "ttl", 1)]).toEqual(["10.1.0.11", "10.2.0.22", "63"]);
  });

  it("type-2 MAC+IP NLRI with two labels and type-5 NLRI parse in a real EVPN UPDATE", async () => {
    advance(3000);
    S().execCommand(byName("H1").id, "ping -c 1 10.2.0.22");
    advance(1000);
    const id = byName("LEAF2").id;
    const pick = (fn: (u: UpdateMsg) => boolean) =>
      S().captures.find((c) => c.deviceId === id && c.dir === "tx" && c.frame.tcp && decodeMessages(l4Payload(c.frame) ?? new Uint8Array(), true).some((m) => m.type === 2 && fn(m)))!.frame;
    const t5 = (await engine.dissect(frameToBytes(pick((u) => !!u.evpnReach?.nlri.some((r) => r.type === 5))))) as D;
    expect(t5.show).toContain("type_code = MP_REACH_NLRI");
    expect(t5.show).toContain("safi      = BGP EVPNs");
    expect(t5.show).toContain("type_code = ORIGIN"); // MP_REACH framing (34-byte type-5 NLRI) is right
    const t2 = (await engine.dissect(frameToBytes(pick((u) => !!u.evpnReach?.nlri.some((r) => r.type === 2 && r.vni2 === 50000))))) as D;
    expect(t2.show).toContain("type_code = MP_REACH_NLRI");
    expect(t2.show).toContain("type_code = EXTENDED COMMUNITIES");
    expect(t2.show).toContain("type_code = ORIGIN"); // 40-byte type-2 (IPv4 + 2 labels) framed correctly
  }, 60_000);
});
