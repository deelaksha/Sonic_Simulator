/**
 * Management / telemetry integration: SNMP, syslog, the SONiC DB projection, LLDP,
 * NTP, AAA/TACACS+, interface counters and KLISH-vs-Click show output, checked
 * against the protocols they observe (link state, BGP, OSPF, LLDP, FDB, traffic).
 * Each scenario follows one event through every place it should show up.
 */
import "../lib/commands/sonic-cli/features";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../lib/labs";
import { resetAll } from "./helpers";
import { S, advance, byName, out } from "./control-helpers";
import { peekTrapd } from "../lib/protocols/snmp-daemon";
import { decodeMessage } from "../lib/protocols/snmp-ber";
import { formatOid } from "../lib/protocols/snmp-mib";

const id = (dev: string) => byName(dev).id;
/** Run at the bash prompt (switches boot into KLISH: `exit` drops to bash). */
function bash(dev: string, cmd: string): string {
  if (byName(dev).type === "switch" && (S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "exit");
  return out(S().execCommand(id(dev), cmd));
}
/** Run in KLISH exec mode. */
function klish(dev: string, cmd: string): string {
  if (!(S().cliMode[id(dev)] ?? ["exec"]).length) S().execCommand(id(dev), "sonic-cli");
  return out(S().execCommand(id(dev), cmd));
}
const cfg = (dev: string, ...lines: string[]) => S().runCliScript(id(dev), ["configure terminal", ...lines, "end"], { silent: true });
/** `sonic-db-cli <DB> HGETALL <key>` → object (the CLI prints a Python dict). */
function hgetall(dev: string, db: string, key: string): Record<string, string> {
  const txt = bash(dev, `sonic-db-cli ${db} HGETALL '${key}'`);
  return Object.fromEntries([...txt.matchAll(/'([^']*)': '([^']*)'/g)].map((m) => [m[1], m[2]]));
}
const keys = (dev: string, db: string, pat: string) =>
  bash(dev, `sonic-db-cli ${db} KEYS '${pat}'`).split("\n").filter((l) => l && l !== "(empty array)");
/** One snmpget value, -Oqv style ("down", "574"). */
const snmp = (agent: string, oid: string) => bash("NMS", `snmpget -v2c -c public -Oqv ${agent} ${oid}`);
/** [source ip, trap OID name] for every notification snmptrapd on the NMS received. */
const traps = () =>
  (peekTrapd(byName("NMS"))?.traps ?? []).map((t) => [t.srcIp, formatOid((decodeMessage(t.bytes).pdu.varbinds[1].value as { value: number[] }).value)]);
/** Click `show interfaces status` row → {oper, admin} (intfutil column order). */
function clickStatus(dev: string, port: string) {
  const row = bash(dev, "show interfaces status").split("\n").find((l) => l.trim().split(/\s+/)[0] === port)!.trim().split(/\s+/);
  return { oper: row[7], admin: row[8], mtu: row[3], vlan: row[6] };
}
/** KLISH `show interface status` row → {oper, reason}. */
function klishStatus(dev: string, port: string) {
  const row = klish(dev, "show interface status").split("\n").find((l) => l.startsWith(port + " "))!.trim().split(/\s+/);
  return { oper: row[2], reason: row[3], mtu: row[6] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  resetAll();
});
afterEach(() => vi.useRealTimers());

describe("link down: CLI status, DBs, IF-MIB, traps and syslog agree (snmp lab)", () => {
  beforeEach(() => {
    S().loadFeatureLab("snmp");
    advance(3000);
  });

  it("KLISH shutdown on S1 Ethernet0 takes both cable ends down everywhere, and no shutdown restores them", () => {
    cfg("S1", "interface Ethernet 0", "shutdown");
    advance(1000);

    // S1: admin down. S2 (far end of the cable): admin up, carrier lost.
    expect(clickStatus("S1", "Ethernet0")).toMatchObject({ oper: "down", admin: "down" });
    expect(klishStatus("S1", "Ethernet0")).toMatchObject({ oper: "down", reason: "admin-down" });
    expect(clickStatus("S2", "Ethernet0")).toMatchObject({ oper: "down", admin: "up" });
    expect(klishStatus("S2", "Ethernet0")).toMatchObject({ oper: "down", reason: "phy-link-down" });
    // MTU in both CLIs is the APPL_DB value
    expect(clickStatus("S1", "Ethernet1").mtu).toBe(hgetall("S1", "APPL_DB", "PORT_TABLE:Ethernet1").mtu);
    expect(klishStatus("S1", "Ethernet1").mtu).toBe("9100");

    // DBs: APPL_DB PORT_TABLE / STATE_DB PORT_TABLE / ASIC_DB port admin state
    expect(hgetall("S1", "APPL_DB", "PORT_TABLE:Ethernet0")).toMatchObject({ admin_status: "down", oper_status: "down" });
    expect(hgetall("S1", "STATE_DB", "PORT_TABLE|Ethernet0")).toMatchObject({ admin_status: "down", netdev_oper_status: "down" });
    expect(hgetall("S2", "APPL_DB", "PORT_TABLE:Ethernet0")).toMatchObject({ admin_status: "up", oper_status: "down" });
    expect(hgetall("S2", "STATE_DB", "PORT_TABLE|Ethernet0")).toMatchObject({ admin_status: "up", netdev_oper_status: "down" });

    // IF-MIB (row 1 = Ethernet0) on both agents; ifMtu = APPL_DB mtu
    expect(snmp("192.168.100.1", "IF-MIB::ifAdminStatus.1")).toBe("down");
    expect(snmp("192.168.100.1", "IF-MIB::ifOperStatus.1")).toBe("down");
    expect(snmp("192.168.100.2", "IF-MIB::ifAdminStatus.1")).toBe("up");
    expect(snmp("192.168.100.2", "IF-MIB::ifOperStatus.1")).toBe("down");
    expect(snmp("192.168.100.1", "IF-MIB::ifMtu.2")).toBe("9100");
    expect(bash("NMS", "snmpwalk -v2c -c public 192.168.100.2 IF-MIB::ifOperStatus")).toContain("IF-MIB::ifOperStatus.1 = INTEGER: down(2)");

    // linkDown traps from both switches
    const downs = traps().filter(([, n]) => n === "IF-MIB::linkDown").map(([src]) => src).sort();
    expect(downs).toEqual(["192.168.100.1", "192.168.100.2"]);

    // syslog (orchagent port oper change) on both
    expect(bash("S1", "show logging")).toMatch(/swss#orchagent: :- updatePortOperStatus: Port Ethernet0 oper state set from up to down$/m);
    expect(bash("S2", "show logging")).toMatch(/swss#orchagent: :- updatePortOperStatus: Port Ethernet0 oper state set from up to down$/m);

    cfg("S1", "interface Ethernet 0", "no shutdown");
    advance(1000);
    expect(clickStatus("S1", "Ethernet0")).toMatchObject({ oper: "up", admin: "up" });
    expect(clickStatus("S2", "Ethernet0")).toMatchObject({ oper: "up", admin: "up" });
    expect(snmp("192.168.100.2", "IF-MIB::ifOperStatus.1")).toBe("up");
    expect(traps().filter(([, n]) => n === "IF-MIB::linkUp").map(([src]) => src).sort()).toEqual(["192.168.100.1", "192.168.100.2"]);
    expect(bash("S2", "show logging -l 5")).toMatch(/Port Ethernet0 oper state set from down to up$/m);
  });

  it("Click `config interface shutdown` drops the peer's carrier too", () => {
    bash("S1", "sudo config interface shutdown Ethernet1");
    advance(500);
    expect(clickStatus("S3", "Ethernet0")).toMatchObject({ oper: "down", admin: "up" });
    bash("S1", "sudo config interface startup Ethernet1");
    advance(500);
    expect(clickStatus("S3", "Ethernet0")).toMatchObject({ oper: "up", admin: "up" });
  });
});

describe("BGP neighbour drop: syslog, show ip bgp summary, STATE_DB, link trap (bgp lab)", () => {
  it("shutting the peer's port resets the session at once (fast-external-failover)", () => {
    S().loadFeatureLab("bgp");
    cfg("S1", "snmp-server community public ro", "snmp-server enable traps", "snmp-server host 192.168.100.250 version v2c community public");
    bash("NMS", "snmptrapd");
    advance(5000);
    expect(hgetall("S1", "STATE_DB", "NEIGH_STATE_TABLE|10.0.12.2").state).toBe("Established");

    cfg("S2", "interface Ethernet 0", "shutdown");
    advance(2000);

    expect(bash("S1", "show logging")).toMatch(/bgp#bgpd\[\d+\]: %ADJCHANGE: neighbor 10\.0\.12\.2\(S2\) in vrf default Down Interface down$/m);
    const click = bash("S1", "show ip bgp summary");
    expect(click).toMatch(/^10\.0\.12\.2\s+4\s+65002\s.*\s(Active|Connect|Idle)\s/m);
    expect(klish("S1", "show ip bgp summary")).toBe(click);
    expect(hgetall("S1", "STATE_DB", "NEIGH_STATE_TABLE|10.0.12.2").state).not.toBe("Established");
    // S1 Ethernet0 lost carrier: linkDown from S1 (bgp4 MIB traps are not modelled)
    expect(traps()).toContainEqual(["192.168.100.1", "IF-MIB::linkDown"]);

    cfg("S2", "interface Ethernet 0", "no shutdown");
    advance(40000);
    expect(bash("S1", "show logging -l 20")).toMatch(/%ADJCHANGE: neighbor 10\.0\.12\.2\(S2\) in vrf default Up$/m);
    expect(hgetall("S1", "STATE_DB", "NEIGH_STATE_TABLE|10.0.12.2").state).toBe("Established");
  });
});

describe("OSPF neighbour change → syslog (ospf lab)", () => {
  it("interface down logs FRR's KillNbr transition to Deleted; recovery logs Loading -> Full", () => {
    S().loadFeatureLab("ospf");
    advance(60000);
    cfg("S2", "interface Ethernet 0", "shutdown");
    advance(2000);
    expect(bash("S1", "show logging")).toMatch(/bgp#ospfd\[\d+\]: AdjChg: Nbr 2\.2\.2\.2, NbrIP 10\.0\.12\.2 \(default\) on Ethernet0:10\.0\.12\.1: Full -> Deleted \(KillNbr\)$/m);
    expect(bash("S1", "show ip ospf neighbor")).not.toContain("2.2.2.2");
    cfg("S2", "interface Ethernet 0", "no shutdown");
    advance(60000);
    expect(bash("S1", "show logging -l 10")).toMatch(/AdjChg: Nbr 2\.2\.2\.2, .*: Loading -> Full \(LoadingDone\)$/m);
  });
});

describe("LLDP neighbours: Click, KLISH and APPL_DB LLDP_ENTRY_TABLE agree (snmp lab)", () => {
  it("every neighbour in show lldp table has an LLDP_ENTRY_TABLE row with the same system/port", () => {
    S().loadFeatureLab("snmp");
    advance(35000);
    const rows = bash("S1", "show lldp table").split("\n").filter((l) => /^(Ethernet|eth)\d+\s/.test(l)).map((l) => l.split(/\s+/));
    expect(rows.map((r) => r[0])).toEqual(["Ethernet0", "Ethernet1", "eth0"]);
    const k = klish("S1", "show lldp table");
    for (const [port, sys, rport] of rows) {
      expect(hgetall("S1", "APPL_DB", `LLDP_ENTRY_TABLE:${port}`)).toMatchObject({ lldp_rem_sys_name: sys, lldp_rem_port_id: rport });
      expect(k).toMatch(new RegExp(`^${port}\\s+${sys}\\s+${rport}\\s`, "m"));
    }
    expect(keys("S1", "APPL_DB", "LLDP_ENTRY_TABLE:*")).toHaveLength(rows.length);
  });
});

describe("interface counters: portstat, KLISH, COUNTERS_DB and IF-MIB agree", () => {
  /** Click portstat row for a port → {rxOk, rxDrp, txOk}. */
  const portstat = (dev: string, port: string, viaKlish = false) => {
    const txt = viaKlish ? klish(dev, "show interface counters") : bash(dev, "show interfaces counters");
    const r = txt.split("\n").find((l) => l.trim().startsWith(port + " "))!.trim().split(/\s+/);
    return { rxOk: Number(r[2].replace(/,/g, "")), rxDrp: Number(r[7].replace(/,/g, "")), txOk: Number(r[9].replace(/,/g, "")) };
  };
  const counters = (dev: string, port: string) => {
    const oid = bash(dev, `sonic-db-cli COUNTERS_DB HGET COUNTERS_PORT_NAME_MAP ${port}`).trim();
    return hgetall(dev, "COUNTERS_DB", `COUNTERS:${oid}`);
  };

  it("ping H1→H3 across the BGP triangle: rx/tx packets and octets match in all four places", () => {
    S().loadFeatureLab("bgp");
    cfg("S1", "snmp-server community public ro");
    advance(5000);
    expect(bash("H1", "ping -c 5 192.168.3.10")).toContain("5 received");
    advance(1500);
    const ps = portstat("S1", "Ethernet2");
    expect(ps.rxOk).toBeGreaterThanOrEqual(5);
    expect(portstat("S1", "Ethernet2", true)).toEqual(ps);
    const c = counters("S1", "Ethernet2");
    expect(Number(c.SAI_PORT_STAT_IF_IN_UCAST_PKTS) + Number(c.SAI_PORT_STAT_IF_IN_NON_UCAST_PKTS)).toBe(ps.rxOk);
    expect(Number(c.SAI_PORT_STAT_IF_OUT_UCAST_PKTS) + Number(c.SAI_PORT_STAT_IF_OUT_NON_UCAST_PKTS)).toBe(ps.txOk);
    // IF-MIB row 3 = Ethernet2
    expect(snmp("192.168.100.1", "IF-MIB::ifInOctets.3")).toBe(c.SAI_PORT_STAT_IF_IN_OCTETS);
    expect(snmp("192.168.100.1", "IF-MIB::ifOutOctets.3")).toBe(c.SAI_PORT_STAT_IF_OUT_OCTETS);
    expect(snmp("192.168.100.1", "IF-MIB::ifInUcastPkts.3")).toBe(c.SAI_PORT_STAT_IF_IN_UCAST_PKTS);
    expect(snmp("192.168.100.1", "IF-MIB::ifHCInOctets.3")).toBe(c.SAI_PORT_STAT_IF_IN_OCTETS);
  });

  it("dropped traffic (no route) counts the same RX_DRP / IF_IN_DISCARDS / ifInDiscards", () => {
    S().loadFeatureLab("snmp"); // no routing protocol: S1 has no route to 192.168.3.0/24
    advance(3000);
    bash("H1", "ping -c 5 192.168.3.10");
    advance(1500);
    const ps = portstat("S1", "Ethernet2");
    expect(ps.rxDrp).toBe(5);
    expect(portstat("S1", "Ethernet2", true).rxDrp).toBe(5);
    expect(counters("S1", "Ethernet2").SAI_PORT_STAT_IF_IN_DISCARDS).toBe("5");
    expect(snmp("192.168.100.1", "IF-MIB::ifInDiscards.3")).toBe("5");
  });
});

describe("KLISH ↔ Click configuration reaches CONFIG_DB and both running configs (bgp lab)", () => {
  beforeEach(() => {
    S().loadFeatureLab("bgp");
    advance(1000);
  });

  it("KLISH VLAN / SVI IP / BGP neighbour → CONFIG_DB and Click show runningconfiguration all", () => {
    cfg("S1", "interface Vlan 100", "exit", "interface Ethernet 3", "switchport access Vlan 100", "exit",
      "interface Vlan 100", "ip address 10.100.0.1/24", "exit", "router bgp 65001", "neighbor 10.100.0.2", "remote-as 65100");
    expect(keys("S1", "CONFIG_DB", "VLAN*")).toEqual(expect.arrayContaining(["VLAN|Vlan100", "VLAN_MEMBER|Vlan100|Ethernet3", "VLAN_INTERFACE|Vlan100|10.100.0.1/24"]));
    expect(hgetall("S1", "CONFIG_DB", "BGP_NEIGHBOR|default|10.100.0.2").asn).toBe("65100");
    const run = JSON.parse(bash("S1", "show runningconfiguration all"));
    expect(run.VLAN_MEMBER["Vlan100|Ethernet3"]).toEqual({ tagging_mode: "untagged" });
    expect(run.VLAN_INTERFACE).toHaveProperty(["Vlan100|10.100.0.1/24"]);
    expect(run.BGP_NEIGHBOR["default|10.100.0.2"].asn).toBe("65100");
    expect(bash("S1", "show vlan brief")).toMatch(/\| 100\s+\|.*\| Ethernet3\s+\| untagged/);
    // the VLAN member port is no longer routed in intfutil's Vlan column
    expect(clickStatus("S1", "Ethernet3").vlan).toBe("trunk");
    expect(clickStatus("S1", "Ethernet0").vlan).toBe("routed");
  });

  it("Click VLAN / SVI IP → KLISH show running-configuration and CONFIG_DB", () => {
    bash("S1", "sudo config vlan add 200");
    bash("S1", "sudo config vlan member add -u 200 Ethernet3");
    // VLAN_INTERFACE on a VLAN created from Click (no KLISH `interface Vlan 200` first)
    expect(bash("S1", "sudo config interface ip add Vlan200 10.200.0.1/24")).not.toContain("no such interface");
    const kr = klish("S1", "show running-configuration");
    expect(kr).toMatch(/^interface Vlan200\n ip address 10\.200\.0\.1\/24$/m);
    expect(kr).toMatch(/^interface Ethernet3\n(?: .*\n)* switchport access Vlan 200$/m);
    expect(keys("S1", "CONFIG_DB", "VLAN_MEMBER*")).toContain("VLAN_MEMBER|Vlan200|Ethernet3");
    expect(keys("S1", "CONFIG_DB", "VLAN_INTERFACE*")).toContain("VLAN_INTERFACE|Vlan200|10.200.0.1/24");
    expect(bash("S1", "show ip interfaces")).toMatch(/^Vlan200\s+10\.200\.0\.1\/24\s/m);
  });
});

describe("remote syslog, NTP and AAA against a lab server (snmp lab, NMS 192.168.100.250)", () => {
  beforeEach(() => {
    S().loadFeatureLab("snmp");
    advance(3000);
  });

  it("KLISH logging server → CONFIG_DB SYSLOG_SERVER, Click show syslog, and the NMS receives lines over UDP/514", () => {
    cfg("S1", "logging server 192.168.100.250");
    expect(keys("S1", "CONFIG_DB", "SYSLOG_SERVER|*")).toEqual(["SYSLOG_SERVER|192.168.100.250"]);
    expect(bash("S1", "show syslog")).toMatch(/^192\.168\.100\.250\s/m);
    advance(200);
    cfg("S1", "interface Ethernet 0", "shutdown");
    advance(500);
    const rx = S().captures.filter((c) => c.deviceId === id("NMS") && c.dir === "rx" && c.frame.udp?.dstPort === 514);
    expect(rx.length).toBeGreaterThan(0);
    expect(rx[0].frame.ipv4).toMatchObject({ srcIp: "192.168.100.1", dstIp: "192.168.100.250" });
    expect(bash("NMS", "show logging")).toMatch(/ s1 NOTICE swss#orchagent: :- updatePortOperStatus: Port Ethernet0 oper state set from up to down$/m);
    cfg("S1", "no logging server 192.168.100.250");
    expect(keys("S1", "CONFIG_DB", "SYSLOG_SERVER|*")).toEqual([]);
  });

  it("KLISH ntp server → CONFIG_DB NTP_SERVER; associations sync over the network and go .INIT. when the server is cut off", () => {
    cfg("S1", "ntp server 192.168.100.250");
    expect(keys("S1", "CONFIG_DB", "NTP_SERVER|*")).toEqual(["NTP_SERVER|192.168.100.250"]);
    expect(klish("S1", "show ntp associations")).toMatch(/^\* 192\.168\.100\.250\s+LOCL\s+\d+\s+32\s+64\s+377\s/m);
    const nmsCable = S().network.connections.find((c) => c.a.deviceId === id("NMS") || c.b.deviceId === id("NMS"))!;
    S().disconnect(nmsCable.id);
    expect(bash("S1", "show ntp associations")).toMatch(/^ {2}192\.168\.100\.250\s+\.INIT\.\s+16\s+-\s+64\s+0\s/m);
  });

  it("TACACS+ server and AAA login method land in CONFIG_DB; tacacs+ login needs the global passkey", () => {
    cfg("S1", "tacacs-server host 192.168.100.250 key srvkey priority 5");
    expect(hgetall("S1", "CONFIG_DB", "TACPLUS_SERVER|192.168.100.250")).toMatchObject({ tcp_port: "49", priority: "5", passkey: "srvkey" });
    expect(bash("S1", "sudo config aaa authentication login tacacs+ local")).toContain("not allowed when passkey not exists");
    expect(keys("S1", "CONFIG_DB", "AAA|*")).toEqual([]);
    cfg("S1", "tacacs-server key globalkey");
    expect(hgetall("S1", "CONFIG_DB", "TACPLUS|global").passkey).toBe("globalkey");
    cfg("S1", "aaa authentication login default group tacacs+ local");
    expect(hgetall("S1", "CONFIG_DB", "AAA|authentication").login).toBe("tacacs+,local");
    expect(bash("S1", "show aaa")).toContain("login-method : tacacs+, local");
  });
});

describe("MAC learning: show mac, STATE_DB FDB_TABLE and ASIC_DB FDB entries agree (MGMT switch)", () => {
  it("every learned MAC appears once in each", () => {
    S().loadFeatureLab("snmp");
    advance(3000);
    bash("NMS", "ping -c 1 192.168.100.2");
    const macs = bash("MGMT", "show mac").split("\n").filter((l) => /^\s+\d+\s+1\s/.test(l)).map((l) => l.trim().split(/\s+/)[2].toLowerCase()).sort();
    expect(macs.length).toBeGreaterThanOrEqual(4);
    expect(klish("MGMT", "show mac address-table").toLowerCase()).toContain(macs[0]);
    const state = keys("MGMT", "STATE_DB", "FDB_TABLE|*").map((k) => k.replace("FDB_TABLE|Vlan1:", "")).sort();
    expect(state).toEqual(macs);
    const asic = keys("MGMT", "ASIC_DB", "ASIC_STATE:SAI_OBJECT_TYPE_FDB_ENTRY:*").map((k) => JSON.parse(k.slice(k.indexOf("{"))).mac.toLowerCase()).sort();
    expect(asic).toEqual(macs);
  });
});
