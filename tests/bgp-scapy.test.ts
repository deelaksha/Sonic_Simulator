import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { ScapyEngine } from "../lib/packetgen/engine";
import { frameToBytes, inetChecksum } from "../lib/sflow/wire";
import { decodeMessages } from "../lib/protocols/bgp-wire";
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
  S().loadFeatureLab("bgp");
});
afterEach(() => vi.useRealTimers());

const firstOfType = (sw: string, type: number) =>
  S().captures.find((c) => c.deviceId === byName(sw).id && c.dir === "tx" && c.frame.tcp && decodeMessages(l4Payload(c.frame) ?? new Uint8Array(), true)[0]?.type === type)!;

const field = (d: { layers: { proto: string; fields: { name: string; value: string }[] }[] }, proto: string, name: string) =>
  d.layers.find((l) => l.proto === proto)?.fields.find((f) => f.name === name)?.value;

describe("BGP wire format dissected by Scapy (scapy.contrib.bgp)", () => {
  it("OPEN, UPDATE, KEEPALIVE and NOTIFICATION are valid TCP/179 BGP segments", async () => {
    // bad remote-as on S2 → S2 sends NOTIFICATION 2/2 to S1
    S().execCommand(byName("S2").id, "configure terminal");
    S().execCommand(byName("S2").id, "router bgp 65002");
    S().execCommand(byName("S2").id, "neighbor 10.0.12.1 remote-as 65099");
    advance(300);

    const open = frameToBytes(firstOfType("S1", 1).frame);
    // IPv4 header checksum valid; TCP checksum verified by Scapy below (chksum recomputed equal)
    expect(inetChecksum(Array.from(open.slice(14, 34)))).toBe(0);
    const o = await engine.dissect(open);
    expect(o.layers.map((l) => l.proto).slice(0, 5)).toEqual(["Ether", "IP", "TCP", "BGPHeader", "BGPOpen"]);
    expect(field(o, "BGPHeader", "type")).toMatch(/OPEN|1/);
    expect(field(o, "BGPOpen", "version")).toBe("4");
    expect(field(o, "BGPOpen", "my_as")).toBe("65001");
    expect(field(o, "BGPOpen", "hold_time")).toBe("180");
    expect(field(o, "BGPOpen", "bgp_id")).toBe("1.1.1.1");
    expect(o.show).toMatch(/Multiprotocol|MP/);
    expect(o.show).toMatch(/Four-Octet|4-octet|AS4|32-bit/i);

    const upd = await engine.dissect(frameToBytes(firstOfType("S3", 2).frame));
    expect(upd.layers.map((l) => l.proto)).toContain("BGPUpdate");
    expect(upd.show).toContain("192.168.3.0");
    expect(upd.show).toMatch(/ORIGIN|Origin/);
    expect(upd.show).toMatch(/NEXT_HOP|Next Hop/i);
    expect(upd.show).toContain("IGP");
    expect(upd.show).toContain("next_hop  = 10.0.13.2");
    expect(upd.show).toContain("prefix    = 192.168.3.0/24");
    // AS_PATH uses 4-octet ASNs (both sides sent the AS4 capability): 1 segment = 2 + 4 bytes.
    // Scapy's contrib.bgp defaults to use_2_bytes_asn=True, so it splits these bytes as 2-byte
    // ASNs; the length (and flags 0x50 = Transitive+Extended-Length, bgp_attr.c:4607) are what it proves.
    expect(upd.show).toContain("type_flags= Extended-Length+Transitive");
    expect(upd.show).toContain("attr_ext_len= 6");

    const ka = await engine.dissect(frameToBytes(firstOfType("S1", 4).frame));
    expect(ka.layers.map((l) => l.proto)).toContain("BGPKeepAlive");
    expect(field(ka, "BGPKeepAlive", "len")).toBe("19");

    const n = await engine.dissect(frameToBytes(firstOfType("S2", 3).frame));
    expect(n.layers.map((l) => l.proto)).toContain("BGPNotification");
    expect(field(n, "BGPNotification", "error_code")).toMatch(/2|OPEN/);
    expect(field(n, "BGPNotification", "error_subcode")).toMatch(/2|Bad Peer AS/);
  }, 60_000);
});
