import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { mclagRuntime, ICCP_TCP_PORT } from "../lib/protocols/mclag-daemon";
import { lacpRuntime, systemMac } from "../lib/protocols/lacp-daemon";

const cli = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
const ping = (from: string, to: string, n = 2) => cli(from, `ping -c ${n} ${to}`);
const pc = (dev: string) => byName(dev).interfaces.find((i) => i.name === "PortChannel1")!;
const macOf = (h: string) => byName(h).interfaces[0].mac;
const fdbPort = (sw: string, mac: string) => {
  const d = byName(sw);
  const e = d.macTable.find((m) => m.mac.toUpperCase() === mac.toUpperCase());
  return e && d.interfaces.find((i) => i.id === e.interfaceId)?.name;
};
const cable = (dev: string, ifIdx: number) =>
  S().network.connections.find((c) => (c.a.deviceId === byName(dev).id && c.a.interfaceId.endsWith(`-if${ifIdx}`)) || (c.b.deviceId === byName(dev).id && c.b.interfaceId.endsWith(`-if${ifIdx}`)))!.id;
const s3Enabled = () => Object.entries(lacpRuntime(byName("S3"))!.lags.PortChannel1.ports).filter(([, p]) => p.enabled).map(([n]) => n).sort();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("mclag");
});
afterEach(() => vi.useRealTimers());

describe("MCLAG (iccpd) on the mclag lab", () => {
  it("ICCP comes up over TCP 8888: P1 (lower IP) Active, P2 Standby, same system MAC", () => {
    advance(3000);
    const r1 = mclagRuntime(byName("P1"))!;
    const r2 = mclagRuntime(byName("P2"))!;
    expect(r1.session && r2.session).toBe(true);
    expect([r1.role, r2.role]).toEqual(["active", "standby"]);
    const tcp = S().captures.filter((c) => c.frame.tcp && (c.frame.tcp.dstPort === ICCP_TCP_PORT || c.frame.tcp.srcPort === ICCP_TCP_PORT));
    expect(tcp.some((c) => c.frame.tcp!.flags.join() === "SYN" && c.frame.ipv4!.srcIp === "10.0.0.1")).toBe(true);
    expect(tcp.some((c) => c.frame.tcp!.flags.includes("SYN") && c.frame.tcp!.flags.includes("ACK") && c.frame.ipv4!.srcIp === "10.0.0.2")).toBe(true);
    const sys = systemMac(byName("P1")).toLowerCase();
    for (const p of ["P1", "P2"]) {
      const brief = cli(p, "show mclag brief");
      expect(brief).toContain(`Role                 : ${p === "P1" ? "active" : "standby"}`);
      expect(brief).toContain("Session Status       : up");
      expect(brief).toContain("Peer Link Status     : up");
      expect(brief).toContain("Keepalive Interval   : 1 secs");
      expect(brief).toContain("Session Timeout      : 30 secs");
      expect(brief).toContain(`System Mac           : ${sys}`);
      expect(brief).toContain("Number of MLAG Interfaces:1");
      expect(brief).toMatch(/PortChannel1 {13}up\/up/);
    }
  });

  it("the Standby presents the Active's system ID, so S3 bonds both links into ONE LAG", () => {
    advance(3000);
    expect(pc("P2").mac.toUpperCase()).toBe(systemMac(byName("P1")).toUpperCase());
    const s3 = lacpRuntime(byName("S3"))!.lags.PortChannel1.ports;
    expect(s3.Ethernet0.partner.system).toBe(s3.Ethernet1.partner.system);
    expect(s3Enabled()).toEqual(["Ethernet0", "Ethernet1"]);
    expect(cli("S3", "show PortChannel summary")).toContain("Ethernet0(P), Ethernet1(P)");
  });

  it("the dual-homed host pings hosts behind each peer; orphan hosts reach each other", () => {
    advance(3000);
    expect(ping("H3", "192.168.10.11")).toMatch(/2 received/);
    expect(ping("H3", "192.168.10.12")).toMatch(/2 received/);
    expect(ping("H1", "192.168.10.12")).toMatch(/2 received/);
  });

  it("MAC sync: MACs learned on one peer are installed on the other (MLAG → local PortChannel, orphan → peer-link)", () => {
    advance(3000);
    expect(ping("H3", "192.168.10.11")).toMatch(/2 received/);
    expect(ping("H2", "192.168.10.13")).toMatch(/2 received/);
    advance(300);
    // H3 (behind the MLAG) is on PortChannel1 on BOTH peers, at least one of them via ICCP.
    expect(fdbPort("P1", macOf("H3"))).toBe("PortChannel1");
    expect(fdbPort("P2", macOf("H3"))).toBe("PortChannel1");
    const key = `${macOf("H3").toUpperCase()}|10`;
    expect([mclagRuntime(byName("P1"))!.remoteMacs[key], mclagRuntime(byName("P2"))!.remoteMacs[key]]).toContain("PortChannel1");
    // Orphan MACs point at the peer-link on the other peer.
    expect(fdbPort("P2", macOf("H1"))).toBe("Ethernet1");
    expect(fdbPort("P1", macOf("H2"))).toBe("Ethernet1");
    expect(mclagRuntime(byName("P1"))!.installed[`${macOf("H2").toUpperCase()}|10`]).toBe(true);
  });

  it("peer-link isolation: a broadcast reaches the dual-homed switch exactly once", () => {
    advance(3000);
    expect(cli("P2", "show mclag interface 1 10")).toContain("IsolateWithPeerLink  : Yes");
    S().execCommand(byName("H1").id, "ping -c 1 192.168.10.13");
    const toS3 = S().events.filter((e) => e.type === "FRAME_SENT" && e.link?.toDeviceId === byName("S3").id && e.frame?.arp?.op === "request" && e.frame.arp.senderIp === "192.168.10.11");
    expect(toS3).toHaveLength(1);
    expect(toS3[0].deviceId).toBe(byName("P1").id); // P2 got it over the peer-link and did not flood it to PortChannel1
    expect(S().events.some((e) => e.type === "FRAME_FLOODED" && e.deviceId === byName("P2").id && /Ethernet3/.test(e.message) && !/PortChannel1/.test(e.message))).toBe(true);
  });

  it("failover: P1's MLAG link down → traffic to H3 crosses the peer-link and leaves P2", () => {
    advance(3000);
    expect(ping("H3", "192.168.10.11")).toMatch(/2 received/);
    S().disconnect(cable("P1", 0));
    advance(500);
    expect(pc("P1").operState).toBe("down");
    expect(cli("P1", "show mclag brief")).toMatch(/PortChannel1 {13}down\/up/);
    expect(cli("P2", "show mclag brief")).toMatch(/PortChannel1 {13}up\/down/);
    expect(cli("P2", "show mclag interface 1 10")).toContain("IsolateWithPeerLink  : No");
    expect(s3Enabled()).toEqual(["Ethernet1"]);
    for (const [a, b] of [["H3", "192.168.10.11"], ["H1", "192.168.10.13"], ["H3", "192.168.10.12"]]) expect(ping(a, b)).toMatch(/2 received/);
    // H1's replies to H3 leave P1 over the peer-link and P2 forwards them out of PortChannel1.
    expect(fdbPort("P1", macOf("H3"))).toBe("Ethernet1");
    expect(S().events.some((e) => e.type === "FRAME_SENT" && e.deviceId === byName("P2").id && e.link?.toDeviceId === byName("S3").id && e.frame?.icmp?.type === "echo-reply")).toBe(true);
  });

  it("ICCP session loss (keepalive link cut): down after session-timeout 30 s, Standby restores its MAC", () => {
    advance(3000);
    S().disconnect(cable("P1", 2));
    advance(20_000);
    expect(mclagRuntime(byName("P2"))!.session).toBe(true); // within the 30 s timeout
    advance(12_000);
    for (const p of ["P1", "P2"]) {
      expect(mclagRuntime(byName(p))!.session).toBe(false);
      expect(cli(p, "show mclag brief")).toContain("Session Status       : down");
    }
    expect(pc("P2").mac.toUpperCase()).not.toBe(systemMac(byName("P1")).toUpperCase());
    advance(3000);
    // S3 now sees two different partner systems: only one aggregator is selected.
    expect(s3Enabled()).toHaveLength(1);
    expect(ping("H3", "192.168.10.11")).toMatch(/2 received/);
    expect(ping("H3", "192.168.10.12")).toMatch(/2 received/);
  });
});
