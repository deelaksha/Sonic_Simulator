/** Daemon state transitions land in /var/log/syslog (`show logging`) with the real daemons' wording. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { BfdApi, BfdState, bfd, setBfdImpl } from "../lib/control/bfd-api";

const id = (dev: string) => byName(dev).id;
/** Bash command (switch terminals start in KLISH). */
function bash(dev: string, cmd: string): string {
  if (byName(dev).type === "switch" && (S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}
function klish(dev: string, ...lines: string[]): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return lines.map((l) => out(S().execCommand(id(dev), l))).join("\n");
}
const log = (dev: string, args = "") => bash(dev, `show logging ${args}`.trim());
const conn = (a: string, b: string) =>
  S().network.connections.find((c) => [c.a.deviceId, c.b.deviceId].sort().join() === [id(a), id(b)].sort().join())!;
/** rsyslog SONiCFileFormat: "<year> <Mon> <dd> <hh:mm:ss>.<usec> <host> <SEV> <tag>: <msg>" */
const LINE = /^\d{4} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d\.\d{6} \S+ (EMERG|ALERT|CRIT|ERR|WARNING|NOTICE|INFO|DEBUG) \S+: .+$/;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("bgpd %ADJCHANGE (bgp_fsm.c, log-neighbor-changes)", () => {
  beforeEach(() => S().loadFeatureLab("bgp"));

  it("logs neighbor Up with the peer's hostname, then Down 'Interface down' after the cable is cut", () => {
    advance(3000);
    const up = log("S1").split("\n");
    for (const l of up) expect(l).toMatch(LINE);
    expect(up).toContainEqual(expect.stringMatching(/ s1 INFO bgp#bgpd\[\d+\]: %ADJCHANGE: neighbor 10\.0\.12\.2\(S2\) in vrf default Up$/));
    expect(up).toContainEqual(expect.stringMatching(/ s1 INFO bgp#bgpd\[\d+\]: %ADJCHANGE: neighbor 10\.0\.13\.2\(S3\) in vrf default Up$/));
    S().disconnect(conn("S1", "S2").id);
    advance(500);
    const text = log("S1");
    expect(text).toMatch(/ s1 INFO bgp#bgpd\[\d+\]: %ADJCHANGE: neighbor 10\.0\.12\.2\(S2\) in vrf default Down Interface down$/m);
    expect(text).toMatch(/ s1 NOTICE swss#orchagent: :- updatePortOperStatus: Port Ethernet0 oper state set from up to down$/m);
    expect(text).toMatch(/ s1 NOTICE swss#orchagent: :- setHostIntfsOperStatus: Set operation status DOWN to host interface Ethernet0$/m);
    expect(log("S2")).toMatch(/%ADJCHANGE: neighbor 10\.0\.12\.1\(S1\) in vrf default Down Interface down$/m);
    // reconnect: oper up + session Up again
    S().connect(id("S1"), `${id("S1")}-if0`, id("S2"), `${id("S2")}-if0`);
    advance(3000);
    expect(log("S1")).toMatch(/Port Ethernet0 oper state set from down to up$/m);
    expect(log("S1", "-l 20").match(/neighbor 10\.0\.12\.2\(S2\) in vrf default Up/g)!.length).toBe(2);
  });

  it("neighbor shutdown: S1 logs 'Admin. shutdown', S2 'BGP Notification received'", () => {
    advance(3000);
    klish("S1", "configure terminal", "router bgp 65001", "neighbor 10.0.12.2", "shutdown", "end");
    advance(500);
    expect(log("S1", "bgpd -l 1")).toMatch(/%ADJCHANGE: neighbor 10\.0\.12\.2\(S2\) in vrf default Down Admin\. shutdown$/);
    expect(log("S2", "bgpd -l 1")).toMatch(/%ADJCHANGE: neighbor 10\.0\.12\.1\(S1\) in vrf default Down BGP Notification received$/);
  });

  it("`show logging -l N` tails and `show logging <process>` greps", () => {
    advance(3000);
    S().disconnect(conn("S1", "S2").id);
    advance(500);
    const all = log("S1").split("\n");
    expect(log("S1", "-l 2").split("\n")).toEqual(all.slice(-2));
    expect(log("S1", "--lines 3").split("\n")).toEqual(all.slice(-3));
    const bgpd = log("S1", "bgpd").split("\n");
    expect(bgpd.length).toBe(3);
    expect(bgpd.every((l) => l.includes("bgpd"))).toBe(true);
    expect(log("S1", "orchagent -l 1")).toMatch(/Set operation status DOWN to host interface Ethernet0$/);
    expect(log("S1", "--severity NOTICE").split("\n").every((l) => / NOTICE /.test(l))).toBe(true);
    expect(log("S1", "--level NOTICE")).not.toContain(" INFO ");
    expect(log("S1", "-l x")).toContain("Error: Invalid value for '-l' / '--lines': 'x' is not a valid integer.");
    expect(log("S1", "-f").split("\n")).toEqual(all.slice(-10));
  });

  it("BFD down tears BGP down: bgpd logs 'BFD down received' (bfdd's own state-change is debug-only)", () => {
    let state: BfdState = "up";
    const original = bfd();
    const fake: BfdApi = { register: () => {}, unregister: () => {}, state: () => state };
    setBfdImpl(fake);
    try {
      klish("S1", "configure terminal", "router bgp 65001", "neighbor 10.0.12.2", "bfd", "end");
      advance(3000);
      state = "down";
      advance(300);
      expect(log("S1", "bgpd -l 1")).toMatch(/%ADJCHANGE: neighbor 10\.0\.12\.2\(S2\) in vrf default Down BFD down received$/);
      expect(log("S1")).not.toContain("bfdd");
    } finally {
      setBfdImpl(original);
    }
  });
});

describe("bfdd", () => {
  it("a BFD session going Down writes no bfdd line (bfd.c state-change logs need `debug bfd peer`)", () => {
    S().loadFeatureLab("bfd");
    advance(2000);
    S().disconnect(conn("S1", "S2").id);
    advance(1500);
    const text = log("S1");
    expect(text).toMatch(/Port Ethernet0 oper state set from up to down$/m);
    expect(text).not.toContain("bfdd");
  });
});

describe("ospfd AdjChg (ospf_nsm.c:626-636)", () => {
  beforeEach(() => S().loadFeatureLab("ospf"));

  it("logs reaching Full and the KillNbr drop when the interface goes down; no intermediate states", () => {
    advance(12_000);
    const text = log("S1");
    expect(text).toMatch(/ s1 NOTICE bgp#ospfd\[\d+\]: AdjChg: Nbr 2\.2\.2\.2, NbrIP 10\.0\.12\.2 \(default\) on Ethernet0:10\.0\.12\.1: (Loading|Exchange) -> Full \((LoadingDone|ExchangeDone)\)$/m);
    expect(text).toMatch(/AdjChg: Nbr 3\.3\.3\.3, NbrIP 10\.0\.13\.2 \(default\) on Ethernet1:10\.0\.13\.1: (Loading|Exchange) -> Full/m);
    expect(text).not.toMatch(/-> (Init|2-Way|ExStart|Exchange|Loading) /); // upward non-Full changes need "detail"
    S().disconnect(conn("S1", "S2").id);
    advance(300);
    expect(log("S1", "ospfd -l 1")).toMatch(/AdjChg: Nbr 2\.2\.2\.2, NbrIP 10\.0\.12\.2 \(default\) on Ethernet0:10\.0\.12\.1: Full -> Deleted \(KillNbr\)$/);
  });
});

describe("teamd (teamd_runner_lacp.c:1483, :759)", () => {
  it("logs member port states and the carrier; a cut member goes current -> disabled", () => {
    S().loadFeatureLab("lacp");
    advance(3000);
    const text = log("S1");
    expect(text).toMatch(/ s1 INFO teamd#teamd_PortChannel1\[\d+\]: Ethernet0: Changed port state: "disabled" -> "expired"$/m);
    expect(text).toMatch(/teamd#teamd_PortChannel1\[\d+\]: Ethernet0: Changed port state: "expired" -> "current"$/m);
    expect(text).toMatch(/teamd#teamd_PortChannel1\[\d+\]: carrier changed to UP$/m);
    // S2 went through expired too (two changes inside one tick are both logged)
    expect(log("S2")).toMatch(/Ethernet0: Changed port state: "disabled" -> "expired"$/m);
    const cable0 = S().network.connections.find((c) => c.a.deviceId === id("S1") && c.a.interfaceId === `${id("S1")}-if0`)!.id;
    S().disconnect(cable0);
    advance(300);
    expect(log("S1", "teamd -l 1")).toMatch(/Ethernet0: Changed port state: "current" -> "disabled"$/);
  });
});

describe("vrrpd (vrrp.c:1476)", () => {
  it("logs Initialize -> Backup at startup and Backup -> Master on the winner", () => {
    S().loadFeatureLab("vrrp");
    advance(10_000);
    const s1 = log("S1", "vrrpd");
    expect(s1).toMatch(/ s1 INFO bgp#vrrpd\[\d+\]: \[CORE\] \[VRID 10\] \[IPv4\] Initialize -> Backup$/m);
    expect(s1).toMatch(/\[CORE\] \[VRID 10\] \[IPv4\] Backup -> Master$/m);
    expect(log("S2", "vrrpd")).not.toContain("-> Master");
  });
});

describe("iccpd (iccp_csm.c:377)", () => {
  it("logs the ICCP session reaching OPERATIONAL on both peers", () => {
    S().loadFeatureLab("mclag");
    advance(3000);
    for (const p of ["P1", "P2"]) expect(log(p, "iccpd")).toMatch(/ NOTICE iccpd#iccpd: \[iccp_csm_transit\.NOTICE\] csm \d+ change state from CAPREC to OPERATIONAL\.$/m);
  });
});

describe("portmgrd / snmpd", () => {
  it("admin shutdown logs portmgrd 'Configure … admin status to down' before the oper change", () => {
    S().loadFeatureLab("bgp");
    advance(3000);
    S().setAdminState(id("S1"), `${id("S1")}-if1`, false);
    advance(300);
    const lines = log("S1", "swss").split("\n");
    const a = lines.findIndex((l) => / NOTICE swss#portmgrd: :- doTask: Configure Ethernet1 admin status to down$/.test(l));
    const o = lines.findIndex((l) => /Port Ethernet1 oper state set from up to down$/.test(l));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(o).toBeGreaterThan(a);
    expect(log("S1")).toMatch(/ s1 INFO snmp#snmpd\[\d+\]: NET-SNMP version 5\.9\.3$/m);
  });
});
