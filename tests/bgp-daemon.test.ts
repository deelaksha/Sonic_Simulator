import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekBgpRuntime, PeerRt } from "../lib/protocols/bgp-daemon";
import { decodeMessages } from "../lib/protocols/bgp-wire";
import { l4Payload } from "../lib/control/packet";
import { formatPacket } from "../lib/commands/tcpdump";
import { CaptureRecord } from "../lib/engine";

const peer = (sw: string, ip: string): PeerRt => peekBgpRuntime(byName(sw))!.peers[ip];
const sh = (sw: string, cmd: string) => out(S().execCommand(byName(sw).id, cmd));
const bgpRoute = (sw: string, dest: string) => byName(sw).routingTable.find((r) => r.type === "bgp" && r.destination === dest);
const conn = (a: string, ai: number, b: string, bi: number) =>
  S().network.connections.find(
    (c) =>
      (c.a.deviceId === byName(a).id && c.a.interfaceId === `${byName(a).id}-if${ai}` && c.b.deviceId === byName(b).id && c.b.interfaceId === `${byName(b).id}-if${bi}`) ||
      (c.b.deviceId === byName(a).id && c.b.interfaceId === `${byName(a).id}-if${ai}` && c.a.deviceId === byName(b).id && c.a.interfaceId === `${byName(b).id}-if${bi}`),
  )!;

/** BGP segments S1 transmitted towards `dst` (in capture order). */
function bgpTx(sw: string, dst: string): CaptureRecord[] {
  const id = byName(sw).id;
  return S().captures.filter((c) => c.deviceId === id && c.dir === "tx" && c.frame.ipv4?.dstIp === dst && (c.frame.tcp?.dstPort === 179 || c.frame.tcp?.srcPort === 179));
}
const msgTypes = (recs: CaptureRecord[]) => recs.flatMap((c) => decodeMessages(l4Payload(c.frame) ?? new Uint8Array(), true).map((m) => m.type));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("bgp");
});
afterEach(() => vi.useRealTimers());

describe("BGP daemon on the routed triangle (eBGP 65001/65002/65003)", () => {
  it("TCP 3-way handshake, OPEN/KEEPALIVE → Established on all three sessions", () => {
    advance(300);
    for (const [sw, peers] of [
      ["S1", ["10.0.12.2", "10.0.13.2"]],
      ["S2", ["10.0.12.1", "10.0.23.2"]],
      ["S3", ["10.0.13.1", "10.0.23.1"]],
    ] as const) {
      for (const ip of peers) expect(peer(sw, ip).state, `${sw}→${ip}`).toBe("Established");
    }
    // S1 opened S1–S2 actively: SYN from an ephemeral port, then ACK, then OPEN.
    const s1 = byName("S1");
    const rx = S().captures.filter((c) => c.deviceId === s1.id && c.dir === "rx" && c.frame.ipv4?.srcIp === "10.0.12.2" && c.frame.tcp);
    const tx = bgpTx("S1", "10.0.12.2");
    expect(tx[0].frame.tcp!.flags).toEqual(["SYN"]);
    expect(tx[0].frame.tcp!.dstPort).toBe(179);
    expect(tx[0].frame.tcp!.srcPort).toBeGreaterThanOrEqual(32768);
    expect(rx[0].frame.tcp!.flags).toEqual(["SYN", "ACK"]);
    expect(rx[0].frame.tcp!.ack).toBe((tx[0].frame.tcp!.seq + 1) >>> 0);
    expect(tx[1].frame.tcp!.flags).toEqual(["ACK"]);
    expect(msgTypes(tx).slice(0, 2)).toEqual([1, 4]); // OPEN, KEEPALIVE
    // seq/ack accounting: each data segment starts where the previous one ended
    const data = tx.filter((c) => (l4Payload(c.frame)?.length ?? 0) > 0);
    for (let i = 1; i < data.length; i++) expect(data[i].frame.tcp!.seq).toBe((data[i - 1].frame.tcp!.seq + l4Payload(data[i - 1].frame)!.length) >>> 0);
    // negotiated timers (traditional profile 60/180)
    expect(peer("S1", "10.0.12.2")).toMatchObject({ holdTime: 180, keepalive: 60, remoteAs: 65002, remoteId: "2.2.2.2" });
  });

  it("exchanges prefixes, prefers the shorter AS path, installs eBGP routes and H1↔H3 ping works", () => {
    advance(300);
    const r = bgpRoute("S1", "192.168.3.0")!;
    expect(r).toMatchObject({ nextHop: "10.0.13.2", distance: 20, prefix: 24 });
    expect(bgpRoute("S3", "192.168.1.0")).toMatchObject({ nextHop: "10.0.13.1" });
    expect(bgpRoute("S2", "192.168.1.0")).toMatchObject({ nextHop: "10.0.12.1" });
    const table = sh("S1", "show ip bgp");
    expect(table).toContain("BGP table version is");
    expect(table).toContain("     Network          Next Hop            Metric LocPrf Weight Path");
    expect(table).toMatch(/^ \*>  192\.168\.1\.0\/24   0\.0\.0\.0                  0         32768 i$/m);
    // S3 originates with MED 0 (network → igp metric), so S1 shows Metric 0 on the direct path only
    expect(table).toMatch(/^ \*>  192\.168\.3\.0\/24   10\.0\.13\.2                0             0 65003 i$/m);
    expect(table).toMatch(/^ \* {20}10\.0\.12\.2 {30}0 65002 65003 i$/m);
    expect(table).toContain("Displayed 2 routes and 3 total paths");
    expect(sh("S1", "show ip route")).toMatch(/B>\* 192\.168\.3\.0\/24 \[20\/0\] via 10\.0\.13\.2, Ethernet1, weight 1/);
    S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10");
    expect(out(S().execCommand(byName("H1").id, "ping -c 2 192.168.3.10"))).toMatch(/2 received/);
  });

  it("FRR-format show ip bgp summary / neighbors", () => {
    advance(300);
    vi.advanceTimersByTime(65_000);
    S().controlTick();
    const sum = sh("S1", "show ip bgp summary");
    expect(sum).toContain("IPv4 Unicast Summary:");
    expect(sum).toContain("BGP router identifier 1.1.1.1, local AS number 65001 VRF default vrf-id 0");
    expect(sum).toContain("Neighbor        V         AS   MsgRcvd   MsgSent   TblVer  InQ OutQ  Up/Down State/PfxRcd   PfxSnt Desc");
    expect(sum).toMatch(/^10\.0\.12\.2       4      65002 +\d+ +\d+ +\d+    0    0 00:01:0\d            1        2 N\/A$/m);
    // to S3 only 192.168.1.0/24 (192.168.3.0/24 is never sent back to its sender)
    expect(sum).toMatch(/^10\.0\.13\.2       4      65003 .* 00:01:0\d            1        1 N\/A$/m);
    expect(sum).toContain("Total number of neighbors 2");
    const nb = sh("S1", "show ip bgp neighbors 10.0.12.2");
    expect(nb).toContain("BGP neighbor is 10.0.12.2, remote AS 65002, local AS 65001, external link");
    expect(nb).toContain("  BGP version 4, remote router ID 2.2.2.2, local router ID 1.1.1.1");
    expect(nb).toMatch(/  BGP state = Established, up for 00:01:0\d/);
    expect(nb).toContain("  Hold time is 180 seconds, keepalive interval is 60 seconds");
    expect(nb).toMatch(/    Keepalives: +2 +2/);
    expect(nb).toContain("    4 Byte AS: advertised and received");
    expect(nb).toContain("  Last reset never");
    // KLISH template variant
    const klish = sh("S1", "show bgp ipv4 unicast summary");
    expect(klish).toContain("Total number of neighbors established 2");
  });

  it("cut S1–S3: fast-external-failover resets at once, reroutes via AS 65002, recovers on reconnect", () => {
    advance(300);
    const c = conn("S1", 1, "S3", 0);
    S().disconnect(c.id);
    advance(200);
    expect(peer("S1", "10.0.13.2").state).not.toBe("Established");
    expect(peer("S1", "10.0.13.2").lastReset?.reason).toBe("Interface down");
    expect(peer("S3", "10.0.13.1").lastReset?.reason).toBe("Interface down");
    expect(bgpRoute("S1", "192.168.3.0")).toMatchObject({ nextHop: "10.0.12.2" });
    expect(bgpRoute("S3", "192.168.1.0")).toMatchObject({ nextHop: "10.0.23.1" });
    expect(sh("S1", "show ip bgp")).toMatch(/^ \*>  192\.168\.3\.0\/24   10\.0\.12\.2 +0 65002 65003 i$/m);
    expect(sh("S1", "show ip bgp neighbors 10.0.13.2")).toMatch(/Last reset 00:00:00,  Interface down \(n\/a\)/);
    expect(out(S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10"))).toMatch(/1 received/);

    S().connect(byName("S1").id, `${byName("S1").id}-if1`, byName("S3").id, `${byName("S3").id}-if0`);
    advance(125_000, 500);
    expect(peer("S1", "10.0.13.2").state).toBe("Established");
    expect(peer("S1", "10.0.13.2").established).toBe(2);
    expect(bgpRoute("S1", "192.168.3.0")).toMatchObject({ nextHop: "10.0.13.2" });
  });

  it("silent peer failure: hold timer expires after 180 s → NOTIFICATION 4 (Hold Timer Expired)", () => {
    advance(300);
    // S3 loses its address on the S1 link (port stays up, no FIN/NOTIFICATION reaches S1)
    S().clearInterfaceIp(byName("S3").id, `${byName("S3").id}-if0`, "10.0.13.2");
    advance(170_000, 1000);
    expect(peer("S1", "10.0.13.2").state).toBe("Established");
    advance(15_000, 1000);
    const p = peer("S1", "10.0.13.2");
    expect(p.lastReset?.notify).toEqual({ code: 4, subcode: 0, dir: "sent" });
    expect(p.sent.notify).toBe(1);
    const notif = bgpTx("S1", "10.0.13.2").filter((c) => msgTypes([c]).includes(3)).pop()!;
    const m = decodeMessages(l4Payload(notif.frame)!, true)[0];
    expect(m).toMatchObject({ type: 3, code: 4, subcode: 0 });
    expect(sh("S1", "show ip bgp neighbors 10.0.13.2")).toMatch(/Last reset \d\d:\d\d:\d\d,  Notification sent \(Hold Timer Expired\)/);
    expect(bgpRoute("S1", "192.168.3.0")).toMatchObject({ nextHop: "10.0.12.2" });
  });

  it("bad peer AS → NOTIFICATION 2/2 (OPEN Message Error/Bad Peer AS)", () => {
    S().execCommand(byName("S2").id, "configure terminal");
    S().execCommand(byName("S2").id, "router bgp 65002");
    S().execCommand(byName("S2").id, "neighbor 10.0.12.1 remote-as 65099");
    advance(300);
    expect(peer("S2", "10.0.12.1").state).not.toBe("Established");
    expect(peer("S2", "10.0.12.1").lastReset?.notify).toEqual({ code: 2, subcode: 2, dir: "sent" });
    expect(peer("S1", "10.0.12.2").lastReset?.notify).toEqual({ code: 2, subcode: 2, dir: "received" });
    expect(sh("S1", "show ip bgp neighbors 10.0.12.2")).toContain("Notification received (OPEN Message Error/Bad Peer AS)");
  });

  it("loop prevention: a path carrying our own AS is rejected (re-established S1–S3 learns 65003 65002 65001)", () => {
    advance(300);
    S().disconnect(conn("S1", 1, "S3", 0).id);
    advance(200);
    // S3 now reaches 192.168.1.0/24 only via S2 (path 65002 65001)
    expect(bgpRoute("S3", "192.168.1.0")).toMatchObject({ nextHop: "10.0.23.1" });
    S().connect(byName("S1").id, `${byName("S1").id}-if1`, byName("S3").id, `${byName("S3").id}-if0`);
    advance(125_000, 500);
    const p = peer("S1", "10.0.13.2");
    expect(p.state).toBe("Established");
    expect(p.aspathLoop).toBeGreaterThan(0);
    // S1 never stores (or installs) its own prefix learned back from a peer
    for (const ip of ["10.0.12.2", "10.0.13.2"]) expect(peer("S1", ip).adjIn["192.168.1.0/24"]).toBeUndefined();
    expect(bgpRoute("S1", "192.168.1.0")).toBeUndefined();
  });

  it("neighbor shutdown sends Cease/Administrative Shutdown; the peer shows Notification received", () => {
    advance(300);
    S().execCommand(byName("S1").id, "configure terminal");
    S().execCommand(byName("S1").id, "router bgp 65001");
    S().execCommand(byName("S1").id, "neighbor 10.0.12.2");
    S().execCommand(byName("S1").id, "shutdown");
    advance(300);
    expect(peer("S1", "10.0.12.2").state).toBe("Idle");
    expect(peer("S2", "10.0.12.1").lastReset?.notify).toEqual({ code: 6, subcode: 2, dir: "received" });
    expect(sh("S1", "do show ip bgp summary")).toMatch(/^10\.0\.12\.2 .* 00:00:00 Idle \(Admin\)        0 N\/A$/m);
    // S2 keeps retrying; S1 refuses with RST → S2 sits in Active
    advance(3_000);
    expect(peer("S2", "10.0.12.1").state).toBe("Active");
  });

  it("tcpdump -nn decodes the TCP/BGP segments", () => {
    advance(300);
    const s1 = byName("S1");
    const ka = S().captures.find((c) => c.deviceId === s1.id && c.dir === "tx" && msgTypes([c]).join() === "4")!;
    const line = formatPacket(ka.frame, {})[0];
    expect(line).toMatch(/^IP 10\.0\.1[23]\.1\.\d+ > 10\.0\.1[23]\.2\.\d+: Flags \[P\.\], seq \d+:\d+, ack \d+, win 502, length 19: BGP$/);
    const open = S().captures.find((c) => c.deviceId === s1.id && c.dir === "tx" && msgTypes([c]).join() === "1")!;
    const v = formatPacket(open.frame, { verbose: true })[0];
    expect(v).toContain("\tOpen Message (1), length: ");
    expect(v).toContain("Version 4, my AS 65001, Holdtime 180s, ID 1.1.1.1");
    const syn = S().captures.find((c) => c.deviceId === s1.id && c.dir === "tx" && c.frame.tcp?.flags.join() === "SYN")!;
    expect(formatPacket(syn.frame, {})[0]).toMatch(/Flags \[S\], seq \d+, win 64240, length 0$/);
  });
});
