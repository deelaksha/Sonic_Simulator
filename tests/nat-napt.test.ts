/** NAT / NAPT on the l3-services lab (lib/protocols/nat.ts, nat-daemon.ts). */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";
import { bash, klish, tcpdump, id } from "./nat-helpers";
import { peekNat } from "../lib/protocols/nat";
import { frameToBytes, inetChecksum } from "../lib/sflow/wire";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("l3-services");
  advance(6000); // IP SLA 1 Up → tracked default route installed
});
afterEach(() => vi.useRealTimers());

describe("dynamic NAPT (pool binding)", () => {
  it("two inside hosts to the same outside host get distinct ports; return traffic is translated back", () => {
    const seen = tcpdump("WEB", "-i eth0 tcp", () => {
      expect(bash("H1", "nc -v 203.0.113.10 80 hello")).toMatch(/succeeded![\s\S]*200 OK/);
      expect(bash("H2", "nc -v 203.0.113.10 80 hi")).toMatch(/succeeded![\s\S]*200 OK/);
    });
    // The outside host only ever sees the pool address, on two different ports.
    expect(seen).toMatch(/IP 100\.64\.0\.1\.20000 > 203\.0\.113\.10\.80: Flags \[S\]/);
    expect(seen).toMatch(/IP 100\.64\.0\.1\.20001 > 203\.0\.113\.10\.80: Flags \[S\]/);
    expect(seen).not.toMatch(/192\.168\./);

    const t = klish("S1", "show nat translations");
    expect(t).toMatch(/Dynamic NAPT Entries\s+\.+ 4/);
    expect(t).toMatch(/tcp\s+192\.168\.1\.10:45000\s+---\s+100\.64\.0\.1:20000\s+---/);
    expect(t).toMatch(/tcp\s+---\s+100\.64\.0\.1:20000\s+---\s+192\.168\.1\.10:45000/);
    expect(t).toMatch(/tcp\s+192\.168\.2\.10:45000\s+---\s+100\.64\.0\.1:20001\s+---/);
    // Click form (sonic-utilities natshow -t) renders the same table.
    expect(bash("S1", "show nat translations")).toContain("100.64.0.1:20001");
    expect(bash("S1", "show nat translations count")).toMatch(/Total Entries\s+\.+ 6/);
  });

  it("rewrites the real bytes: checksums stay valid on the outside", () => {
    bash("H1", "nc 203.0.113.10 80 hello");
    const cap = S().captures.find((c) => c.deviceId === id("WEB") && c.dir === "rx" && c.frame.tcp && c.frame.rawL3)!;
    expect(cap.frame.ipv4!.srcIp).toBe("100.64.0.1");
    const b = Array.from(frameToBytes(cap.frame)).slice(14);
    expect(b.slice(12, 16)).toEqual([100, 64, 0, 1]);
    expect(inetChecksum(b.slice(0, 20))).toBe(0);
    const len = (b[2] << 8) | b[3];
    const seg = b.slice(20, len);
    expect((seg[0] << 8) | seg[1]).toBe(20000);
    expect(inetChecksum([...b.slice(12, 20), 0, 6, seg.length >> 8, seg.length & 0xff, ...seg])).toBe(0);
  });

  it("ICMP: ping works through NAT, tcpdump shows the translation, but the ASIC table does not list it", () => {
    const outside = tcpdump("WEB", "-i eth0 icmp", () => {
      expect(bash("H1", "ping -c 2 203.0.113.10")).toContain("2 received");
    });
    expect(outside).toMatch(/IP 100\.64\.0\.1 > 203\.0\.113\.10: ICMP echo request/);
    expect(outside).toMatch(/IP 203\.0\.113\.10 > 100\.64\.0\.1: ICMP echo reply/);
    const inside = tcpdump("H1", "-i eth0 icmp", () => bash("H1", "ping -c 1 203.0.113.10"));
    expect(inside).toMatch(/IP 203\.0\.113\.10 > 192\.168\.1\.10: ICMP echo reply/);
    expect(peekNat(byName("S1"))!.entries.some((e) => e.proto === "icmp" && e.inIp === "192.168.1.10")).toBe(true);
    // natsync.cpp:215-217: ICMP entries are kernel-only.
    expect(klish("S1", "show nat translations")).toMatch(/Dynamic NAPT Entries\s+\.+ 0/);
    // Kernel conntrack ages ICMP after 30 s.
    advance(31_000, 1000);
    expect(peekNat(byName("S1"))!.entries.some((e) => e.proto === "icmp")).toBe(false);
  });

  it("statistics count translated packets; clear nat translations / statistics", () => {
    bash("H1", "nc 203.0.113.10 80 hello");
    const st = klish("S1", "show nat statistics");
    expect(st).toMatch(/tcp\s+192\.168\.1\.10:45000\s+---\s+[1-9]\d*\s+[1-9]\d*/);
    expect(st).toMatch(/tcp\s+---\s+100\.64\.0\.1:20000\s+[1-9]\d*\s+[1-9]\d*/);
    expect(klish("S1", "clear nat statistics")).toContain("NAT statistics are cleared.");
    expect(klish("S1", "show nat statistics")).toMatch(/tcp\s+192\.168\.1\.10:45000\s+---\s+0\s+0/);
    expect(klish("S1", "clear nat translations")).toContain("Dynamic NAT entries are cleared.");
    const t = klish("S1", "show nat translations");
    expect(t).not.toContain("20000");
    expect(t).toMatch(/Static NAPT Entries\s+\.+ 2/); // static entries stay programmed
  });

  it("dynamic entries age out after the configured tcp-timeout", () => {
    bash("H1", "nc 203.0.113.10 80 hello");
    klish("S1", "configure terminal", "nat", "tcp-timeout 300", "end");
    advance(290_000, 1000);
    expect(klish("S1", "show nat translations")).toContain("100.64.0.1:20000");
    advance(15_000, 1000);
    expect(klish("S1", "show nat translations")).not.toContain("100.64.0.1:20000");
  });

  it("the binding ACL decides which inside hosts are translated (deny / no match = no NAT)", () => {
    klish("S1", "configure terminal", "ip access-list NAT-ACL", "seq 10 permit ip 192.168.2.0/24 any", "exit", "nat", "binding LAN INET NAT-ACL", "end");
    bash("H2", "nc 203.0.113.10 80 hi");
    const t = klish("S1", "show nat translations");
    expect(t).toContain("192.168.2.10:45000");
    // H1 is not permitted: it leaves untranslated and the outside cannot route back to it.
    const seen = tcpdump("WEB", "-i eth0 tcp", () => bash("H1", "nc 203.0.113.10 80 x"));
    expect(seen).toMatch(/IP 192\.168\.1\.10\.45000 > 203\.0\.113\.10\.80/);
  });
});

describe("static NAT / NAPT", () => {
  it("static basic NAT maps one inside host 1:1 in both directions", () => {
    klish("S1", "configure terminal", "nat", "static basic 100.64.0.50 192.168.1.10", "end");
    const seen = tcpdump("WEB", "-i eth0 icmp", () => expect(bash("H1", "ping -c 1 203.0.113.10")).toContain("1 received"));
    expect(seen).toMatch(/IP 100\.64\.0\.50 > 203\.0\.113\.10: ICMP echo request/);
    // Unsolicited inbound to the global address reaches the inside host.
    bash("H1", "nc -l 7000");
    expect(bash("WEB", "nc -v 100.64.0.50 7000 inbound")).toMatch(/succeeded/);
    const t = klish("S1", "show nat translations");
    expect(t).toMatch(/Static NAT Entries\s+\.+ 2/);
    expect(t).toMatch(/all\s+192\.168\.1\.10\s+---\s+100\.64\.0\.50\s+---/);
    expect(t).toMatch(/all\s+---\s+100\.64\.0\.50\s+---\s+192\.168\.1\.10/);
  });

  it("static NAPT forwards outside port 8080 to the inside server port 80", () => {
    bash("H1", "nc -l 80");
    const inside = tcpdump("H1", "-i eth0 tcp", () => expect(bash("WEB", "nc -v 100.64.0.1 8080 GET")).toMatch(/succeeded/));
    expect(inside).toMatch(/IP 203\.0\.113\.10\.\d+ > 192\.168\.1\.10\.80: Flags \[S\]/);
    expect(inside).toMatch(/IP 192\.168\.1\.10\.80 > 203\.0\.113\.10\.\d+: Flags \[S\.\]/);
    expect(klish("S1", "show nat statistics")).toMatch(/tcp\s+---\s+100\.64\.0\.1:8080\s+[1-9]/);
  });

  it("NAT disabled: nothing is translated and the tables are empty", () => {
    klish("S1", "configure terminal", "nat", "no enable", "end");
    const seen = tcpdump("WEB", "-i eth0 icmp", () => bash("H1", "ping -c 1 203.0.113.10"));
    expect(seen).toMatch(/IP 192\.168\.1\.10 > 203\.0\.113\.10/);
    expect(klish("S1", "show nat translations")).toMatch(/Total Entries\s+\.+ 0/);
  });
});
