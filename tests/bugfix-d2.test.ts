/**
 * D2 regressions: config changes logged by the daemons that apply them (show logging),
 * and the QoS / CoPP / queue tables in sonic-db-cli.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";

const id = (dev: string) => byName(dev).id;
function bash(dev: string, cmd: string): string {
  if (byName(dev).type === "switch" && (S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}
function klish(dev: string, ...lines: string[]): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return lines.map((l) => out(S().execCommand(id(dev), l))).join("\n");
}
const log = (dev: string) => bash(dev, "show logging");
const lab = (name: string) => {
  S().loadFeatureLab(name);
  advance(3000, 500);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("bug 1: config changes reach show logging", () => {
  it("ACL: aclorch logs table create/update/delete and rule create/delete (aclorch.cpp:3095-3125, 4945, 5082, 5661)", () => {
    lab("acl");
    const before = log("S1");
    expect(before).not.toMatch(/H1-POLICY/); // lab preset = boot config: nothing new
    klish("S1", "configure terminal", "interface Ethernet2", "ip access-group H1-POLICY in", "end");
    klish("S1", "configure terminal", "ip access-list NEWACL", "seq 10 permit ip any any", "end");
    advance(500);
    let text = log("S1");
    expect(text).toMatch(/ s1 NOTICE swss#orchagent: :- doAclTableTask: Successfully updated existing ACL table H1-POLICY$/m);
    expect(text).toMatch(/ s1 NOTICE swss#orchagent: :- addAclTable: Created ACL table NEWACL oid:7[0-9a-f]+$/m);
    expect(text).toMatch(/ s1 NOTICE swss#orchagent: :- add: Successfully created ACL rule DEFAULT_DROP_ANY in table NEWACL$/m);
    expect(text).toMatch(/ s1 NOTICE swss#orchagent: :- addDefaultDenyRule: Added implicit deny-all rule DEFAULT_DROP_ANY \(IPV4ANY\) to ACL table NEWACL$/m);
    expect(text).toMatch(/ s1 NOTICE swss#orchagent: :- add: Successfully created ACL rule RULE_10 in table NEWACL$/m);
    klish("S1", "configure terminal", "ip access-list NEWACL", "no seq 10", "exit", "no ip access-list NEWACL", "end");
    advance(500);
    text = log("S1");
    expect(text).toMatch(/:- remove: Successfully deleted ACL rule RULE_10 in table NEWACL$/m);
    expect(text).toMatch(/:- removeAclTable: Successfully deleted ACL table NEWACL$/m);
  });

  it("port speed: orchagent doPortTask 'Set port <if> speed to <n>' (portsorch.cpp:4647-4650)", () => {
    lab("qos");
    bash("S1", "config interface speed Ethernet2 100");
    advance(500);
    expect(log("S1")).toMatch(/ s1 NOTICE swss#orchagent: :- doPortTask: Set port Ethernet2 speed to 100$/m);
  });

  it("feature state: featured runs systemctl and logs the result (sonic-host-services scripts/featured:268-274, 403-455)", () => {
    lab("qos");
    bash("S1", "config feature state snmp disabled");
    advance(500);
    let text = log("S1");
    expect(text).toMatch(/ s1 INFO featured: Running cmd: '\['sudo', 'systemctl', 'stop', 'snmp\.service'\]'$/m);
    expect(text).toMatch(/ s1 INFO featured: Running cmd: '\['sudo', 'systemctl', 'mask', 'snmp\.service'\]'$/m);
    expect(text).toMatch(/ s1 INFO featured: Feature snmp is stopped and disabled$/m);
    bash("S1", "config feature state snmp enabled");
    advance(500);
    text = log("S1");
    expect(text).toMatch(/ s1 INFO featured: Running cmd: '\['sudo', 'systemctl', 'start', 'snmp\.service'\]'$/m);
    expect(text).toMatch(/ s1 INFO featured: Feature snmp is enabled and started$/m);
  });

  it("CoPP: copporch trap group / policer creation (copporch.cpp:615, 652, 772, 791)", () => {
    lab("copp");
    bash("S1", "config copp action add LOGTEST");
    bash("S1", "config copp action set LOGTEST trap-queue 3");
    advance(500);
    let text = log("S1");
    expect(text).toMatch(/ s1 NOTICE swss#orchagent: :- processCoppRule: Create host interface trap group LOGTEST$/m);
    expect(text).not.toMatch(/policer for trap group LOGTEST/);
    bash("S1", "config copp action set LOGTEST police cir 100 cbs 100");
    advance(500);
    text = log("S1");
    expect(text).toMatch(/:- trapGroupUpdatePolicer: Creating policer for existing Trap group: [0-9a-f]+ \(name:LOGTEST\)\.$/m);
    expect(text).toMatch(/:- createPolicer: Create policer for trap group LOGTEST$/m);
    expect(text).toMatch(/:- createPolicer: Bind policer to trap group LOGTEST:$/m);
    bash("S1", "config copp action set copp-lab-ip2me trap-queue 6");
    advance(500);
    expect(log("S1")).toMatch(/:- processCoppRule: Set trap group copp-lab-ip2me to host interface$/m);
  });

  it("QoS: qosorch Created/Set [TABLE:name] and 'Applied QoS maps to ports' (qosorch.cpp:156, 169, 1470, 2221)", () => {
    lab("qos");
    bash("S1", "config qos map dscp-tc add LOGMAP 8 1");
    advance(500);
    expect(log("S1")).toMatch(/ s1 NOTICE swss#orchagent: :- processWorkItem: Created \[DSCP_TO_TC_MAP:LOGMAP\]$/m);
    bash("S1", "config qos map dscp-tc add LOGMAP 16 2");
    bash("S1", "config qos scheduler-policy add LOGSCHED 3 strict");
    bash("S1", "config qos interface bind Ethernet2 dscp-tc LOGMAP");
    advance(500);
    const text = log("S1");
    expect(text).toMatch(/:- processWorkItem: Set \[DSCP_TO_TC_MAP:LOGMAP\]$/m);
    expect(text).toMatch(/:- handleSchedulerTable: Created \[SCHEDULER:LOGSCHED@3\]$/m);
    expect(text).toMatch(/:- handlePortQosMapTable: Applied QoS maps to ports$/m);
  });
});

describe("bug 2: sonic-db-cli QoS / CoPP / queue tables", () => {
  it("CONFIG_DB QoS tables from the qos lab", () => {
    lab("qos");
    bash("S1", "config qos interface bind Ethernet2 scheduler-policy LAB-STRICT");
    bash("S1", "config qos interface bind Ethernet2 wred-policy LAB-WRED");
    expect(bash("S1", "sonic-db-cli CONFIG_DB hgetall 'DSCP_TO_TC_MAP|LAB-DSCP'")).toMatch(/'46': '5'/);
    expect(bash("S1", "sonic-db-cli CONFIG_DB hgetall 'PORT_QOS_MAP|Ethernet0'")).toMatch(/'dscp_to_tc_map': 'LAB-DSCP'/);
    expect(bash("S1", "sonic-db-cli CONFIG_DB hget 'SCHEDULER|LAB-STRICT@5' type")).toBe("STRICT");
    expect(bash("S1", "sonic-db-cli CONFIG_DB hget 'QUEUE|Ethernet2|5' scheduler")).toBe("LAB-STRICT@5");
    expect(bash("S1", "sonic-db-cli CONFIG_DB hget 'QUEUE|Ethernet2|0' wred_profile")).toBe("LAB-WRED");
    expect(bash("S1", "sonic-db-cli CONFIG_DB hget 'WRED_PROFILE|LAB-WRED' green_min_threshold")).toBe(String(100 * 1024));
  });

  it("COUNTERS_DB queue counters follow the QoS model", () => {
    lab("qos");
    out(S().execCommand(id("H3"), "iperf3 -s"));
    out(S().execCommand(id("H2"), "iperf3 -c 192.168.3.10 -u -b 10M -S 184 -t 2"));
    advance(3000, 100);
    const oid = bash("S1", "sonic-db-cli COUNTERS_DB hget COUNTERS_QUEUE_NAME_MAP Ethernet2:5");
    expect(oid).toMatch(/^oid:0x15[0-9a-f]+$/);
    expect(bash("S1", `sonic-db-cli COUNTERS_DB hget COUNTERS_QUEUE_TYPE_MAP ${oid}`)).toBe("SAI_QUEUE_TYPE_UNICAST");
    expect(bash("S1", `sonic-db-cli COUNTERS_DB hget COUNTERS_QUEUE_INDEX_MAP ${oid}`)).toBe("5");
    expect(Number(bash("S1", `sonic-db-cli COUNTERS_DB hget COUNTERS:${oid} SAI_QUEUE_STAT_PACKETS`))).toBeGreaterThan(0);
  });

  it("CoPP: CONFIG_DB COPP_GROUP/COPP_TRAP, APPL_DB COPP_TABLE, trap flow counters", () => {
    lab("copp");
    expect(bash("S1", "sonic-db-cli CONFIG_DB hgetall 'COPP_GROUP|copp-lab-ip2me'")).toMatch(/'cir': '50'/);
    expect(bash("S1", "sonic-db-cli CONFIG_DB hget 'COPP_TRAP|copp-lab-ip2me' trap_ids")).toBe("ip2me");
    expect(bash("S1", "sonic-db-cli APPL_DB hget COPP_TABLE:copp-lab-ip2me trap_ids")).toBe("ip2me");
    expect(bash("S1", "sonic-db-cli APPL_DB hget COPP_TABLE:bgp trap_ids")).toBe("bgp,bgpv6");
    expect(bash("S1", "sonic-db-cli APPL_DB exists COPP_TABLE:pim")).toBe("0"); // pending: no enabled trap
    out(S().execCommand(id("H1"), "ping -c 2 192.168.1.1"));
    advance(3000, 100);
    const oid = bash("S1", "sonic-db-cli COUNTERS_DB hget COUNTERS_TRAP_NAME_MAP ip2me");
    expect(oid).toMatch(/^oid:0x54[0-9a-f]+$/);
    expect(Number(bash("S1", `sonic-db-cli COUNTERS_DB hget COUNTERS:${oid} SAI_COUNTER_STAT_PACKETS`))).toBeGreaterThan(0);
  });
});
