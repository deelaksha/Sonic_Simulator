/**
 * `show` outputs per source (KLISH show_snmp*.j2 templates, sonic-utilities show/main.py
 * tabulate tables), Click snmptrap / snmpagentaddress, and the BER codec.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekTrapd } from "../lib/protocols/snmp-daemon";
import { decodeMessage, encodeMessage, PDU } from "../lib/protocols/snmp-ber";
import { formatOid } from "../lib/protocols/snmp-mib";

const id = (n: string) => byName(n).id;
const run = (dev: string, cmd: string) => out(S().execCommand(id(dev), cmd));
const trapNames = () =>
  (peekTrapd(byName("NMS"))?.traps ?? []).map((t) => formatOid((decodeMessage(t.bytes).pdu.varbinds[1].value as { value: number[] }).value));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 17, 10, 0, 0));
  resetAll();
  S().loadFeatureLab("snmp");
  advance(3000);
});
afterEach(() => vi.useRealTimers());

describe("KLISH show snmp-server (renderer/templates/show_snmp*.j2)", () => {
  it("global, community, host, traps, agentaddress, running-configuration", () => {
    const mac = byName("S1").interfaces.find((i) => i.management)!.mac.toLowerCase();
    expect(run("S1", "show snmp-server")).toBe(`EngineID   : 80:00:01:37:03:${mac}\nContact    : noc@lab.example\nLocation   : Lab-Row1-Rack1`);
    expect(run("S1", "show snmp-server community")).toBe(
      ["Community Name                    Type", "-------------------------------- ------", "private                          RW    ", "public                           RO    "].join("\n"),
    );
    expect(run("S1", "show snmp-server host")).toBe(
      [
        "Host Name                         Host IP          Port   Source Interface",
        "-------------------------------- ---------------- ------ ----------------",
        "192.168.100.250_162              192.168.100.250  162    -",
      ].join("\n"),
    );
    expect(run("S1", "show snmp-server traps")).toBe(
      [
        "Traps Enabled  : Yes",
        "Authen Traps   : No",
        "",
        "Trap Hosts:",
        "Host Name                         Host IP          Port",
        "-------------------------------- ---------------- ------",
        "192.168.100.250_162              192.168.100.250  162",
      ].join("\n"),
    );
    expect(run("S1", "show snmp-server agentaddress")).toBe("No SNMP agent addresses configured");
    expect(run("S1", "show running-configuration snmp")).toBe(
      [
        "!",
        "snmp-server contact noc@lab.example",
        "snmp-server location Lab-Row1-Rack1",
        "snmp-server community public ro",
        "snmp-server community private rw",
        "snmp-server enable traps",
        "snmp-server host 192.168.100.250 port 162 version v2c community public",
        "!",
      ].join("\n"),
    );
  });

  it("community type is mandatory; host / agentaddress validation and `no` forms", () => {
    const cfg = (l: string) => out(S().execCommand(id("S1"), l));
    cfg("configure terminal");
    expect(cfg("snmp-server community lonely")).toMatch(/Community access type required/);
    expect(cfg("snmp-server agentaddress 10.9.9.9")).toBe("%Error: agent-address is not a local interface IP: 10.9.9.9");
    expect(cfg("no snmp-server host 10.1.1.1")).toBe("%Error: Host '10.1.1.1' port 162 not found");
    expect(cfg("snmp-server agentaddress 192.168.100.1 port 1161")).toBe("");
    expect(cfg("snmp-server enable authen-traps")).toBe("");
    cfg("end");
    expect(run("S1", "show snmp-server agentaddress")).toBe(
      ["Listen IP       Listen Port  Listen VRF", "--------------- ------------ ------------", "192.168.100.1   1161                     "].join("\n"),
    );
    advance(2500); // debounced restart applies the agentAddress
    expect(run("NMS", "snmpget -v2c -c public -r 0 192.168.100.1 sysName.0")).toBe("Timeout: No Response from 192.168.100.1.");
    expect(run("NMS", "snmpget -v2c -c public 192.168.100.1:1161 sysName.0")).toBe("SNMPv2-MIB::sysName.0 = STRING: S1");
    // authen-traps: a bad community now also produces an authenticationFailure trap.
    run("NMS", "snmpget -v2c -c nope -r 0 192.168.100.1:1161 sysName.0");
    expect(trapNames()).toContain("SNMPv2-MIB::authenticationFailure");
  });

  it("show snmp counters reflects agent activity", () => {
    run("NMS", "snmpget -v2c -c public 192.168.100.1 sysName.0 sysLocation.0");
    run("NMS", "snmpget -v2c -c bogus -r 0 192.168.100.1 sysName.0");
    const c = run("S1", "show snmp counters").split("\n");
    expect(c[0]).toBe("    SNMP Counters");
    expect(c).toContain("    2 SNMP packets input");
    expect(c).toContain("    1 Unknown community name");
    expect(c).toContain("    2 Number of requested variables");
    expect(c).toContain("    1 Get-request PDUs");
    expect(c).toContain("    1 Response PDUs");
  });

  it("KLISH interface shutdown sends linkDown via snmp_linktrapd", () => {
    for (const l of ["configure terminal", "interface Ethernet 1", "shutdown", "end"]) S().execCommand(id("S2"), l);
    advance(200);
    // S2's own linkDown, plus S3's: the far end of the S2–S3 cable loses carrier too
    expect(trapNames().filter((n) => n === "IF-MIB::linkDown")).toHaveLength(2);
    const fromS2 = (peekTrapd(byName("NMS"))?.traps ?? []).filter((t) => t.srcIp === "192.168.100.2");
    expect(fromS2.map((t) => formatOid((decodeMessage(t.bytes).pdu.varbinds[1].value as { value: number[] }).value))).toContain("IF-MIB::linkDown");
  });
});

describe("Click (sonic-utilities) snmp commands", () => {
  beforeEach(() => S().execCommand(id("S1"), "exit"));

  it("show runningconfiguration snmp tables", () => {
    expect(run("S1", "show runningconfiguration snmp community")).toBe(
      ["Community String    Community Type", "------------------  ----------------", "private             RW", "public              RO"].join("\n"),
    );
    expect(run("S1", "show runningconfiguration snmp contact")).toBe("Contact          Contact Email\n---------------  ---------------\nnoc@lab.example");
    const full = run("S1", "show runningconfiguration snmp").split("\n");
    expect(full.slice(0, 5)).toEqual(["Location", "--------------", "Lab-Row1-Rack1", "", ""]);
  });

  it("config snmptrap modify → show snmptrap and a coldStart to the new trap2sink", () => {
    run("S3", "exit");
    const before = trapNames().length;
    expect(run("S3", "sudo config snmptrap modify 2 192.168.100.250 -c public")).toBe("");
    expect(run("S3", "show snmptrap")).toBe(
      ["  Version  TrapReceiverIP      Port  VRF    Community", "---------  ----------------  ------  -----  -----------", "        2  192.168.100.250      162  None   public"].join("\n"),
    );
    advance(200); // synchronous restart: nsNotifyShutdown (old sinks) + coldStart to v2TrapDest and the KLISH host
    expect(trapNames().slice(before)).toEqual(["NET-SNMP-AGENT-MIB::nsNotifyShutdown", "SNMPv2-MIB::coldStart", "SNMPv2-MIB::coldStart"]);
  });

  it("config snmpagentaddress add/del and show snmpagentaddress", () => {
    expect(run("S1", "sudo config snmpagentaddress add 10.1.1.1")).toBe("IP address is not available");
    expect(run("S1", "sudo config snmpagentaddress add 192.168.100.1 -p 1161")).toBe("");
    expect(run("S1", "show snmpagentaddress")).toBe("ListenIP         ListenPort  ListenVrf\n-------------  ------------  -----------\n192.168.100.1          1161");
    expect(run("S1", "sudo config snmpagentaddress add 192.168.100.1 -p 1161")).toBe("entry with 192.168.100.1:1161 already exists ");
  });
});

describe("BER codec", () => {
  it("round-trips a GetResponse with every value type", () => {
    const m = {
      version: 1,
      community: "public",
      pdu: {
        type: PDU.RESPONSE,
        reqId: 0x7fffffff,
        errStatus: 0,
        errIndex: 0,
        varbinds: [
          { oid: [1, 3, 6, 1, 2, 1, 1, 3, 0], value: { type: "timeticks" as const, value: 4294967295 } },
          { oid: [1, 3, 6, 1, 2, 1, 2, 2, 1, 1, 1], value: { type: "integer" as const, value: -129 } },
          { oid: [1, 3, 6, 1, 2, 1, 31, 1, 1, 1, 6, 1], value: { type: "counter64" as const, value: BigInt("18446744073709551615") } },
          { oid: [1, 3, 6, 1, 4, 1, 8072, 3, 2, 10], value: { type: "oid" as const, value: [1, 3, 6, 1, 4, 1, 8072, 3, 2, 10] } },
          { oid: [1, 3, 6, 1, 2, 1, 4, 20, 1, 1], value: { type: "ipaddress" as const, value: "10.0.0.1" } },
          { oid: [1, 3, 6, 1, 2, 1, 1, 9], value: { type: "noSuchInstance" as const } },
        ],
      },
    };
    expect(decodeMessage(encodeMessage(m))).toEqual(m);
    // The canonical GetRequest for sysName.0 with request-id 1 (RFC 3416 framing).
    const get = encodeMessage({ version: 1, community: "public", pdu: { type: PDU.GET, reqId: 1, errStatus: 0, errIndex: 0, varbinds: [{ oid: [1, 3, 6, 1, 2, 1, 1, 5, 0], value: { type: "null" } }] } });
    expect(Buffer.from(get).toString("hex")).toBe("3026020101040670756" + "26c6963a019020101020100020100300e300c06082b060102010105000500");
  });
});
