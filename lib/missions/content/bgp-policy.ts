/**
 * Missions on the BGP policy lab (lib/labs/bgp-policy-lab.ts): E1 AS65001 dual-homed
 * to ISPA AS65002 (10.0.12.2) and ISPB AS65003 (10.0.13.2), both reaching REMOTE
 * AS65004 (H4 192.168.4.0/24). Everyone redistributes connected.
 */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

const paths = (c: CheckCtx, dev: string, prefix: string) => Number(c.shell(dev, `show ip bgp ${prefix}`).match(/Paths: \((\d+) available/)?.[1] ?? 0);
const advertisedCount = (c: CheckCtx, peer: string) =>
  Number(c.shell("E1", `show ip bgp neighbors ${peer} advertised-routes`).match(/Total number of prefixes (\d+)/)?.[1] ?? 0);
/** REMOTE has a path to E1's LAN through both ISPs. */
const remoteViaBoth = (c: CheckCtx) => {
  const d = c.shell("REMOTE", "show ip bgp 192.168.1.0/24");
  return /^ {2}65002 65001/m.test(d) && /^ {2}65003 65001/m.test(d);
};

registerMission({
  id: "bgp-policy-steer-exits",
  labId: "bgp-policy",
  kind: "mission",
  level: "intermediate",
  title: "Steer both directions onto ISPB",
  summary:
    "ISPA is the expensive link. Make ISPB carry the traffic in both directions — E1's outbound traffic to H4 and REMOTE's return traffic to H1 — while keeping the ISPA session up and its routes available as the backup.",
  objectives: [
    {
      id: "inspect",
      title: "On E1, look at both paths to 192.168.4.0/24 and why one is best",
      hints: ["`exit` sonic-cli, then: show ip bgp 192.168.4.0/24", "Both paths have the same AS_PATH length, so the tie is broken late in the decision process (Older Path / Router ID)."],
      check: (c) => c.typed("E1", /show ip bgp( ipv4 unicast)? 192\.168\.4\.0/) && paths(c, "E1", "192.168.4.0/24") === 2,
    },
    {
      id: "outbound",
      title: "E1 sends traffic for 192.168.4.0/24 via ISPB (10.0.13.2), with the ISPA path still in its table",
      hints: [
        "LOCAL_PREF is the first attribute compared after weight; higher wins and it only matters inside your AS.",
        "Create a route-map that sets local-preference 200 and apply it inbound on the ISPB neighbour.",
        "route-map PREFER-B permit 10 → set local-preference 200 → exit → router bgp 65001 → neighbor 10.0.13.2 → address-family ipv4 unicast → route-map PREFER-B in",
      ],
      check: (c) => c.route("E1", "192.168.4.0/24")?.nextHop === "10.0.13.2" && paths(c, "E1", "192.168.4.0/24") === 2,
    },
    {
      id: "inbound",
      title: "REMOTE sends traffic for 192.168.1.0/24 via ISPB (10.0.34.1), still knowing the ISPA path",
      hints: [
        "You cannot set LOCAL_PREF inside someone else's AS — but you can make the ISPA path look longer.",
        "Prepend your own AS on what you announce to ISPA: route-map with `set as-path prepend 65001 65001`, applied out on neighbor 10.0.12.2.",
        "route-map PREPEND-A permit 10 → set as-path prepend 65001 65001 → exit → router bgp 65001 → neighbor 10.0.12.2 → address-family ipv4 unicast → route-map PREPEND-A out",
      ],
      check: (c) => c.route("REMOTE", "192.168.1.0/24")?.nextHop === "10.0.34.1" && remoteViaBoth(c),
    },
    {
      id: "reach",
      title: "H1 still reaches H4",
      check: (c) => c.ping("H1", "192.168.4.10"),
    },
  ],
  solution: [
    { device: "E1", shell: ["exit", "show ip bgp 192.168.4.0/24"] },
    {
      device: "E1",
      klish: [
        "configure terminal",
        "route-map PREFER-B permit 10",
        "set local-preference 200",
        "exit",
        "route-map PREPEND-A permit 10",
        "set as-path prepend 65001 65001",
        "exit",
        "router bgp 65001",
        "neighbor 10.0.13.2",
        "address-family ipv4 unicast",
        "route-map PREFER-B in",
        "exit",
        "exit",
        "neighbor 10.0.12.2",
        "address-family ipv4 unicast",
        "route-map PREPEND-A out",
        "end",
      ],
      waitMs: 3000,
    },
  ],
  explanation:
    "Outbound and inbound traffic are steered with different tools. LOCAL_PREF (RFC 4271 §5.1.5) is compared before AS_PATH length and is shared by every router inside your AS, so `set local-preference 200` on routes from ISPB makes E1 exit through ISPB. LOCAL_PREF is never sent to eBGP peers, so to influence REMOTE you lengthen the path it sees through ISPA: with two extra 65001 prepends, 65002 65001 65001 65001 loses to 65003 65001. Both ISPA paths stay in the tables, ready if ISPB fails.",
});

registerMission({
  id: "bgp-policy-trouble-prefix-list",
  labId: "bgp-policy",
  kind: "troubleshoot",
  level: "intermediate",
  title: "The internet cannot reach our LAN",
  summary:
    "After security hardened E1's BGP announcements yesterday, H1 can no longer reach H4 — pings time out. Security's requirement still stands: E1 must announce only its LAN, 192.168.1.0/24, to each ISP. Restore connectivity without breaking that rule.",
  inject(api) {
    api.runCliScript(api.deviceId("E1"), [
      "configure terminal",
      "ip prefix-list ONLY-LAN seq 5 permit 192.168.10.0/24",
      "router bgp 65001",
      "neighbor 10.0.12.2",
      "address-family ipv4 unicast",
      "prefix-list ONLY-LAN out",
      "exit",
      "exit",
      "neighbor 10.0.13.2",
      "address-family ipv4 unicast",
      "prefix-list ONLY-LAN out",
      "end",
    ]);
  },
  objectives: [
    {
      id: "remote-learns",
      title: "REMOTE learns 192.168.1.0/24 through both ISPs",
      hints: [
        "Pings need a return path: on REMOTE, show ip bgp 192.168.1.0/24.",
        "On E1: show ip bgp summary — the PfxSnt column — and show ip bgp neighbors 10.0.12.2 (look for an outgoing prefix filter).",
        "show ip prefix-list on E1: the list permits 192.168.10.0/24, not the LAN. Replace the entry: no ip prefix-list ONLY-LAN seq 5 permit 192.168.10.0/24, then ip prefix-list ONLY-LAN seq 5 permit 192.168.1.0/24",
      ],
      check: (c) => remoteViaBoth(c),
    },
    {
      id: "reach",
      title: "H1 reaches H4",
      check: (c) => c.ping("H1", "192.168.4.10"),
    },
    {
      id: "only-lan",
      title: "E1 still announces exactly one prefix to each ISP",
      check: (c) => advertisedCount(c, "10.0.12.2") === 1 && advertisedCount(c, "10.0.13.2") === 1,
    },
  ],
  solution: [
    {
      device: "E1",
      klish: ["configure terminal", "no ip prefix-list ONLY-LAN seq 5 permit 192.168.10.0/24", "ip prefix-list ONLY-LAN seq 5 permit 192.168.1.0/24", "end"],
      waitMs: 3000,
    },
  ],
  explanation:
    "Both ISP neighbours had `prefix-list ONLY-LAN out`, but the list's only entry permitted 192.168.10.0/24 — a typo. A prefix-list ends with an implicit deny, so E1 announced nothing at all; H1's pings reached H4, but REMOTE had no route back to 192.168.1.0/24. Fixing the entry makes FRR re-run the outbound policy and announce exactly the LAN, which satisfies the security rule and restores the return path.",
});

registerMission({
  id: "bgp-policy-trouble-community",
  labId: "bgp-policy",
  kind: "troubleshoot",
  level: "advanced",
  title: "Both ISPs have our route, the remote site does not",
  summary:
    "A new outbound route-map was rolled out on E1 last night. H1 can no longer reach H4. Both ISPs confirm they receive 192.168.1.0/24 from us, yet REMOTE says it never sees it. Restore reachability through both ISPs.",
  inject(api) {
    api.runCliScript(api.deviceId("E1"), [
      "configure terminal",
      "route-map TO-ISP permit 10",
      "set community no-export",
      "exit",
      "router bgp 65001",
      "neighbor 10.0.12.2",
      "address-family ipv4 unicast",
      "route-map TO-ISP out",
      "exit",
      "exit",
      "neighbor 10.0.13.2",
      "address-family ipv4 unicast",
      "route-map TO-ISP out",
      "end",
    ]);
  },
  objectives: [
    {
      id: "remote-learns",
      title: "REMOTE learns 192.168.1.0/24 through both ISPs",
      hints: [
        "On ISPA: show ip bgp 192.168.1.0/24 — read the 'Paths:' line and the attributes of the path.",
        "'not advertised to EBGP peer' plus 'Community: no-export' — a well-known community tells the ISP to keep the route to itself. Where was it attached? On E1: show route-map.",
        "On E1: route-map TO-ISP permit 10 → no set community",
      ],
      check: (c) => remoteViaBoth(c),
    },
    {
      id: "reach",
      title: "H1 reaches H4",
      check: (c) => c.ping("H1", "192.168.4.10"),
    },
  ],
  solution: [{ device: "E1", klish: ["configure terminal", "route-map TO-ISP permit 10", "no set community", "end"], waitMs: 3000 }],
  explanation:
    "The route-map TO-ISP tagged everything E1 announced with the well-known community NO_EXPORT. RFC 1997 says a route carrying NO_EXPORT must not be advertised outside the receiving AS, so ISPA and ISPB installed it but never passed it on to REMOTE, which had no return path to H1. Removing the `set community` (or tagging with a regular community such as 65001:100) lets the ISPs propagate the route again.",
});
