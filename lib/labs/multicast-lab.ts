/**
 * IP multicast lab (UI feature id "multicast"): PIM-SM with a static RP, IGMP on
 * the receiver VLAN and IGMP snooping inside it.
 *
 *   H1 192.168.1.10 (sender)
 *    | Ethernet2 192.168.1.1/24
 *   S1 (FHR) ── Ethernet0 10.0.12.1/30 ── 10.0.12.2/30 Ethernet0 ── S2 (RP, Loopback0 2.2.2.2)
 *    \ Ethernet1 10.0.13.1/30                       Ethernet1 10.0.23.1/30 /
 *     \                                                                  /
 *      10.0.13.2/30 Ethernet0 ── S3 (LHR) ── Ethernet1 10.0.23.2/30
 *                                 | Vlan30 192.168.30.1/24 (ip igmp v2, ip igmp snooping)
 *                Ethernet2 H3 .10 · Ethernet3 H4 .11 · Ethernet4 H5 .12 (non-member)
 *
 * Unicast routing is static, so RPF(S1's source) on S3 is the direct S1 link while
 * RPF(RP) is via S2: the first packet comes down the RPT (S2 → S3), S3 switches
 * to the SPT (FRR default: immediately) and prunes the source off the RPT.
 */
import { registerLab } from "./registry";

const pim = (ifs: string[]) => ifs.flatMap((i) => [`interface ${i}`, "ip pim sparse-mode", "exit"]);

export const MULTICAST_LAB_SCRIPTS: Record<"S1" | "S2" | "S3", string[]> = {
  S1: [
    "configure terminal",
    "ip route 2.2.2.2/32 10.0.12.2",
    "ip route 10.0.23.0/30 10.0.12.2",
    "ip route 192.168.30.0/24 10.0.13.2",
    "ip pim rp-address 2.2.2.2",
    ...pim(["Ethernet 0", "Ethernet 1", "Ethernet 2"]),
    "end",
  ],
  S2: [
    "configure terminal",
    "interface Loopback 0", "ip address 2.2.2.2/32", "ip pim sparse-mode", "exit",
    "ip route 192.168.1.0/24 10.0.12.1",
    "ip route 10.0.13.0/30 10.0.12.1",
    "ip route 192.168.30.0/24 10.0.23.2",
    "ip pim rp-address 2.2.2.2",
    ...pim(["Ethernet 0", "Ethernet 1"]),
    "end",
  ],
  S3: [
    "configure terminal",
    "ip route 2.2.2.2/32 10.0.23.1",
    "ip route 10.0.12.0/30 10.0.23.1",
    "ip route 192.168.1.0/24 10.0.13.1",
    "ip pim rp-address 2.2.2.2",
    ...pim(["Ethernet 0", "Ethernet 1"]),
    "interface Vlan 30",
    "ip address 192.168.30.1/24",
    "ip pim sparse-mode",
    "ip igmp",
    "ip igmp version 2",
    "ip igmp snooping",
    "end",
  ],
};

registerLab("multicast", (api) => {
  api.newLab();
  const s1 = api.addDevice("switch", { x: 220, y: 120 }, 4);
  const s2 = api.addDevice("switch", { x: 640, y: 120 }, 4);
  const s3 = api.addDevice("switch", { x: 430, y: 330 }, 5);
  const h1 = api.addDevice("pc", { x: 20, y: 120 });
  const h3 = api.addDevice("pc", { x: 250, y: 520 });
  const h4 = api.addDevice("pc", { x: 430, y: 540 });
  const h5 = api.addDevice("pc", { x: 610, y: 520 });
  [["S1", s1], ["S2", s2], ["S3", s3], ["H1", h1], ["H3", h3], ["H4", h4], ["H5", h5]].forEach(([n, id]) => api.rename(id, n));

  const ip = (dev: string, idx: number, a: string, p: number) => api.setInterfaceIp(dev, `${dev}-if${idx}`, a, p);
  ip(s1, 0, "10.0.12.1", 30);
  ip(s2, 0, "10.0.12.2", 30);
  ip(s1, 1, "10.0.13.1", 30);
  ip(s3, 0, "10.0.13.2", 30);
  ip(s2, 1, "10.0.23.1", 30);
  ip(s3, 1, "10.0.23.2", 30);
  ip(s1, 2, "192.168.1.1", 24);
  ip(h1, 0, "192.168.1.10", 24);
  api.setDefaultGateway(h1, "192.168.1.1");
  [h3, h4, h5].forEach((h, i) => {
    ip(h, 0, `192.168.30.${10 + i}`, 24);
    api.setDefaultGateway(h, "192.168.30.1");
  });

  api.connect(s1, `${s1}-if0`, s2, `${s2}-if0`);
  api.connect(s1, `${s1}-if1`, s3, `${s3}-if0`);
  api.connect(s2, `${s2}-if1`, s3, `${s3}-if1`);
  api.connect(h1, `${h1}-if0`, s1, `${s1}-if2`);
  [h3, h4, h5].forEach((h, i) => {
    api.connect(h, `${h}-if0`, s3, `${s3}-if${2 + i}`);
    api.setAccessVlan(s3, `${s3}-if${2 + i}`, 30);
  });
  api.runCliScript(s1, MULTICAST_LAB_SCRIPTS.S1);
  api.runCliScript(s2, MULTICAST_LAB_SCRIPTS.S2);
  api.runCliScript(s3, MULTICAST_LAB_SCRIPTS.S3);

  api.hint(s3, [
    "Multicast lab — sender H1 behind S1 (FHR), RP 2.2.2.2 on S2, receivers in S3 Vlan30 (IGMPv2 querier + IGMP snooping).",
    "PIM neighbours come up within a second:  show ip pim neighbor   ·   bash: show ip pim neighbor | show ip pim rp-info",
    "On H3 and H4:  mcast join 239.1.1.1      (IGMPv2 report; H5 stays a non-member)",
    "  S3: show ip igmp groups · show ip igmp snooping groups · bash: show ip pim join  → (*,G) join sent to S2",
    "On H1:  mcast send 239.1.1.1 -c 5 -t 16   (Linux multicast TTL defaults to 1: -t lets it be routed)",
    "  packet 1: S1 Registers it to the RP, S2 decapsulates down the RPT, S3 switches to the SPT (joins S1);",
    "  then S3 sets the SPT bit, prunes (S,G,rpt) at S2, S2 prunes (S,G) and sends Register-Stop to S1.",
    "  bash on S1/S2/S3: show ip mroute  (flags F/T, IIF on S3 moves to Ethernet0)  ·  KLISH: show ip mroute / show ip pim topology",
    "Receivers: mcast show (H3/H4 count the stream, H5 gets nothing)  ·  tcpdump -i eth0 -nn on H3 / H5",
    "On H3: mcast leave 239.1.1.1 → Leave to 224.0.0.2, S3 sends 2 group-specific queries, port pruned from snooping after 2 s.",
  ]);
  api.finish("Multicast Lab — PIM-SM (RP S2), IGMP + snooping on S3 Vlan30", s3);
});
