/**
 * LACP feature lab: two SONiC switches bonded by a 2-member PortChannel (LACP
 * fast rate), two hosts behind each switch, everything in VLAN 10.
 *
 *   H1 192.168.10.11 ─ Ethernet2 ┐                                 ┌ Ethernet2 ─ H3 192.168.10.13
 *                                S1 ═ Ethernet0+Ethernet1 = PortChannel1 ═ S2
 *   H2 192.168.10.12 ─ Ethernet3 ┘                                 └ Ethernet3 ─ H4 192.168.10.14
 *
 * Configured through KLISH (interface.xml): `interface PortChannel 1` → `fast_rate`
 * → `switchport access Vlan 10`, and `channel-group 1` on Ethernet0/1.
 */
import { registerLab, LabApi } from "./registry";

export interface LacpLab {
  s1: string;
  s2: string;
  hosts: string[];
}

export function buildLacpLab(api: LabApi): LacpLab {
  api.newLab();
  const s1 = api.addDevice("switch", { x: 260, y: 160 }, 4);
  const s2 = api.addDevice("switch", { x: 620, y: 160 }, 4);
  const hosts = [
    api.addDevice("pc", { x: 60, y: 60 }),
    api.addDevice("pc", { x: 60, y: 300 }),
    api.addDevice("pc", { x: 820, y: 60 }),
    api.addDevice("pc", { x: 820, y: 300 }),
  ];
  api.rename(s1, "S1");
  api.rename(s2, "S2");
  hosts.forEach((h, i) => {
    api.rename(h, `H${i + 1}`);
    api.setInterfaceIp(h, `${h}-if0`, `192.168.10.${11 + i}`, 24);
  });
  for (const s of [s1, s2]) api.setPortSpeed(s, 25000);
  api.connect(s1, `${s1}-if0`, s2, `${s2}-if0`);
  api.connect(s1, `${s1}-if1`, s2, `${s2}-if1`);
  api.connect(hosts[0], `${hosts[0]}-if0`, s1, `${s1}-if2`);
  api.connect(hosts[1], `${hosts[1]}-if0`, s1, `${s1}-if3`);
  api.connect(hosts[2], `${hosts[2]}-if0`, s2, `${s2}-if2`);
  api.connect(hosts[3], `${hosts[3]}-if0`, s2, `${s2}-if3`);
  for (const s of [s1, s2]) {
    api.runCliScript(s, [
      "configure terminal",
      "vlan 10",
      "interface PortChannel 1",
      "fast_rate",
      "switchport access Vlan 10",
      "exit",
      "interface Ethernet 0",
      "channel-group 1",
      "exit",
      "interface Ethernet 1",
      "channel-group 1",
      "exit",
      "interface Ethernet 2",
      "switchport access Vlan 10",
      "exit",
      "interface Ethernet 3",
      "switchport access Vlan 10",
      "exit",
      "end",
    ]);
  }
  return { s1, s2, hosts };
}

registerLab("lacp", (api) => {
  const t = buildLacpLab(api);
  api.hint(t.s1, [
    "LACP lab — PortChannel1 = Ethernet0 + Ethernet1 between S1 and S2 (LACP fast rate, VLAN 10)",
    "LACPDUs every 1 s (fast); members are Selected/Collecting/Distributing within ~3 s.",
    "Watch:   show PortChannel summary   |   show interface PortChannel 1",
    "Click:   exit → show interfaces portchannel   (teamshow: Ethernet0(S) Ethernet1(S))",
    "Packets: tcpdump -i Ethernet0 -nn -v ether proto 0x8809   (LACPv1, length 110)",
    "Try:     ping between H1..H4 (different flows hash onto different members),",
    "         delete one S1–S2 cable: traffic moves to the other member, LAG stays up;",
    "         delete both: PortChannel1 goes down. min-links 2 under interface PortChannel 1",
    "         brings it down as soon as one member fails.",
  ]);
  api.finish("LACP — PortChannel with two members", t.s1);
});
