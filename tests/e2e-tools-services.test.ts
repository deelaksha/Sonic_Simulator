/**
 * End to end: host tools, traffic tools and the smaller services — config typed
 * in KLISH / Click, the control- and data-plane effect with real traffic, and
 * the show / DB view of it. Interactions with routing, ACLs and VRFs included.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekDrops } from "../lib/control/drops";
import { inetChecksum } from "../lib/sflow/wire";
import { peekTrafficSink } from "../lib/protocols/traffic";

const id = (n: string) => byName(n).id;
const sh = (n: string, cmd: string) => out(S().execCommand(id(n), cmd));
/** KLISH config lines from configure terminal (switch terminals boot into sonic-cli). */
const klish = (n: string, lines: string[]) => S().runCliScript(id(n), ["configure terminal", ...lines, "end"], { silent: true });
/** A KLISH exec command (enters sonic-cli from bash if needed). */
function kx(n: string, cmd: string): string {
  if (!(S().cliMode[id(n)] ?? ["exec"]).length) S().execCommand(id(n), "sonic-cli");
  return sh(n, cmd);
}
/** A bash / Click command on a switch. */
function bash(n: string, cmd: string): string {
  if (byName(n).type === "switch" && (S().cliMode[id(n)] ?? ["exec"]).length) S().execCommand(id(n), "exit");
  return sh(n, cmd);
}
const port = (dev: string, name: string) => byName(dev).interfaces.find((i) => i.name === name)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => {
  S().stopTraffic();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
describe("ping options over a routed path (ospf lab)", () => {
  beforeEach(() => {
    S().loadFeatureLab("ospf");
    advance(12_000);
  });

  it("-t: a TTL that runs out on the way gets Time to live exceeded from that hop, counted as +errors", () => {
    const t1 = sh("H1", "ping -c 2 -t 1 192.168.3.10");
    expect(t1).toContain("From 192.168.1.1 icmp_seq=1 Time to live exceeded");
    expect(t1).toContain("2 packets transmitted, 0 received, +2 errors, 100% packet loss");
    expect(sh("H1", "ping -c 1 -t 2 192.168.3.10")).toContain("From 10.0.13.2 icmp_seq=1 Time to live exceeded");
    const ok = sh("H1", "ping -c 2 -t 3 192.168.3.10");
    expect(ok).toContain("64 bytes from 192.168.3.10: icmp_seq=1 ttl=62");
    expect(ok).toMatch(/2 packets transmitted, 2 received, 0% packet loss\nrtt min\/avg\/max\/mdev = [\d.]+\/[\d.]+\/[\d.]+\/[\d.]+ ms/);
    expect(sh("H1", "ping -c 1 -t 0 192.168.3.10")).toContain("out of range: 1 <= value <= 255");
  });

  it("-M do: a probe over the 1500-byte host MTU fails locally; 1472 bytes of data fit exactly", () => {
    const big = sh("H1", "ping -c 2 -M do -s 1473 192.168.3.10");
    expect(big).toContain("PING 192.168.3.10 (192.168.3.10) 1473(1501) bytes of data.");
    expect(big).toContain("ping: local error: message too long, mtu=1500");
    expect(big).toContain("2 packets transmitted, 0 received, +2 errors, 100% packet loss");
    const fits = sh("H1", "ping -c 1 -M do -s 1472 192.168.3.10");
    expect(fits).toContain("1480 bytes from 192.168.3.10: icmp_seq=1");
    // A SONiC front-panel port has the 9100 PORT.mtu default: 9000 bytes of data leave S1 with DF.
    expect(bash("S1", "ping -c 1 -M do -s 9000 10.0.12.2")).toContain("9008 bytes from 10.0.12.2");
    expect(bash("S1", "ping -c 1 -M do -s 9073 10.0.12.2")).toContain("local error: message too long, mtu=9100");
    expect(sh("H1", "ping -c 1 -M sometimes 192.168.3.10")).toContain("invalid -M argument");
  });

  it("-I <port> binds the probe to that port and its address; no route out of it is unreachable", () => {
    const bound = bash("S1", "ping -c 1 -I Ethernet0 10.0.12.2");
    expect(bound).toContain("PING 10.0.12.2 (10.0.12.2) from 10.0.12.1 Ethernet0: 56(84) bytes of data.");
    expect(bound).toContain("1 received");
    const tx0 = port("S1", "Ethernet0").statistics.txFrames;
    // OSPF reaches H3 via Ethernet1; bound to Ethernet0 there is no route out of it.
    expect(bash("S1", "ping -c 1 -I Ethernet0 192.168.3.10")).toContain("ping: connect: Network is unreachable");
    expect(port("S1", "Ethernet0").statistics.txFrames).toBe(tx0);
    expect(sh("H1", "ping -c 1 -I eth0 192.168.3.10")).toContain("from 192.168.1.10 eth0: 56(84)");
    expect(bash("S1", "ping -c 1 -I Ethernet9 10.0.12.2")).toContain("unknown VRF or interface");
  });

  it("-q prints only the summary; a switch with no route drops in the ASIC (no ICMP)", () => {
    const q = sh("H1", "ping -q -c 3 192.168.3.10");
    expect(q).not.toContain("bytes from");
    expect(q).toContain("3 packets transmitted, 3 received, 0% packet loss");
    expect(sh("H1", "ping -c 1 172.31.0.1")).toContain("100% packet loss"); // S1 has no route: dropped in the ASIC
  });

  it("traceroute prints Linux traceroute's format; -n drops the name column; no route is a connect error", () => {
    const tr = sh("H1", "traceroute 192.168.3.10").split("\n");
    expect(tr[0]).toBe("traceroute to 192.168.3.10 (192.168.3.10), 30 hops max, 60 byte packets");
    expect(tr[1]).toMatch(/^ 1 {2}192\.168\.1\.1 \(192\.168\.1\.1\) {2}\d+\.\d{3} ms$/);
    expect(tr[2]).toMatch(/^ 2 {2}10\.0\.13\.2 \(10\.0\.13\.2\) /);
    expect(tr[3]).toMatch(/^ 3 {2}192\.168\.3\.10 \(192\.168\.3\.10\) /);
    expect(sh("H1", "traceroute -n -m 2 192.168.3.10").split("\n").slice(1)).toEqual([
      expect.stringMatching(/^ 1 {2}192\.168\.1\.1 {2}\d/),
      expect.stringMatching(/^ 2 {2}10\.0\.13\.2 {2}\d/),
    ]);
    S().setDefaultGateway(id("H1"), "");
    expect(sh("H1", "traceroute 192.168.3.10")).toMatch(/60 byte packets\nconnect: Network is unreachable$/);
    expect(sh("H1", "ping -c 1 192.168.3.10")).toMatch(/^ping: connect: Network is unreachable/);
  });
});

// ---------------------------------------------------------------------------
describe("host tools inside a VRF (vrf lab)", () => {
  beforeEach(() => {
    S().loadFeatureLab("vrf");
    advance(3_000);
  });

  it("KLISH `traceroute vrf` and Linux `traceroute -i <VRF>` trace inside Vrf-red; the default VRF has no route", () => {
    const k = kx("S1", "traceroute vrf Vrf-red 192.168.3.10");
    expect(k).toMatch(/^ 1 {2}10\.0\.13\.2 \(10\.0\.13\.2\)/m);
    expect(k).toMatch(/^ 2 {2}192\.168\.3\.10 \(192\.168\.3\.10\)/m);
    expect(bash("S1", "traceroute -n -i Vrf-red 192.168.3.10")).toMatch(/ 1 {2}10\.0\.13\.2 {2}[\s\S]* 2 {2}192\.168\.3\.10 /);
    expect(bash("S1", "traceroute 192.168.3.10")).toContain("connect: Network is unreachable");
    expect(bash("S1", "traceroute -i Vrf-blue 192.168.3.10")).toContain("Vrf-blue: No such device");
  });

  it("ping -I <VRF port> picks up the port's VRF; ICMP errors are routed back inside the VRF", () => {
    expect(bash("S1", "ping -c 1 -I Ethernet2 192.168.1.10")).toContain("from 192.168.1.1 Ethernet2: 56(84)");
    expect(bash("S1", "ping -c 1 -I Ethernet1 192.168.3.10")).toContain("1 received");
    // TTL expiry on S1 (Vrf-red ingress): the Time Exceeded must go back through Vrf-red.
    expect(sh("H1", "ping -c 1 -t 1 192.168.3.10")).toContain("From 192.168.1.1 icmp_seq=1 Time to live exceeded");
    expect(sh("H1", "traceroute -n 192.168.3.10")).toMatch(/ 1 {2}192\.168\.1\.1 [\s\S]* 2 {2}10\.0\.13\.2 [\s\S]* 3 {2}192\.168\.3\.10 /);
  });
});

// ---------------------------------------------------------------------------
describe("DHCP client and DNS resolution end to end", () => {
  it("a DHCP lease installs the server's nameserver: the host then resolves names over the routed path", () => {
    S().loadFeatureLab("copp"); // S1 routes 192.168.1.0/24 (H1) ↔ 192.168.2.0/24 (H2)
    klish("S1", ["vlan 10", "interface Vlan 10", "ip address 10.10.0.1/24", "ip dhcp-relay 192.168.2.10", "exit", "interface Ethernet 3", "switchport access Vlan 10"]);
    // H2 is the DHCP + DNS server for the relayed VLAN.
    byName("H2").config.features = {
      dhcpServer: { gateway: "192.168.2.1", dns: "192.168.2.10", prefix: 24, leases: {}, pools: [{ subnet: "10.10.0.0", prefix: 24, gateway: "10.10.0.1", dns: "192.168.2.10", leases: {} }] },
      dnsRecords: { "h1.lab": "192.168.1.10" },
    };
    const pc = S().addDevice("pc", { x: 0, y: 0 });
    S().renameDevice(pc, "PC");
    S().connect(pc, `${pc}-if0`, id("S1"), `${id("S1")}-if3`, { autoDhcp: false });
    expect(sh("PC", "nslookup h1.lab")).toMatch(/can't resolve|no nameserver/i);
    const lease = sh("PC", "dhclient eth0");
    expect(lease).toMatch(/bound to 10\.10\.0\.1\d\d\/24 -- gateway 10\.10\.0\.1, dns 192\.168\.2\.10/);
    expect(sh("PC", "nslookup h1.lab")).toMatch(/Server:\s+192\.168\.2\.10[\s\S]*Name:\s+h1\.lab\nAddress: 192\.168\.1\.10/);
    expect(sh("PC", "ping -c 2 h1.lab")).toMatch(/PING h1\.lab \(192\.168\.1\.10\)[\s\S]*2 received/);
    expect(sh("PC", "traceroute -n h1.lab")).toMatch(/traceroute to h1\.lab \(192\.168\.1\.10\)[\s\S]* 1 {2}10\.10\.0\.1 [\s\S]* 2 {2}192\.168\.1\.10 /);
  });

  it("KLISH `ip name-server` on a switch: show hosts / CONFIG_DB, and ping/traceroute/nslookup by name over the management network", () => {
    S().loadFeatureLab("ospf");
    advance(12_000);
    byName("NMS").config.features = { dnsRecords: { "h3.lab": "192.168.3.10" } };
    expect(kx("S1", "ping -c 1 h3.lab")).toContain("ping: h3.lab: Name or service not known");
    klish("S1", ["ip name-server 192.168.100.250"]);
    expect(kx("S1", "show hosts")).toContain("Name servers are: 192.168.100.250");
    expect(bash("S1", "sonic-db-cli CONFIG_DB KEYS 'DNS_NAMESERVER|*'")).toContain("DNS_NAMESERVER|192.168.100.250");
    expect(kx("S1", "ping -c 1 h3.lab")).toMatch(/PING h3\.lab \(192\.168\.3\.10\)[\s\S]*1 received/);
    expect(bash("S1", "nslookup h3.lab")).toMatch(/Name:\s+h3\.lab\nAddress: 192\.168\.3\.10/);
    expect(bash("S1", "traceroute -n h3.lab")).toMatch(/ 1 {2}10\.0\.13\.2 [\s\S]* 2 {2}192\.168\.3\.10 /);
    klish("S1", ["no ip name-server 192.168.100.250"]);
    expect(kx("S1", "ping -c 1 h3.lab")).toContain("Name or service not known");
  });
});

// ---------------------------------------------------------------------------
describe("TCP apps and ACLs: drops, ACL counters and port counters agree (acl lab)", () => {
  it("nc to TCP/80 times out (seq 20 drop), TCP/22 connects (seq 30); each dropped packet counts once", () => {
    S().loadFeatureLab("acl");
    advance(3_000);
    klish("S1", ["interface Ethernet 2", "ip access-group H1-POLICY in"]);
    sh("H3", "nc -l -k 80");
    sh("H3", "nc -l -k 22");
    expect(sh("H1", "nc -z -v -w 1 192.168.3.10 80")).toContain("timed out");
    expect(sh("H1", "nc -z -v -w 1 192.168.3.10 22")).toContain("succeeded!");
    expect(sh("H1", "ping -c 2 192.168.3.10")).toContain("0 received");
    const acl = kx("S1", "show ip access-lists H1-POLICY");
    const hits = (seq: number) => Number(new RegExp(`seq ${seq} [^\\n]*\\((\\d+) packets\\)`).exec(acl)![1]);
    expect(hits(10)).toBe(2);
    const denied = hits(10) + hits(20);
    expect(port("S1", "Ethernet2").statistics.rxDropped).toBe(denied);
    expect(peekDrops(byName("S1"))!.Ethernet2).toEqual({ ACL_ANY: denied });
    const row = bash("S1", "show dropcounters counts").split("\n").find((l) => l.startsWith("Ethernet2"))!.trim().split(/\s+/);
    expect(Number(row[3])).toBe(denied); // RX_DROPS
    const oid = bash("S1", "sonic-db-cli COUNTERS_DB HGET COUNTERS_PORT_NAME_MAP Ethernet2").trim();
    expect(bash("S1", `sonic-db-cli COUNTERS_DB HGET COUNTERS:${oid} SAI_PORT_STAT_IF_IN_DISCARDS`).trim()).toBe(String(denied));
  });
});

// ---------------------------------------------------------------------------
describe("CoPP configured in KLISH polices a real TTL-expiry storm (ospf lab)", () => {
  it("copp-action / class-map match-type copp / policy-map copp-system-policy: ttl_error is policed at the CIR; counters move", () => {
    S().loadFeatureLab("ospf");
    advance(12_000);
    klish("S1", [
      "copp-action TTL-LIM", "set trap-action trap", "set trap-queue 3", "police cir 20 cbs 20", "exit",
      "class-map TTL-CL match-type copp", "match protocol ttl_error", "exit",
      "policy-map copp-system-policy type copp", "class TTL-CL priority 5", "set copp-action TTL-LIM",
    ]);
    expect(bash("S1", "show copp policy")).toMatch(/Flow TTL-CL[\s\S]*police cir 20 cbs 20/);
    const cfg = bash("S1", "show copp configuration");
    expect(cfg).toMatch(/ttl_error\s+TTL-LIM\s+trap\s+20\s+20\s+packets\s+sr_tcm\s+installed/);
    expect(cfg).toMatch(/ttl_error\s+ttl\s+trap\s+100\s+100\s+packets\s+sr_tcm\s+not-installed/);
    // 100 probes expiring on S1 within ~0.7 s: the 20-packet bucket plus ~20 pps of refill reach the CPU.
    const r = sh("H1", "ping -c 100 -t 1 192.168.3.10");
    const errs = Number(/\+(\d+) errors/.exec(r)![1]);
    expect(errs).toBeGreaterThanOrEqual(20);
    expect(errs).toBeLessThan(45);
    const counters = bash("S1", "show copp counters");
    expect(Number(/^ttl_error\s+(\d+)/m.exec(counters)![1])).toBe(100);
    const q3 = (byName("S1").config.features?.["cpu-queues"] as Record<string, { pkts: number; dropPkts: number }>)["3"];
    expect(q3.dropPkts).toBe(100 - errs);
    expect(peekDrops(byName("S1"))!.Ethernet2.COPP_POLICER).toBe(100 - errs);
    // Transit traffic is not trapped and not policed.
    expect(sh("H1", "ping -c 5 192.168.3.10")).toContain("5 received");
    // Removing the binding returns ttl_error to the default ttl group (100 pps).
    klish("S1", ["policy-map copp-system-policy type copp", "no class TTL-CL"]);
    vi.advanceTimersByTime(5_000);
    expect(bash("S1", "show copp policy")).not.toContain("TTL-CL");
    expect(Number(/\+(\d+) errors/.exec(sh("H1", "ping -c 50 -t 1 192.168.3.10"))![1])).toBe(50);
  });
});

// ---------------------------------------------------------------------------
describe("ECMP load sharing with real flows (ospf lab, equal-cost S1→S3 and S1→S2→S3)", () => {
  /** Next hops S1 used for 32 UDP flows H1 → H3 (different source ports). */
  function spread(): { e0: number; e1: number } {
    const s1 = byName("S1");
    const before = S().captures.length;
    for (let p = 0; p < 32; p++) {
      S().startTraffic({ srcDeviceId: id("H1"), dstIp: "192.168.3.10", protocol: "udp", srcPort: 42000 + p, dstPort: 5001, size: 64, count: 1, intervalMs: 0, continuous: false });
      vi.advanceTimersByTime(100);
    }
    const sent = S().captures.slice(before).filter((c) => c.deviceId === s1.id && c.dir === "tx" && c.frame.udp?.dstPort === 5001);
    return { e0: sent.filter((c) => c.interfaceId === port("S1", "Ethernet0").id).length, e1: sent.filter((c) => c.interfaceId === port("S1", "Ethernet1").id).length };
  }

  it("flows spread over both next hops; a KLISH hash seed reshuffles them; every flow still arrives", () => {
    S().loadFeatureLab("ospf");
    klish("S1", ["interface Ethernet 1", "ip ospf cost 8"]); // 8 = 4 + 4 via S2
    advance(15_000);
    expect(kx("S1", "show ip route 192.168.3.0/24")).toMatch(/via 10\.0\.12\.2[\s\S]*via 10\.0\.13\.2|via 10\.0\.13\.2[\s\S]*via 10\.0\.12\.2/);
    const a = spread();
    expect(a.e0 + a.e1).toBe(32);
    expect(Math.min(a.e0, a.e1)).toBeGreaterThan(4);
    klish("S1", ["ip load-share hash seed 77"]);
    expect(kx("S1", "show ip load-share")).toMatch(/seed\s*:?\s*77/i);
    const b = spread();
    expect(b.e0 + b.e1).toBe(32);
    expect(b).not.toEqual(a);
    // Hash only on addresses: all 32 flows between the same two hosts take one path.
    klish("S1", ["no ip load-share hash ipv4 ipv4-l4-src-port", "no ip load-share hash ipv4 ipv4-l4-dst-port"]);
    const c = spread();
    expect(Math.max(c.e0, c.e1)).toBe(32);
    expect(byName("H3").config.features?.["traffic-sink"]).toMatchObject({ udp: { packets: 96 } });
  });
});

// ---------------------------------------------------------------------------
describe("iperf3 and PFC on the real forwarding path (qos lab)", () => {
  beforeEach(() => {
    S().loadFeatureLab("qos");
    sh("H3", "iperf3 -s");
  });
  const portstat = (dev: string, p: string) => {
    // Columns are 2+ spaces apart ("12.3 MB/s" is one cell).
    const r = bash(dev, "show interfaces counters").split("\n").find((l) => l.trim().startsWith(p + " "))!.trim().split(/\s{2,}/);
    return { rxOk: Number(r[2].replace(/,/g, "")), txOk: Number(r[8].replace(/,/g, "")), txDrp: Number(r[12].replace(/,/g, "")) };
  };

  it("a TCP iperf3 stream moves portstat, COUNTERS_DB octets and the util column on every hop", () => {
    const before = portstat("S1", "Ethernet2");
    const r = sh("H1", "iperf3 -c 192.168.3.10 -t 4");
    expect(r).toMatch(/9\d\d Mbits\/sec\s+0\s+sender/);
    advance(2_000);
    const mid = portstat("S1", "Ethernet2");
    expect(mid.txOk - before.txOk).toBeGreaterThan(100_000); // ~81k pps of 1514-byte frames
    expect(portstat("S1", "Ethernet0").rxOk).toBeGreaterThan(100_000);
    const oid = bash("S1", "sonic-db-cli COUNTERS_DB HGET COUNTERS_PORT_NAME_MAP Ethernet2").trim();
    const octets = Number(bash("S1", `sonic-db-cli COUNTERS_DB HGET COUNTERS:${oid} SAI_PORT_STAT_IF_OUT_OCTETS`).trim());
    expect(octets).toBeGreaterThan(100_000_000); // > 100 MB in 2 s at ~1 Gbit/s
    expect(bash("S1", "show interfaces counters")).toMatch(/Ethernet2\s+U\s+[\d,]+\s+[\d.]+ \S+\/s\s+[\d.]+%\s+0\s+0\s+0\s+[\d,]+\s+1[12]\d\.\d\d MB\/s\s+[1-9][\d.]*%/);
    advance(3_000); // the stream ends with -t
    const end = portstat("S1", "Ethernet2").txOk;
    advance(1_000);
    expect(portstat("S1", "Ethernet2").txOk - end).toBeLessThan(100);
  });

  it("KLISH `priority-flow-control priority 3` makes UC3 lossless: senders are paused (PFC Tx) instead of the queue dropping", () => {
    klish("S1", ["interface Ethernet 2", "priority-flow-control priority 3"]);
    expect(bash("S1", "show pfc priority Ethernet2")).toMatch(/Ethernet2\s+3/);
    sh("H1", "iperf3 -c 192.168.3.10 -u -b 800M -S 104 -t 10"); // DSCP 26 → TC3 → UC3
    const r = sh("H2", "iperf3 -c 192.168.3.10 -u -b 800M -S 104 -t 3");
    expect(r).toMatch(/ 0\/\d+ \(0%\)\s+receiver/);
    advance(2_000);
    const pfc = bash("S1", "show pfc counters");
    const txRow = (p: string) => pfc.split("\n").filter((l) => l.trim().startsWith(p + " ")).pop()!.trim().split(/\s+/).slice(1).map((v) => Number(v.replace(/,/g, "")));
    expect(txRow("Ethernet0")[3]).toBeGreaterThan(0); // PFC3 pause frames sent towards H1
    expect(txRow("Ethernet0")[0]).toBe(0);
    expect(portstat("S1", "Ethernet2").txDrp).toBe(0);
    // Back to lossy: the same overload drops in the queue.
    klish("S1", ["interface Ethernet 2", "no priority-flow-control priority 3"]);
    advance(10_000);
    sh("H1", "iperf3 -c 192.168.3.10 -u -b 800M -S 104 -t 3");
    expect(sh("H2", "iperf3 -c 192.168.3.10 -u -b 800M -S 104 -t 3")).not.toMatch(/ 0\/\d+ \(0%\)\s+receiver/);
    advance(2_000);
    expect(portstat("S1", "Ethernet2").txDrp).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("PBR (FBS forwarding policy) with ACLs (l3-services lab)", () => {
  it("an ingress ACL drop on the bound port wins over the forwarding policy; removing it restores the policy path", () => {
    S().loadFeatureLab("l3-services");
    advance(6_000);
    const matches = () => Number(/Packet matches: (\d+) frames/.exec(kx("S1", "show service-policy interface Ethernet 3"))?.[1]);
    const viaE1 = () => S().captures.filter((c) => c.deviceId === id("S1") && c.dir === "tx" && c.interfaceId === port("S1", "Ethernet1").id && c.frame.icmp?.type === "echo-request").length;
    expect(sh("H2", "ping -c 2 203.0.113.10")).toContain("2 received");
    expect(matches()).toBe(2);
    const e1 = viaE1();
    klish("S1", ["ip access-list NO-PING", "seq 10 deny icmp 192.168.2.0/24 any", "seq 20 permit ip any any", "exit", "interface Ethernet 3", "ip access-group NO-PING in"]);
    expect(sh("H2", "ping -c 3 203.0.113.10")).toContain("0 received");
    expect(kx("S1", "show ip access-lists NO-PING")).toMatch(/seq 10 deny icmp 192\.168\.2\.0\/24 any \(3 packets\)/);
    expect(matches()).toBe(2); // dropped before the policy classifies
    expect(viaE1()).toBe(e1);
    expect(peekDrops(byName("S1"))!.Ethernet3.ACL_ANY).toBe(3);
    klish("S1", ["interface Ethernet 3", "no ip access-group NO-PING in"]);
    expect(sh("H2", "ping -c 2 203.0.113.10")).toContain("2 received");
    expect(matches()).toBe(4);
    expect(viaE1()).toBe(e1 + 2);
  });
});

// ---------------------------------------------------------------------------
describe("uncabled ports are operationally down for routing", () => {
  it("an address on an unplugged port installs no connected route and is not advertised; cabling it brings both", () => {
    S().loadFeatureLab("ospf");
    advance(12_000);
    klish("S1", ["interface Ethernet 3", "ip address 10.33.0.1/24", "exit", "router ospf", "network 10.33.0.0/24 area 0"]);
    advance(2_000);
    expect(bash("S1", "show ip interfaces")).toMatch(/Ethernet3\s+10\.33\.0\.1\/24\s+up\/down/);
    expect(bash("S1", "show ip route")).not.toContain("10.33.0.0/24");
    expect(byName("S3").routingTable.some((r) => r.destination === "10.33.0.0")).toBe(false);
    const pc = S().addDevice("pc", { x: 0, y: 0 });
    S().connect(pc, `${pc}-if0`, id("S1"), `${id("S1")}-if3`, { autoDhcp: false });
    advance(2_000);
    expect(bash("S1", "show ip route")).toMatch(/C>\* 10\.33\.0\.0\/24 is directly connected, Ethernet3/);
    expect(byName("S3").routingTable.some((r) => r.destination === "10.33.0.0" && r.type === "ospf")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("RADIUS + AAA: KLISH config → CONFIG_DB → KLISH and Click shows (snmp lab)", () => {
  it("radius-server host/timeout and `aaa authentication login default group radius local` land in RADIUS_SERVER / RADIUS / AAA", () => {
    S().loadFeatureLab("snmp");
    advance(3_000);
    klish("S1", ["radius-server host 192.168.100.250 key s3cret auth-port 1812 priority 3", "radius-server timeout 3", "aaa authentication login default group radius local", "aaa authentication failthrough enable"]);
    expect(kx("S1", "show radius-server")).toMatch(/192\.168\.100\.250\s+-\s+Yes\s+1812\s+3\s/);
    expect(kx("S1", "show aaa")).toContain("login-method : radius, local");
    expect(bash("S1", "sonic-db-cli CONFIG_DB HGETALL 'RADIUS_SERVER|192.168.100.250'")).toBe("{'auth_port': '1812', 'passkey': 's3cret', 'priority': '3'}");
    expect(bash("S1", "sonic-db-cli CONFIG_DB HGETALL 'RADIUS|global'")).toBe("{'timeout': '3'}");
    expect(bash("S1", "sonic-db-cli CONFIG_DB HGETALL 'AAA|authentication'")).toBe("{'login': 'radius,local', 'failthrough': 'True'}");
    expect(bash("S1", "show aaa")).toContain("failthrough : enabled");
    klish("S1", ["no radius-server host 192.168.100.250", "aaa authentication login default local"]);
    expect(bash("S1", "sonic-db-cli CONFIG_DB KEYS 'RADIUS_SERVER|*'")).not.toContain("192.168.100.250");
    expect(bash("S1", "show aaa")).toContain("login-method : local");
  });
});

// ---------------------------------------------------------------------------
describe("packet generator (engine-built frames) through routing and ACLs (acl lab)", () => {
  const mac = (m: string) => m.split(":").map((h) => parseInt(h, 16));
  const ip4 = (a: string) => a.split(".").map(Number);
  /** Ethernet / IPv4 / TCP SYN as the packet engine would hand it over (checksums filled in). */
  function tcpSyn(srcMac: string, dstMac: string, src: string, dst: string, dport: number, pad = 0): number[] {
    const tcp = [0x9c, 0x40, dport >> 8, dport & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0x50, 0x02, 0xfa, 0xf0, 0, 0, 0, 0, ...new Array(pad).fill(0)];
    const pseudo = [...ip4(src), ...ip4(dst), 0, 6, tcp.length >> 8, tcp.length & 255];
    const tc = inetChecksum([...pseudo, ...tcp]);
    tcp[16] = tc >> 8;
    tcp[17] = tc & 255;
    const len = 20 + tcp.length;
    const ip = [0x45, 0, len >> 8, len & 255, 0, 1, 0, 0, 64, 6, 0, 0, ...ip4(src), ...ip4(dst)];
    const ic = inetChecksum(ip);
    ip[10] = ic >> 8;
    ip[11] = ic & 255;
    return [...mac(dstMac), ...mac(srcMac), 0x08, 0x00, ...ip, ...tcp];
  }
  const send = (bytes: number[], count = 1) =>
    S().startTraffic({ srcDeviceId: id("H1"), dstIp: "", protocol: "engine", srcPort: 0, dstPort: 0, size: 0, count, intervalMs: 0, continuous: false, packet: { bytes, summary: "TCP SYN" } });

  it("crafted TCP SYNs are routed to H3; the bound ACL drops dport 80 (seq 20) and passes 22 (seq 30) with per-rule counters", () => {
    S().loadFeatureLab("acl");
    advance(3_000);
    sh("H1", "ping -c 1 192.168.1.1"); // resolve the gateway MAC like the UI does before building
    klish("S1", ["interface Ethernet 2", "ip access-group H1-POLICY in"]);
    const gw = port("S1", "Ethernet2").mac;
    const h1 = byName("H1").interfaces[0].mac;
    expect(send(tcpSyn(h1, gw, "192.168.1.10", "192.168.3.10", 80), 5)).toBeNull();
    vi.advanceTimersByTime(200);
    expect(send(tcpSyn(h1, gw, "192.168.1.10", "192.168.3.10", 22), 4)).toBeNull();
    vi.advanceTimersByTime(200);
    const acl = kx("S1", "show ip access-lists H1-POLICY");
    expect(acl).toMatch(/seq 20 deny tcp 192\.168\.1\.0\/24 host 192\.168\.3\.10 eq 80 \(5 packets\)/);
    expect(acl).toMatch(/seq 30 permit tcp 192\.168\.1\.0\/24 any eq 22 \(4 packets\)/);
    expect(peekTrafficSink(byName("H3"))?.tcp.packets).toBe(4);
    expect(peekDrops(byName("S1"))!.Ethernet2.ACL_ANY).toBe(5);
  });

  it("a frame over the 1500-byte host MTU is refused at the source, a full-size one is sent", () => {
    S().loadFeatureLab("acl");
    advance(3_000);
    const gw = port("S1", "Ethernet2").mac;
    const h1 = byName("H1").interfaces[0].mac;
    // 14 + 20 + 20 + 1460 = 1514 bytes: exactly a full 1500-byte IP packet.
    expect(send(tcpSyn(h1, gw, "192.168.1.10", "192.168.3.10", 443, 1460))).toBeNull();
    vi.advanceTimersByTime(200);
    expect(peekTrafficSink(byName("H3"))?.tcp.packets).toBe(1);
    expect(send(tcpSyn(h1, gw, "192.168.1.10", "192.168.3.10", 443, 1461))).toContain("Message too long");
  });
});
