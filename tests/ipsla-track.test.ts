/** IP SLA probes + SLA-tracked static routes (lib/protocols/ipsla-daemon.ts) on the l3-services lab. */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance } from "./control-helpers";
import { bash, klish } from "./nat-helpers";

const defaultRoute = () => klish("S1", "show ip route 0.0.0.0/0");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 19, 10, 0, 0));
  resetAll();
  S().loadFeatureLab("l3-services");
});
afterEach(() => vi.useRealTimers());

describe("IP SLA icmp-echo", () => {
  it("comes Up on the first reply and installs the tracked route", () => {
    expect(defaultRoute()).toMatch(/S>\* 0\.0\.0\.0\/0 \[200\/0\] via 10\.0\.13\.2/); // only the floating backup before the first probe
    advance(1000);
    const sum = klish("S1", "show ip sla");
    expect(sum).toMatch(/^SLA#    Type         State Target                    VRF          Transitions  Last change$/m);
    expect(sum).toMatch(/^1       ICMP-echo    Up    10\.0\.12\.2                 default      1            00:00:0\d ago$/m);
    const det = klish("S1", "show ip sla 1");
    for (const l of ["Type of Operation: ICMP-echo", "ICMP destination IP address: 10.0.12.2", "Operation frequency (sec): 5", "Operation timeout (sec): 2", "Operation threshold: 2", "Operation state: Up", "Operation state transitions: 1", "ICMP Echo Request counter: 1", "ICMP Echo Reply counter: 1", "ICMP Error counter: 0"]) {
      expect(det).toContain(l);
    }
    const r = defaultRoute();
    expect(r).toMatch(/S>\* 0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.12\.2, Ethernet0/);
    expect(r).toMatch(/S   0\.0\.0\.0\/0 \[200\/0\] via 10\.0\.13\.2, Ethernet1/);
    expect(bash("S1", "show logging")).toMatch(/NOTICE ipsla#ipslad: IP SLA 1 state changed to: Up$/m);
  });

  it("fails over to the backup route after `threshold` lost probes and fails back on recovery", () => {
    advance(6000);
    klish("S2", "configure terminal", "interface Ethernet 0", "shutdown", "end");
    advance(5000); // one lost probe: still Up (threshold 2)
    expect(klish("S1", "show ip sla")).toMatch(/^1\s+ICMP-echo\s+Up/m);
    advance(5000); // second lost probe → Down
    expect(klish("S1", "show ip sla")).toMatch(/^1\s+ICMP-echo\s+Down\s+10\.0\.12\.2\s+default\s+2\s/m);
    const r = defaultRoute();
    expect(r).not.toContain("via 10.0.12.2");
    expect(r).toMatch(/S>\* 0\.0\.0\.0\/0 \[200\/0\] via 10\.0\.13\.2, Ethernet1/);
    expect(bash("S1", "show logging")).toMatch(/WARNING ipsla#ipslad: IP SLA 1 state changed to: Down$/m);
    // S2 tracks 10.0.12.1 the same way, so NATed traffic flows over the backup link both ways.
    expect(bash("H1", "ping -c 2 203.0.113.10")).toContain("2 received");
    expect(klish("S1", "show ip sla 1")).toMatch(/ICMP Error counter: [1-9]/);

    klish("S2", "configure terminal", "interface Ethernet 0", "no shutdown", "end");
    advance(5000);
    expect(klish("S1", "show ip sla")).toMatch(/^1\s+ICMP-echo\s+Up\s+10\.0\.12\.2\s+default\s+3\s/m);
    expect(defaultRoute()).toMatch(/S>\* 0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.12\.2, Ethernet0/);
    const hist = klish("S1", "show ip sla 1 history").split("\n");
    expect(hist[0]).toBe("Timestamp                 Event");
    expect(hist.slice(2).map((l) => l.slice(26))).toEqual(["State changed to: Up", "State changed to: Down", "State changed to: Up", "Started"]);
    expect(hist[2]).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d\d \d\d:\d\d:\d\d \d{4}\s+State/);
  });
});

describe("IP SLA tcp-connect and tracked-route config", () => {
  it("tcp-connect succeeds against a listening port and fails on RST", () => {
    klish("S2", "configure terminal", "ip sla 2", "frequency 5", "tcp-connect 203.0.113.10 port 80", "exit", "exit", "ip sla 3", "frequency 5", "tcp-connect 203.0.113.10 port 81", "end");
    advance(1000);
    const sum = klish("S2", "show ip sla");
    expect(sum).toMatch(/^2\s+TCP-connect\s+Up\s+203\.0\.113\.10\(80\)/m);
    expect(sum).toMatch(/^3\s+TCP-connect\s+Down\s+203\.0\.113\.10\(81\)\s+default\s+0\s+-$/m);
    const det = klish("S2", "show ip sla 3");
    expect(det).toContain("TCP connect request counter: 1");
    expect(det).toContain("TCP connect error counter: 1");
    expect(klish("S2", "show ip sla 2")).toContain("TCP connect success counter: 1");
  });

  it("no ip route ... track removes the tracked route; removing the SLA withdraws it", () => {
    advance(1000);
    klish("S1", "configure terminal", "no ip sla 1", "end");
    advance(100);
    expect(defaultRoute()).not.toContain("via 10.0.12.2");
    klish("S1", "configure terminal", "ip sla 1", "frequency 5", "icmp-echo 10.0.12.2", "end");
    advance(1000);
    expect(defaultRoute()).toContain("via 10.0.12.2");
    klish("S1", "configure terminal", "no ip route 0.0.0.0/0 10.0.12.2 track 1", "end");
    advance(6000);
    expect(defaultRoute()).not.toContain("via 10.0.12.2");
  });

  it("plain `no ip route <p> <nh>` also forgets the tracking (no re-install on the next probe)", () => {
    advance(1000);
    expect(defaultRoute()).toContain("via 10.0.12.2");
    klish("S1", "configure terminal", "no ip route 0.0.0.0/0 10.0.12.2", "end");
    advance(12_000); // two more successful probes
    expect(defaultRoute()).not.toContain("via 10.0.12.2");
  });
});
