/** FBS forwarding policies (policy-based routing) on the l3-services lab (lib/protocols/pbr.ts). */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";
import { bash, klish } from "./nat-helpers";

const port = (name: string) => byName("S1").interfaces.find((i) => i.name === name)!.id;
/** IPv4 packets S1 sends out of each uplink while `fn` runs (ARP excluded). */
function uplinks(fn: () => void): { e0: number; e1: number } {
  const before = S().captures.length;
  fn();
  const sent = S().captures.slice(before).filter((c) => c.deviceId === byName("S1").id && c.dir === "tx" && c.frame.ipv4);
  return { e0: sent.filter((c) => c.interfaceId === port("Ethernet0")).length, e1: sent.filter((c) => c.interfaceId === port("Ethernet1")).length };
}
const matches = () => Number(/Packet matches: (\d+) frames/.exec(klish("S1", "show service-policy interface Ethernet 3"))?.[1]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("l3-services");
  advance(6000);
});
afterEach(() => vi.useRealTimers());

describe("FBS forwarding policy overrides the routing table", () => {
  it("only the matching subnet takes the policy next hop; per-flow counters count it", () => {
    expect(klish("S1", "show ip route 0.0.0.0/0")).toMatch(/S>\* 0\.0\.0\.0\/0 \[1\/0\] via 10\.0\.12\.2, Ethernet0/);
    const lan1 = uplinks(() => expect(bash("H1", "ping -c 3 203.0.113.10")).toContain("3 received"));
    expect(lan1).toEqual({ e0: 3, e1: 0 }); // routing table: default via Ethernet0
    expect(matches()).toBe(0); // H1 is not on the bound interface
    const lan2 = uplinks(() => expect(bash("H2", "ping -c 3 203.0.113.10")).toContain("3 received"));
    expect(lan2).toEqual({ e0: 0, e1: 3 }); // policy: next hop 10.0.13.2 out Ethernet1
    expect(matches()).toBe(3);
    const sp = klish("S1", "show service-policy interface Ethernet 3");
    expect(sp).toContain("  Policy PBR-LAN2 type forwarding at ingress");
    expect(sp).toContain("    Flow LAN2 at priority 10 (Active)");
    expect(sp).toContain("      set ip next-hop 10.0.13.2 priority 10");
    expect(sp).toMatch(/Packet matches: 3 frames \d+ bytes/);
    klish("S1", "clear counters service-policy interface Ethernet 3");
    expect(matches()).toBe(0);
  });

  it("classifier on protocol + L4 port: only TCP/80 is policy-routed, ping follows the routing table", () => {
    klish("S1", "configure terminal", "class-map LAN2 match-type fields match-all", "match ip protocol tcp", "match l4-port destination eq 80", "end");
    expect(klish("S1", "show class-map LAN2")).toBe(
      [
        "Class-map LAN2 match-type fields",
        "  Description: ",
        "  Match:",
        "    ip protocol tcp",
        "    src-ip 192.168.2.0/24",
        "    dst-port 80",
        "  Referenced in flows:",
        "    policy PBR-LAN2 at priority 10",
      ].join("\n"),
    );
    expect(uplinks(() => bash("H2", "ping -c 2 203.0.113.10"))).toEqual({ e0: 2, e1: 0 });
    const web = uplinks(() => expect(bash("H2", "nc -v 203.0.113.10 80 hi")).toMatch(/200 OK/));
    expect(web.e0).toBe(0);
    expect(web.e1).toBeGreaterThan(0);
  });

  it("the highest-priority usable next hop wins; unusable next hops fall back, then to the routing table", () => {
    klish("S1", "configure terminal", "policy-map PBR-LAN2 type forwarding", "class LAN2", "set ip next-hop 10.0.12.2 priority 20", "end");
    expect(klish("S1", "show policy-map PBR-LAN2")).toBe(
      [
        "Policy PBR-LAN2 Type forwarding",
        "  Description: ",
        "  Flow LAN2 at priority 10",
        "    Description: ",
        "    set ip nexthop 10.0.13.2 priority 10",
        "    set ip nexthop 10.0.12.2 priority 20",
        "  Applied to:",
        "    Ethernet3 at Ingress",
      ].join("\n"),
    );
    expect(uplinks(() => bash("H2", "ping -c 1 203.0.113.10"))).toEqual({ e0: 1, e1: 0 });
    // Highest-priority next hop unusable (not on any connected subnet) → the priority 10 one.
    klish("S1", "configure terminal", "policy-map PBR-LAN2 type forwarding", "class LAN2", "no set ip next-hop 10.0.12.2", "set ip next-hop 10.0.99.1 priority 30", "end");
    expect(uplinks(() => bash("H2", "ping -c 1 203.0.113.10"))).toEqual({ e0: 0, e1: 1 });
    // No usable next hop at all → normal routing (default route via Ethernet0).
    klish("S1", "configure terminal", "policy-map PBR-LAN2 type forwarding", "class LAN2", "no set ip next-hop 10.0.13.2", "end");
    expect(uplinks(() => expect(bash("H2", "ping -c 1 203.0.113.10")).toContain("1 received"))).toEqual({ e0: 1, e1: 0 });
    // ...unless the flow says `set interface null`: drop.
    klish("S1", "configure terminal", "policy-map PBR-LAN2 type forwarding", "class LAN2", "set interface null", "end");
    expect(bash("H2", "ping -c 1 203.0.113.10")).toContain("0 received");
  });

  it("set interface sends the flow out of a port; unbinding restores the routing table", () => {
    klish("S1", "configure terminal", "policy-map PBR-LAN2 type forwarding", "class LAN2", "no set ip next-hop 10.0.13.2", "set interface Ethernet 1", "end");
    expect(uplinks(() => expect(bash("H2", "ping -c 1 203.0.113.10")).toContain("1 received"))).toEqual({ e0: 0, e1: 1 });
    klish("S1", "configure terminal", "interface Ethernet 3", "no service-policy type forwarding in", "end");
    expect(uplinks(() => bash("H2", "ping -c 1 203.0.113.10"))).toEqual({ e0: 1, e1: 0 });
    expect(klish("S1", "show service-policy summary")).toBe("");
  });

  it("show service-policy summary / Click show fbs reflect the binding", () => {
    expect(klish("S1", "show service-policy summary")).toBe("Ethernet3\n    forwarding policy PBR-LAN2 at ingress");
    expect(bash("S1", "show fbs policy PBR-LAN2")).toContain("set-ip-nexthop 10.0.13.2 priority 10");
  });
});
