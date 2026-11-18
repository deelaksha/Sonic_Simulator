/**
 * ACL enforcement end to end through the store (KLISH config → data-plane hook
 * → counters → show), on the "acl" feature lab (routedTriangle + static routes)
 * and small purpose-built switch labs for VLAN / PortChannel bindings.
 */
import "../lib/commands/sonic-cli/features"; // register KLISH handlers (as the app does)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerLab } from "../lib/labs";
import { registerDataPlaneHook } from "../lib/control/hooks";
import { peekTrafficSink } from "../lib/protocols/traffic";
import { peekFeatureState } from "../lib/models/feature-state";
import { AclState } from "../lib/protocols/acl-rules";
import { aclshowCommand } from "../lib/commands/sonic/acl";
import { S, byName, out } from "./control-helpers";
import { resetAll } from "./helpers";

const id = (n: string) => byName(n).id;
const klish = (dev: string, lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"]);
const ping = (from: string, ip: string, n = 2) => out(S().execCommand(id(from), `ping -c ${n} ${ip}`));
const received = (from: string, ip: string, n = 2) => Number(ping(from, ip, n).match(/(\d+) (packets )?received/)?.[1] ?? -1);
const show = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const counters = (dev: string) => peekFeatureState<AclState>(byName(dev), "acl")?.counters ?? {};
const hits = (dev: string, key: string) => counters(dev)[key]?.packets ?? 0;

function tcp(dstPort: number, count = 3) {
  const before = peekTrafficSink(byName("H3"))?.tcp.packets ?? 0;
  S().startTraffic({ srcDeviceId: id("H1"), dstIp: "192.168.3.10", protocol: "tcp", srcPort: 40000, dstPort, size: 0, count, intervalMs: 0, continuous: false });
  vi.advanceTimersByTime(200);
  return (peekTrafficSink(byName("H3"))?.tcp.packets ?? 0) - before;
}

/** Replace S1's lab ACL with a fresh one bound on Ethernet2 (H1-facing) in `dir`. */
function bindAcl(rules: string[], dir: "in" | "out" = "in", port = "Ethernet 2") {
  return klish("S1", ["ip access-list T", ...rules, "exit", `interface ${port}`, `ip access-group T ${dir}`, "exit"]);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAll();
  S().loadFeatureLab("acl");
});
afterEach(() => {
  S().stopTraffic();
  vi.useRealTimers();
});

describe("ACL lab baseline", () => {
  it("H1 reaches H3 over the static routes while H1-POLICY is unbound (no counters shown)", () => {
    expect(received("H1", "192.168.3.10")).toBe(2);
    const o = show("S1", "show ip access-lists H1-POLICY");
    expect(o).toContain("ip access-list H1-POLICY\n  remark Block ping and HTTP from H1 to H3, allow the rest");
    expect(o).toContain("    seq 10 deny icmp host 192.168.1.10 host 192.168.3.10\n");
    expect(o).not.toContain("packets"); // unbound ACL: no counter leaves (xfmr_acl.go:2008)
  });
});

describe("IPv4 ACL enforcement", () => {
  it("binding H1-POLICY denies ICMP, counts it per rule, keeps ARP; unbinding restores traffic", () => {
    expect(klish("S1", ["interface Ethernet 2", "ip access-group H1-POLICY in"])).toEqual([]);
    S().execCommand(id("H1"), "ip neigh flush all");
    expect(received("H1", "192.168.3.10")).toBe(0);
    expect(byName("H1").arpTable.some((e) => e.ip === "192.168.1.1")).toBe(true); // ARP is not IPv4
    expect(hits("S1", "H1-POLICY|RULE_10")).toBe(2);
    const o = show("S1", "show ip access-lists");
    expect(o).toMatch(/    seq 10 deny icmp host 192\.168\.1\.10 host 192\.168\.3\.10 \(2 packets\) \[\d+ bytes\]/);
    expect(o).toContain("    seq 40 permit ip any any (0 packets) [0 bytes]");
    expect(show("S1", "show ip access-group")).toBe("Ingress IP access-list H1-POLICY on Ethernet2");

    expect(klish("S1", ["interface Ethernet 2", "no ip access-group H1-POLICY in"])).toEqual([]);
    expect(received("H1", "192.168.3.10")).toBe(2);
    expect(show("S1", "show ip access-group")).toBe("");
  });

  it("L4 ports: TCP SYN to 80 is dropped, 22 is allowed (first match by seq)", () => {
    klish("S1", ["interface Ethernet 2", "ip access-group H1-POLICY in"]);
    expect(tcp(80)).toBe(0);
    expect(hits("S1", "H1-POLICY|RULE_20")).toBe(3);
    expect(tcp(22)).toBe(3);
    expect(hits("S1", "H1-POLICY|RULE_30")).toBe(3);
    expect(tcp(443)).toBe(3); // seq 40 permit ip any any
  });

  it("port operators gt/lt/range and tcp flags", () => {
    bindAcl(["seq 10 deny tcp any any range 1000 2000", "seq 20 deny tcp any any gt 8000 syn", "seq 30 deny tcp any lt 1024 any", "seq 40 permit ip any any"]);
    expect(tcp(1500)).toBe(0);
    expect(tcp(999)).toBe(3);
    expect(tcp(8080)).toBe(0); // SYN set
    expect(show("S1", "show ip access-lists T")).toContain("seq 20 deny tcp any any gt 8000 syn (3 packets)");
    expect(show("S1", "show ip access-lists T")).toContain("seq 30 deny tcp any lt 1024 any (0 packets)"); // src port 40000
  });

  it("source / destination prefix matching", () => {
    bindAcl(["seq 10 deny ip 10.0.0.0/8 any", "seq 20 permit ip any any"]);
    expect(received("H1", "192.168.3.10")).toBe(2); // 192.168.1.10 is not in 10/8
    klish("S1", ["ip access-list T", "seq 5 deny ip 192.168.1.0/24 192.168.3.0/24", "exit"]);
    expect(received("H1", "192.168.3.10")).toBe(0);
    expect(hits("S1", "T|RULE_5")).toBe(2);
    expect(hits("S1", "T|RULE_10")).toBe(0);
  });

  it("first match wins: an earlier permit shadows a later deny, a lower seq deny overrides it", () => {
    bindAcl(["seq 10 permit icmp any any", "seq 20 deny icmp any any"]);
    expect(received("H1", "192.168.3.10")).toBe(2);
    expect(hits("S1", "T|RULE_10")).toBe(2);
    expect(hits("S1", "T|RULE_20")).toBe(0);
    klish("S1", ["ip access-list T", "seq 5 deny icmp any any", "exit"]);
    expect(received("H1", "192.168.3.10")).toBe(0);
    expect(hits("S1", "T|RULE_5")).toBe(2);
  });

  it("implicit deny drops unmatched IPv4 (DEFAULT_DROP_ANY) but not ARP", () => {
    bindAcl(["seq 10 permit tcp any any eq 22"]);
    S().execCommand(id("H1"), "ip neigh flush all");
    expect(received("H1", "192.168.3.10")).toBe(0);
    expect(hits("S1", "T|DEFAULT_DROP_ANY")).toBe(2);
    expect(byName("H1").arpTable.some((e) => e.ip === "192.168.1.1")).toBe(true);
    expect(tcp(22)).toBe(3);
  });

  it("ICMP type match: deny echo-request (type 8) only", () => {
    bindAcl(["seq 10 deny icmp any any type 8", "seq 20 permit ip any any"]);
    expect(received("H1", "192.168.3.10")).toBe(0);
    expect(received("H3", "192.168.1.10")).toBe(2); // H3's request enters S1 on Ethernet1; replies (type 0) pass Ethernet2
  });

  it("egress binding drops the reply leaving S1 towards H1; one stage per ACL", () => {
    bindAcl(["seq 10 deny icmp host 192.168.3.10 any", "seq 20 permit ip any any"], "out");
    const before = peekTrafficSink(byName("H3"))?.icmp.packets ?? 0;
    expect(received("H1", "192.168.3.10")).toBe(0);
    expect((peekTrafficSink(byName("H3"))?.icmp.packets ?? 0) - before).toBe(2); // requests got through
    expect(hits("S1", "T|RULE_10")).toBe(2);
    expect(show("S1", "show access-group")).toBe("Egress IP access-list T on Ethernet2");
    const errs = klish("S1", ["interface Ethernet 1", "ip access-group T in"]);
    expect(errs.map((e) => e.text)).toEqual(["%Error: Acl T direction of INGRESS not allowed when it is already configured as EGRESS"]);
  });

  it("switch-global binding applies to every port; type mismatch rejected", () => {
    klish("S1", ["ip access-list G", "seq 10 deny icmp any any", "seq 20 permit ip any any", "exit", "ip access-group G in"]);
    expect(received("H1", "192.168.3.10")).toBe(0);
    expect(show("S1", "show ip access-group")).toBe("Ingress IP access-list G on Switch");
    const e = klish("S1", ["mac access-group G in"]);
    expect(e.map((x) => x.text)).toEqual(["%Error: ACL G of the specified type not found"]);
    klish("S1", ["no ip access-group G in"]);
    expect(received("H1", "192.168.3.10")).toBe(2);
  });

  it("clear ip access-list counters, Click show acl table/rule and aclshow", () => {
    klish("S1", ["interface Ethernet 2", "ip access-group H1-POLICY in"]);
    received("H1", "192.168.3.10");
    const s1 = byName("S1");
    const ctx = { device: s1, network: S().network, captures: [], runSim: () => ({ value: undefined, events: [] }) } as never;
    const acl = out(aclshowCommand.run([], ctx));
    expect(acl.split("\n")[0]).toMatch(/^RULE NAME\s+TABLE NAME\s+PRIO\s+PACKETS COUNT\s+BYTES COUNT$/);
    expect(acl).toMatch(/RULE_10\s+H1-POLICY\s+65526\s+2\s+\d+/);
    expect(acl).not.toContain("RULE_20"); // zero counters hidden without -a
    expect(out(aclshowCommand.run(["-a"], ctx))).toMatch(/RULE_40\s+H1-POLICY\s+65496\s+0\s+0/);

    S().execCommand(s1.id, "clear ip access-list counters H1-POLICY");
    expect(hits("S1", "H1-POLICY|RULE_10")).toBe(0);

    S().execCommand(s1.id, "exit"); // sonic-cli → bash (Click)
    expect(show("S1", "show acl table H1-POLICY")).toMatch(/^H1-POLICY\s+L3\s+Ethernet2\s+Block ping.*\s+ingress\s+Active$/m);
    const rules = show("S1", "show acl rule H1-POLICY RULE_20");
    expect(rules).toMatch(/H1-POLICY\s+RULE_20\s+65516\s+DROP\s+DST_IP: 192\.168\.3\.10\/32/);
    expect(rules).toContain("L4_DST_PORT: 80");
  });
});

describe("rule validation", () => {
  it("rejects malformed matches and keeps per-rule remarks", () => {
    const errs = klish("S1", ["ip access-list V", "seq 10 permit tcp any any eq 70000", "seq 20 permit ip any", "seq 30 permit udp any any eq 53 remark DNS", "exit"]);
    expect(errs).toHaveLength(2);
    expect(show("S1", "show ip access-lists V")).toBe("ip access-list V\n    seq 30 permit udp any any eq 53\n      remark DNS");
  });
});

// ---------------------------------------------------------------------------
// VLAN / PortChannel / MAC on purpose-built switch labs
// ---------------------------------------------------------------------------

/** SW: H1 (Ethernet0) + H2 (Ethernet1) in VLAN 10, H3 (Ethernet2) in VLAN 20, SVI gateways. */
registerLab("acl-test-vlan", (api) => {
  api.newLab();
  const sw = api.addDevice("switch", { x: 0, y: 0 }, 4);
  const hs = [0, 1, 2].map((i) => api.addDevice("pc", { x: i * 100, y: 200 }));
  api.rename(sw, "SW");
  ["H1", "H2", "H3"].forEach((n, i) => api.rename(hs[i], n));
  const addr = ["10.0.10.1", "10.0.10.2", "10.0.20.3"];
  hs.forEach((h, i) => {
    api.setInterfaceIp(h, `${h}-if0`, addr[i], 24);
    api.setDefaultGateway(h, i < 2 ? "10.0.10.254" : "10.0.20.254");
    api.connect(h, `${h}-if0`, sw, `${sw}-if${i}`);
    api.setAccessVlan(sw, `${sw}-if${i}`, i < 2 ? 10 : 20);
  });
  api.runCliScript(sw, ["configure terminal", "interface Vlan 10", "ip address 10.0.10.254/24", "exit", "interface Vlan 20", "ip address 10.0.20.254/24", "end"]);
});

describe("VLAN and MAC ACLs", () => {
  beforeEach(() => S().loadFeatureLab("acl-test-vlan"));

  it("an ACL on Vlan10 filters bridged and SVI-routed traffic entering VLAN 10 ports", () => {
    expect(received("H1", "10.0.10.2")).toBe(2);
    expect(received("H1", "10.0.20.3")).toBe(2);
    expect(klish("SW", ["ip access-list V10", "seq 10 deny icmp any host 10.0.20.3", "seq 20 permit ip any any", "exit", "interface Vlan 10", "ip access-group V10 in"])).toEqual([]);
    expect(received("H1", "10.0.10.2")).toBe(2); // bridged, permitted by seq 20
    expect(received("H1", "10.0.20.3")).toBe(0); // routed via the SVI, denied by seq 10
    expect(hits("SW", "V10|RULE_10")).toBe(2);
    expect(received("H3", "10.0.10.1")).toBe(0); // H3's request passes; H1's reply (src 10.0.10.1 → H3) hits seq 10
    expect(show("SW", "show ip access-group")).toBe("Ingress IP access-list V10 on Vlan10");
  });

  it("port binding only affects that port", () => {
    klish("SW", ["ip access-list P", "seq 10 deny icmp any any", "seq 20 permit ip any any", "exit", "interface Ethernet 1", "ip access-group P in"]);
    expect(received("H1", "10.0.20.3")).toBe(2); // Ethernet0 unaffected
    expect(received("H2", "10.0.20.3")).toBe(0);
  });

  it("MAC ACL: deny by source MAC; no implicit deny for L2; ethertype arp match", () => {
    const h2mac = byName("H2").interfaces[0].mac.toLowerCase();
    expect(klish("SW", ["mac access-list M", `seq 10 deny host ${h2mac} any`, "exit", "interface Ethernet 1", "mac access-group M in"])).toEqual([]);
    expect(received("H2", "10.0.10.1")).toBe(0);
    expect(hits("SW", "M|RULE_10")).toBeGreaterThan(0);
    expect(received("H3", "10.0.10.1")).toBe(2); // other ports unaffected
    expect(counters("SW")["M|DEFAULT_DROP_ANY"]).toBeUndefined();
    expect(show("SW", "show mac access-lists M")).toMatch(new RegExp(`seq 10 deny host ${h2mac} any \\(\\d+ packets\\)`));
    expect(show("SW", "show mac access-group")).toBe("Ingress MAC access-list M on Ethernet1");

    klish("SW", ["mac access-list M", "no seq 10", "seq 10 deny any any arp", "exit"]);
    S().execCommand(id("H2"), "ip neigh flush all");
    expect(received("H2", "10.0.10.1")).toBe(0); // H2 cannot resolve H1
    expect(hits("SW", "M|RULE_10")).toBeGreaterThan(0);
  });
});

/** SW1 ═(Ethernet2+3 = PortChannel1)═ SW2, H1 on SW1 Ethernet0, H2 on SW2 Ethernet0 (VLAN 1). */
registerLab("acl-test-lag", (api) => {
  api.newLab();
  const s1 = api.addDevice("switch", { x: 0, y: 0 }, 4);
  const s2 = api.addDevice("switch", { x: 300, y: 0 }, 4);
  const h1 = api.addDevice("pc", { x: 0, y: 200 });
  const h2 = api.addDevice("pc", { x: 300, y: 200 });
  [["SW1", s1], ["SW2", s2], ["H1", h1], ["H2", h2]].forEach(([n, d]) => api.rename(d, n));
  api.setInterfaceIp(h1, `${h1}-if0`, "10.0.0.1", 24);
  api.setInterfaceIp(h2, `${h2}-if0`, "10.0.0.2", 24);
  api.connect(h1, `${h1}-if0`, s1, `${s1}-if0`);
  api.connect(h2, `${h2}-if0`, s2, `${s2}-if0`);
  api.connect(s1, `${s1}-if2`, s2, `${s2}-if2`);
  api.connect(s1, `${s1}-if3`, s2, `${s2}-if3`);
  for (const s of [s1, s2]) api.runCliScript(s, ["configure terminal", "interface PortChannel 1", "end"]);
});

describe("PortChannel binding", () => {
  beforeEach(() => {
    S().loadFeatureLab("acl-test-lag");
    for (const n of ["SW1", "SW2"]) byName(n).interfaces.find((i) => i.name === "PortChannel1")!.operState = "up";
    // Test scaffolding: a static LAG (Ethernet2/3 → PortChannel1) in place of the
    // LACP daemon's hook, so this test does not depend on LACP negotiation.
    const pc = (d: { interfaces: { name: string }[] }) => d.interfaces.find((i) => i.name === "PortChannel1");
    registerDataPlaneHook({
      id: "lacp",
      lagOf: (d, i) => (d.type === "switch" && /^Ethernet[23]$/.test(i.name) ? (pc(d) as never) : undefined),
      egressMember: (d, l) => (l.name === "PortChannel1" ? (d.interfaces.find((i) => i.name === "Ethernet3") as never) : undefined),
    });
  });

  it("frames arriving on a LAG member match the ACL bound to its PortChannel; counted once", () => {
    expect(received("H1", "10.0.0.2")).toBe(2);
    expect(klish("SW2", ["ip access-list L", "seq 10 deny icmp any any", "seq 20 permit ip any any", "exit", "interface PortChannel 1", "ip access-group L in"])).toEqual([]);
    expect(received("H1", "10.0.0.2")).toBe(0);
    expect(hits("SW2", "L|RULE_10")).toBe(2);
    expect(show("SW2", "show ip access-group")).toBe("Ingress IP access-list L on PortChannel1");

    // Egress on SW1's PortChannel: evaluated on the PortChannel, not again on the member.
    klish("SW2", ["interface PortChannel 1", "no ip access-group L in"]);
    klish("SW1", ["ip access-list E", "seq 10 deny icmp any any", "seq 20 permit ip any any", "exit", "interface PortChannel 1", "ip access-group E out"]);
    expect(received("H1", "10.0.0.2")).toBe(0);
    expect(hits("SW1", "E|RULE_10")).toBe(2);
  });
});
