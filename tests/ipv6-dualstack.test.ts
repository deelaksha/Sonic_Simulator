/**
 * Dual-stack: radvd Router Advertisements → host SLAAC + default route, OSPFv3
 * (ospf6d) adjacencies / LSDB / SPF routes across the routedTriangle, ping6 and
 * traceroute6 across, reconvergence after a link cut, FRR show formats, and
 * Scapy decodes of the real RA / OSPFv3 bytes. Store + fake time.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { nodePacketEngine } from "./packet-engine-node";
import { ospf6Runtime, Ospf6Nbr } from "../lib/protocols/ospf6-daemon";
import { slaacRuntime, renderIp6Addr, renderIp6Route } from "../lib/protocols/radv-daemon";
import { decodeRa } from "../lib/protocols/radv-wire";
import { linkLocalFromMac, slaacAddress } from "../lib/models/ipv6";
import { formatPacket } from "../lib/commands/tcpdump";
import { projectApplDb } from "../lib/sonicdb/appl-state-db";
import { projectAsicDb } from "../lib/sonicdb/asic-db";

const iface = (dev: string, name: string) => byName(dev).interfaces.find((i) => i.name === name)!;
const ll = (dev: string, name: string) => linkLocalFromMac(iface(dev, name).mac);
const h1Addr = () => slaacAddress("2001:db8:1::", iface("H1", "eth0").mac);
const h3Addr = () => slaacAddress("2001:db8:3::", iface("H3", "eth0").mac);
const nbrs = (name: string): Ospf6Nbr[] => ospf6Runtime(byName(name))!.oifs.flatMap((o) => o.nbrs);
const o6 = (name: string, dest: string) => byName(name).routingTable6.filter((r) => r.type === "ospf" && r.destination === dest);
const klish = (name: string, cmd: string) => out(S().execCommand(byName(name).id, cmd));
const host = (name: string, cmd: string) => out(S().execCommand(byName(name).id, cmd));
const conn = (a: string, aIf: string, b: string, bIf: string) =>
  S().network.connections.find(
    (c) => (c.a.interfaceId === `${byName(a).id}-${aIf}` && c.b.interfaceId === `${byName(b).id}-${bIf}`) || (c.b.interfaceId === `${byName(a).id}-${aIf}` && c.a.interfaceId === `${byName(b).id}-${bIf}`),
  )!;
/** Captured RAs sent by a device out of an interface. */
const rasOut = (dev: string, ifName: string) =>
  S().captures.filter((c) => c.deviceId === byName(dev).id && c.interfaceId === iface(dev, ifName).id && c.dir === "tx" && c.frame.rawL3?.[6] === 58 && c.frame.rawL3[40] === 134);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("ipvx");
});
afterEach(() => vi.useRealTimers());

describe("radvd + SLAAC", () => {
  it("hosts autoconfigure EUI-64 addresses and a default route via the router's link-local", () => {
    advance(1000);
    const h1 = byName("H1").interfaces[0];
    expect(h1.ipv6[0]).toEqual({ address: h1Addr(), prefix: 64 }); // global first (primary / ping6 source)
    expect(h1.ipv6[1]).toEqual({ address: linkLocalFromMac(h1.mac), prefix: 64 });
    expect(byName("H1").routingTable6).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ destination: "2001:db8:1::", prefix: 64, type: "connected", nextHop: null }),
        expect.objectContaining({ destination: "::", prefix: 0, type: "default", nextHop: ll("S1", "Ethernet2"), metric: 1024 }),
      ]),
    );
    expect(byName("H3").interfaces[0].ipv6[0].address).toBe(h3Addr());
    // The router MAC was learned from the source link-layer option (no NS needed).
    expect(byName("H1").ndpTable.some((n) => n.ip === ll("S1", "Ethernet2") && n.state === "reachable")).toBe(true);

    const addr = renderIp6Addr(byName("H1"), Date.now()).join("\n");
    expect(addr).toContain(`    inet6 ${h1Addr()}/64 scope global dynamic `);
    expect(addr).toContain(`    inet6 ${linkLocalFromMac(h1.mac)}/64 scope link `);
    expect(addr).toContain("       valid_lft forever preferred_lft forever");
    const route = renderIp6Route(byName("H1"), Date.now());
    expect(route[0]).toBe("2001:db8:1::/64 dev eth0 proto kernel metric 256 pref medium");
    expect(route[1]).toBe("fe80::/64 dev eth0 proto kernel metric 256 pref medium");
    expect(route[2]).toMatch(new RegExp(`^default via ${ll("S1", "Ethernet2")} dev eth0 proto ra metric 1024 expires 5(39|40)sec hoplimit 64 pref medium$`));
  });

  it("advertises on the host-facing port only, at once then 3 initial RAs 16 s apart, then every MaxRtrAdvInterval (180 s)", () => {
    advance(250_000);
    expect(rasOut("S1", "Ethernet0")).toHaveLength(0); // `ipv6 nd suppress-ra` on the fabric links
    expect(rasOut("S2", "Ethernet0")).toHaveLength(0);
    const t = rasOut("S1", "Ethernet2").map((c) => c.timeMs);
    expect(t).toHaveLength(4);
    expect(t.slice(1).map((x, i) => Math.round((x - t[i]) / 1000))).toEqual([16, 16, 180]);
    const ra = decodeRa(rasOut("S1", "Ethernet2")[0].frame.rawL3!.slice(40))!;
    expect(ra).toMatchObject({ curHopLimit: 64, managed: false, other: false, lifetime: 540, mtu: 9100 });
    expect(ra.prefixes).toEqual([{ prefix: "2001:db8:1::", len: 64, onLink: true, autonomous: true, valid: 0xffffffff, preferred: 0xffffffff }]);
    const f = rasOut("S1", "Ethernet2")[0].frame;
    expect(formatPacket(f)[0]).toBe(`IP6 ${ll("S1", "Ethernet2")} > ff02::1: ICMP6, router advertisement, length 64`);
    expect(formatPacket(f, { verbose: true }).join("\n")).toContain("prefix info option (3), length 32 (4): 2001:db8:1::/64, Flags [onlink, auto], valid time infinity, pref. time infinity");
  });

  it("a host whose link comes up without a router sends Router Solicitations and the router answers at once", () => {
    advance(40_000); // initial RA burst over: next periodic RA only at ~212 s
    S().network.devices[byName("H1").id].config.features!.slaac = { sig: "", routers: [], addrs: [], rs: {} };
    S().network.devices[byName("H1").id].routingTable6 = [];
    host("H1", "ip link set eth0 down");
    advance(200);
    host("H1", "ip link set eth0 up");
    const before = rasOut("S1", "Ethernet2").length;
    advance(1500);
    const rs = S().captures.find((x) => x.deviceId === byName("H1").id && x.dir === "tx" && x.frame.rawL3?.[40] === 133);
    expect(rs?.frame.ipv6).toMatchObject({ dstIp: "ff02::2", srcIp: linkLocalFromMac(iface("H1", "eth0").mac), hopLimit: 255 });
    expect(formatPacket(rs!.frame)[0]).toMatch(/IP6 fe80::\S+ > ff02::2: ICMP6, router solicitation, length 16/);
    expect(rasOut("S1", "Ethernet2").length).toBe(before + 1);
    expect(slaacRuntime(byName("H1"))!.routers).toHaveLength(1);
    expect(slaacRuntime(byName("H1"))!.rs[iface("H1", "eth0").id]).toEqual({ sent: 1 }); // answered: no more RS
    expect(byName("H1").routingTable6.some((r) => r.type === "default" && r.nextHop === ll("S1", "Ethernet2"))).toBe(true);
  });

  it("KLISH `ipv6 nd` managed/other flags and ra-interval change the advertisement", () => {
    advance(1000);
    for (const l of ["configure terminal", "interface Ethernet 2", "ipv6 nd managed-config-flag", "ipv6 nd other-config-flag", "ipv6 nd ra-interval 30", "end"]) klish("S1", l);
    advance(40_000);
    const ra = decodeRa(rasOut("S1", "Ethernet2").at(-1)!.frame.rawL3!.slice(40))!;
    expect(ra).toMatchObject({ managed: true, other: true, lifetime: 90 });
    expect(slaacRuntime(byName("H1"))!.routers[0]).toMatchObject({ managed: true, other: true, lifetime: 90 });
    klish("S1", "configure terminal");
    klish("S1", "interface Ethernet 2");
    expect(klish("S1", "ipv6 nd ra-interval 0")).toMatch(/Invalid value/);
  });
});

describe("OSPFv3", () => {
  it("forms Full adjacencies over link-locals and installs O routes (25G → cost 4); ping6 H1 → H3 works", () => {
    advance(1000);
    expect(nbrs("S1").map((n) => n.state)).toEqual(["Init", "Init"]);
    advance(11_000);
    for (const s of ["S1", "S2", "S3"]) expect(nbrs(s).map((n) => n.state)).toEqual(["Full", "Full"]);
    expect(nbrs("S1").find((n) => n.rid === "3.3.3.3")!.ll).toBe(ll("S3", "Ethernet0"));
    expect(o6("S1", "2001:db8:3::")).toEqual([expect.objectContaining({ prefix: 64, nextHop: ll("S3", "Ethernet0"), metric: 8, distance: 110 })]);
    expect(o6("S1", "2001:db8:23::").map((r) => r.nextHop).sort()).toEqual([ll("S2", "Ethernet0"), ll("S3", "Ethernet0")].sort()); // ECMP
    // All five OSPFv3 packet types crossed the wire as Next Header 89 from link-locals.
    const pk = S().captures.filter((c) => c.frame.rawL3?.[6] === 89);
    expect([...new Set(pk.map((c) => c.frame.rawL3![41]))].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(pk.every((c) => c.frame.ipv6!.srcIp.startsWith("fe80::") && c.frame.ipv6!.hopLimit === 1)).toBe(true);

    // fpmsyncd ROUTE_TABLE / SAI ROUTE_ENTRY carry the IPv6 routes too.
    const appl = projectApplDb(byName("S1")).ROUTE_TABLE;
    expect(appl["2001:db8:3::/64"]).toEqual({ nexthop: ll("S3", "Ethernet0"), ifname: "Ethernet1", protocol: "ospf" });
    expect(appl["2001:db8:12::/64"]).toEqual({ nexthop: "::", ifname: "Ethernet0", protocol: "connected" });
    expect(Object.keys(projectAsicDb(byName("S1")).ASIC_STATE).some((k) => k.startsWith("SAI_OBJECT_TYPE_ROUTE_ENTRY:") && k.includes('"dest":"2001:db8:3::/64"'))).toBe(true);

    const ping = host("H1", `ping6 -c 2 ${h3Addr()}`);
    expect(ping).toMatch(/2 received/);
    expect(ping).toContain(`bytes from ${h3Addr()}: icmp_seq=1 hlim=62`);
    const tr = host("H1", `traceroute6 ${h3Addr()}`).split("\n");
    expect(tr[1]).toMatch(/^ 1  2001:db8:1::1 \(2001:db8:1::1\)/);
    expect(tr[2]).toMatch(/^ 2  2001:db8:13::2 \(2001:db8:13::2\)/);
    expect(tr[3]).toMatch(new RegExp(`^ 3  ${h3Addr()} `));
  });

  it("cutting S1–S3 drops the neighbour and reroutes via S2 (cost 12); reconnecting restores", () => {
    advance(12_000);
    const c = conn("S1", "if1", "S3", "if0");
    S().disconnect(c.id);
    advance(200);
    expect(nbrs("S1").map((n) => n.rid)).toEqual(["2.2.2.2"]);
    expect(o6("S1", "2001:db8:3::")).toEqual([expect.objectContaining({ nextHop: ll("S2", "Ethernet0"), metric: 12 })]);
    expect(host("H1", `ping6 -c 1 ${h3Addr()}`)).toMatch(/hlim=61/);
    S().connect(c.a.deviceId, c.a.interfaceId, c.b.deviceId, c.b.interfaceId);
    advance(12_000);
    expect(nbrs("S1").every((n) => n.state === "Full")).toBe(true);
    expect(o6("S1", "2001:db8:3::")).toEqual([expect.objectContaining({ nextHop: ll("S3", "Ethernet0"), metric: 8 })]);
    expect(host("H1", `ping6 -c 1 ${h3Addr()}`)).toMatch(/hlim=62/);
  });

  it("FRR show formats: show ipv6 ospf6 neighbor / database, show ipv6 route", () => {
    advance(12_000);
    const nb = klish("S1", "show ipv6 ospf6 neighbor").split("\n");
    expect(nb[0]).toBe("Neighbor ID     Pri    DeadTime    State/IfState         Duration I/F[State]");
    expect(nb[1]).toMatch(/^2\.2\.2\.2           1    00:00:3\d     Full\/PointToPoint    00:00:0\d Ethernet0\[PointToPoint\]$/);
    expect(nb[2]).toMatch(/^3\.3\.3\.3 .* Ethernet1\[PointToPoint\]$/);

    const db = klish("S1", "show ipv6 ospf6 database");
    expect(db).toContain("        Area Scoped Link State Database (Area 0.0.0.0)");
    expect(db).toContain("Type LSId           AdvRouter       Age   SeqNum                        Payload");
    expect(db).toMatch(/Rtr  0\.0\.0\.0        1\.1\.1\.1 +\d+ 8000000\d +2\.2\.2\.2\/0\.0\.0\.1/);
    expect(db).toMatch(/INAP 0\.0\.0\.0        3\.3\.3\.3 +\d+ 80000001 +2001:db8:3::\/64/);
    expect(db).toContain("        I/F Scoped Link State Database (I/F Ethernet0 in Area 0.0.0.0)");
    expect(db).toMatch(new RegExp(`Lnk  0\\.0\\.0\\.1        2\\.2\\.2\\.2 +\\d+ 80000001 +${ll("S2", "Ethernet0")}`));
    expect(db).toContain("        AS Scoped Link State Database");

    const rib = klish("S1", "show ipv6 route");
    expect(rib).toContain("IPv6 unicast VRF default:");
    expect(rib).toContain("       R - RIPng, O - OSPFv3, I - IS-IS, B - BGP, N - NHRP,");
    expect(rib).toMatch(new RegExp(`O>\\* 2001:db8:3::/64 \\[110/8\\] via ${ll("S3", "Ethernet0")}, Ethernet1, weight 1, 00:00:\\d\\d`));
    expect(rib).toMatch(/C>\* 2001:db8:12::\/64 is directly connected, Ethernet0, /);
    expect(rib).toMatch(/O   2001:db8:12::\/64 \[110\/4\] is directly connected, Ethernet0, weight 1, /);
    expect(rib).toMatch(/L>\* 2001:db8:12::1\/128 is directly connected, Ethernet0, /);
    expect(rib).toMatch(/C>\* fe80::\/64 is directly connected, Ethernet0, /);
    expect(rib).toMatch(/C \* fe80::\/64 is directly connected, Ethernet1, /);
    expect(klish("S1", "show ipv6 route 2001:db8:3::/64").split("\n").filter((l) => l.startsWith("O"))).toHaveLength(1);
    // tcpdump text for an OSPFv3 Hello.
    const hello = S().captures.find((c) => c.frame.rawL3?.[6] === 89 && c.frame.rawL3[41] === 1)!.frame;
    expect(formatPacket(hello)[0]).toMatch(/^IP6 fe80::\S+ > ff02::5: OSPFv3, Hello, length 3[6-9]|40$/);
  });

  it("broadcast links elect a DR (Router IDs) and carry the transit prefix in Network + Intra-Area-Prefix LSAs", () => {
    for (const sw of ["S1", "S2"]) for (const l of ["configure terminal", "interface Ethernet 0", "no ipv6 ospf6 network", "end"]) klish(sw, l);
    advance(12_000);
    const st = (name: string) => ospf6Runtime(byName(name))!.oifs.find((o) => o.name === "Ethernet0")!;
    expect(st("S1").state).toBe("Waiting"); // WaitTimer = dead interval
    advance(35_000);
    expect(st("S2")).toMatchObject({ state: "DR", dr: "2.2.2.2", bdr: "1.1.1.1" });
    expect(st("S1")).toMatchObject({ state: "BDR", dr: "2.2.2.2" });
    expect(nbrs("S1").find((n) => n.rid === "2.2.2.2")!.state).toBe("Full");
    const db = ospf6Runtime(byName("S3"))!.lsdb["0.0.0.0"];
    expect(Object.keys(db)).toEqual(expect.arrayContaining(["2002/2.2.2.2/0.0.0.1", "2009/2.2.2.2/0.0.0.1"]));
    // S3 reaches the S1–S2 transit network through either router at cost 8.
    expect(o6("S3", "2001:db8:12::").map((r) => [r.nextHop, r.metric]).sort()).toEqual([[ll("S1", "Ethernet1"), 8], [ll("S2", "Ethernet1"), 8]].sort());
    expect(klish("S1", "show ipv6 ospf6 neighbor")).toMatch(/^2\.2\.2\.2 .* Full\/DR .* Ethernet0\[BDR\]$/m);
    expect(host("H1", `ping6 -c 1 ${h3Addr()}`)).toMatch(/1 received/);
  });

  it("a router without a route answers ICMPv6 Destination Unreachable (traceroute6 !N)", () => {
    advance(12_000);
    const tr = host("H1", "traceroute6 2001:db8:99::1").split("\n");
    expect(tr[1]).toMatch(/^ 1  2001:db8:1::1 \(2001:db8:1::1\)  \d+ ms !N$/);
    expect(tr).toHaveLength(2);
  });
});

describe("Scapy decodes the real bytes", () => {
  it("Router Advertisement and OSPFv3 Hello dissect cleanly and rebuild byte-identical (checksums)", async () => {
    advance(12_000);
    const ra = rasOut("S1", "Ethernet2")[0].frame.rawL3!;
    const hello = S().captures.find((c) => c.frame.rawL3?.[6] === 89 && c.frame.rawL3[41] === 1 && c.frame.rawL3[16 + 40 + 20 - 1] !== undefined)!.frame.rawL3!;
    const s1e2 = ll("S1", "Ethernet2");
    const s1mac = iface("S1", "Ethernet2").mac.toLowerCase();
    vi.useRealTimers();
    const eng = await nodePacketEngine();
    const field = (d: Awaited<ReturnType<typeof eng.dissect>>, proto: string, name: string) => d.layers.find((l) => l.proto === proto)?.fields.find((f) => f.name === name)?.value;

    const r = await eng.dissect(Uint8Array.from(ra), "IPv6");
    expect(r.layers.map((l) => l.proto)).toEqual(["IPv6", "ICMPv6ND_RA", "ICMPv6NDOptPrefixInfo", "ICMPv6NDOptMTU", "ICMPv6NDOptSrcLLAddr"]);
    expect(field(r, "IPv6", "hlim")).toBe("255");
    expect(field(r, "ICMPv6ND_RA", "routerlifetime")).toBe("540");
    expect(field(r, "ICMPv6NDOptPrefixInfo", "prefix")).toBe("2001:db8:1::");
    expect(field(r, "ICMPv6NDOptPrefixInfo", "A")).toBe("1");
    expect(field(r, "ICMPv6NDOptMTU", "mtu")).toBe("9100");
    const builtRa = await eng.build([
      { proto: "IPv6", fields: { src: s1e2, dst: "ff02::1", hlim: 255 } },
      { proto: "ICMPv6ND_RA", fields: { chlim: 64, prf: 0, routerlifetime: 540 } }, // radvd AdvDefaultPreference medium (Scapy defaults to high)
      { proto: "ICMPv6NDOptPrefixInfo", fields: { prefixlen: 64, L: 1, A: 1, validlifetime: 0xffffffff, preferredlifetime: 0xffffffff, prefix: "2001:db8:1::" } },
      { proto: "ICMPv6NDOptMTU", fields: { mtu: 9100 } },
      { proto: "ICMPv6NDOptSrcLLAddr", fields: { lladdr: s1mac } },
    ]);
    expect(Array.from(builtRa.bytes)).toEqual(ra);

    const h = await eng.dissect(Uint8Array.from(hello), "IPv6");
    expect(h.layers.map((l) => l.proto)).toEqual(["IPv6", "OSPFv3_Hdr", "OSPFv3_Hello"]);
    expect(field(h, "IPv6", "nh")).toBe("89");
    expect(field(h, "IPv6", "tc")).toBe("192");
    expect(field(h, "OSPFv3_Hello", "options")).toBe("V6+E+R");
    expect(field(h, "OSPFv3_Hello", "hellointerval")).toBe("10");
    expect(field(h, "OSPFv3_Hello", "deadinterval")).toBe("40");
    const ip = (b: number[], o: number) => b.slice(o, o + 4).join(".");
    const nbrList = Array.from({ length: (hello.length - 76) / 4 }, (_, i) => ip(hello, 76 + i * 4));
    const builtHello = await eng.build([
      { proto: "IPv6", fields: { src: h.layers[0].fields.find((f) => f.name === "src")!.value, dst: "ff02::5", hlim: 1, tc: 192 } },
      { proto: "OSPFv3_Hdr", fields: { src: ip(hello, 44), area: "0.0.0.0" } },
      { proto: "OSPFv3_Hello", fields: { intid: (hello[56] << 24) | (hello[57] << 16) | (hello[58] << 8) | hello[59], prio: 1, options: 0x13, hellointerval: 10, deadinterval: 40, router: ip(hello, 68), backup: ip(hello, 72), neighbors: nbrList } },
    ]);
    expect(Array.from(builtHello.bytes)).toEqual(hello);
  }, 120_000);
});
