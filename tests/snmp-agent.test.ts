/**
 * SNMP end to end on the store (fake time): the NMS polls S1–S3's snmpd over the
 * management LAN, snmptrapd on the NMS receives coldStart / linkDown traps.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekAgent } from "../lib/protocols/snmp-config";
import { peekTrapd } from "../lib/protocols/snmp-daemon";
import { decodeMessage } from "../lib/protocols/snmp-ber";
import { formatOid } from "../lib/protocols/snmp-mib";

const nms = () => byName("NMS").id;
const run = (dev: string, cmd: string) => out(S().execCommand(byName(dev).id, cmd));
const nmsRun = (cmd: string) => out(S().execCommand(nms(), cmd));
const trapOids = () =>
  (peekTrapd(byName("NMS"))?.traps ?? []).map((t) => {
    const vbs = decodeMessage(t.bytes).pdu.varbinds;
    return { src: t.srcIp, oid: formatOid((vbs[1].value as { value: number[] }).value), vbs };
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 17, 10, 0, 0));
  resetAll();
  S().loadFeatureLab("snmp");
  advance(3000); // KLISH writes → debounced snmp restart (2 s) → config applied
  for (const sw of ["S1", "S2", "S3"]) S().execCommand(byName(sw).id, "exit"); // KLISH → bash
});
afterEach(() => vi.useRealTimers());

describe("snmpd on SONiC (store, fake time)", () => {
  it("lab applies the KLISH config: communities, trap host, traps enabled", () => {
    const s1 = byName("S1");
    const rt = peekAgent(s1)!;
    expect(rt.applied.communities.map((c) => `${c.name}:${c.access}`)).toEqual(["public:RO", "private:RW"]);
    expect(rt.applied.sinks).toEqual([{ ip: "192.168.100.250", port: 162, community: "public" }]);
    expect(peekTrapd(byName("NMS"))?.running).toBe(true);
  });

  it("snmpget from the NMS returns live system values", () => {
    expect(nmsRun("snmpget -v2c -c public 192.168.100.1 SNMPv2-MIB::sysName.0")).toBe("SNMPv2-MIB::sysName.0 = STRING: S1");
    expect(nmsRun("snmpget -v2c -c public -On 192.168.100.2 sysName.0")).toBe(".1.3.6.1.2.1.1.5.0 = STRING: S2");
    expect(nmsRun("snmpget -v2c -c public 192.168.100.1 sysLocation.0 sysServices.0 sysObjectID.0")).toBe(
      ["SNMPv2-MIB::sysLocation.0 = STRING: Lab-Row1-Rack1", "SNMPv2-MIB::sysServices.0 = INTEGER: 72", "SNMPv2-MIB::sysObjectID.0 = OID: NET-SNMP-MIB::netSnmpAgentOIDs.10"].join("\n"),
    );
    // sysUpTime counts from the snmp restart (t ≈ 2 s after the lab load).
    advance(5000);
    const m = nmsRun("snmpget -v2c -c public 192.168.100.1 sysUpTime.0").match(/^DISMAN-EVENT-MIB::sysUpTimeInstance = Timeticks: \((\d+)\) 0:00:0\d\.\d\d$/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(500);
    expect(Number(m![1])).toBeLessThan(800);
  });

  it("snmpwalk system and ifTable; ifOperStatus follows the port", () => {
    const sys = nmsRun("snmpwalk -v2c -c public 192.168.100.1 system").split("\n");
    expect(sys[0]).toMatch(/^SNMPv2-MIB::sysDescr\.0 = STRING: SONiC Software Version: SONiC\./);
    expect(sys.map((l) => l.split(" = ")[0])).toEqual([
      "SNMPv2-MIB::sysDescr.0", "SNMPv2-MIB::sysObjectID.0", "DISMAN-EVENT-MIB::sysUpTimeInstance", "SNMPv2-MIB::sysContact.0",
      "SNMPv2-MIB::sysName.0", "SNMPv2-MIB::sysLocation.0", "SNMPv2-MIB::sysServices.0", "SNMPv2-MIB::sysORLastChange.0",
    ]);
    const ift = nmsRun("snmpwalk -v2c -c public 192.168.100.1 ifTable");
    expect(ift).toContain("IF-MIB::ifIndex.1 = INTEGER: 0"); // sonic-snmpagent: 0-based value
    expect(ift).toContain("IF-MIB::ifIndex.10000 = INTEGER: 9999"); // eth0
    expect(ift).toContain("IF-MIB::ifDescr.1 = STRING: Ethernet0");
    expect(ift).toContain("IF-MIB::ifType.1 = INTEGER: ethernetCsmacd(6)");
    expect(ift).toContain("IF-MIB::ifSpeed.1 = Gauge32: 4294967295"); // 25G capped
    expect(ift).toContain("IF-MIB::ifOperStatus.1 = INTEGER: up(1)");
    expect(ift).toContain("IF-MIB::ifOperStatus.4 = INTEGER: down(2)"); // Ethernet3 unwired
    expect(ift).toContain("IF-MIB::ifSpecific.10000 = OID: SNMPv2-SMI::zeroDotZero");
    expect(ift.split("\n").filter((l) => l.startsWith("IF-MIB::ifIndex."))).toHaveLength(5);

    run("S1", "sudo config interface shutdown Ethernet0");
    expect(nmsRun("snmpget -v2c -c public 192.168.100.1 IF-MIB::ifAdminStatus.1 IF-MIB::ifOperStatus.1")).toBe(
      "IF-MIB::ifAdminStatus.1 = INTEGER: down(2)\nIF-MIB::ifOperStatus.1 = INTEGER: down(2)",
    );
    expect(nmsRun("snmpget -v2c -c public 192.168.100.1 ifHighSpeed.1 ifName.1")).toBe("IF-MIB::ifHighSpeed.1 = Gauge32: 25000\nIF-MIB::ifName.1 = STRING: Ethernet0");
  });

  it("ifInOctets increases after traffic crosses the port", () => {
    const get = () => Number(nmsRun("snmpget -v2c -c public -Oqv 192.168.100.1 IF-MIB::ifInOctets.3"));
    const hc = () => nmsRun("snmpget -v2c -c public 192.168.100.1 ifHCInOctets.3");
    const before = get();
    expect(out(S().execCommand(byName("H1").id, "ping -c 3 192.168.1.1"))).toMatch(/3 received/);
    const after = get();
    expect(after).toBeGreaterThan(before);
    expect(hc()).toBe(`IF-MIB::ifHCInOctets.3 = Counter64: ${after}`);
  });

  it("wrong community and unreachable agent time out; walk end of view", () => {
    expect(nmsRun("snmpget -v2c -c wrong -r 1 192.168.100.1 sysName.0")).toBe("Timeout: No Response from 192.168.100.1.");
    expect(nmsRun("snmpwalk -v2c -c wrong -r 0 192.168.100.1 system")).toBe("Timeout: No Response from 192.168.100.1");
    expect(peekAgent(byName("S1"))!.stats.snmpInBadCommunityNames).toBe(3);
    expect(nmsRun("snmpget -v2c -c public -r 1 192.168.100.9 sysName.0")).toBe("Timeout: No Response from 192.168.100.9.");
    // SNMPv1 is not mapped to the v2c VACM group SONiC renders → dropped too.
    expect(nmsRun("snmpget -v1 -c public -r 0 192.168.100.1 sysName.0")).toBe("Timeout: No Response from 192.168.100.1.");
    expect(nmsRun("snmpget -v2c -c public 192.168.100.1 sysName sysFoo.0")).toContain("sysFoo.0: Unknown Object Identifier");
    expect(nmsRun("snmpget -v2c -c public 192.168.100.1 sysName .1.3.6.1.4.1.9.1.0")).toBe(
      "SNMPv2-MIB::sysName = No Such Instance currently exists at this OID\nSNMPv2-SMI::enterprises.9.1.0 = No Such Object available on this agent at this OID",
    );
    // ifMIB is the last subtree of the view: the walk ends on endOfMibView (printed, snmpwalk.c:326-360).
    const tail = nmsRun("snmpwalk -v2c -c public 192.168.100.1 ifMIB").split("\n").slice(-2);
    expect(tail[0]).toBe("IF-MIB::ifCounterDiscontinuityTime.10000 = Timeticks: (0) 0:00:00.00");
    expect(tail[1]).toBe("IF-MIB::ifCounterDiscontinuityTime.10000 = No more variables left in this MIB View (It is past the end of the MIB tree)");
    expect(nmsRun("snmpgetnext -v2c -c public 192.168.100.1 ifCounterDiscontinuityTime.10000")).toBe(
      "IF-MIB::ifCounterDiscontinuityTime.10000 = No more variables left in this MIB View (It is past the end of the MIB tree)",
    );
    const bulk = nmsRun("snmpbulkwalk -v2c -c public 192.168.100.1 system");
    expect(bulk).toBe(nmsRun("snmpwalk -v2c -c public 192.168.100.1 system"));
  });

  it("SET: rw community writes sysName; sysLocation is notWritable; ro gets noAccess; config changes show up", () => {
    expect(nmsRun("snmpset -v2c -c private 192.168.100.1 sysName.0 s core-1")).toBe("SNMPv2-MIB::sysName.0 = STRING: core-1");
    expect(nmsRun("snmpget -v2c -c public 192.168.100.1 sysName.0")).toBe("SNMPv2-MIB::sysName.0 = STRING: core-1");
    expect(nmsRun("snmpset -v2c -c private 192.168.100.1 sysLocation.0 s Elsewhere")).toBe(
      "Error in packet.\nReason: notWritable (That object does not support modification)\nFailed object: SNMPv2-MIB::sysLocation.0",
    );
    expect(nmsRun("snmpset -v2c -c public 192.168.100.1 sysName.0 s x")).toBe("Error in packet.\nReason: noAccess\nFailed object: SNMPv2-MIB::sysName.0");
    expect(nmsRun("snmpset -v2c -c private 192.168.100.1 sysName.0 i 5")).toContain("Reason: wrongType");

    // sysLocation changes through CONFIG_DB: Click write + snmp restart.
    expect(run("S1", "sudo config snmp location add Building-7")).toContain("Restarting SNMP service...");
    advance(200);
    expect(nmsRun("snmpget -v2c -c public 192.168.100.1 sysLocation.0")).toBe("SNMPv2-MIB::sysLocation.0 = STRING: Building-7");
    expect(run("S1", "show runningconfiguration snmp location")).toBe("Location\n----------\nBuilding-7");
  });

  it("coldStart on start, linkDown/linkUp traps reach snmptrapd on the NMS", () => {
    const cold = trapOids().filter((t) => t.oid === "SNMPv2-MIB::coldStart");
    expect(cold.map((t) => t.src).sort()).toEqual(["192.168.100.1", "192.168.100.2", "192.168.100.3"]);
    expect(formatOid(cold[0].vbs[2].oid)).toBe("SNMPv2-MIB::snmpTrapEnterprise.0");

    run("S1", "sudo config interface shutdown Ethernet0");
    advance(200);
    const down = trapOids().filter((t) => t.oid === "IF-MIB::linkDown" && t.src === "192.168.100.1");
    expect(down).toHaveLength(1);
    // the cable's far end (S2 Ethernet0) loses carrier too: its own linkDown (admin up, oper down)
    expect(trapOids().filter((t) => t.oid === "IF-MIB::linkDown").map((t) => t.src).sort()).toEqual(["192.168.100.1", "192.168.100.2"]);
    const log = nmsRun("snmptrapd -l").split("\n");
    const i = log.findIndex((l) => l.includes("IF-MIB::linkDown"));
    expect(log[i - 1]).toMatch(/^2026-11-17 10:00:\d\d <UNKNOWN> \[UDP: \[192\.168\.100\.1\]:\d+->\[192\.168\.100\.250\]:162\]:$/);
    expect(log[i].split("\t")).toEqual([
      expect.stringMatching(/^DISMAN-EVENT-MIB::sysUpTimeInstance = Timeticks: \(\d+\) /),
      "SNMPv2-MIB::snmpTrapOID.0 = OID: IF-MIB::linkDown",
      "IF-MIB::ifIndex.1 = INTEGER: 1",
      "IF-MIB::ifAdminStatus.1 = INTEGER: down(2)",
      "IF-MIB::ifOperStatus.1 = INTEGER: down(2)",
    ]);

    run("S1", "sudo config interface startup Ethernet0");
    advance(200);
    expect(trapOids().filter((t) => t.oid === "IF-MIB::linkUp" && t.src === "192.168.100.1")).toHaveLength(1);

    // `no snmp-server enable traps` → snmp_linktrapd suppresses link traps.
    S().runCliScript(byName("S1").id, ["configure terminal", "no snmp-server enable traps", "end"]);
    run("S1", "sudo config interface shutdown Ethernet1");
    advance(200);
    expect(trapOids().filter((t) => t.oid === "IF-MIB::linkDown" && t.src === "192.168.100.1")).toHaveLength(1);
  });

  it("tcpdump prints SNMP like print-snmp.c", () => {
    S().execCommand(nms(), "sudo tcpdump -i eth0 -nn -c 2 port 161");
    nmsRun("snmpget -v2c -c private 192.168.100.1 sysName.0");
    const lines = (S().terminals[nms()] ?? []).map((l) => l.text);
    expect(lines.some((l) => /IP 192\.168\.100\.250\.\d+ > 192\.168\.100\.1\.161:  C="private" GetRequest\(28\)  \.1\.3\.6\.1\.2\.1\.1\.5\.0$/.test(l))).toBe(true);
    expect(lines.some((l) => /IP 192\.168\.100\.1\.161 > 192\.168\.100\.250\.\d+:  C="private" GetResponse\(30\)  \.1\.3\.6\.1\.2\.1\.1\.5\.0="S1"$/.test(l))).toBe(true);
  });
});
