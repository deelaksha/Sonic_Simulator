/**
 * SNMP feature lab on routedTriangle(): S1–S3 run snmpd (SONiC docker-snmp) with
 * community `public` (ro) and `private` (rw), link traps enabled and a v2c trap
 * host 192.168.100.250 — the NMS, which runs snmptrapd. Configured through KLISH;
 * the writes restart snmp ~2 s later (snmp_post_xfmr debounce), which sends the
 * coldStart traps NMS logs.
 */
import { registerLab } from "./registry";
import { routedTriangle } from "./topologies";

export const SNMP_LAB_SCRIPT = (location: string): string[] => [
  "configure terminal",
  "snmp-server community public ro",
  "snmp-server community private rw",
  `snmp-server location ${location}`,
  "snmp-server contact noc@lab.example",
  "snmp-server enable traps",
  "snmp-server host 192.168.100.250 version v2c community public",
  "end",
];

registerLab("snmp", (api) => {
  const t = routedTriangle(api);
  // LabApi has no bash entry point; KLISH `do <cmd>` runs a shell command on the host.
  api.exec(t.nms, "snmptrapd");
  api.runCliScript(t.s1, SNMP_LAB_SCRIPT("Lab-Row1-Rack1"));
  api.runCliScript(t.s2, SNMP_LAB_SCRIPT("Lab-Row1-Rack2"));
  api.runCliScript(t.s3, SNMP_LAB_SCRIPT("Lab-Row1-Rack3"));
  api.hint(t.nms, [
    "SNMP lab — NMS 192.168.100.250 manages S1/S2/S3 (eth0 192.168.100.1/.2/.3)",
    "snmptrapd is running here; the switches' snmp service restarts ~2 s after the lab loads → coldStart traps.",
    "1. snmpwalk -v2c -c public 192.168.100.1 system        — sysDescr, sysUpTime, sysName = S1 …",
    "2. snmpwalk -v2c -c public 192.168.100.1 ifTable       — ifIndex.1 = 0 (sonic-snmpagent), ifOperStatus, counters",
    "3. snmpget -v2c -c public 192.168.100.1 IF-MIB::ifInOctets.1   (ping H1→H3, then again: it grows)",
    "4. snmpget -v2c -c wrong 192.168.100.1 sysName.0       — wrong community: dropped → Timeout",
    "5. snmpset -v2c -c private 192.168.100.1 sysName.0 s core-1   (sysLocation: notWritable — set in snmpd.conf)",
    "6. On S1: configure terminal / interface Ethernet 0 / shutdown — then here: snmptrapd -l (linkDown trap)",
    "7. sudo tcpdump -i eth0 -nn port 161 or port 162       — GetRequest / GetResponse / V2Trap on the wire",
    "8. SNMPv3: on S1 `sudo config snmp user add u1 Priv RO SHA authpass1 AES privpass1`, then here:",
    "   snmpget -v3 -u u1 -l authPriv -a SHA -A authpass1 -x AES -X privpass1 192.168.100.1 sysName.0",
    "9. SNMPv1 traps: on S1 `sudo config snmptrap modify 1 192.168.100.250` → snmptrapd -l shows 'TRAP, SNMP v1'",
  ]);
  api.finish("SNMP Lab — NMS polling S1/S2/S3 + traps", t.nms);
});
