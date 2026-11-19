/**
 * VRRP feature lab (UI feature id "vrrp"): two SONiC gateways S1/S2 share the
 * virtual IP 192.168.10.1 for host VLAN 10; both uplink over routed /30 links
 * to S3, and OSPF (area 0) carries the routes, so traffic H1 ↔ H2 survives a
 * gateway failure.
 *
 *   H1 192.168.10.100 (gw 192.168.10.1)
 *    |
 *   ACC (L2, VLAN 10)
 *    | Ethernet1                    | Ethernet2
 *   S1 Ethernet0 (Vlan10)          S2 Ethernet0 (Vlan10)
 *      Vlan10 192.168.10.2/24         Vlan10 192.168.10.3/24
 *      vrrp 10 vip .1 priority 120    vrrp 10 vip .1 (priority 100)
 *   S1 Ethernet1 10.0.13.1/30      S2 Ethernet1 10.0.23.1/30
 *          \                           /
 *     10.0.13.2/30 Ethernet0 ── S3 ── Ethernet1 10.0.23.2/30
 *                               | Ethernet2 192.168.20.1/24
 *                              H2 192.168.20.100
 *
 * VRRPv3 (the default), 1 s advertisements: both gateways start as Backup and
 * S1 wins after its Master_Down_Interval (3 × 1 s + skew 0.53 s). ACC is
 * created first so it is the STP root; the only physical loop (ACC-S1-S3-S2)
 * is then cut on a routed S3 port, which STP does not affect.
 */
import { registerLab } from "./registry";

const ospf = (lan: string, uplink: string) => [
  "router ospf", `network ${uplink} area 0`, `network ${lan} area 0`, "passive-interface Vlan10", "exit",
];

export const VRRP_LAB_SCRIPTS: Record<"S1" | "S2" | "S3", string[]> = {
  S1: [
    "configure terminal",
    "interface Vlan 10", "ip address 192.168.10.2/24",
    "vrrp 10 address-family ipv4", "vip 192.168.10.1", "priority 120", "exit", "exit",
    ...ospf("192.168.10.0/24", "10.0.13.0/30"),
    "interface Ethernet 1", "ip ospf network point-to-point",
    "end",
  ],
  S2: [
    "configure terminal",
    "interface Vlan 10", "ip address 192.168.10.3/24",
    "vrrp 10 address-family ipv4", "vip 192.168.10.1", "exit", "exit",
    ...ospf("192.168.10.0/24", "10.0.23.0/30"),
    "interface Ethernet 1", "ip ospf network point-to-point",
    "end",
  ],
  S3: [
    "configure terminal",
    "router ospf", "network 10.0.13.0/30 area 0", "network 10.0.23.0/30 area 0", "network 192.168.20.0/24 area 0", "passive-interface Ethernet2", "exit",
    "interface Ethernet 0", "ip ospf network point-to-point", "exit",
    "interface Ethernet 1", "ip ospf network point-to-point",
    "end",
  ],
};

registerLab("vrrp", (api) => {
  api.newLab();
  const acc = api.addDevice("switch", { x: 230, y: 220 }, 4);
  const h1 = api.addDevice("pc", { x: 40, y: 220 });
  const s1 = api.addDevice("switch", { x: 450, y: 100 }, 4);
  const s2 = api.addDevice("switch", { x: 450, y: 340 }, 4);
  const s3 = api.addDevice("switch", { x: 670, y: 220 }, 4);
  const h2 = api.addDevice("server", { x: 860, y: 220 });
  [["ACC", acc], ["H1", h1], ["S1", s1], ["S2", s2], ["S3", s3], ["H2", h2]].forEach(([n, id]) => api.rename(id, n));

  const ip = (dev: string, idx: number, a: string, p: number) => api.setInterfaceIp(dev, `${dev}-if${idx}`, a, p);
  ip(h1, 0, "192.168.10.100", 24);
  api.setDefaultGateway(h1, "192.168.10.1");
  ip(h2, 0, "192.168.20.100", 24);
  api.setDefaultGateway(h2, "192.168.20.1");
  ip(s1, 1, "10.0.13.1", 30);
  ip(s3, 0, "10.0.13.2", 30);
  ip(s2, 1, "10.0.23.1", 30);
  ip(s3, 1, "10.0.23.2", 30);
  ip(s3, 2, "192.168.20.1", 24);

  api.connect(h1, `${h1}-if0`, acc, `${acc}-if0`);
  api.connect(s1, `${s1}-if0`, acc, `${acc}-if1`);
  api.connect(s2, `${s2}-if0`, acc, `${acc}-if2`);
  api.connect(s1, `${s1}-if1`, s3, `${s3}-if0`);
  api.connect(s2, `${s2}-if1`, s3, `${s3}-if1`);
  api.connect(h2, `${h2}-if0`, s3, `${s3}-if2`);
  for (const i of [0, 1, 2]) api.setAccessVlan(acc, `${acc}-if${i}`, 10);
  for (const s of [s1, s2]) api.setAccessVlan(s, `${s}-if0`, 10);
  api.runCliScript(s1, VRRP_LAB_SCRIPTS.S1);
  api.runCliScript(s2, VRRP_LAB_SCRIPTS.S2);
  api.runCliScript(s3, VRRP_LAB_SCRIPTS.S3);

  api.hint(s1, [
    "VRRP lab — S1 (priority 120) and S2 (100) share gateway VIP 192.168.10.1 (vrid 10, vMAC 00:00:5e:00:01:0a).",
    "Both start as Backup; S1 becomes Master after Master_Down_Interval (3 s + skew 0.53 s):  show vrrp",
    "Details / counters:  show vrrp interface Vlan 10   ·   bash:  show vrrp  |  show vrrp summary",
    "Adverts every 1 s:  sudo tcpdump -i Vlan10 -nn   (VRRPv3, Advertisement, vrid 10, prio 120, intvl 100cs)",
    "From H1:  ping 192.168.10.1   ·   ping 192.168.20.100 (H2 via the Master + OSPF, up after ~10 s)",
    "Fail S1:  interface Ethernet 0 / shutdown  (and Ethernet 1 to take S1 out completely):",
    "  S2 becomes Master ~3.6 s after S1's last advert; its gratuitous ARP moves the vMAC on ACC.",
    "Bring S1 back (no shutdown): it preempts after its own Master_Down_Interval (3.53 s).",
    "Fast handover: on S1 `interface Vlan 10` → `vrrp 10 address-family ipv4` → `shutdown`",
    "  (or `no vrrp 10 address-family ipv4`): S1 sends priority 0, S2 takes over after Skew_Time (0.6 s).",
    "Tracking: in the vrrp sub-mode `track-interface Ethernet 1 weight 30`, then shut Ethernet 1 → S1 advertises 90, S2 takes over.",
    "IPv6: `vrrp 10 address-family ipv6` → `vip 2001:db8:10::1` on S1 and S2 → show vrrp6 (vMAC 00:00:5e:00:02:0a, unsolicited NA).",
  ]);
  api.finish("VRRP Lab — S1 (Master) / S2 (Backup) share gateway 192.168.10.1", s1);
});
