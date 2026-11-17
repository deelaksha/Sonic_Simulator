/**
 * Cross-protocol integration on the shared triangle: the real BFD daemon driving
 * OSPF and BGP failover, and every control protocol visible on the wire at once.
 *
 * "Silent failure": the S1–S3 link is rebuilt through an L2 switch (L2X), and
 * the cable L2X–S3 is pulled. S1's Ethernet1 keeps carrier, so only BFD (or the
 * protocol's own dead/hold timer) can notice that S3 is gone.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

const show = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));

/** Re-cable S1 Ethernet1 ↔ S3 Ethernet0 through an L2 switch; returns the L2X–S3 connection id. */
function viaL2Switch(): string {
  const s1 = byName("S1").id;
  const s3 = byName("S3").id;
  const direct = S().network.connections.find(
    (c) => [c.a.interfaceId, c.b.interfaceId].includes(`${s1}-if1`) && [c.a.interfaceId, c.b.interfaceId].includes(`${s3}-if0`),
  )!;
  S().disconnect(direct.id);
  const l2 = S().addDevice("switch", { x: 300, y: 260 }, 2);
  S().renameDevice(l2, "L2X");
  S().connect(s1, `${s1}-if1`, l2, `${l2}-if0`);
  S().connect(l2, `${l2}-if1`, s3, `${s3}-if0`);
  return S().network.connections.find((c) => [c.a.deviceId, c.b.deviceId].includes(l2) && [c.a.deviceId, c.b.deviceId].includes(s3))!.id;
}

/** Route S1 uses for H3's subnet, e.g. "via 10.0.13.2". */
/** FRR 10 summary row for an Established peer: Up/Down then State/PfxRcd = 1 prefix, PfxSnt, Desc. */
const ESTABLISHED_S3 = /^10\.0\.13\.2\s+4\s+65003(\s+\d+){5}\s+\d\d:\d\d:\d\d\s+1\s+\d+\s+N\/A$/m;
const routeToH3 = () => show("S1", "show ip route").split("\n").find((l) => l.includes("192.168.3.0/24") && l.includes(">"));

describe("BFD drives OSPF and BGP failover (real daemons)", () => {
  it("OSPF with `ip ospf bfd`: silent failure detected in ~1 s instead of the 40 s dead interval", () => {
    S().loadFeatureLab("ospf");
    const cut = viaL2Switch();
    S().runCliScript(byName("S1").id, ["configure terminal", "interface Ethernet 1", "ip ospf bfd", "end"]);
    S().runCliScript(byName("S3").id, ["configure terminal", "interface Ethernet 0", "ip ospf bfd", "end"]);
    for (const s of ["S1", "S2", "S3"]) S().execCommand(byName(s).id, "exit");
    advance(25_000);
    expect(show("S1", "show ip ospf neighbor")).toMatch(/3\.3\.3\.3\s.*Full/);
    expect(show("S1", "show bfd peers brief")).toMatch(/10\.0\.13\.2.*up/i);
    expect(routeToH3()).toContain("via 10.0.13.2");

    S().disconnect(cut);
    advance(1500);
    // S1 Ethernet1 still has carrier (L2X is up), yet BFD tore the adjacency down.
    expect(byName("S1").interfaces.find((i) => i.name === "Ethernet1")!.operState).toBe("up");
    expect(show("S1", "show ip ospf neighbor")).not.toMatch(/3\.3\.3\.3/);
    expect(routeToH3()).toContain("via 10.0.12.2"); // rerouted through S2
    expect(out(S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10"))).toMatch(/1 received/);
  });

  it("OSPF without BFD waits for the dead interval on the same silent failure", () => {
    S().loadFeatureLab("ospf");
    const cut = viaL2Switch();
    S().execCommand(byName("S1").id, "exit");
    advance(25_000);
    expect(show("S1", "show ip ospf neighbor")).toMatch(/3\.3\.3\.3\s.*Full/);
    S().disconnect(cut);
    advance(5_000);
    expect(show("S1", "show ip ospf neighbor")).toMatch(/3\.3\.3\.3/); // still listed
    advance(40_000);
    expect(show("S1", "show ip ospf neighbor")).not.toMatch(/3\.3\.3\.3/);
    expect(routeToH3()).toContain("via 10.0.12.2");
  });

  it("BGP with `neighbor bfd`: silent failure resets the session in ~1 s instead of the 180 s hold time", () => {
    S().loadFeatureLab("bgp");
    const cut = viaL2Switch();
    S().runCliScript(byName("S1").id, ["configure terminal", "router bgp 65001", "neighbor 10.0.13.2", "bfd", "end"]);
    S().runCliScript(byName("S3").id, ["configure terminal", "router bgp 65003", "neighbor 10.0.13.1", "bfd", "end"]);
    for (const s of ["S1", "S2", "S3"]) S().execCommand(byName(s).id, "exit");
    advance(30_000);
    const summary = show("S1", "show ip bgp summary");
    expect(summary).toMatch(ESTABLISHED_S3);
    expect(routeToH3()).toMatch(/^B>\* 192\.168\.3\.0\/24 \[20\/0\] via 10\.0\.13\.2/);

    S().disconnect(cut);
    advance(1500);
    expect(show("S1", "show ip bgp summary")).not.toMatch(ESTABLISHED_S3);
    expect(routeToH3()).toContain("via 10.0.12.2"); // AS path 65002 65003
    expect(show("S1", "show ip bgp neighbors 10.0.13.2")).toMatch(/BFD/i);
    expect(out(S().execCommand(byName("H1").id, "ping -c 1 192.168.3.10"))).toMatch(/1 received/);
  });
});

describe("all control protocols on the wire together", () => {
  it("one tcpdump on S1 sees LLDP, ARP, BFD, OSPF and BGP; LLDP/ARP tables are live", () => {
    S().loadFeatureLab("ospf");
    const s1 = byName("S1").id;
    // BGP between S1 and S2 alongside OSPF, with BFD on that session.
    S().runCliScript(s1, ["configure terminal", "router bgp 65001", "neighbor 10.0.12.2", "remote-as 65002", "bfd", "end"]);
    S().runCliScript(byName("S2").id, ["configure terminal", "router bgp 65002", "neighbor 10.0.12.1", "remote-as 65001", "bfd", "end"]);
    S().execCommand(s1, "exit");
    S().execCommand(s1, "sudo tcpdump -i Ethernet0 -nn");
    advance(40_000);
    S().stopLiveCapture(s1);
    const lines = (S().terminals[s1] ?? []).map((l) => l.text).join("\n");
    expect(lines).toMatch(/LLDP, length \d+: S2/);
    expect(lines).toMatch(/OSPFv2, Hello, length/);
    expect(lines).toMatch(/BFDv1, Control, State Up/);
    expect(lines).toMatch(/: BGP/);
    expect(lines).toMatch(/ARP, (Request|Reply)/);

    expect(show("S1", "show lldp table")).toMatch(/Ethernet0\s+S2\s+Ethernet0/);
    expect(show("S1", "show arp")).toMatch(/10\.0\.12\.2/);
  });
});
