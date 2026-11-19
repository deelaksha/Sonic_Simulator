/**
 * QoS / bandwidth lab: two senders converge on one 1G egress port.
 *
 *   H1 192.168.1.10 ── Ethernet0 ┐
 *                                 S1 (25G ports, routed) ── Ethernet2 ── H3 192.168.3.10
 *   H2 192.168.2.10 ── Ethernet1 ┘                          (H3 NIC is 1G → 1G link)
 *
 * Host NICs are 1G, so H1 + H2 offer 2G into S1 Ethernet2 (1G): a 2:1
 * congestion point. S1 classifies with a DSCP->TC map on the ingress ports
 * (the HwSKU default maps every DSCP to TC 0, qos.json.j2:75), so AF11 (DSCP 10,
 * iperf3 -S 40) lands in queue 1 and EF (DSCP 46, -S 184) in queue 5. Ethernet2
 * keeps the default DWRR weights (q1 = 2, q5 = 10). A WRED profile and a strict
 * scheduler policy are pre-created but not bound, for the student to apply.
 */
import { registerLab } from "./registry";

registerLab("qos", (api) => {
  api.newLab();
  const s1 = api.addDevice("switch", { x: 380, y: 200 }, 4);
  const h1 = api.addDevice("pc", { x: 80, y: 80 });
  const h2 = api.addDevice("pc", { x: 80, y: 340 });
  const h3 = api.addDevice("server", { x: 700, y: 200 });
  [["S1", s1], ["H1", h1], ["H2", h2], ["H3", h3]].forEach(([n, id]) => api.rename(id, n));
  api.setPortSpeed(s1, 25000);
  const ip = (d: string, i: number, a: string) => api.setInterfaceIp(d, `${d}-if${i}`, a, 24);
  ip(s1, 0, "192.168.1.1");
  ip(s1, 1, "192.168.2.1");
  ip(s1, 2, "192.168.3.1");
  ip(h1, 0, "192.168.1.10");
  ip(h2, 0, "192.168.2.10");
  ip(h3, 0, "192.168.3.10");
  api.setDefaultGateway(h1, "192.168.1.1");
  api.setDefaultGateway(h2, "192.168.2.1");
  api.setDefaultGateway(h3, "192.168.3.1");
  api.connect(h1, `${h1}-if0`, s1, `${s1}-if0`);
  api.connect(h2, `${h2}-if0`, s1, `${s1}-if1`);
  api.connect(h3, `${h3}-if0`, s1, `${s1}-if2`);

  api.exec(s1, "exit"); // KLISH → Linux shell for the Click QoS commands
  for (const cmd of [
    "config qos map dscp-tc add LAB-DSCP 10 1",
    "config qos map dscp-tc add LAB-DSCP 26 3",
    "config qos map dscp-tc add LAB-DSCP 46 5",
    "config qos interface bind Ethernet0 dscp-tc LAB-DSCP",
    "config qos interface bind Ethernet1 dscp-tc LAB-DSCP",
    "config qos wred-policy add LAB-WRED green 100 600 20",
    "config qos scheduler-policy add LAB-STRICT 5 strict",
  ]) api.exec(s1, cmd);

  api.hint(s1, [
    "QoS lab — H1 and H2 (1G NICs) converge on S1 Ethernet2 → H3 (1G): 2:1 congestion",
    "Classify: DSCP 10 → TC1 → UC1, DSCP 26 → TC3 → UC3, DSCP 46 → TC5 → UC5 (map LAB-DSCP on Ethernet0/1;",
    "          unmapped DSCPs → TC0: the HwSKU default maps every DSCP to TC 0).  show qos map dscp-tc",
    "0. H3: iperf3 -s                          (server listens in the background)",
    "1. H1: iperf3 -c 192.168.3.10            → ~941 Mbits/sec (the 1G link is the bottleneck)",
    "2. H1: iperf3 -c 192.168.3.10 -S 40 -t 30   then quickly   H2: iperf3 -c 192.168.3.10 -S 184",
    "   → DWRR shares Ethernet2 by weight: UC1 (w2) ≈ 1/6, UC5 (w10) ≈ 5/6 of 1G.",
    "3. UDP over capacity: H1 iperf3 -c 192.168.3.10 -u -b 800M -t 30 ; H2 iperf3 -c 192.168.3.10 -u -b 800M -S 184",
    "   → the UDP receiver reports Lost/Total; queue drops: show queue counters Ethernet2",
    "4. Strict priority: config qos interface bind Ethernet2 scheduler-policy LAB-STRICT (UC5 served first)",
    "5. WRED: config qos interface bind Ethernet2 wred-policy LAB-WRED → early drops, lower show queue watermark",
    "6. PFC (lossless): config pfc priority Ethernet2 3 on, send with -S 104 (DSCP 26): no drops,",
    "   the sender is paused instead → show pfc counters (Tx on Ethernet0/1)",
    "Watch:   show queue counters [Ethernet2]   show queue watermark   show pfc counters",
    "         show interfaces counters (port utilisation)   config interface speed Ethernet2 100",
  ]);
  api.finish("QoS — bandwidth, queues, scheduling, WRED, PFC", s1);
});
