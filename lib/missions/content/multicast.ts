/** Missions on the multicast lab (lib/labs/multicast-lab.ts: sender H1 behind S1, static RP 2.2.2.2 on S2, receivers H3/H4/H5 in S3 Vlan30 with IGMPv2 + snooping). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** Packets a host has received for a group (`mcast show` RxPackets column). */
const rx = (c: CheckCtx, host: string, group: string) => {
  const m = c.shell(host, "mcast show").match(new RegExp(`${group.replace(/\./g, "\\.")}\\s+\\d+\\s+(\\d+)`));
  return m ? Number(m[1]) : 0;
};
/** S3 has an IGMP membership for the group on Vlan30. */
const igmpMember = (c: CheckCtx, group: string) => new RegExp(`Vlan30\\s+\\S+\\s+${group.replace(/\./g, "\\.")}\\b`).test(c.klish("S3", "show ip igmp groups"));
/** (S,G) entry for H1's stream in KLISH `show ip pim topology` on a switch. */
const hasSG = (c: CheckCtx, sw: string, group: string) => c.klish(sw, "show ip pim topology").includes(`(192.168.1.10, ${group})`);
/** RP addresses a switch uses (`show ip pim rp-info`). */
const rpOf = (c: CheckCtx, sw: string) => [...c.shell(sw, "show ip pim rp-info").matchAll(/^\s*(\d+\.\d+\.\d+\.\d+)\s+224\.0\.0\.0\/4/gm)].map((m) => m[1]);

registerMission({
  id: "mcast-shared-tree",
  labId: "multicast",
  kind: "mission",
  level: "intermediate",
  title: "Shared tree or shortest path?",
  summary:
    "Get H1's stream to the receivers on S3, find out which path S3 pulls it over, then make S3 keep new streams on the shared tree through the RP (S2) instead of switching to the shortest-path tree.",
  objectives: [
    {
      id: "join",
      title: "H3 joins 239.1.1.1 and S3 sees the membership",
      hints: ["On H3: mcast join 239.1.1.1 (sends an IGMPv2 report).", "On S3: show ip igmp groups"],
      check: (c) => c.typed("S3", /show ip igmp/) && igmpMember(c, "239.1.1.1"),
    },
    {
      id: "stream",
      title: "H1's stream to 239.1.1.1 reaches H3",
      hints: ["On H1: mcast send 239.1.1.1 -c 5 -t 16 — a TTL above 1 lets the routers forward it.", "On H3: mcast show counts what arrived."],
      check: (c) => rx(c, "H3", "239.1.1.1") > 0,
    },
    {
      id: "spt",
      title: "Find the interface S3 receives (192.168.1.10, 239.1.1.1) on",
      hints: [
        "S3: show ip mroute or show ip pim topology — the (*,G) comes from the RP side (Ethernet1), the (S,G) from …?",
        "After the first packet S3 joined the source directly via S1 (Ethernet0): FRR switches to the SPT immediately by default.",
      ],
      check: (c) => c.typed("S3", /show ip (mroute|pim topology)/) && hasSG(c, "S3", "239.1.1.1"),
    },
    {
      id: "rpt",
      title: "Keep new streams on the shared tree: H3 receives 239.2.2.2 while S3 builds no (S,G) for it",
      hints: [
        "PIM's SPT switchover is controlled on the last-hop router with `ip pim spt-threshold`.",
        "S3: configure terminal → ip pim spt-threshold infinity. Existing (S,G) state stays until it times out, so test with a new group.",
        "H3: mcast join 239.2.2.2 · H1: mcast send 239.2.2.2 -c 5 -t 16 · S3: show ip pim topology",
      ],
      check: (c) => rx(c, "H3", "239.2.2.2") > 0 && !hasSG(c, "S3", "239.2.2.2") && /spt-threshold infinity/.test(c.klish("S3", "show running-configuration pim")),
    },
  ],
  solution: [
    { device: "H3", shell: ["mcast join 239.1.1.1"], waitMs: 2000 },
    { device: "S3", klish: ["show ip igmp groups"] },
    { device: "H1", shell: ["mcast send 239.1.1.1 -c 5 -t 16"], waitMs: 3000 },
    { device: "S3", klish: ["show ip mroute"] },
    { device: "S3", klish: ["configure terminal", "ip pim spt-threshold infinity", "end"] },
    { device: "H3", shell: ["mcast join 239.2.2.2"], waitMs: 2000 },
    { device: "H1", shell: ["mcast send 239.2.2.2 -c 5 -t 16"], waitMs: 3000 },
  ],
  explanation:
    "In PIM-SM the last-hop router first joins the shared tree (*,G) towards the RP; the first packets arrive Register-encapsulated at the RP and flow down that tree. By default FRR's last-hop router then joins (S,G) towards the source along the unicast RPF path (S3 → S1), sets the SPT bit and prunes the source off the shared tree (RFC 7761 §4.2.1). `ip pim spt-threshold infinity` disables that switchover, so S3 keeps only (*,G) state and the stream stays on S1 → S2 → S3 — less state on the last-hop router at the cost of a longer path through the RP.",
});

registerMission({
  id: "mcast-trouble-igmp",
  labId: "multicast",
  kind: "troubleshoot",
  level: "beginner",
  title: "Receiver joined, nothing arrives",
  summary:
    "H3 has joined 239.1.1.1, but when H1 streams to that group (mcast send 239.1.1.1 -c 5 -t 16) H3 receives nothing. The PIM neighbours between S1, S2 and S3 are all up. Get the stream to H3.",
  inject(api) {
    api.runCliScript(api.deviceId("S3"), ["configure terminal", "interface Vlan 30", "no ip igmp", "end"]);
    api.exec(api.deviceId("H3"), "mcast join 239.1.1.1");
  },
  objectives: [
    {
      id: "membership",
      title: "S3 knows H3's membership of 239.1.1.1 on Vlan30",
      hints: [
        "Start at the receiver side: does S3 know anyone wants 239.1.1.1? `show ip igmp groups` on S3.",
        "Snooping (`show ip igmp snooping groups`) sees H3's report, but the router does not. Is IGMP running on the SVI? `show running-configuration igmp`.",
        "S3: configure terminal → interface Vlan 30 → ip igmp → ip igmp version 2",
      ],
      check: (c) => igmpMember(c, "239.1.1.1"),
    },
    {
      id: "stream",
      title: "H3 receives H1's stream (send it again after the fix)",
      check: (c) => rx(c, "H3", "239.1.1.1") > 0 && hasSG(c, "S3", "239.1.1.1"),
    },
  ],
  solution: [
    { device: "S3", klish: ["configure terminal", "interface Vlan 30", "ip igmp", "ip igmp version 2", "end"], waitMs: 3000 },
    { device: "H1", shell: ["mcast send 239.1.1.1 -c 5 -t 16"], waitMs: 3000 },
  ],
  explanation:
    "IGMP had been removed from S3's Vlan30, so S3 was no longer the querier and ignored H3's membership reports: no IGMP group, no (*,G) join towards the RP, and the routers had nowhere to send the stream. IGMP snooping still saw the report (it only constrains flooding inside the VLAN), which is why `show ip igmp snooping groups` and `show ip igmp groups` disagreed. With `ip igmp` back on, S3 queries the VLAN, H3 answers, S3 joins the shared tree (RFC 2236, RFC 7761) and the stream flows.",
});

registerMission({
  id: "mcast-trouble-rp",
  labId: "multicast",
  kind: "troubleshoot",
  level: "intermediate",
  title: "The stream never leaves the source",
  summary:
    "H3 has joined 239.1.1.1 and S3 shows the membership, but H1's stream (mcast send 239.1.1.1 -c 5 -t 16) never reaches it. PIM neighbours are up everywhere. Fix it without changing S2 or S3.",
  inject(api) {
    api.runCliScript(api.deviceId("S1"), ["configure terminal", "ip pim rp-address 2.2.2.3", "no ip pim rp-address 2.2.2.2", "end"]);
    api.exec(api.deviceId("H3"), "mcast join 239.1.1.1");
  },
  objectives: [
    {
      id: "rp",
      title: "S1, S2 and S3 agree on the RP 2.2.2.2",
      hints: [
        "S3 has (*,G) state towards the RP. Send the stream and look at the first-hop router: `show ip mroute` on S1 — where does it send the source's packets (Register)?",
        "Compare `show ip pim rp-info` on S1, S2 and S3.",
        "S1 points to 2.2.2.3, an address nobody owns. S1: configure terminal → no ip pim rp-address 2.2.2.3 → ip pim rp-address 2.2.2.2",
      ],
      check: (c) => ["S1", "S2", "S3"].every((s) => rpOf(c, s).join() === "2.2.2.2"),
    },
    {
      id: "stream",
      title: "H3 receives H1's stream (send it again after the fix)",
      check: (c) => rx(c, "H3", "239.1.1.1") > 0,
    },
  ],
  solution: [
    { device: "S1", klish: ["configure terminal", "no ip pim rp-address 2.2.2.3", "ip pim rp-address 2.2.2.2", "end"], waitMs: 2000 },
    { device: "H1", shell: ["mcast send 239.1.1.1 -c 5 -t 16"], waitMs: 3000 },
  ],
  explanation:
    "In PIM-SM the first-hop router Register-encapsulates a new source's packets to the RP it maps the group to, and the last-hop router joins the shared tree towards its own RP mapping. S1 had a mistyped static RP (2.2.2.3), so its Registers went to an address nobody owns, while S3's (*,G) join went to the real RP 2.2.2.2 — the two halves of the tree never met and S3 never learned the source. Every router in the domain must map a group to the same RP (RFC 7761 §4.7); `show ip pim rp-info` on each router exposes the mismatch.",
});
