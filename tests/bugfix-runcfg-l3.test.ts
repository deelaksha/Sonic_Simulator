/**
 * Regression: KLISH `show running-configuration` rendered only interface IPs;
 * NAT, MCLAG, LLDP, VRRP, VXLAN/EVPN, SAG, BFD, IP SLA, link tracking, FBS and
 * PIM/IGMP config were missing (lib/commands/sonic-cli/running-config/l3-features.ts).
 *
 * Round trip: render every switch, replay the text on a config-less copy of the
 * lab, render again — identical. The replay emulates KLISH's parent-view lookup
 * (a command not known in the current sub-mode is retried in the enclosing
 * modes, which is how a saved running-config replays on the box), so sub-mode
 * entries without a body (`icmp-echo <ip>`, `peer <ip>`) are handled as on KLISH;
 * unindented lines are configure-view commands.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { S } from "./control-helpers";
import { devId, runcfg, roundTrip } from "./runcfg-helpers";

function expectRoundTrip(lab: string, extra: Record<string, string[]> = {}, ignore?: RegExp) {
  for (const r of roundTrip(lab, extra)) {
    const keep = (ls: string[]) => (ignore ? ls.filter((l) => !ignore.test(l)) : ls);
    expect(keep(r.errors), `${lab} ${r.name} replay errors`).toEqual([]);
    expect(keep(r.after), `${lab} ${r.name}`).toEqual(keep(r.before));
  }
}

const has = (name: string, lines: string[], cmd = "show running-configuration") => {
  const rc = runcfg(name, cmd);
  for (const l of lines) expect(rc, `${name}: ${cmd} → ${l}`).toContain(l);
};

describe("show running-configuration: L3/overlay features", () => {
  beforeEach(() => S().newLab());

  it("l3-services: NAT, interface nat-zone, IP SLA, FBS class-map/policy-map/service-policy", () => {
    S().loadFeatureLab("l3-services");
    const nat = ["nat", " enable", " pool INET 100.64.0.1 20000-29999", " binding LAN INET", " static tcp 100.64.0.1 8080 192.168.1.10 80"];
    has("S1", [...nat, " nat-zone 1", "ip sla 1", " frequency 5", " icmp-echo 10.0.12.2", "class-map LAN2 match-type fields match-all", " match source-address ip 192.168.2.0/24", "policy-map PBR-LAN2 type forwarding", " class LAN2 priority 10", "  set ip next-hop 10.0.13.2 priority 10", " service-policy type forwarding in PBR-LAN2"]);
    has("S1", nat, "show running-configuration nat");
    has("S1", ["ip sla 1"], "show running-configuration ip sla");
    has("S1", ["class-map LAN2 match-type fields match-all"], "show running-configuration class-map");
    has("S1", ["policy-map PBR-LAN2 type forwarding"], "show running-configuration policy-map");
    expectRoundTrip("l3-services");
  });

  it("mclag: domain block, PortChannel mclag binding", () => {
    S().loadFeatureLab("mclag");
    const dom = ["mclag domain 10", " source-ip 10.0.0.1", " peer-ip 10.0.0.2", " peer-link Ethernet1"];
    has("P1", [...dom, " mclag 10"]);
    has("P1", [...dom, "interface PortChannel1 mode active", " mclag 10"], "show running-configuration mclag");
    expectRoundTrip("mclag");
  });

  it("lldp: global and per-interface config", () => {
    const cfg = { S1: ["configure terminal", "lldp timer 10", "lldp multiplier 5", "lldp system-name core1", "interface Ethernet 1", "no lldp transmit", "network-policy 3", "end"] };
    S().loadFeatureLab("lldp");
    S().runCliScript(devId("S1"), cfg.S1, { silent: true });
    const lines = ["lldp enable", "lldp timer 10", "lldp multiplier 5", "lldp system-name core1", " no lldp transmit", " network-policy 3"];
    has("S1", lines);
    has("S1", [...lines, "interface Ethernet1"], "show running-configuration lldp");
    expectRoundTrip("lldp", cfg);
  });

  it("vrrp: per-interface vrrp address-family block", () => {
    S().loadFeatureLab("vrrp");
    const v = ["interface Vlan10", " vrrp 10 address-family ipv4", "  priority 120", "  vip 192.168.10.1"];
    has("S1", v);
    has("S1", v, "show running-configuration vrrp");
    expectRoundTrip("vrrp");
  });

  it("evpn-irb / vxlan: interface vxlan, VNI maps, SAG, neigh-suppress", () => {
    S().loadFeatureLab("evpn-irb");
    const vx = ["interface vxlan vtep1", " source-ip 10.0.0.1", " map vni 10010 vlan 10", " map vni 50000 vrf Vrf-red"];
    has("LEAF1", [...vx, "ip anycast-mac-address 00:00:5e:00:01:01", " ip anycast-address 10.1.0.1/24", " neigh-suppress"]);
    has("LEAF1", vx, "show running-configuration interface vxlan");
    expectRoundTrip("evpn-irb");
    S().loadFeatureLab("vxlan");
    has("LEAF1", ["interface vxlan vtep1", " map vni 10100 vlan 100"]);
    expectRoundTrip("vxlan");
  });

  it("bfd: peers with their timers", () => {
    const cfg = { S1: ["configure terminal", "bfd", "peer 10.0.12.2 interface Ethernet0", "detect-multiplier 5", "transmit-interval 200", "end"] };
    S().loadFeatureLab("bfd");
    S().runCliScript(devId("S1"), cfg.S1, { silent: true });
    const b = ["bfd", " peer 10.0.12.2 interface Ethernet0", "  detect-multiplier 5", "  transmit-interval 200", " peer 10.0.13.2 interface Ethernet1"];
    has("S1", b);
    has("S1", b, "show running-configuration bfd");
    expectRoundTrip("bfd", cfg);
  });

  it("multicast: PIM global/interface and IGMP interface lines", () => {
    S().loadFeatureLab("multicast");
    has("S3", ["ip pim rp-address 2.2.2.2", "interface Vlan30", " ip pim sparse-mode", " ip igmp", " ip igmp version 2"]);
    expectRoundTrip("multicast");
  });

  it("l2-protect: link state tracking group + interface bindings", () => {
    S().loadFeatureLab("l2-protect");
    const g = ["link state track UPLINK", " timeout 10", " link state track UPLINK upstream", " link state track UPLINK downstream"];
    has("SW1", g);
    has("SW1", g, "show running-configuration link state tracking");
    expectRoundTrip("l2-protect");
  });

  it("extra stores: EVPN-MH, load-share, NAT static basic/timeouts, VRRP ipv6, IP SLA tcp", () => {
    const cfg = {
      P1: ["configure terminal", "evpn esi-multihoming", "startup-delay 100", "exit", "interface PortChannel 1", "evpn ethernet-segment 00:11:22:33:44:55:66:77:88:99", "df-preference 50000", "exit", "exit",
        "ip load-share hash seed 42", "no ip load-share hash ipv4 ipv4-l4-src-port", "nat", "timeout 900", "static basic 100.64.0.9 10.0.0.9 snat", "exit",
        "interface Vlan 10", "ip address 192.168.10.2/24", "vrrp 5 address-family ipv6", "vip 2001:db8::1", "priority 150", "exit", "exit",
        "ip sla 7", "tcp-connect 10.0.0.2 port 179", "source-port 5000", "end"],
    };
    S().loadFeatureLab("mclag");
    S().runCliScript(devId("P1"), cfg.P1, { silent: true });
    has("P1", ["evpn esi-multihoming", " startup-delay 100", " evpn ethernet-segment 00:11:22:33:44:55:66:77:88:99", "  df-preference 50000", "ip load-share hash seed 42", "no ip load-share hash ipv4 ipv4-l4-src-port",
      " timeout 900", " static basic 100.64.0.9 10.0.0.9 snat", " vrrp 5 address-family ipv6", "  priority 150", "  vip 2001:db8::1", "ip sla 7", " tcp-connect 10.0.0.2 port 179", "  source-port 5000"]);
    expectRoundTrip("mclag", cfg);
  });
});
