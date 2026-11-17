import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { describeControl } from "../lib/control";
import { bfd } from "../lib/control/bfd-api";
import { registerLab } from "../lib/labs";
import { routedTriangle } from "../lib/labs/topologies";
import { findSession, bfdSessions } from "../lib/protocols/bfd-daemon";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { nodePacketEngine } from "./packet-engine-node";

registerLab("bfd-test-bare", (api) => routedTriangle(api));

const sess = (dev: string, peer: string) => findSession(byName(dev), peer)!;
const id = (dev: string) => byName(dev).id;
/** Run a bash-shell command on a switch (switch terminals start in KLISH). */
function bash(dev: string, cmd: string): string {
  if ((S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}
function klish(dev: string, cmd: string): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return out(S().execCommand(id(dev), cmd));
}
const conn = (a: string, b: string) =>
  S().network.connections.find((c) => [c.a.deviceId, c.b.deviceId].sort().join() === [id(a), id(b)].sort().join())!;

/** Advance in 100 ms steps until pred() holds; returns elapsed ms (or Infinity). */
function until(pred: () => boolean, maxMs: number): number {
  for (let t = 100; t <= maxMs; t += 100) {
    advance(100);
    if (pred()) return t;
  }
  return Infinity;
}

const ALL: [string, string][] = [
  ["S1", "10.0.12.2"], ["S1", "10.0.13.2"], ["S2", "10.0.12.1"], ["S2", "10.0.23.2"], ["S3", "10.0.13.1"], ["S3", "10.0.23.1"],
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("BFD daemon on the bfd lab (store-level, fake time)", () => {
  beforeEach(() => S().loadFeatureLab("bfd"));

  it("brings every link's session Up within ~2 s with discriminators exchanged", () => {
    expect(ALL.every(([d, p]) => sess(d, p).state === 1)).toBe(true); // configured, Down
    const t = until(() => ALL.every(([d, p]) => sess(d, p).state === 3), 2000);
    expect(t).toBeLessThanOrEqual(2000);
    const a = sess("S1", "10.0.12.2");
    const b = sess("S2", "10.0.12.1");
    expect(a.myDisc).not.toBe(0);
    expect(a.remoteDisc).toBe(b.myDisc);
    expect(b.remoteDisc).toBe(a.myDisc);
    // Discriminators unique per device.
    expect(new Set(bfdSessions(byName("S1")).map((s) => s.myDisc)).size).toBe(2);
  });

  it("negotiates 300 ms / 900 ms after Poll/Final and transmits at that rate", () => {
    advance(2000);
    const a = sess("S1", "10.0.12.2");
    expect(a.polling).toBe(false);
    expect(a.xmtTO).toBe(300);
    expect(a.detectTO).toBe(900);
    const tx0 = a.stats.txCtrl;
    advance(3000);
    expect(sess("S1", "10.0.12.2").stats.txCtrl - tx0).toBe(10);
  });

  it("honours configured intervals / multiplier: tx = max(local tx, remote rx), detect = remote mult × max(local rx, remote tx)", () => {
    advance(2000);
    S().runCliScript(id("S1"), ["configure terminal", "bfd", "peer 10.0.12.2 interface Ethernet0", "transmit-interval 500", "receive-interval 600", "end"]);
    S().runCliScript(id("S2"), ["configure terminal", "bfd", "peer 10.0.12.1 interface Ethernet0", "detect-multiplier 5", "end"]);
    advance(2000); // Poll/Final round
    const a = sess("S1", "10.0.12.2");
    const b = sess("S2", "10.0.12.1");
    expect(a.state).toBe(3);
    expect(a.xmtTO).toBe(500); // max(500, S2 rx 300)
    expect(b.xmtTO).toBe(600); // max(300, S1 rx 600)
    expect(a.detectTO).toBe(5 * 600); // S2 mult 5 × max(600, 300)
    expect(b.detectTO).toBe(3 * 500); // S1 mult 3 × max(300, 500)
    const tx0 = a.stats.txCtrl;
    advance(5000);
    expect(sess("S1", "10.0.12.2").stats.txCtrl - tx0).toBe(10);
  });

  it("cutting a link brings both ends Down (diag 1) within the detection time, then recovers", () => {
    advance(2000);
    S().disconnect(conn("S1", "S2").id);
    const t = until(() => sess("S1", "10.0.12.2").state === 1 && sess("S2", "10.0.12.1").state === 1, 2000);
    expect(t).toBeLessThanOrEqual(1000);
    for (const s of [sess("S1", "10.0.12.2"), sess("S2", "10.0.12.1")]) {
      expect(s.localDiag).toBe(1);
      expect(s.stats.down).toBe(1);
    }
    expect(sess("S1", "10.0.13.2").state).toBe(3); // other link unaffected
    expect(bash("S1", "show bfd peer 10.0.12.2")).toContain("Diagnostics: control detection time expired");
    S().connect(id("S1"), `${id("S1")}-if0`, id("S2"), `${id("S2")}-if0`);
    expect(until(() => sess("S1", "10.0.12.2").state === 3 && sess("S2", "10.0.12.1").state === 3, 4000)).toBeLessThanOrEqual(3000);
    expect(sess("S1", "10.0.12.2").stats.up).toBe(2);
  });

  it("shutting Ethernet0 on S2 takes S1's session Down within ~900 ms", () => {
    advance(2000);
    S().setAdminState(id("S2"), `${id("S2")}-if0`, false);
    expect(until(() => sess("S1", "10.0.12.2").state === 1, 2000)).toBeLessThanOrEqual(1000);
    expect(sess("S1", "10.0.12.2").localDiag).toBe(1);
    advance(2000);
    expect(sess("S2", "10.0.12.1").stats.txFail).toBeGreaterThan(0); // socket bound to a down port
    S().setAdminState(id("S2"), `${id("S2")}-if0`, true);
    expect(until(() => sess("S1", "10.0.12.2").state === 3, 4000)).toBeLessThanOrEqual(3000);
  });

  it("peer shutdown → AdminDown locally; the neighbour shows diag 3 / remote diag 7; no shutdown recovers", () => {
    advance(2000);
    S().runCliScript(id("S1"), ["configure terminal", "bfd", "peer 10.0.12.2 interface Ethernet0", "shutdown", "end"]);
    advance(200);
    const a = sess("S1", "10.0.12.2");
    const b = sess("S2", "10.0.12.1");
    expect(a.state).toBe(0);
    expect(a.localDiag).toBe(7);
    expect(b.state).toBe(1);
    expect(b.localDiag).toBe(3);
    expect(b.remoteDiag).toBe(7);
    expect(bfd().state(byName("S1"), "10.0.12.2")).toBe("admin-down");
    const s2 = bash("S2", "show bfd peer 10.0.12.1");
    expect(s2).toContain("\t\tStatus: down");
    expect(s2).toContain("\t\tDiagnostics: neighbor signaled session down");
    expect(s2).toContain("\t\tRemote diagnostics: administratively down");
    expect(bash("S1", "show bfd peer 10.0.12.2")).toContain("\t\tStatus: shutdown");
    // AdminDown session stays silent; the neighbour keeps sending slow Down packets.
    const tx = sess("S1", "10.0.12.2").stats.txCtrl;
    advance(3000);
    expect(sess("S1", "10.0.12.2").stats.txCtrl).toBe(tx);
    expect(sess("S2", "10.0.12.1").state).toBe(1);
    S().runCliScript(id("S1"), ["configure terminal", "bfd", "peer 10.0.12.2 interface Ethernet0", "no shutdown", "end"]);
    expect(until(() => sess("S1", "10.0.12.2").state === 3 && sess("S2", "10.0.12.1").state === 3, 4000)).toBeLessThanOrEqual(3000);
  });

  it("emits real 24-byte UDP/3784 TTL-255 packets that Scapy dissects as BFD", async () => {
    advance(2000);
    const a = sess("S1", "10.0.12.2");
    const rec = [...S().captures].reverse().find(
      (c) => c.deviceId === id("S1") && c.dir === "tx" && c.frame.udp?.dstPort === 3784 && c.frame.ipv4?.dstIp === "10.0.12.2",
    )!;
    const f = rec.frame;
    expect(f.ipv4!.ttl).toBe(255);
    expect(f.udp!.srcPort).toBeGreaterThanOrEqual(49152);
    expect(f.rawL3!.length).toBe(20 + 8 + 24);
    expect(f.rawL3![1]).toBe(0xc0); // IP TOS (BFD_TOS_VAL)
    expect(describeControl(f, false)).toBe("BFDv1, Control, State Up, Flags: [none], length: 24");
    expect(describeControl(f, true)).toMatch(
      /^BFDv1, length: 24\n\tControl, State Up, Flags: \[none\], Diagnostic: No Diagnostic \(0x00\)\n\tDetection Timer Multiplier: 3 \(900 ms Detection time\), BFD Length: 24\n\tMy Discriminator: 0x[0-9a-f]{8}, Your Discriminator: 0x[0-9a-f]{8}\n\t  Desired min Tx Interval:     300 ms\n\t  Required min Rx Interval:    300 ms\n\t  Required min Echo Interval:   50 ms$/,
    );

    vi.useRealTimers(); // Pyodide needs real timers
    const engine = await nodePacketEngine();
    const d = await engine.dissect(Uint8Array.from(f.rawL3!), "IP");
    const layer = d.layers.find((l) => l.proto === "BFD")!;
    expect(layer).toBeDefined();
    const field = (n: string) => layer.fields.find((x) => x.name === n)?.value;
    expect(field("version")).toBe("1");
    expect(field("sta")).toMatch(/^(3|Up)$/);
    expect(field("detect_mult")).toBe("3");
    expect(field("len")).toBe("24");
    expect(field("my_discriminator")).toBe(String(a.myDisc));
    expect(field("your_discriminator")).toBe(String(a.remoteDisc));
    expect(field("min_tx_interval")).toBe("300000");
    expect(field("min_rx_interval")).toBe("300000");
    expect(field("echo_rx_interval")).toBe("50000");
  }, 120_000);

  it("tcpdump -nn on a port prints BFD lines", () => {
    S().execCommand(id("S2"), "sudo tcpdump -i Ethernet0 -nn -c 2 udp port 3784");
    advance(2000);
    const lines = (S().terminals[id("S2")] ?? []).map((l) => l.text);
    expect(lines.some((l) => /IP 10\.0\.12\.\d\.\d+ > 10\.0\.12\.\d\.3784: BFDv1, Control, State (Down|Init|Up), Flags: \[[A-Za-z, ]+\], length: 24$/.test(l))).toBe(true);
  });

  it("FRR show bfd peers / peer / counters / brief match bfdd_vty.c", () => {
    vi.setSystemTime(1_000_000);
    advance(2000);
    advance(5000);
    const a = sess("S1", "10.0.12.2");
    const peer = bash("S1", "show bfd peer 10.0.12.2");
    expect(peer.split("\n")).toEqual([
      "BFD Peer:",
      "\tpeer 10.0.12.2 vrf default interface Ethernet0",
      `\t\tID: ${a.myDisc}`,
      `\t\tRemote ID: ${a.remoteDisc}`,
      "\t\tActive mode",
      "\t\tStatus: up",
      expect.stringMatching(/^\t\tUptime: [56] second\(s\)$/),
      "\t\tDiagnostics: ok",
      "\t\tRemote diagnostics: ok",
      "\t\tPeer Type: configured",
      "\t\tRTT min/avg/max: 0/0/0 usec",
      "\t\tLocal timers:",
      "\t\t\tDetect-multiplier: 3",
      "\t\t\tReceive interval: 300ms",
      "\t\t\tTransmission interval: 300ms",
      "\t\t\tEcho receive interval: 50ms",
      "\t\t\tEcho transmission interval: disabled",
      "\t\tRemote timers:",
      "\t\t\tDetect-multiplier: 3",
      "\t\t\tReceive interval: 300ms",
      "\t\t\tTransmission interval: 300ms",
      "\t\t\tEcho receive interval: 50ms",
      "",
    ]);
    const all = bash("S1", "show bfd peers");
    expect(all.startsWith("BFD Peers:\n\tpeer 10.0.12.2 vrf default interface Ethernet0\n")).toBe(true);
    expect(all).toContain("\tpeer 10.0.13.2 vrf default interface Ethernet1");

    const counters = bash("S1", "show bfd peers counters").split("\n");
    expect(counters[0]).toBe("BFD Peers:");
    expect(counters.slice(1, 11)).toEqual([
      "\tpeer 10.0.12.2 vrf default interface Ethernet0",
      `\t\tControl packet input: ${a.stats.rxCtrl} packets`,
      `\t\tControl packet output: ${a.stats.txCtrl} packets`,
      "\t\tEcho packet input: 0 packets",
      "\t\tEcho packet output: 0 packets",
      "\t\tSession up events: 1",
      "\t\tSession down events: 0",
      "\t\tZebra notifications: 1",
      "\t\tTx fail packet: 0",
      "",
    ]);
    expect(a.stats.rxCtrl).toBeGreaterThan(20);

    const brief = bash("S1", "show bfd peers brief").split("\n");
    expect(brief[0]).toBe("Session count: 2");
    expect(brief[1]).toBe(`${"SessionId".padEnd(10)} ${"LocalAddress".padEnd(40)} ${"PeerAddress".padEnd(40)}${"Status".padEnd(15)}`);
    expect(brief[2]).toBe(`${"=========".padEnd(10)} ${"============".padEnd(40)} ${"===========".padEnd(40)}${"======".padEnd(15)}`);
    expect(brief[3]).toBe(`${String(a.myDisc).padEnd(10)} ${"10.0.12.1".padEnd(40)} ${"10.0.12.2".padEnd(40)}${"up".padEnd(15)}`);

    expect(bash("S1", "show bfd peer 10.9.9.9")).toBe("% Unable to find 'peer 10.9.9.9'");
  });

  it("KLISH show bfd peers renders the sonic-mgmt-framework templates", () => {
    advance(3000);
    const a = sess("S1", "10.0.12.2");
    const detail = klish("S1", "show bfd peer 10.0.12.2").split("\n");
    expect(detail.slice(0, 9)).toEqual([
      "BFD Peers:",
      "",
      "",
      "    peer 10.0.12.2 vrf default interface Ethernet0",
      `        ID: ${a.myDisc}`,
      `        Remote ID: ${a.remoteDisc}`,
      "        Passive mode: Disabled",
      "        Admin State: up",
      "        Status: up",
    ]);
    expect(detail[9]).toMatch(/^        Uptime: 0 day\(s\), 0 hour\(s\), 0 min\(s\), \d sec\(s\)$/);
    expect(detail).toContain("        Diagnostics: ok");
    expect(detail).toContain("            Echo transmission interval: 50ms");
    const brief = klish("S1", "show bfd peers brief").split("\n");
    expect(brief[0]).toBe("Session Count: 2");
    expect(brief[3]).toBe([String(a.myDisc).padEnd(10), "".padEnd(41), "10.0.12.2".padEnd(41), "up".padEnd(14), "Ethernet0".padEnd(14), "default".padEnd(8)].join(" "));
    const cnt = klish("S1", "show bfd peers counters").split("\n");
    expect(cnt[0]).toBe("peer 10.0.12.2 interface Ethernet0 vrf default");
    expect(cnt[1]).toBe(`    Control packet input: ${a.stats.rxCtrl} packets`);
    expect(klish("S1", "show bfd peer 10.9.9.9")).toBe("BFD peer 10.9.9.9 not found");
  });
});

describe("bfd-api for clients (OSPF/BGP)", () => {
  beforeEach(() => S().loadFeatureLab("bfd-test-bare"));

  it("register creates a dynamic session that comes Up; unregister removes it", () => {
    // Clients call register() on the device they are ticking; mutate the live state the same way.
    bfd().register(S().network.devices[id("S1")], { peer: "10.0.12.2" }, "ospf");
    bfd().register(S().network.devices[id("S2")], { peer: "10.0.12.1", iface: "Ethernet0" }, "bgp");
    bfd().register(S().network.devices[id("S2")], { peer: "10.0.12.1", iface: "Ethernet0" }, "bgp"); // idempotent
    expect(bfd().state(byName("S1"), "10.0.12.2")).toBe("down");
    expect(bfdSessions(byName("S2"))).toHaveLength(1);
    expect(until(() => bfd().state(byName("S1"), "10.0.12.2") === "up" && bfd().state(byName("S2"), "10.0.12.1") === "up", 2500)).toBeLessThanOrEqual(2000);
    expect(bash("S1", "show bfd peer 10.0.12.2")).toContain("\t\tPeer Type: dynamic");
    expect(bfd().state(byName("S1"), "10.0.13.2")).toBeUndefined();

    bfd().unregister(S().network.devices[id("S1")], "10.0.12.2", "ospf");
    expect(bfd().state(byName("S1"), "10.0.12.2")).toBeUndefined();
    expect(until(() => bfd().state(byName("S2"), "10.0.12.1") === "down", 2000)).toBeLessThanOrEqual(1000);
    expect(sess("S2", "10.0.12.1").localDiag).toBe(1);
  });

  it("a client reference keeps a session alive after its CLI config is removed", () => {
    bfd().register(S().network.devices[id("S1")], { peer: "10.0.12.2" }, "bgp");
    klish("S1", "configure terminal");
    klish("S1", "bfd");
    klish("S1", "peer 10.0.12.2 interface Ethernet0");
    expect(sess("S1", "10.0.12.2").configured).toBe(true);
    klish("S1", "exit");
    klish("S1", "no peer 10.0.12.2");
    expect(sess("S1", "10.0.12.2").configured).toBe(false);
    bfd().unregister(S().network.devices[id("S1")], "10.0.12.2", "bgp");
    expect(findSession(byName("S1"), "10.0.12.2")).toBeUndefined();
  });
});
