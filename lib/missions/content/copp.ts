/**
 * Missions on the CoPP lab (lib/labs/copp-lab.ts: S1 routes H1 192.168.1.10 ⇄
 * H2 192.168.2.10; the IP2ME trap is bound to action group copp-lab-ip2me,
 * policed at 50 pps / 50 packets burst on CPU queue 7). The lab leaves S1 at
 * its Linux shell.
 */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** Drop/pkts of a CPU queue in `show queue counters CPU`. */
const cpuQueueDrops = (c: CheckCtx, q: number) =>
  Number(new RegExp(`^\\s*CPU\\s+MC${q}\\s+\\d+\\s+\\d+\\s+(\\d+)`, "m").exec(c.shell("S1", "show queue counters CPU"))?.[1] ?? 0);
/** IP2ME is still handled by the lab's action group with a packet policer (CIR column filled). */
const ip2mePoliced = (c: CheckCtx) => /^ip2me\s+copp-lab-ip2me\s+trap\s+\d+\s+\d+\s+\w+\s+sr_tcm\s+installed$/m.test(c.shell("S1", "show copp configuration"));
const received = (out: string) => Number(/(\d+) received/.exec(out)?.[1] ?? -1);

registerMission({
  id: "copp-police-ip2me",
  labId: "copp",
  kind: "mission",
  level: "beginner",
  title: "Watch CoPP protect the CPU",
  summary:
    "S1's CPU is protected by control-plane policing: traffic addressed to the switch itself (IP2ME) is limited to 50 packets/s. Flood the switch from H1, find where the excess is dropped, check that routed traffic is unaffected, then tune the policer so a 150-packet burst gets through.",
  objectives: [
    {
      id: "read-policy",
      title: "On S1, find the trap group, CPU queue and policer that IP2ME traffic uses",
      hints: [
        "S1 is already at its Linux shell. The CoPP show commands are `show copp configuration`, `show copp policy` and `show copp actions`.",
        "show copp configuration detailed --trapid ip2me",
      ],
      check: (c) => c.typed("S1", /show copp (configuration|policy|actions)/),
    },
    {
      id: "flood",
      title: "Flood 192.168.1.1 from H1 and find the policer drops in S1's CPU queue counters",
      hints: [
        "On H1, `ping -f -c 500 192.168.1.1` sends a flood at the switch's own address. Note the loss it reports.",
        "Trapped packets go through a CPU queue, not a front-panel port. `show copp counters` counts what arrived per trap, and `show queue counters CPU` shows per-queue drops.",
        "IP2ME uses queue 7 (MC7). Its Drop/pkts column shows the packets the 50 pps policer discarded.",
      ],
      check: (c) => c.typed("S1", /show queue counters/) && cpuQueueDrops(c, 7) > 0,
    },
    {
      id: "transit",
      title: "Show that H1 → H2 traffic routed through S1 still flows",
      hints: ["Ping 192.168.2.10 from H1. Routed packets are forwarded by the ASIC and never reach the CPU, so CoPP doesn't touch them (show copp counters doesn't count them)."],
      check: (c) => c.typed("H1", /ping .*192\.168\.2\.10/) && c.ping("H1", "192.168.2.10"),
    },
    {
      id: "tune",
      title: "Tune copp-lab-ip2me so a 150-packet flood to 192.168.1.1 loses nothing (keep a policer)",
      hints: [
        "The policer is a token bucket: CBS is the burst it absorbs and CIR the refill rate, both in packets.",
        "Change the action group, not the trap: `config copp action set copp-lab-ip2me police cir <n> cbs <n>`.",
        "config copp action set copp-lab-ip2me police cir 500 cbs 500, then on H1 run ping -f -c 150 192.168.1.1",
      ],
      check: (c) => ip2mePoliced(c) && received(c.shell("H1", "ping -f -c 150 192.168.1.1")) === 150,
    },
  ],
  solution: [
    { device: "S1", shell: ["show copp configuration detailed --trapid ip2me"] },
    { device: "H1", shell: ["ping -f -c 500 192.168.1.1"] },
    { device: "S1", shell: ["show copp counters", "show queue counters CPU"] },
    { device: "H1", shell: ["ping -c 3 192.168.2.10"] },
    { device: "S1", shell: ["config copp action set copp-lab-ip2me police cir 500 cbs 500"] },
    { device: "H1", shell: ["ping -f -c 150 192.168.1.1"] },
  ],
  explanation:
    "Everything punted to the CPU goes hostif trap → trap group → policer → CPU queue (copporch). IP2ME is bound to copp-lab-ip2me, an sr_tcm policer with CIR 50 and CBS 50 packets and red action drop. The flood emptied the bucket within the first 50 packets, and from then on only about 50 packets/s were admitted. The rest show up as Drop/pkts on CPU queue MC7, not on any front-panel port. Routed H1 → H2 packets never take the CPU path. With CBS 500 the bucket absorbs a 150-packet burst. You raise CoPP limits only as far as the CPU can safely take, because the policer is what keeps a flood from starving BGP, LACP or ARP.",
});

registerMission({
  id: "copp-trouble-arp",
  labId: "copp",
  kind: "troubleshoot",
  level: "intermediate",
  title: "Hosts lost their gateway after CoPP hardening",
  summary:
    "After a 'CoPP hardening' change on S1, H1 and H2 can no longer reach each other or their default gateways. All links are up and nobody touched the IP addressing. The approved IP2ME policer (copp-lab-ip2me) must stay in place.",
  inject(api) {
    const s1 = api.deviceId("S1");
    for (const cmd of [
      "config copp action add copp-hardening",
      "config copp action set copp-hardening trap-action drop",
      "config copp classifier add copp-hardening",
      "config copp classifier match copp-hardening arp_req",
      "config copp bind copp-hardening copp-hardening",
    ])
      api.exec(s1, cmd);
  },
  objectives: [
    {
      id: "h1-h2",
      title: "H1 can ping H2",
      hints: [
        "Start at a host: ping fails with 'Destination Host Unreachable'. `arp -n` on H1 shows the gateway 192.168.1.1 as (incomplete), so ARP never gets an answer.",
        "ARP requests for the switch's own address are trapped to S1's CPU. Compare `show copp counters` (arp_req arrives) with `show queue counters CPU` (where does it go?).",
        "`show copp configuration`: which trap group handles arp_req now, and with what action? Unbind that classifier (config copp unbind …) or make its action trap/copy.",
      ],
      check: (c) => c.ping("H1", "192.168.2.10"),
    },
    {
      id: "gateway",
      title: "H2 can ping its gateway 192.168.2.1",
      check: (c) => c.ping("H2", "192.168.2.1"),
    },
    {
      id: "ip2me-kept",
      title: "IP2ME is still policed by copp-lab-ip2me",
      check: ip2mePoliced,
    },
  ],
  solution: [{ device: "S1", shell: ["show copp configuration", "config copp unbind copp-hardening"] }],
  explanation:
    "The hardening change bound arp_req to a new action group with trap-action drop. In copporch a trap's action decides what the ASIC does with the matching packet, and drop discards it before the CPU sees it. S1 never answered ARP for 192.168.1.1/192.168.2.1, the hosts' gateway entries stayed incomplete, and nothing could be forwarded. `show copp configuration` shows arp_req in copp-hardening with action drop and the default arp group not-installed. Unbinding the classifier hands arp_req back to the default arp group (copy, 3000 pps), so ARP resolves again.",
});

registerMission({
  id: "copp-trouble-meter",
  labId: "copp",
  kind: "troubleshoot",
  level: "advanced",
  title: "Monitoring says S1 is down",
  summary:
    "The NOC's monitoring marks S1 as DOWN: pings to its gateway address 192.168.1.1 get no reply, and SSH to the switch times out. Users behind S1 report no problems, and H1 ↔ H2 traffic flows. IP2ME traffic must stay policed (copp-lab-ip2me).",
  inject(api) {
    api.exec(api.deviceId("S1"), "config copp action set copp-lab-ip2me meter-type bytes");
  },
  objectives: [
    {
      id: "ping-gw",
      title: "H1 can ping S1's address 192.168.1.1",
      hints: [
        "Transit works and the ping is addressed to the switch itself, so look at the CPU path: `show copp counters` and `show queue counters CPU` while H1 pings 192.168.1.1.",
        "Every ip2me packet is counted in queue 7's Drop/pkts. Read the policer: `show copp configuration detailed --trapid ip2me` and compare it with `show copp actions`.",
        "CIR/CBS 50 means 50 packets only when Meter Type is packets. With bytes, the bucket holds 50 bytes and a 98-byte ping never fits. Run config copp action set copp-lab-ip2me meter-type packets",
      ],
      check: (c) => c.ping("H1", "192.168.1.1"),
    },
    {
      id: "ssh",
      title: "SSH (TCP/22) to 192.168.1.1 connects again",
      hints: ["`nc -zv -w 1 192.168.1.1 22` on H1."],
      check: (c) => /succeeded/.test(c.shell("H1", "nc -zv -w 1 192.168.1.1 22")),
    },
    {
      id: "still-policed",
      title: "IP2ME is still policed by copp-lab-ip2me",
      check: ip2mePoliced,
    },
  ],
  solution: [{ device: "S1", shell: ["show copp configuration detailed --trapid ip2me", "config copp action set copp-lab-ip2me meter-type packets"] }],
  explanation:
    "Someone set copp-lab-ip2me's meter type to bytes, but left CIR/CBS at 50. A SAI policer reads cir/cbs in the unit of its meter_type, so the bucket now held 50 bytes refilled at 50 bytes/s. Every ICMP echo (98 bytes) and TCP SYN to the switch was red and dropped. That's why `show copp counters` counted ip2me packets while queue 7's Drop/pkts rose by the same amount. Transit traffic is forwarded in hardware and never policed, so only the switch itself looked dead. Setting meter-type back to packets makes 50/50 mean packets again.",
});
