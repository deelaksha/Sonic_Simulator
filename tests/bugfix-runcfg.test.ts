/**
 * Area A — KLISH `show running-configuration` rendered only interface IPs.
 * Core sections: router bgp, router ospf (areas/ranges/redistribute/VRF),
 * router ospf6 + IPv6 (addresses, ipv6 ospf6, ipv6 nd), VRF definitions and
 * bindings, static routes, prefix-lists, community/as-path lists, route-maps,
 * VLAN/PortChannel membership — in sonic_cli_show_config.py show_all_config
 * order and the mgmt-framework templates' syntax, and replayable.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { S } from "./control-helpers";
import { devId, runcfg, roundTrip } from "./runcfg-helpers";

const RICH: string[] = [
  "configure terminal",
  "ip vrf Vrf-blue",
  "interface Loopback 1", "ip vrf forwarding Vrf-blue", "ip address 10.9.9.9/32", "exit",
  "interface Ethernet 3", "ipv6 address 2001:db8:3::1/64", "ipv6 nd ra-interval 30", "ipv6 nd managed-config-flag", "ipv6 ospf6 area 0.0.0.0", "ipv6 ospf6 cost 20", "ip ospf cost 15", "exit",
  "router ospf6", "ospf6 router-id 1.1.1.1", "exit",
  "router ospf", "ospf router-id 1.1.1.1", "network 10.0.12.0/30 area 0", "area 0.0.0.1 stub no-summary", "area 0.0.0.1 range 10.1.0.0/16",
  "redistribute connected metric 20 metric-type 1", "default-information originate always", "passive-interface Ethernet2", "exit",
  "router ospf vrf Vrf-blue", "ospf router-id 9.9.9.9", "network 10.9.9.9/32 area 0", "exit",
  "ip prefix-list PL-OUT seq 5 permit 192.168.1.0/24", "ip prefix-list PL-OUT seq 10 deny 0.0.0.0/0 le 32",
  "ipv6 prefix-list PL6 seq 5 permit 2001:db8::/32 ge 48 le 64",
  "bgp community-list standard CL1 permit 65001:100",
  "bgp as-path-list AP1 permit ^65002$",
  "route-map RM-IN permit 10", "match ip address prefix-list PL-OUT", "set local-preference 200", "exit",
  "router bgp 65001", "timers 10 30", "bestpath as-path multipath-relax",
  "neighbor 10.0.12.2", "description to-S2", "timers 3 9", "bfd",
  "address-family ipv4 unicast", "route-map RM-IN in", "prefix-list PL-OUT out", "soft-reconfiguration inbound", "exit", "exit",
  "address-family ipv4 unicast", "maximum-paths 4", "redistribute static route-map RM-IN", "exit",
  "address-family ipv6 unicast", "network 2001:db8:3::/64", "exit",
  "exit",
  "router bgp 65001 vrf Vrf-blue", "router-id 9.9.9.9", "address-family ipv4 unicast", "network 10.9.9.9/32", "exit", "exit",
  "ip route 172.16.0.0/16 10.0.12.2", "ip route vrf Vrf-blue 172.17.0.0/16 10.9.9.1",
  "end",
];

/** The block starting at `head` (up to the next top-level line). */
function block(rc: string[], head: string): string[] {
  const i = rc.indexOf(head);
  if (i < 0) return [];
  const end = rc.findIndex((l, k) => k > i && l.length > 0 && !l.startsWith(" "));
  return rc.slice(i, end < 0 ? undefined : rc[end] === "exit" ? end + 1 : end);
}

describe("KLISH show running-configuration — core sections", () => {
  beforeEach(() => S().newLab());

  it("bgp lab: router bgp with neighbors and the ipv4 unicast network (bgp lab used to show only IPs)", () => {
    S().loadFeatureLab("bgp");
    const rc = runcfg("S1");
    expect(rc.slice(0, 2)).toEqual(["!", "Current configuration:"]);
    expect(rc[rc.length - 1]).toBe("end");
    expect(block(rc, "router bgp 65001")).toEqual([
      "router bgp 65001",
      " router-id 1.1.1.1",
      " !",
      " address-family ipv4 unicast",
      "  network 192.168.1.0/24",
      "  exit",
      " !",
      " neighbor 10.0.12.2",
      "  remote-as 65002",
      "  !",
      "  address-family ipv4 unicast",
      "   activate",
      "   exit",
      "  exit",
      " !",
      " neighbor 10.0.13.2",
      "  remote-as 65003",
      "  !",
      "  address-family ipv4 unicast",
      "   activate",
      "   exit",
      "  exit",
      "exit",
    ]);
    expect(block(rc, "interface Ethernet0")).toEqual(["interface Ethernet0", " no shutdown", " ip address 10.0.12.1/30"]);
    // per-feature form (bgp.xml:20)
    expect(runcfg("S1", "show running-configuration bgp")).toEqual(["!", ...block(rc, "router bgp 65001")]);
  });

  it("renders BGP policy, OSPF (areas, ranges, redistribute, VRF), OSPFv3/IPv6, VRF, static routes and policy lists", () => {
    S().loadFeatureLab("bgp");
    S().runCliScript(devId("S1"), RICH, { silent: true });
    const rc = runcfg("S1");
    expect(rc).toContain("ip vrf Vrf-blue");
    expect(block(rc, "router ospf")).toEqual([
      "router ospf",
      " ospf router-id 1.1.1.1",
      " passive-interface Ethernet2",
      " default-information originate always",
      " redistribute connected metric 20 metric-type 1",
      " area 0.0.0.1 stub no-summary",
      " area 0.0.0.1 range 10.1.0.0/16",
      " network 10.0.12.0/30 area 0.0.0.0",
    ]);
    expect(block(rc, "router ospf vrf Vrf-blue")).toEqual(["router ospf vrf Vrf-blue", " ospf router-id 9.9.9.9", " network 10.9.9.9/32 area 0.0.0.0"]);
    expect(block(rc, "router ospf6")).toEqual(["router ospf6", " ospf6 router-id 1.1.1.1"]);
    expect(block(rc, "interface Ethernet3")).toEqual([
      "interface Ethernet3",
      " no shutdown",
      " ipv6 address 2001:db8:3::1/64",
      " ipv6 nd managed-config-flag",
      " ipv6 nd ra-interval 30",
      " ip ospf cost 15",
      " ipv6 ospf6 area 0.0.0.0",
      " ipv6 ospf6 cost 20",
    ]);
    expect(block(rc, "interface Loopback1")).toEqual(["interface Loopback1", " ip vrf forwarding Vrf-blue", " ip address 10.9.9.9/32"]);
    expect(rc).toEqual(expect.arrayContaining([
      "ip prefix-list PL-OUT seq 5 permit 192.168.1.0/24",
      "ip prefix-list PL-OUT seq 10 deny 0.0.0.0/0 le 32",
      "ipv6 prefix-list PL6 seq 5 permit 2001:db8::/32 ge 48 le 64",
      "bgp community-list standard CL1 permit 65001:100",
      "bgp as-path-list AP1 permit ^65002$",
      "ip route 172.16.0.0/16 10.0.12.2",
      "ip route vrf Vrf-blue 172.17.0.0/16 10.9.9.1", // next hop unresolved: configured, inactive
    ]));
    expect(block(rc, "route-map RM-IN permit 10")).toEqual(["route-map RM-IN permit 10", " match ip address prefix-list PL-OUT", " set local-preference 200"]);
    const bgp = block(rc, "router bgp 65001");
    expect(bgp.slice(0, 4)).toEqual(["router bgp 65001", " router-id 1.1.1.1", " timers 10 30", " bestpath as-path multipath-relax"]);
    expect(bgp).toEqual(expect.arrayContaining(["  maximum-paths 4", "  redistribute static route-map RM-IN", " address-family ipv6 unicast", "  network 2001:db8:3::/64"]));
    const nbr = bgp.slice(bgp.indexOf(" neighbor 10.0.12.2"), bgp.indexOf(" neighbor 10.0.13.2") - 1);
    expect(nbr).toEqual([
      " neighbor 10.0.12.2",
      "  description to-S2",
      "  remote-as 65002",
      "  timers 3 9",
      "  bfd",
      "  !",
      "  address-family ipv4 unicast",
      "   activate",
      "   route-map RM-IN in",
      "   prefix-list PL-OUT out",
      "   soft-reconfiguration inbound",
      "   exit",
      "  exit",
    ]);
    expect(block(rc, "router bgp 65001 vrf Vrf-blue")).toEqual(["router bgp 65001 vrf Vrf-blue", " router-id 9.9.9.9", " !", " address-family ipv4 unicast", "  network 10.9.9.9/32", "  exit", "exit"]);

    // source order (OSPF moved after interfaces for replay): interfaces → ospf → prefix-lists → route-maps → bgp → static routes → end
    const at = (l: string) => rc.indexOf(l);
    expect(at("ip vrf Vrf-blue")).toBeLessThan(at("interface Ethernet0"));
    expect(at("interface Management0")).toBeLessThan(at("router ospf"));
    expect(at("interface Management0")).toBeLessThan(at("ip prefix-list PL-OUT seq 5 permit 192.168.1.0/24"));
    expect(at("ip prefix-list PL-OUT seq 5 permit 192.168.1.0/24")).toBeLessThan(at("route-map RM-IN permit 10"));
    expect(at("route-map RM-IN permit 10")).toBeLessThan(at("router bgp 65001"));
    expect(at("router bgp 65001")).toBeLessThan(at("ip route 172.16.0.0/16 10.0.12.2"));

    // per-feature forms
    expect(runcfg("S1", "show running-configuration ospf")).toContain(" area 0.0.0.1 range 10.1.0.0/16");
    expect(runcfg("S1", "show running-configuration vrf")).toEqual(["!", "ip vrf Vrf-blue", "!", "interface Loopback1", " ip vrf forwarding Vrf-blue"]);
    expect(runcfg("S1", "show running-configuration route-map RM-IN")).toEqual(["!", ...block(rc, "route-map RM-IN permit 10")]);
    expect(runcfg("S1", "show running-configuration ip prefix-list")).toEqual(["!", "ip prefix-list PL-OUT seq 5 permit 192.168.1.0/24", "ip prefix-list PL-OUT seq 10 deny 0.0.0.0/0 le 32"]);
    expect(runcfg("S1", "show running-configuration interface Ethernet 3")).toEqual(["!", ...block(rc, "interface Ethernet3")]);
  });

  it("SLA-tracked static routes render with `track <id>` (l3-services lab)", () => {
    S().loadFeatureLab("l3-services");
    const routes = runcfg("S1").filter((l) => l.startsWith("ip route "));
    expect(routes.some((l) => / track \d+/.test(l))).toBe(true);
    expect(runcfg("S1", "show running-configuration ip route")).toEqual(["!", ...routes]);
  });

  it("PortChannel and VLAN membership (lacp lab)", () => {
    S().loadFeatureLab("lacp");
    const rc = runcfg("S1");
    expect(block(rc, "vlan 10")).toEqual(["vlan 10"]);
    expect(block(rc, "interface PortChannel1 mode active")).toEqual(["interface PortChannel1 mode active", " fast_rate", " switchport access Vlan 10"]);
    expect(block(rc, "interface Ethernet0")).toEqual(["interface Ethernet0", " channel-group 1", " no shutdown"]);
  });

  it.each(["bgp", "bgp-policy", "ospf", "ospf-areas", "lacp", "vrf", "ipvx", "evpn-irb"])("round trip: %s config replayed on the bare topology renders identically", (lab) => {
    for (const r of roundTrip(lab)) {
      expect(r.errors, `${lab}/${r.name}`).toEqual([]);
      expect(r.after, `${lab}/${r.name}`).toEqual(r.before);
    }
  });

  it("round trip of the rich core config", () => {
    for (const r of roundTrip("bgp", { S1: RICH })) {
      expect(r.errors, r.name).toEqual([]);
      expect(r.after, r.name).toEqual(r.before);
    }
  });
});
