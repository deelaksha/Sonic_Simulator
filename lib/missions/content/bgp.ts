/** Missions on the BGP lab (lib/labs/bgp-lab.ts: eBGP triangle S1 AS65001 / S2 AS65002 / S3 AS65003, H1 ↔ H3). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** The neighbour's line in FRR's `show ip bgp summary` (empty string if absent). */
const summaryLine = (c: CheckCtx, sw: string, peer: string) =>
  c.shell(sw, "show ip bgp summary").split("\n").find((l) => l.startsWith(`${peer} `)) ?? "";
/** Established = the State/PfxRcd column holds a prefix count, not a state name. */
const established = (c: CheckCtx, sw: string, peer: string) => /\s\d+\s+\d+\s+N\/A$/.test(summaryLine(c, sw, peer));
const adminUp = (c: CheckCtx, dev: string, ifName: string) => c.dev(dev).interfaces.find((i) => i.name === ifName)?.adminState === "up";

registerMission({
  id: "bgp-drain-session",
  labId: "bgp",
  kind: "mission",
  level: "beginner",
  title: "Drain a BGP session for maintenance",
  summary:
    "The S1–S3 link needs maintenance tonight. Before the technician touches the cable, gracefully move H1 → H3 traffic off it by administratively shutting S1's BGP session to S3 — the link itself must stay up — and confirm BGP falls back to the path through AS 65002.",
  objectives: [
    {
      id: "sessions",
      title: "On S1, list the BGP neighbours and confirm both sessions are Established",
      hints: ["`exit` sonic-cli to reach the Linux shell, where FRR's show commands live.", "show ip bgp summary — an Established session shows a prefix count in State/PfxRcd."],
      check: (c) => c.typed("S1", /show ip bgp sum/) && established(c, "S1", "10.0.12.2") && established(c, "S1", "10.0.13.2"),
    },
    {
      id: "paths",
      title: "Look at the two paths S1 knows for 192.168.3.0/24",
      hints: ["show ip bgp 192.168.3.0/24 lists every path with its AS_PATH.", "The direct path (65003) is shorter than the one through S2 (65002 65003), so it wins."],
      check: (c) => c.typed("S1", /show ip bgp( ipv4 unicast)? 192\.168\.3\.0/),
    },
    {
      id: "drained",
      title: "S1's session to 10.0.13.2 is administratively down and 192.168.3.0/24 now goes via S2 — with both link ends still up",
      hints: [
        "Don't shut the interface: BGP has a per-neighbour shutdown that sends a Cease NOTIFICATION.",
        "sonic-cli → configure terminal → router bgp 65001 → neighbor 10.0.13.2 → shutdown",
      ],
      check: (c) =>
        /Idle \(Admin\)/.test(summaryLine(c, "S1", "10.0.13.2")) &&
        c.route("S1", "192.168.3.0/24")?.nextHop === "10.0.12.2" &&
        adminUp(c, "S1", "Ethernet1") &&
        adminUp(c, "S3", "Ethernet0"),
    },
    {
      id: "reach",
      title: "H1 still reaches H3",
      check: (c) => c.ping("H1", "192.168.3.10"),
    },
  ],
  solution: [
    { device: "S1", shell: ["exit", "show ip bgp summary", "show ip bgp 192.168.3.0/24"] },
    { device: "S1", klish: ["configure terminal", "router bgp 65001", "neighbor 10.0.13.2", "shutdown", "end"], waitMs: 3000 },
  ],
  explanation:
    "`neighbor … shutdown` sends a Cease/Administrative Shutdown NOTIFICATION (RFC 4486) and keeps the session Idle (Admin), so S3's routes learned over it are withdrawn at once. BGP then picks the only remaining path to 192.168.3.0/24, AS_PATH 65002 65003 via S2. Draining the session before pulling the cable avoids the blackhole you would get while the hold timer (180 s) waits to notice a silent failure; `no shutdown` brings it back after the maintenance.",
});

registerMission({
  id: "bgp-trouble-remote-as",
  labId: "bgp",
  kind: "troubleshoot",
  level: "intermediate",
  title: "S1–S3 BGP session will not come up",
  summary:
    "S3 was re-provisioned from a template this morning. Since then H1 → H3 traffic takes the long way through S2 and S1's BGP session to S3 refuses to establish. Restore the direct path. S1 is managed by another team — do not change it.",
  inject(api) {
    api.runCliScript(api.deviceId("S3"), ["configure terminal", "router bgp 65003", "neighbor 10.0.13.1", "remote-as 65011", "end"]);
  },
  objectives: [
    {
      id: "established",
      title: "The S1–S3 session is Established on both ends",
      hints: [
        "On S1: show ip bgp neighbors 10.0.13.2 — look at 'Last reset' to see what the peer complained about.",
        "'OPEN Message Error/Bad Peer AS' means one side expects a different AS than the other announces in its OPEN. Compare the AS column of show ip bgp summary on S3 with S1's local AS.",
        "On S3: router bgp 65003 → neighbor 10.0.13.1 → remote-as 65001",
      ],
      check: (c) => established(c, "S1", "10.0.13.2") && established(c, "S3", "10.0.13.1"),
    },
    {
      id: "direct",
      title: "S1 routes 192.168.3.0/24 directly via S3 (10.0.13.2)",
      check: (c) => c.route("S1", "192.168.3.0/24")?.nextHop === "10.0.13.2",
    },
    {
      id: "s1-untouched",
      title: "S1 still expects AS 65003 on that session",
      check: (c) => /^10\.0\.13\.2\s+4\s+65003\s/.test(summaryLine(c, "S1", "10.0.13.2")),
    },
  ],
  solution: [{ device: "S3", klish: ["configure terminal", "router bgp 65003", "neighbor 10.0.13.1", "remote-as 65001", "end"], waitMs: 5000 }],
  explanation:
    "S3 had `remote-as 65011` for neighbor 10.0.13.1, but S1 announces My AS 65001 in its OPEN. A BGP speaker must reject an OPEN whose AS differs from the configured remote-as with NOTIFICATION 2/2 Bad Peer AS (RFC 4271 §6.2), so the session flapped between Active and Idle and S1 only had the path through AS 65002. Correcting remote-as on S3 lets the OPENs match and the shorter AS_PATH 65003 wins again.",
});

registerMission({
  id: "bgp-trouble-network",
  labId: "bgp",
  kind: "troubleshoot",
  level: "beginner",
  title: "H3's subnet vanished from the network",
  summary:
    "Nobody can reach H3 (192.168.3.10) from H1 any more, although every BGP session in the triangle shows Established. Make H3's subnet reachable again.",
  inject(api) {
    api.runCliScript(api.deviceId("S3"), ["configure terminal", "router bgp 65003", "address-family ipv4 unicast", "no network 192.168.3.0/24", "end"]);
  },
  objectives: [
    {
      id: "learned",
      title: "S1 learns 192.168.3.0/24 through BGP",
      hints: [
        "On S1: show ip bgp — which prefixes are in the table? On S2 too?",
        "If nobody has the route, look at its origin: on S3, show ip bgp lists locally originated prefixes with Next Hop 0.0.0.0.",
        "BGP only originates what `network` (or redistribute) tells it: on S3, router bgp 65003 → address-family ipv4 unicast → network 192.168.3.0/24",
      ],
      check: (c) => c.route("S1", "192.168.3.0/24")?.type === "bgp",
    },
    {
      id: "reach",
      title: "H1 reaches H3",
      check: (c) => c.ping("H1", "192.168.3.10"),
    },
  ],
  solution: [{ device: "S3", klish: ["configure terminal", "router bgp 65003", "address-family ipv4 unicast", "network 192.168.3.0/24", "end"], waitMs: 3000 }],
  explanation:
    "S3's `network 192.168.3.0/24` statement had been removed, so S3 no longer originated its host subnet: sessions stayed Established but carried no route for it. BGP advertises only prefixes injected by `network` (when a matching route exists in the RIB) or by redistribution; restoring the statement makes S3 send an UPDATE and both S1 and S2 install the route again.",
});
