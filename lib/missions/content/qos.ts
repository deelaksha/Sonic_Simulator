/**
 * Missions on the QoS lab (lib/labs/qos-lab.ts: H1 + H2 (1G) → S1 → Ethernet2 →
 * H3 (1G); DSCP→TC map LAB-DSCP (10→1, 26→3, 46→5) on Ethernet0/1; strict
 * scheduler LAB-STRICT and WRED LAB-WRED pre-created, unbound). The lab leaves
 * S1 at its Linux shell.
 */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";
import { peekFeatureState } from "../../models/feature-state";
import { QueueCounters, classify } from "../../protocols/qos-model";

const queue = (c: CheckCtx, port: string, q: number) => peekFeatureState<QueueCounters>(c.dev("S1"), "qos-queues")?.[port]?.[q];
const strictBound = (c: CheckCtx) => /scheduler policy: LAB-STRICT/.test(c.shell("S1", "show qos interface Ethernet2"));
/** Sender Mbit/s of a 1 s iperf3 TCP test H1 → H3, run on a copy (needs H3's server). */
function h1Mbps(c: CheckCtx): number {
  const m = /0\.00-\S+\s+sec\s+\S+ \S+\s+(\S+) (\w)bits\/sec.*sender/.exec(c.shell("H1", "iperf3 -c 192.168.3.10 -t 1"));
  return m ? Number(m[1]) * ({ K: 1e-3, M: 1, G: 1e3 }[m[2]] ?? 1e-6) : 0;
}

registerMission({
  id: "qos-ef-priority",
  labId: "qos",
  kind: "mission",
  level: "intermediate",
  title: "Give voice traffic priority",
  summary:
    "H1 and H2 both send to H3 through S1's 1G Ethernet2, a 2:1 congestion point. Measure the bottleneck, follow EF-marked traffic (DSCP 46) into its egress queue, give that queue strict priority, and then overload the port to see who gets dropped.",
  objectives: [
    {
      id: "baseline",
      title: "Start an iperf3 server on H3 and measure H1 → H3 TCP throughput",
      hints: ["On H3: `iperf3 -s`. On H1: `iperf3 -c 192.168.3.10`. About 941 Mbit/s of goodput: the 1G link to H3 is the bottleneck."],
      check: (c) => c.typed("H3", /iperf3 -s/) && c.typed("H1", /iperf3 -c 192\.168\.3\.10/),
    },
    {
      id: "ef-queue",
      title: "Send EF traffic (DSCP 46) from H2 and find it in queue UC5 of Ethernet2",
      hints: [
        "iperf3 sets the IP TOS byte with -S. DSCP 46 is TOS 184 (46 × 4): `iperf3 -c 192.168.3.10 -u -b 50M -S 184` on H2.",
        "S1 classifies on ingress with the DSCP→TC map (`show qos map dscp-tc`, `show qos interface Ethernet1`). TC n goes to unicast queue UCn on the egress port.",
        "On S1: `show queue counters Ethernet2`. The EF packets are counted in UC5.",
      ],
      check: (c) => c.typed("S1", /show queue counters/) && (queue(c, "Ethernet2", 5)?.pkts ?? 0) > 0,
    },
    {
      id: "strict",
      title: "Bind the strict-priority scheduler LAB-STRICT (queue 5) to Ethernet2",
      hints: [
        "`show qos scheduler-policy` lists LAB-STRICT. By default Ethernet2 shares bandwidth by DWRR weight.",
        "config qos interface bind Ethernet2 scheduler-policy LAB-STRICT. Check with show qos interface Ethernet2.",
      ],
      check: strictBound,
    },
    {
      id: "congest",
      title: "Overload Ethernet2 with best-effort UDP while EF runs: queue UC0 drops, EF still gets through",
      hints: [
        "On H1: `iperf3 -c 192.168.3.10 -u -b 800M -t 10` (DSCP 0 → UC0). Quickly, on H2: `iperf3 -c 192.168.3.10 -u -b 300M -S 184 -t 5`.",
        "Together that's 1.1G offered into a 1G port. `show queue counters Ethernet2`: strict priority serves UC5 first, so UC0 takes the tail drops. `show interfaces counters` shows Ethernet2 TX_UTIL.",
      ],
      check: (c) => strictBound(c) && (queue(c, "Ethernet2", 0)?.dropPkts ?? 0) > 0 && (queue(c, "Ethernet2", 5)?.pkts ?? 0) > 0,
    },
  ],
  solution: [
    { device: "H3", shell: ["iperf3 -s"] },
    { device: "H1", shell: ["iperf3 -c 192.168.3.10 -t 2"], waitMs: 2500 },
    { device: "H2", shell: ["iperf3 -c 192.168.3.10 -u -b 50M -S 184 -t 2"], waitMs: 2500 },
    { device: "S1", shell: ["show queue counters Ethernet2", "config qos interface bind Ethernet2 scheduler-policy LAB-STRICT"] },
    { device: "H1", shell: ["iperf3 -c 192.168.3.10 -u -b 800M -t 10"], waitMs: 500 },
    { device: "H2", shell: ["iperf3 -c 192.168.3.10 -u -b 300M -S 184 -t 5"], waitMs: 3000 },
    { device: "S1", shell: ["show queue counters Ethernet2"] },
  ],
  explanation:
    "QoS on S1 runs in two stages. On ingress, the port's DSCP→TC map (LAB-DSCP on Ethernet0/1) turns DSCP 46 into traffic class 5. On egress, TC 5 uses unicast queue UC5 of Ethernet2. By default the queues share the port by DWRR weight. Binding LAB-STRICT makes UC5 a strict-priority queue: the scheduler always empties it first and only gives the leftover bandwidth to the DWRR queues. With 1.1G offered into 1G, the 300M of EF went out untouched and best-effort UC0 absorbed the overload as tail drops (`show queue counters` Drop/pkts). A strict queue can starve the others, so it is meant for traffic like voice that is low-rate and policed.",
});

registerMission({
  id: "qos-trouble-trust",
  labId: "qos",
  kind: "troubleshoot",
  level: "intermediate",
  title: "Voice from H2 breaks up under load",
  summary:
    "Voice calls from H2's subnet (192.168.2.0/24) break up whenever the link towards H3 is busy. Calls from H1's subnet are fine. Both phones mark their packets EF (DSCP 46). An iperf3 server is running on H3 for testing.",
  inject(api) {
    api.exec(api.deviceId("S1"), "config qos interface unbind Ethernet1 dscp-tc");
    api.exec(api.deviceId("H3"), "iperf3 -s");
  },
  objectives: [
    {
      id: "h2-ef",
      title: "EF traffic entering on H2's port (Ethernet1) is queued in UC5 of Ethernet2",
      hints: [
        "Reproduce it: on H2, `iperf3 -c 192.168.3.10 -u -b 10M -S 184 -t 2`, then on S1 `show queue counters Ethernet2`. Which queue counted it? Do the same from H1.",
        "Classification happens on the ingress port. Compare `show qos interface Ethernet0` with `show qos interface Ethernet1`.",
        "Without a DSCP→TC map, the HwSKU default puts every DSCP in TC 0. Run config qos interface bind Ethernet1 dscp-tc LAB-DSCP",
      ],
      check: (c) => classify(c.dev("S1"), "Ethernet1", "Ethernet2", 46).queue === 5,
    },
    {
      id: "map-intact",
      title: "The rest of the marking plan still holds: AF11 from H2 → UC1, EF from H1 → UC5",
      check: (c) =>
        classify(c.dev("S1"), "Ethernet1", "Ethernet2", 10).queue === 1 && classify(c.dev("S1"), "Ethernet0", "Ethernet2", 46).queue === 5,
    },
  ],
  solution: [{ device: "S1", shell: ["show qos interface Ethernet1", "config qos interface bind Ethernet1 dscp-tc LAB-DSCP"] }],
  explanation:
    "Ethernet1 (H2's port) had lost its DSCP_TO_TC_MAP binding. SONiC classifies on the ingress port, and a port with no map uses the HwSKU default, which maps every DSCP to TC 0. H2's EF packets therefore landed in best-effort UC0 on Ethernet2 and were dropped along with the bulk traffic whenever the port congested, while H1's EF still reached UC5. `show queue counters Ethernet2` showed it right away. Binding LAB-DSCP to Ethernet1 again restores DSCP 46 → TC 5 → UC5.",
});

registerMission({
  id: "qos-trouble-speed",
  labId: "qos",
  kind: "troubleshoot",
  level: "beginner",
  title: "Backups to H3 crawl at 94 Mbit/s",
  summary:
    "Since last night's maintenance, backups from H1 to H3 run at about 94 Mbit/s. They used to run at about 940 Mbit/s. Nothing changed on the hosts, and an iperf3 server is running on H3 for testing.",
  inject(api) {
    api.exec(api.deviceId("S1"), "config interface speed Ethernet2 100");
    api.exec(api.deviceId("H3"), "iperf3 -s");
  },
  objectives: [
    {
      id: "throughput",
      title: "A TCP iperf3 test from H1 to H3 reaches more than 900 Mbit/s",
      hints: [
        "Run `iperf3 -c 192.168.3.10 -t 10` on H1, and while it runs, `show interfaces counters` on S1. Which port is at 100 % utilisation?",
        "Utilisation is a percentage of the port's speed. `show interfaces status` lists every port's speed.",
        "Ethernet2 is at 100M. Run config interface speed Ethernet2 25000 (the link to H3 then runs at H3's 1G NIC speed).",
      ],
      check: (c) => h1Mbps(c) > 900,
    },
    {
      id: "up",
      title: "Ethernet2 is admin up",
      check: (c) => c.dev("S1").interfaces.find((i) => i.name === "Ethernet2")?.adminState === "up",
    },
  ],
  solution: [{ device: "S1", shell: ["show interfaces status", "config interface speed Ethernet2 25000"] }],
  explanation:
    "Ethernet2 had been forced to 100 Mb/s, so the 1G path H1 → H3 now had a 100M bottleneck: TCP settled at about 94 Mbit/s of goodput, Ethernet2 showed 100 % TX_UTIL in `show interfaces counters`, and the excess queued and dropped there. A link runs at the lower speed of its two ends, so restoring the port speed lets the link run at H3's 1G NIC rate again and TCP climbs back to about 941 Mbit/s.",
});
