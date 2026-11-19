import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { createDevice } from "../lib/models/factory";
import { Frame } from "../lib/models/packet";
import { Device } from "../lib/models/device";
import { classifyTrap, trapFor } from "../lib/protocols/cpu-traps";
import { peekCoppRuntime, CpuQueues } from "../lib/protocols/cpu-daemon";
import { peekDrops } from "../lib/control/drops";
import { peekTrafficSink } from "../lib/protocols/traffic";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(30_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

const queues = (d: Device) => (d.config.features?.["cpu-queues"] ?? {}) as CpuQueues;
const coppDrops = (d: Device) => Object.values(peekDrops(d) ?? {}).reduce((n, r) => n + (r.COPP_POLICER ?? 0), 0);
const trapPkts = (d: Device, id: string) => peekCoppRuntime(d)?.traps[id]?.pkts ?? 0;

function frame(p: Partial<Frame> & { dst?: string; type?: number }): Frame {
  return {
    id: "f1",
    ethernet: { srcMac: "02:00:00:00:00:99", dstMac: p.dst ?? "02:00:00:00:00:01", etherType: p.type ? "Other" : p.arp ? "ARP" : "IPv4", typeCode: p.type },
    meta: { sizeBytes: 100, summary: "" },
    ...p,
  } as Frame;
}

describe("hostif trap classification (copp_cfg.j2 defaults)", () => {
  const sw = () => {
    const d = createDevice({ id: "sw1", type: "switch", name: "SW1", x: 0, y: 0, ports: 4 });
    d.interfaces[0].ipv4 = [{ address: "10.0.0.1", prefix: 24 }];
    return d;
  };
  const ip = (dst: string, extra: Partial<Frame>, ttl = 64, proto: "ICMP" | "TCP" | "UDP" | "OSPF" | "OTHER" = "UDP", num?: number): Partial<Frame> => ({
    ipv4: { srcIp: "10.0.0.2", dstIp: dst, ttl, protocol: proto, protocolNumber: num, identification: 0 },
    ...extra,
  });
  const cases: [string, Partial<Frame> & { dst?: string; type?: number }, string, string, number][] = [
    ["ARP request", { arp: { op: "request", senderMac: "", senderIp: "10.0.0.2", targetMac: "", targetIp: "10.0.0.1" }, dst: "FF:FF:FF:FF:FF:FF" }, "arp_req", "arp", 10],
    ["ARP reply", { arp: { op: "reply", senderMac: "", senderIp: "10.0.0.2", targetMac: "", targetIp: "10.0.0.1" } }, "arp_resp", "arp", 10],
    ["LACP", { dst: "01:80:C2:00:00:02", type: 0x8809 }, "lacp", "lacp", 23],
    ["LLDP", { dst: "01:80:C2:00:00:0E", type: 0x88cc }, "lldp", "lldp", 18],
    ["STP BPDU", { dst: "01:80:C2:00:00:00", type: 0x0026 }, "stp", "stp", 21],
    ["OSPF hello", { dst: "01:00:5E:00:00:05", ...ip("224.0.0.5", {}, 1, "OSPF") }, "ospf", "ospf", 15],
    ["BGP", ip("10.0.0.1", { tcp: { srcPort: 40000, dstPort: 179, seq: 0, ack: 0, flags: ["SYN"], window: 64240 } }, 64, "TCP"), "bgp", "bgp", 14],
    ["BFD", ip("10.0.0.1", { udp: { srcPort: 49152, dstPort: 3784, length: 24 } }), "bfd", "bfd", 20],
    ["VRRP", { dst: "01:00:5E:00:00:12", ...ip("224.0.0.18", {}, 255, "OTHER", 112) }, "vrrp", "vrrp", 17],
    ["DHCP", { dst: "FF:FF:FF:FF:FF:FF", ...ip("255.255.255.255", { udp: { srcPort: 68, dstPort: 67, length: 300 } }) }, "dhcp", "dhcp_relay", 9],
    ["ICMP to me", ip("10.0.0.1", { icmp: { type: "echo-request", code: 0, identifier: 1, sequence: 1 } }, 64, "ICMP"), "ip2me", "ip2me", 7],
    ["SNMP to me (no snmp trap installed → ip2me)", ip("10.0.0.1", { udp: { srcPort: 5000, dstPort: 161, length: 40 } }), "ip2me", "ip2me", 7],
    ["TTL expiry", ip("10.9.9.9", { icmp: { type: "echo-request", code: 0, identifier: 1, sequence: 1 } }, 1, "ICMP"), "ttl_error", "ttl", 0],
  ];
  for (const [name, f, trapId, group, queue] of cases) {
    it(`${name} → trap ${trapId}, group ${group}, CPU queue ${queue}`, () => {
      const d = sw();
      const t = trapFor(d, classifyTrap(d, frame(f)))!;
      expect([t.trapId, t.group, t.params.queue]).toEqual([trapId, group, queue]);
    });
  }

  it("a configured CoPP policy overrides the default group; disabling the bgp FEATURE falls BGP back to ip2me", () => {
    const d = sw();
    const bgp = frame(cases[6][1]);
    d.config.features = {
      copp: { actions: [{ name: "my-bgp", trapQueue: 5, cir: 10, cbs: 10 }], classifiers: [{ name: "c", protocols: ["bgp"] }], bindings: [{ classifier: "c", action: "my-bgp", priority: 0 }] },
    };
    expect(trapFor(d, classifyTrap(d, bgp))).toMatchObject({ trapId: "bgp", group: "my-bgp", params: { queue: 5, cir: 10 } });
    d.config.features = { cp_feature: { features: [{ name: "bgp", state: "disabled" }] } };
    expect(trapFor(d, classifyTrap(d, bgp))).toMatchObject({ trapId: "ip2me", group: "ip2me" });
  });
});

describe("CoPP policers on the CPU path (copp lab)", () => {
  const storm = (count: number) => {
    S().startTraffic({ srcDeviceId: byName("H1").id, dstIp: "192.168.1.1", protocol: "icmp", srcPort: 0, dstPort: 0, size: 56, count, intervalMs: 0, continuous: false });
    vi.advanceTimersByTime(Math.ceil(count / 200) * 50 + 50);
  };

  it("an ICMP-to-switch storm above the 50 pps CIR is dropped; slow pings and transit traffic pass", () => {
    S().loadFeatureLab("copp");
    S().execCommand(byName("H1").id, "ping -c 3 192.168.1.1"); // below CIR: all answered
    const s1 = () => byName("S1");
    expect(queues(s1())["7"]?.pkts).toBeGreaterThanOrEqual(3);
    expect(queues(s1())["7"]?.dropPkts ?? 0).toBe(0);
    expect(coppDrops(s1())).toBe(0);

    vi.advanceTimersByTime(5_000); // bucket refills
    storm(600);
    const q7 = queues(s1())["7"];
    expect(q7.dropPkts).toBeGreaterThan(400);
    expect(q7.pkts).toBeLessThan(120);
    expect(coppDrops(s1())).toBe(q7.dropPkts);
    expect(peekCoppRuntime(s1())!.groups["copp-lab-ip2me"]).toMatchObject({ queue: 7, dropPkts: q7.dropPkts });
    expect(trapPkts(s1(), "ip2me")).toBe(q7.pkts + q7.dropPkts);

    // transit H1 → H2 is routed in hardware, never trapped: all 300 arrive
    const before = q7.pkts + q7.dropPkts;
    S().startTraffic({ srcDeviceId: byName("H1").id, dstIp: "192.168.2.10", protocol: "udp", srcPort: 40000, dstPort: 5001, size: 64, count: 300, intervalMs: 0, continuous: false });
    vi.advanceTimersByTime(200);
    expect(peekTrafficSink(byName("H2"))?.udp.packets).toBe(300);
    expect(queues(s1())["7"].pkts + queues(s1())["7"].dropPkts).toBe(before);
  });

  it("raising the CIR raises the limit", () => {
    S().loadFeatureLab("copp");
    const s1 = byName("S1").id;
    S().execCommand(s1, "config copp action set copp-lab-ip2me police cir 100000 cbs 100000");
    storm(600);
    expect(queues(byName("S1"))["7"]?.dropPkts ?? 0).toBe(0);
    expect(queues(byName("S1"))["7"].pkts).toBeGreaterThanOrEqual(600);
    S().execCommand(s1, "config copp action set copp-lab-ip2me police cir 10 cbs 10");
    storm(200);
    expect(queues(byName("S1"))["7"].dropPkts).toBeGreaterThan(150);
  });

  it("show copp counters / configuration render live trap counters and HW status", () => {
    S().loadFeatureLab("copp");
    storm(200);
    advance(1_000, 500);
    const s1 = byName("S1").id;
    const counters = out(S().execCommand(s1, "show copp counters"));
    expect(counters).toMatch(/^Trap Name\s+Packets\s+Bytes\s+PPS/m);
    expect(counters).toMatch(/^ip2me\s+\d+\s+\d+\s+\d+\.\d\d$/m);
    expect(counters).toMatch(/^arp_req\s+[1-9]/m);
    const cfg = out(S().execCommand(s1, "show copp configuration"));
    expect(cfg).toMatch(/ip2me\s+copp-lab-ip2me\s+trap\s+50\s+50\s+packets\s+sr_tcm\s+installed/);
    expect(cfg).toMatch(/ip2me\s+ip2me\s+trap\s+6000\s+6000\s+packets\s+sr_tcm\s+not-installed/);
    expect(cfg).toMatch(/arp_req\s+arp\s+copy\s+3000\s+3000/);
    const det = out(S().execCommand(s1, "show copp configuration detailed --trapid ip2me"));
    expect(det).toContain("Trap Group.................. copp-lab-ip2me");
    expect(det).toContain("Queue....................... 7");
    expect(det).toContain("HW Status................... installed");
  });

  it("hardware data plane: tcpdump still shows trapped (CPU-bound) frames", () => {
    S().loadFeatureLab("copp");
    const s1 = byName("S1").id;
    S().setDataplaneMode(s1, "hardware");
    S().execCommand(s1, "sudo tcpdump -i Ethernet0 -nn");
    S().execCommand(byName("H1").id, "ping -c 2 192.168.1.1");
    S().execCommand(byName("H1").id, "ping -c 2 192.168.2.10");
    S().stopLiveCapture(s1);
    const lines = (S().terminals[s1] ?? []).map((l) => l.text).join("\n");
    expect(lines).toMatch(/192\.168\.1\.10 > 192\.168\.1\.1: ICMP echo request/);
    expect(lines).not.toMatch(/192\.168\.1\.10 > 192\.168\.2\.10: ICMP echo request/);
  });
});

describe("protocol traffic lands in the right CPU queues", () => {
  it("LACP → queue 23, OSPF → 15, BGP → 14, LLDP → 18", () => {
    S().loadFeatureLab("lacp");
    advance(5_000);
    expect(trapPkts(byName("S1"), "lacp")).toBeGreaterThan(0);
    expect(queues(byName("S1"))["23"].pkts).toBeGreaterThan(0);

    S().loadFeatureLab("ospf");
    advance(15_000);
    expect(trapPkts(byName("S1"), "ospf")).toBeGreaterThan(0);
    expect(queues(byName("S1"))["15"].pkts).toBeGreaterThan(0);

    S().loadFeatureLab("bgp");
    advance(20_000);
    expect(trapPkts(byName("S1"), "bgp")).toBeGreaterThan(0);
    expect(queues(byName("S1"))["14"].pkts).toBeGreaterThan(0);

    S().loadFeatureLab("lldp");
    advance(40_000);
    const sw = Object.values(S().network.devices).find((d) => d.type === "switch" && trapPkts(d, "lldp") > 0)!;
    expect(queues(sw)["18"].pkts).toBeGreaterThan(0);
  });
});

describe("SONiC containers: show services / feature status / docker ps", () => {
  it("feature table drives docker ps; disabling lldp stops its container and its LLDP trap", () => {
    S().loadFeatureLab("lldp");
    advance(40_000);
    const sw = Object.values(S().network.devices).find((d) => d.type === "switch" && trapPkts(d, "lldp") > 0)!;
    const id = sw.id;
    S().execCommand(id, "exit"); // KLISH → Click shell
    const status = out(S().execCommand(id, "show feature status"));
    expect(status).toMatch(/^Feature\s+State\s+AutoRestart/m);
    expect(status).toMatch(/^database\s+always_enabled\s+always_enabled/m);
    expect(status).toMatch(/^lldp\s+enabled\s+enabled/m);
    expect(status).toMatch(/^nat\s+disabled\s+enabled/m);

    const ps = out(S().execCommand(id, "docker ps"));
    expect(ps).toMatch(/^CONTAINER ID\s+IMAGE\s+COMMAND\s+CREATED\s+STATUS\s+PORTS\s+NAMES/);
    expect(ps).toMatch(/docker-lldp:latest .* Up .* lldp$/m);
    expect(ps).not.toMatch(/ nat$/m);

    const svc = out(S().execCommand(id, "show services"));
    expect(svc).toContain("lldp\tdocker");
    expect(svc).toMatch(/\/usr\/bin\/lldpd/);
    expect(svc).toMatch(/\/usr\/bin\/orchagent/);
    expect(out(S().execCommand(id, "docker exec bgp ps aux"))).toMatch(/\/usr\/bin\/bgpd/);

    expect(out(S().execCommand(id, "config feature state database disabled"))).toContain("always enabled and can not be modified");
    expect(out(S().execCommand(id, "config feature state nosuch disabled"))).toContain("Feature 'nosuch' doesn't exist");
    S().execCommand(id, "config feature state lldp disabled");
    expect(out(S().execCommand(id, "show feature status lldp"))).toMatch(/^lldp\s+disabled/m);
    expect(out(S().execCommand(id, "docker ps"))).not.toMatch(/ lldp$/m);
    expect(out(S().execCommand(id, "docker ps -a"))).toMatch(/Exited \(0\) .* lldp$/m);
    expect(out(S().execCommand(id, "show copp configuration"))).toMatch(/^lldp\s+lldp\s+trap\s+500\s+500\s+packets\s+sr_tcm\s+not-installed/m);
    const before = trapPkts(byName(sw.name), "lldp");
    advance(40_000);
    expect(trapPkts(byName(sw.name), "lldp")).toBe(before); // no longer trapped

    S().execCommand(id, "config feature state lldp enabled");
    advance(40_000);
    expect(trapPkts(byName(sw.name), "lldp")).toBeGreaterThan(before);
  });
});
