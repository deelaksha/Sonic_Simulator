/**
 * KLISH `show running-configuration`: ACL, sFlow, SNMP, QoS, CoPP, mirror,
 * storm-control, DHCP snooping, UDLD, errdisable, IGMP snooping, spanning-tree
 * (lib/commands/sonic-cli/running-config/l2-features.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { S, out } from "./control-helpers";
import { roundTrip, runcfg, devId, baseLab, klishReplay } from "./runcfg-helpers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const clean = (labs: ReturnType<typeof roundTrip>) => {
  for (const r of labs) {
    expect(r.errors, r.name).toEqual([]);
    expect(r.after, r.name).toEqual(r.before);
  }
};

/** Labs configured through Click leave the switch at the bash prompt: render from KLISH. */
function klishRuncfg(name: string, cmd = "show running-configuration"): string[] {
  const id = devId(name);
  S().execCommand(id, "sonic-cli");
  return out(S().execCommand(id, cmd)).split("\n");
}

describe("running-config: ACL", () => {
  const bind = { S1: ["configure terminal", "interface Ethernet 2", "ip access-group H1-POLICY in", "end"] };
  it("renders the ACL with rules and the interface binding (full + per-feature)", () => {
    S().loadFeatureLab("acl");
    S().runCliScript(devId("S1"), bind.S1, { silent: true });
    const rc = runcfg("S1");
    const at = rc.indexOf("ip access-list H1-POLICY");
    expect(at).toBeGreaterThan(0);
    expect(rc.slice(at, at + 6)).toEqual([
      "ip access-list H1-POLICY",
      " remark Block ping and HTTP from H1 to H3, allow the rest",
      " seq 10 deny icmp host 192.168.1.10 host 192.168.3.10",
      " seq 20 deny tcp 192.168.1.0/24 host 192.168.3.10 eq 80",
      " seq 30 permit tcp 192.168.1.0/24 any eq 22",
      " seq 40 permit ip any any",
    ]);
    const e2 = rc.indexOf("interface Ethernet2");
    expect(rc.slice(e2, e2 + 4)).toContain(" ip access-group H1-POLICY in");
    const only = runcfg("S1", "show running-configuration ip access-list");
    expect(only).toContain("ip access-list H1-POLICY");
    expect(only).toContain(" ip access-group H1-POLICY in");
    expect(only.join("\n")).not.toMatch(/ip address/);
  });
  it("round-trips", () => clean(roundTrip("acl", bind)));
});

describe("running-config: sFlow", () => {
  const cfg = {
    S1: ["configure terminal", "sflow enable", "sflow polling-interval 30", "sflow sampling-rate 4096", "sflow collector 192.168.100.250", "interface Ethernet 0", "sflow enable", "sflow sampling-rate 1024", "end"],
  };
  it("renders global and interface sFlow lines", () => {
    S().loadFeatureLab("acl");
    S().runCliScript(devId("S1"), cfg.S1, { silent: true });
    const rc = runcfg("S1");
    for (const l of ["sflow enable", "sflow polling-interval 30", "sflow sampling-rate 4096", "sflow collector 192.168.100.250 vrf default", " sflow sampling-rate 1024"]) expect(rc).toContain(l);
    const e0 = rc.indexOf("interface Ethernet0");
    expect(rc.slice(e0, e0 + 5)).toContain(" sflow enable");
  });
  it("round-trips", () => clean(roundTrip("acl", cfg)));
});

describe("running-config: SNMP", () => {
  it("full output carries the snmp-server lines; the per-feature form still works", () => {
    S().loadFeatureLab("snmp");
    const rc = runcfg("S3");
    expect(rc).toContain("snmp-server host 192.168.100.250 port 162 version v2c community public");
    expect(rc).toContain("snmp-server community public ro");
    expect(runcfg("S3", "show running-configuration snmp")).toContain("snmp-server location Lab-Row1-Rack3");
  });
  it("round-trips", () => clean(roundTrip("snmp")));
});

describe("running-config: l2-protect (mirror, DHCP snooping, storm-control, UDLD, errdisable)", () => {
  const extra = {
    SW1: [
      "configure terminal",
      "ipv6 dhcp snooping",
      "ip dhcp snooping verify mac-address",
      "mirror-session ER1",
      "destination erspan dst-ip 10.10.10.2 src-ip 10.10.10.1 dscp 8 ttl 64 source Ethernet1 direction rx",
      "exit",
      "interface Ethernet 3",
      "storm-control unknown-unicast 200",
      "exit",
      "interface Ethernet 5",
      "udld aggressive",
      "exit",
      "udld message-time 5",
      "end",
    ],
  };
  it("renders every feature", () => {
    S().loadFeatureLab("l2-protect");
    S().runCliScript(devId("SW1"), extra.SW1, { silent: true });
    const rc = runcfg("SW1");
    for (const l of [
      "mirror-session SPAN1",
      " destination Ethernet4 source Ethernet0 direction both",
      " destination erspan dst-ip 10.10.10.2 src-ip 10.10.10.1 dscp 8 ttl 64 source Ethernet1 direction rx",
      "ip dhcp snooping",
      "ip dhcp snooping Vlan10",
      "ip dhcp snooping verify mac-address",
      "ipv6 dhcp snooping",
      " ip dhcp snooping trust",
      " storm-control broadcast 100",
      " storm-control unknown-unicast 200",
      "udld enable",
      "udld message-time 5",
      " udld enable",
      " udld aggressive",
      "errdisable recovery cause udld",
      "errdisable recovery interval 30",
    ])
      expect(rc, l).toContain(l);
    const ms = runcfg("SW1", "show running-configuration mirror-session");
    expect(ms).toEqual(["!", "mirror-session SPAN1", " destination Ethernet4 source Ethernet0 direction both", "!", "mirror-session ER1", " destination erspan dst-ip 10.10.10.2 src-ip 10.10.10.1 dscp 8 ttl 64 source Ethernet1 direction rx"]);
  });
  it("round-trips", () => clean(roundTrip("l2-protect", extra)));
});

describe("running-config: IGMP snooping + spanning-tree", () => {
  const extra = {
    S3: [
      "configure terminal",
      "spanning-tree mode rapid-pvst",
      "spanning-tree vlan 30 priority 4096",
      "interface Vlan 30",
      "ip igmp snooping querier",
      "ip igmp snooping version 3",
      "ip igmp snooping mrouter interface Ethernet2",
      "exit",
      "end",
    ],
  };
  it("renders IGMP snooping inside the Vlan block and the STP globals", () => {
    S().loadFeatureLab("multicast");
    S().runCliScript(devId("S3"), extra.S3, { silent: true });
    const rc = runcfg("S3");
    const v = rc.indexOf("interface Vlan30");
    const block = rc.slice(v, rc.indexOf("!", v));
    for (const l of [" ip igmp snooping", " ip igmp snooping querier", " ip igmp snooping version 3", " ip igmp snooping mrouter interface Ethernet2"]) expect(block, l).toContain(l);
    expect(rc).toContain("spanning-tree mode rapid-pvst");
    expect(rc).toContain("spanning-tree vlan 30 priority 4096");
    expect(rc.indexOf("spanning-tree mode rapid-pvst")).toBeLessThan(rc.indexOf("interface Ethernet0"));
  });
  it("round-trips", () => clean(roundTrip("multicast", extra)));
});

describe("running-config: QoS and CoPP (labs configured through Click)", () => {
  it("QoS: maps and WRED before the interfaces, bindings in the interface block", () => {
    S().loadFeatureLab("qos");
    const rc = klishRuncfg("S1");
    const map = rc.indexOf("qos map dscp-tc LAB-DSCP");
    expect(rc.slice(map, map + 4)).toEqual(["qos map dscp-tc LAB-DSCP", " dscp 10 traffic-class 1", " dscp 26 traffic-class 3", " dscp 46 traffic-class 5"]);
    expect(map).toBeLessThan(rc.indexOf("interface Ethernet0"));
    expect(rc).toContain(" green minimum-threshold 100 maximum-threshold 600 drop-probability 20");
    expect(rc).toContain(" qos-map dscp-tc LAB-DSCP");
    expect(rc).toContain("qos scheduler-policy LAB-STRICT");
    expect(rc).toContain("  type strict");
    // Replay: everything but the scheduler-policy block (no KLISH sub-mode in the simulator).
    baseLab("qos");
    expect(klishReplay("S1", rc)).toEqual(['% Unrecognized command "qos scheduler-policy LAB-STRICT".', '% Unrecognized command "queue 5".', '% Unrecognized command "type strict".']);
    const after = runcfg("S1");
    const s = rc.indexOf("qos scheduler-policy LAB-STRICT");
    const e = rc.indexOf("!", s + 2); // " !" inside the block is indented; the closing "!" is not
    expect(after).toEqual([...rc.slice(0, s - 1), ...rc.slice(e)]);
  });
  it("CoPP: the action group with its trap/police settings", () => {
    S().loadFeatureLab("copp");
    const rc = klishRuncfg("S1");
    const at = rc.indexOf("copp-action copp-lab-ip2me");
    expect(rc.slice(at, at + 4)).toEqual(["copp-action copp-lab-ip2me", " set trap-action trap", " set trap-queue 7", " police cir 50 cbs 50"]);
    expect(klishRuncfg("S1", "show running-configuration copp-action")).toContain(" set trap-queue 7");
  });
});
