/** Missions on the OSPF lab (lib/labs/ospf-lab.ts: S1/S2/S3 triangle, H1 ↔ H3, cost 4 per link). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** Number of Full adjacencies in FRR's `show ip ospf neighbor` (state column "Full/…"). */
const fullNeighbors = (c: CheckCtx, sw: string) => (c.shell(sw, "show ip ospf neighbor").match(/\bFull\//g) ?? []).length;
const hasNeighbor = (c: CheckCtx, sw: string, rid: string) => new RegExp(`^${rid.replace(/\./g, "\\.")}\\s+\\d+\\s+Full/`, "m").test(c.shell(sw, "show ip ospf neighbor"));

registerMission({
  id: "ospf-cost-steering",
  labId: "ospf",
  kind: "mission",
  level: "beginner",
  title: "Steer traffic with OSPF cost",
  summary:
    "H1 reaches H3 over the direct S1–S3 link. Make S1 send traffic for 192.168.3.0/24 through S2 instead — without shutting any link — and keep the S1–S3 link as the backup.",
  objectives: [
    {
      id: "adjacencies",
      title: "On S1, list the OSPF neighbours and confirm both are Full",
      hints: ["Switches start in sonic-cli; `exit` to the Linux shell, where the FRR show commands live.", "show ip ospf neighbor"],
      check: (c) => c.typed("S1", /show ip ospf nei/) && fullNeighbors(c, "S1") === 2,
    },
    {
      id: "path",
      title: "Find the path H1 → H3 takes today",
      hints: ["Run traceroute from H1 to 192.168.3.10 — each hop is one router."],
      check: (c) => c.typed("H1", /traceroute\s+192\.168\.3\.10/),
    },
    {
      id: "via-s2",
      title: "S1 routes 192.168.3.0/24 via S2 (10.0.12.2) while S1–S3 stays Full",
      hints: [
        "OSPF picks the lowest total cost. Today: S1→S3 = 4 + 4, S1→S2→S3 = 4 + 4 + 4.",
        "Raise the cost of S1's link towards S3 (Ethernet1) above 8.",
        "sonic-cli → configure terminal → interface Ethernet 1 → ip ospf cost 100",
      ],
      check: (c) => c.route("S1", "192.168.3.0/24")?.nextHop === "10.0.12.2" && hasNeighbor(c, "S1", "3.3.3.3"),
    },
    {
      id: "reach",
      title: "H1 still reaches H3",
      check: (c) => c.ping("H1", "192.168.3.10"),
    },
  ],
  solution: [
    { device: "S1", shell: ["exit", "show ip ospf neighbor"] },
    { device: "H1", shell: ["traceroute 192.168.3.10"] },
    { device: "S1", klish: ["configure terminal", "interface Ethernet 1", "ip ospf cost 100", "end"], waitMs: 2000 },
  ],
  explanation:
    "OSPF installs the path with the lowest sum of interface costs. FRR's auto-cost gives a 25G link cost 4, so the direct S1→S3 path (8) beat S1→S2→S3 (12). With Ethernet1 at cost 100 the direct path costs 104, so SPF now prefers S2.\nThe adjacency to S3 is untouched: cost only changes route selection, so if the S1–S2 link fails S1 falls back to the direct link immediately.",
});

registerMission({
  id: "ospf-trouble-hello",
  labId: "ospf",
  kind: "troubleshoot",
  level: "beginner",
  title: "S1 and S2 stopped talking",
  summary:
    "After last night's change window, S1 and S2 are no longer OSPF neighbours. Traffic between the hosts still flows, but the fabric has lost its redundancy. Find out why and fix it without changing S1.",
  inject(api) {
    api.runCliScript(api.deviceId("S2"), ["configure terminal", "interface Ethernet 0", "ip ospf hello-interval 5", "end"]);
  },
  objectives: [
    {
      id: "adjacent",
      title: "S1 and S2 are Full OSPF neighbours again",
      hints: [
        "Compare the OSPF settings of the two ends of the link: show ip ospf interface Ethernet0 on S1 and on S2.",
        "Hello and dead intervals must match on both ends or the Hellos are ignored.",
      ],
      check: (c) => hasNeighbor(c, "S1", "2.2.2.2") && hasNeighbor(c, "S2", "1.1.1.1"),
    },
    {
      id: "redundant",
      title: "S2 learns H1's subnet (192.168.1.0/24) through OSPF",
      check: (c) => c.route("S2", "192.168.1.0/24")?.type === "ospf",
    },
  ],
  solution: [{ device: "S2", klish: ["configure terminal", "interface Ethernet 0", "no ip ospf hello-interval", "end"], waitMs: 15000 }],
  explanation:
    "S2's Ethernet0 had `ip ospf hello-interval 5` while S1 used the default 10 s. OSPF routers only accept a Hello whose hello and dead intervals match their own (RFC 2328 §10.5), so each side dropped the other's Hellos and the adjacency never left Down. `show ip ospf interface` shows the timers on each side; removing the override restores the default and the adjacency comes up after the next Hello exchange.",
});

registerMission({
  id: "ospf-trouble-passive",
  labId: "ospf",
  kind: "troubleshoot",
  level: "beginner",
  title: "H1 → H3 takes a detour",
  summary:
    "Since this morning, traceroute from H1 to H3 shows an extra hop through S2, although the direct S1–S3 link is up and error-free. Bring the traffic back onto the direct link. S1 is not to be changed, and the host-facing ports must stay silent towards the hosts.",
  inject(api) {
    api.runCliScript(api.deviceId("S3"), ["configure terminal", "router ospf", "passive-interface Ethernet0", "end"]);
  },
  objectives: [
    {
      id: "adjacent",
      title: "S1 and S3 are Full OSPF neighbours",
      hints: [
        "show ip ospf neighbor on S1: S3 (3.3.3.3) is missing; the link itself is up.",
        "show ip ospf interface Ethernet0 on S3 — look at the line under the timer intervals.",
        "'No Hellos (Passive interface)': on S3, router ospf → no passive-interface Ethernet0",
      ],
      check: (c) => hasNeighbor(c, "S1", "3.3.3.3") && hasNeighbor(c, "S3", "1.1.1.1"),
    },
    {
      id: "direct",
      title: "S1 routes 192.168.3.0/24 directly via S3 (10.0.13.2)",
      check: (c) => c.route("S1", "192.168.3.0/24")?.nextHop === "10.0.13.2",
    },
    {
      id: "hosts-passive",
      title: "S3's host port Ethernet2 is still passive",
      check: (c) => /No Hellos \(Passive interface\)/.test(c.shell("S3", "show ip ospf interface Ethernet2")),
    },
  ],
  solution: [{ device: "S3", klish: ["configure terminal", "router ospf", "no passive-interface Ethernet0", "end"], waitMs: 15000 }],
  explanation:
    "S3 had `passive-interface Ethernet0` on its link to S1. A passive interface still advertises its subnet but sends and accepts no Hellos, so no adjacency can form over it (FRR ospfd; RFC 2328 needs the Hello exchange first). SPF then only saw the path S1→S2→S3 (cost 12). Removing the passive flag lets Hellos flow again, the adjacency reaches Full and the direct path (cost 8) wins; Ethernet2 stays passive because nothing on the host side should ever become a neighbour.",
});
