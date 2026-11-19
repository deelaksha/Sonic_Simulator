/**
 * L2 protection + port mirroring lab: one access switch (SW1) with
 *
 *   Ethernet0  Client     VLAN 10, gets its address by DHCP (untrusted)
 *   Ethernet1  Rogue      rogue DHCP server 10.66.66.1 (untrusted port)
 *   Ethernet2  DHCP       legitimate DHCP server 192.168.10.1 (trusted port)
 *   Ethernet3  Attacker   192.168.10.66, broadcast-storm source (storm-control 100 kbps)
 *   Ethernet4  Analyzer   SPAN destination (isolated VLAN 999, sees only mirrored frames)
 *   Ethernet5  SW2        uplink: UDLD, link-state-tracking upstream of Ethernet0
 *   Ethernet6  Collector  routed 10.10.10.1/24 — ERSPAN destination 10.10.10.2
 *
 * The rogue server sits on a lower port than the real one, so without snooping
 * the client's DISCOVER reaches it first and the client takes the rogue lease.
 */
import { registerLab } from "./registry";

registerLab("l2-protect", (api) => {
  api.newLab();
  const sw1 = api.addDevice("switch", { x: 380, y: 220 }, 8);
  const sw2 = api.addDevice("switch", { x: 760, y: 220 }, 8);
  const client = api.addDevice("pc", { x: 80, y: 60 });
  const rogue = api.addDevice("dhcp-server", { x: 80, y: 220 });
  const dhcp = api.addDevice("dhcp-server", { x: 80, y: 380 });
  const attacker = api.addDevice("pc", { x: 260, y: 470 });
  const analyzer = api.addDevice("pc", { x: 500, y: 470 });
  const collector = api.addDevice("server", { x: 380, y: 0 });
  ([["SW1", sw1], ["SW2", sw2], ["Client", client], ["Rogue", rogue], ["DHCP", dhcp], ["Attacker", attacker], ["Analyzer", analyzer], ["Collector", collector]] as const).forEach(
    ([n, id]) => api.rename(id, n),
  );

  const port = (sw: string, i: number) => `${sw}-if${i}`;
  const nic = (h: string) => `${h}-if0`;
  api.setInterfaceIp(rogue, nic(rogue), "10.66.66.1", 24);
  api.setInterfaceIp(dhcp, nic(dhcp), "192.168.10.1", 24);
  api.setInterfaceIp(attacker, nic(attacker), "192.168.10.66", 24);
  api.setInterfaceIp(analyzer, nic(analyzer), "192.168.99.10", 24);
  api.setInterfaceIp(sw1, port(sw1, 6), "10.10.10.1", 24);
  api.setInterfaceIp(collector, nic(collector), "10.10.10.2", 24);
  api.setDefaultGateway(collector, "10.10.10.1");

  [client, rogue, dhcp, attacker, analyzer].forEach((h, i) => api.connect(sw1, port(sw1, i), h, nic(h)));
  api.connect(sw1, port(sw1, 5), sw2, port(sw2, 5));
  api.connect(sw1, port(sw1, 6), collector, nic(collector));
  for (let i = 0; i < 4; i++) api.setAccessVlan(sw1, port(sw1, i), 10);
  api.setAccessVlan(sw1, port(sw1, 4), 999);

  api.runCliScript(sw1, [
    "configure terminal",
    "mirror-session SPAN1",
    "destination Ethernet4 source Ethernet0 direction both",
    "exit",
    "ip dhcp snooping",
    "ip dhcp snooping Vlan10",
    "interface Ethernet 2",
    "ip dhcp snooping trust",
    "exit",
    "interface Ethernet 3",
    "storm-control broadcast 100",
    "exit",
    "udld enable",
    "interface Ethernet 5",
    "udld enable",
    "link state track UPLINK upstream",
    "exit",
    "link state track UPLINK",
    "timeout 10",
    "exit",
    "interface Ethernet 0",
    "link state track UPLINK downstream",
    "exit",
    "errdisable recovery cause udld",
    "errdisable recovery interval 30",
    "end",
  ]);
  api.runCliScript(sw2, ["configure terminal", "udld enable", "interface Ethernet 5", "udld enable", "exit", "end"]);

  api.hint(sw1, [
    "L2 protection lab — SW1: SPAN1 (Ethernet0 → Analyzer), DHCP snooping on Vlan10",
    "(Ethernet2 trusted, Rogue on untrusted Ethernet1), storm-control broadcast 100 kbps",
    "on Ethernet3, UDLD on Ethernet5 ↔ SW2, link state track UPLINK (Ethernet5 → Ethernet0).",
    "1 Mirror:   Analyzer: sudo tcpdump -i eth0 -nn   then Client: dhclient  → the DORA appears",
    "            show mirror-session   |   Click: show mirror_session",
    "2 Snooping: Client: dhclient → 192.168.10.x from DHCP; show ip dhcp snooping binding",
    "            no ip dhcp snooping, dhclient again → the Rogue's 10.66.66.x lease wins",
    "3 Storm:    Attacker: arping -b -c 100 192.168.10.1  → most broadcasts dropped at Ethernet3",
    "            show storm-control   |   show interfaces counters (RX_DRP)",
    "4 UDLD:     show udld neighbors | show udld interface Ethernet5 | show errdisable recovery",
    "5 LST:      SW2: interface Ethernet 5 / shutdown → SW1 Ethernet0 goes down (show link state tracking UPLINK)",
    "6 ERSPAN:   mirror-session ER1 / destination erspan dst-ip 10.10.10.2 src-ip 10.10.10.1 dscp 8 ttl 64",
    "            gre 0x88be source Ethernet3 direction rx  → Collector: sudo tcpdump -i eth0 -nn",
  ]);
  api.finish("L2 protection — SPAN/ERSPAN, storm control, DHCP snooping, UDLD, LST", sw1);
});
