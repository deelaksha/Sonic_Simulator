/**
 * L3 services lab: NAT/NAPT, policy-based routing (FBS), IP SLA-tracked static
 * routes and the ECMP load-share hash on one customer edge.
 *
 *   H1 192.168.1.10 ── Ethernet2 ┐                 ┌ Ethernet0 10.0.12.2 ┐
 *                                S1 ═ two uplinks ═ S2 (ISP)             ├ Ethernet2 203.0.113.1 ── WEB 203.0.113.10
 *   H2 192.168.2.10 ── Ethernet3 ┘ Ethernet0 10.0.12.1/30 (primary, zone 1)
 *                                  Ethernet1 10.0.13.1/30 (backup,  zone 1)
 *
 * S1: NAPT of both LANs to pool INET 100.64.0.1 ports 20000-29999 (inside zone
 * 0 → outside zone 1), a static NAPT 100.64.0.1:8080 → H1:80, a default route
 * via 10.0.12.2 tracked by IP SLA 1 (floating backup via 10.0.13.2, distance
 * 200), and a forwarding policy that sends 192.168.2.0/24 out the second
 * uplink. S2 routes the NAT pool back to S1 the same way (SLA 1 → 10.0.12.1).
 */
import { registerLab } from "./registry";

registerLab("l3-services", (api) => {
  api.newLab();
  const s1 = api.addDevice("switch", { x: 300, y: 200 }, 4);
  const s2 = api.addDevice("switch", { x: 620, y: 200 }, 4);
  const h1 = api.addDevice("pc", { x: 60, y: 100 });
  const h2 = api.addDevice("pc", { x: 60, y: 320 });
  const web = api.addDevice("server", { x: 900, y: 200 });
  [["S1", s1], ["S2", s2], ["H1", h1], ["H2", h2], ["WEB", web]].forEach(([n, id]) => api.rename(id, n));
  for (const s of [s1, s2]) api.setPortSpeed(s, 25000);

  const ip = (dev: string, idx: number, a: string, p: number) => api.setInterfaceIp(dev, `${dev}-if${idx}`, a, p);
  ip(s1, 0, "10.0.12.1", 30);
  ip(s1, 1, "10.0.13.1", 30);
  ip(s1, 2, "192.168.1.1", 24);
  ip(s1, 3, "192.168.2.1", 24);
  ip(s2, 0, "10.0.12.2", 30);
  ip(s2, 1, "10.0.13.2", 30);
  ip(s2, 2, "203.0.113.1", 24);
  ip(h1, 0, "192.168.1.10", 24);
  ip(h2, 0, "192.168.2.10", 24);
  ip(web, 0, "203.0.113.10", 24);
  api.setDefaultGateway(h1, "192.168.1.1");
  api.setDefaultGateway(h2, "192.168.2.1");
  api.setDefaultGateway(web, "203.0.113.1");

  api.connect(s1, `${s1}-if0`, s2, `${s2}-if0`);
  api.connect(s1, `${s1}-if1`, s2, `${s2}-if1`);
  api.connect(h1, `${h1}-if0`, s1, `${s1}-if2`);
  api.connect(h2, `${h2}-if0`, s1, `${s1}-if3`);
  api.connect(web, `${web}-if0`, s2, `${s2}-if2`);

  api.runCliScript(s1, [
    "configure terminal",
    "interface Ethernet 0",
    "nat-zone 1",
    "exit",
    "interface Ethernet 1",
    "nat-zone 1",
    "exit",
    "nat",
    "enable",
    "pool INET 100.64.0.1 20000-29999",
    "binding LAN INET",
    "static tcp 100.64.0.1 8080 192.168.1.10 80",
    "exit",
    "ip sla 1",
    "frequency 5",
    "threshold 2",
    "timeout 2",
    "icmp-echo 10.0.12.2",
    "exit",
    "exit",
    "ip route 0.0.0.0/0 10.0.12.2 track 1",
    "ip route 0.0.0.0/0 10.0.13.2 200",
    "class-map LAN2 match-type fields match-all",
    "match source-address ip 192.168.2.0/24",
    "exit",
    "policy-map PBR-LAN2 type forwarding",
    "class LAN2 priority 10",
    "set ip next-hop 10.0.13.2 priority 10",
    "exit",
    "exit",
    "interface Ethernet 3",
    "service-policy type forwarding in PBR-LAN2",
    "exit",
    "end",
  ]);
  api.runCliScript(s2, [
    "configure terminal",
    "ip sla 1",
    "frequency 5",
    "threshold 2",
    "icmp-echo 10.0.12.1",
    "exit",
    "exit",
    "ip route 100.64.0.0/24 10.0.12.1 track 1",
    "ip route 100.64.0.0/24 10.0.13.1 200",
    "end",
  ]);
  api.hint(s1, [
    "L3 services lab — NAT, policy-based routing, IP SLA tracking, ECMP hashing on S1",
    "Wait ~5 s for IP SLA 1 to come Up: show ip sla → the tracked default route appears in show ip route.",
    "NAT:   H1 ping 203.0.113.10, then show nat translations / show nat statistics (TCP/UDP entries;",
    "       ICMP is translated by the kernel and not listed). tcpdump -i Ethernet2 on S2's side shows",
    "       100.64.0.1 as the source. WEB: nc 100.64.0.1 8080 reaches H1 port 80 (static NAPT).",
    "       clear nat translations flushes the dynamic entries.",
    "PBR:   H2 (192.168.2.0/24) leaves via Ethernet1 although the default route says Ethernet0:",
    "       show service-policy interface Ethernet 3 (packet matches), show policy-map, show class-map.",
    "SLA:   shut S2 Ethernet0 → after 2 failed probes SLA 1 goes Down (show logging), the tracked route",
    "       is withdrawn and the distance-200 backup via 10.0.13.2 takes over; no shutdown restores it.",
    "ECMP:  ip load-share hash ipv4 <field> / no ip load-share hash ipv4 ipv4-l4-src-port; show ip load-share.",
  ]);
  api.finish("L3 services — NAT, PBR, IP SLA", s1);
});
