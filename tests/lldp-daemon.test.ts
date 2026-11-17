import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { frameToBytes } from "../lib/sflow/wire";
import { nodePacketEngine } from "./packet-engine-node";
import { lldpRuntime } from "../lib/protocols/lldp-daemon";

const bash = (name: string, cmd: string) => out(S().execCommand(byName(name).id, cmd));
const klish = (name: string, cmd: string) => out(S().execCommand(byName(name).id, cmd));
const nbrs = (name: string) => lldpRuntime(byName(name))?.neighbors ?? {};
const lldpCaps = () => S().captures.filter((c) => c.frame.ethernet.typeCode === 0x88cc);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
  S().loadFeatureLab("lldp");
  // Switch terminals start in KLISH; drop S1..S3 to bash for the Click commands.
  for (const n of ["S1", "S2", "S3"]) S().execCommand(byName(n).id, "exit");
});
afterEach(() => vi.useRealTimers());

describe("LLDP daemon (lldpd model) on the routed triangle", () => {
  it("learns every triangle link within one 30 s timer interval; hosts are never neighbours", () => {
    advance(30_000);
    const t1 = bash("S1", "show lldp table");
    expect(t1).toContain("Capability codes: (R) Router, (B) Bridge, (O) Other");
    expect(t1).toMatch(/^Ethernet0 +S2 +Ethernet0 +BR +Ethernet0$/m);
    expect(t1).toMatch(/^Ethernet1 +S3 +Ethernet0 +BR +Ethernet0$/m);
    expect(t1).toMatch(/^eth0 +MGMT +Ethernet0 +BR +Ethernet0$/m);
    expect(t1).toContain("Total entries displayed:  3");
    expect(t1).not.toContain("H1");
    expect(bash("S2", "show lldp table")).toMatch(/^Ethernet1 +S3 +Ethernet1 +BR +Ethernet1$/m);
    expect(bash("S3", "show lldp table")).toMatch(/^Ethernet0 +S1 +Ethernet1 +BR +Ethernet1$/m);
    expect(Object.keys(nbrs("S1")).sort()).toEqual(["Ethernet0", "Ethernet1", "eth0"]);
  });

  it("show lldp neighbors prints lldpctl's text for the learned neighbour", () => {
    advance(10_000);
    const lines = bash("S1", "show lldp neighbors Ethernet0").split("\n");
    const s2 = byName("S2");
    expect(lines[0]).toBe("-".repeat(79));
    expect(lines[1]).toBe("LLDP neighbors:");
    expect(lines[3]).toMatch(/^Interface: {4}Ethernet0, via: LLDP, RID: \d+, Time: 0 day, 00:00:0\d$/);
    expect(lines).toContain(`    ChassisID:    mac ${s2.interfaces.find((i) => i.management)!.mac.toLowerCase()}`);
    expect(lines).toContain("    SysName:      S2");
    expect(lines).toContain("    MgmtIP:       192.168.100.2");
    expect(lines).toContain("    Capability:   Bridge, on");
    expect(lines).toContain("    Capability:   Router, on");
    expect(lines).toContain("    Capability:   Station, off");
    expect(lines).toContain("    PortID:       local Ethernet0");
    expect(lines).toContain("    TTL:          120");
    // a port with no neighbour: the port name is absent from lldpctl's output → empty line
    expect(bash("S1", "show lldp neighbors Ethernet2").trim()).toBe("");
  });

  it("KLISH show lldp table / show lldp neighbor render the mgmt-framework templates", () => {
    advance(10_000);
    const s1 = byName("S1").id;
    S().execCommand(s1, "sonic-cli");
    const table = klish("S1", "show lldp table").split("\n");
    expect(table[1]).toBe(`${"LocalPort".padEnd(20)}${"RemoteDevice".padEnd(30)}${"RemotePortID".padEnd(20)}${"Capability".padEnd(12)}${"RemotePortDescr".padEnd(38)}`);
    expect(table).toContain(`${"Ethernet0".padEnd(20)}${"S2".padEnd(30)}${"Ethernet0".padEnd(20)}${"BR".padEnd(12)}${"Ethernet0".padEnd(38)}`);
    const nb = klish("S1", "show lldp neighbor Ethernet 1");
    expect(nb).toContain("LLDP Neighbors");
    expect(nb).toMatch(/Interface: {4}Ethernet1, via: LLDP, RID: \d+/);
    expect(nb).toContain("    SysName:      S3");
    expect(nb).toContain("    Capability:   MAC_BRIDGE, ON");
    expect(nb).toContain("    PortID:       local Ethernet0");
    expect(nb).not.toContain("S2");
  });

  it("neighbour expires at TTL (120 s) when the peer stops transmitting", () => {
    advance(10_000);
    bash("S2", "sudo config lldp no-transmit");
    advance(100_000);
    expect(bash("S1", "show lldp table")).toMatch(/^Ethernet0 +S2/m); // still within TTL
    advance(30_000);
    expect(bash("S1", "show lldp table")).not.toMatch(/^Ethernet0 +S2/m);
    expect(bash("S1", "show lldp statistics Ethernet0")).toContain("Ageout : 1");
    // S2 keeps receiving: it still knows S1
    expect(bash("S2", "show lldp table")).toMatch(/^Ethernet0 +S1/m);
  });

  it("local link down removes the neighbour at once; disconnecting the cable clears both ends", () => {
    advance(10_000);
    const s1 = byName("S1");
    S().setAdminState(s1.id, `${s1.id}-if0`, false);
    advance(200);
    expect(nbrs("S1").Ethernet0).toBeUndefined();
    S().setAdminState(s1.id, `${s1.id}-if0`, true);
    advance(200); // link back up: lldpd sends at once (no 30 s wait)
    expect(nbrs("S2").Ethernet0?.[0].sysName).toBe("S1");

    const conn = S().network.connections.find((c) => [c.a.deviceId, c.b.deviceId].includes(byName("S3").id) && [c.a.deviceId, c.b.deviceId].includes(byName("S2").id))!;
    S().disconnect(conn.id);
    advance(200);
    expect(nbrs("S2").Ethernet1).toBeUndefined();
    expect(nbrs("S3").Ethernet1).toBeUndefined();
  });

  it("receive disabled: frames are ignored and the entry ages out", () => {
    advance(10_000);
    bash("S1", "sudo config lldp interface Ethernet0 no-receive");
    advance(125_000);
    expect(nbrs("S1").Ethernet0).toBeUndefined();
    expect(nbrs("S1").Ethernet1?.[0].sysName).toBe("S3");
  });

  it("a local change (system-name) is advertised immediately", () => {
    advance(10_000);
    bash("S2", "sudo config lldp system-name CORE-2");
    advance(200);
    expect(bash("S1", "show lldp table")).toMatch(/^Ethernet0 +CORE-2 +Ethernet0/m);
  });

  it("LLDP is never bridged: eth0 neighbours are the MGMT switch only; hosts only hear their own switch", () => {
    advance(65_000);
    for (const n of ["S1", "S2", "S3"]) {
      const eth0 = nbrs(n).eth0 ?? [];
      expect(eth0.map((x) => x.sysName)).toEqual(["MGMT"]);
    }
    // NMS hears MGMT's own LLDPDUs (and ignores them: hosts run no lldpd), never S1/S2/S3's.
    const macsOf = (n: string) => byName(n).interfaces.map((i) => i.mac);
    const atNms = lldpCaps().filter((c) => c.deviceId === byName("NMS").id && c.dir === "rx");
    expect(atNms.length).toBeGreaterThan(0);
    expect(atNms.every((c) => macsOf("MGMT").includes(c.frame.ethernet.srcMac))).toBe(true);
    expect(lldpCaps().filter((c) => c.deviceId === byName("H1").id).every((c) => macsOf("S1").includes(c.frame.ethernet.srcMac))).toBe(true);
    // MGMT received S1's LLDPDU but did not forward it (802.1D link-local).
    const mgmt = byName("MGMT").id;
    expect(lldpCaps().filter((c) => c.deviceId === mgmt && c.dir === "tx").every((c) => byName("MGMT").interfaces.some((i) => i.mac === c.frame.ethernet.srcMac))).toBe(true);
  });

  it("tcpdump prints `LLDP, length N: <sysname>` (print-lldp.c) and -v lists the TLVs", () => {
    const s1 = byName("S1").id;
    S().execCommand(s1, "sudo tcpdump -i Ethernet0 -nn -c 2");
    advance(6_000);
    const term = (S().terminals[s1] ?? []).map((l) => l.text);
    expect(term.some((t) => /LLDP, length \d+: S2$/.test(t))).toBe(true);
    S().execCommand(s1, "sudo tcpdump -i Ethernet0 -nn -v -c 1");
    advance(31_000);
    const v = (S().terminals[s1] ?? []).map((l) => l.text).join("\n");
    expect(v).toMatch(/LLDP, length \d+\n\tChassis ID TLV \(1\), length 7\n\t {2}Subtype MAC address \(4\): /);
    expect(v).toContain("\tTime to Live TLV (3), length 2: TTL 120s");
    expect(v).toContain("\t  Enabled Capabilities [Bridge, Router] (0x0014)");
  });

  it("Scapy dissects the LLDPDU as LLDPDU* layers with the advertised values", async () => {
    advance(6_000);
    const s2 = byName("S2");
    const cap = lldpCaps().find((c) => c.deviceId === s2.id && c.dir === "tx" && c.interfaceId === `${s2.id}-if0`)!;
    expect(cap.frame.ethernet.dstMac.toUpperCase()).toBe("01:80:C2:00:00:0E");
    vi.useRealTimers(); // Pyodide needs real timers
    const engine = await nodePacketEngine();
    const d = await engine.dissect(frameToBytes(cap.frame));
    const protos = d.layers.map((l) => l.proto);
    expect(protos.slice(0, 1)).toEqual(["Ether"]);
    for (const p of ["LLDPDUChassisID", "LLDPDUPortID", "LLDPDUTimeToLive", "LLDPDUSystemName", "LLDPDUSystemDescription", "LLDPDUSystemCapabilities", "LLDPDUManagementAddress", "LLDPDUPortDescription", "LLDPDUEndOfLLDPDU"]) {
      expect(protos).toContain(p);
    }
    const field = (proto: string, name: string) => d.layers.find((l) => l.proto === proto)?.fields.find((f) => f.name === name)?.value;
    expect(field("LLDPDUChassisID", "subtype")).toMatch(/4|MAC/i);
    expect(field("LLDPDUChassisID", "id")?.toLowerCase()).toContain(s2.interfaces.find((i) => i.management)!.mac.toLowerCase());
    expect(field("LLDPDUPortID", "id")).toContain("Ethernet0");
    expect(field("LLDPDUTimeToLive", "ttl")).toBe("120");
    expect(field("LLDPDUSystemName", "system_name")).toContain("S2");
  }, 60_000);
});
