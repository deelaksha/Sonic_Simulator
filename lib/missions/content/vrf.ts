/** Missions on the VRF lab (lib/labs/vrf-lab.ts: routed triangle; S1 Ethernet1 + Ethernet2 in Vrf-red with a static route to H3, Ethernet0 to S2 in default). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";
import { vrfOf } from "../../models/vrf";

/** VRF an interface of a switch is bound to ("default" if none). */
const vrfOfIf = (c: CheckCtx, sw: string, ifname: string) => {
  const d = c.dev(sw);
  return vrfOf(d, d.interfaces.find((i) => i.name === ifname));
};
/** A static route for prefix via next hop exists in that VRF's table. */
const hasStatic = (c: CheckCtx, sw: string, prefix: string, nh: string, vrf: string) => {
  const [dst, len] = prefix.split("/");
  return c.dev(sw).routingTable.some((r) => r.destination === dst && r.prefix === Number(len) && r.type === "static" && r.nextHop === nh && (r.vrf ?? "default") === vrf);
};

registerMission({
  id: "vrf-extend-tenant",
  labId: "vrf",
  kind: "mission",
  level: "beginner",
  title: "Bring S2 into the red tenant",
  summary:
    "H1 lives in Vrf-red on S1 and reaches H3, but S2 (10.0.12.2) is invisible to it because S1's link to S2 is in the default VRF. Extend Vrf-red over S1's Ethernet0 so H1 can reach S2, and keep H1 ↔ H3 working.",
  objectives: [
    {
      id: "inspect",
      title: "On S1, list the VRFs and the routing table of Vrf-red",
      hints: [
        "In the Linux shell (`exit` from sonic-cli): `show vrf` lists each VRF and its interfaces.",
        "`show ip route vrf Vrf-red` shows only the routes of that VRF; plain `show ip route` is the default VRF.",
      ],
      check: (c) => c.typed("S1", /show (ip )?vrf/) && c.typed("S1", /show ip route vrf/),
    },
    {
      id: "isolated",
      title: "Confirm H1 cannot reach S2 (10.0.12.2) today",
      hints: ["From H1: ping 10.0.12.2 — S1 looks the destination up in Vrf-red, which has no route to 10.0.12.0/30."],
      check: (c) => c.typed("H1", /ping .*10\.0\.12\.2/),
    },
    {
      id: "member",
      title: "S1's Ethernet0 is a member of Vrf-red",
      hints: ["sonic-cli → configure terminal → interface Ethernet 0 → ip vrf forwarding Vrf-red", "Then `show ip route vrf Vrf-red` lists 10.0.12.0/30 as connected."],
      check: (c) => vrfOfIf(c, "S1", "Ethernet0") === "Vrf-red" && vrfOfIf(c, "S1", "Ethernet2") === "Vrf-red",
    },
    {
      id: "reach-s2",
      title: "H1 reaches S2 (10.0.12.2) and still reaches H3",
      hints: [
        "The request now gets to S2, but does S2 know how to send the reply back to 192.168.1.0/24? Look at `show ip route` on S2.",
        "S2: configure terminal → ip route 192.168.1.0/24 10.0.12.1",
      ],
      check: (c) => c.ping("H1", "10.0.12.2") && c.ping("H1", "192.168.3.10"),
    },
  ],
  solution: [
    { device: "S1", shell: ["exit", "show vrf", "show ip route vrf Vrf-red"] },
    { device: "H1", shell: ["ping -c 1 10.0.12.2"] },
    { device: "S1", klish: ["configure terminal", "interface Ethernet 0", "ip vrf forwarding Vrf-red", "end"] },
    { device: "S2", klish: ["configure terminal", "ip route 192.168.1.0/24 10.0.12.1", "end"], waitMs: 2000 },
  ],
  explanation:
    "A VRF is a separate routing table: S1 looks up packets arriving on a Vrf-red interface only in Vrf-red, and an interface's connected subnet lands in the table of the VRF it is bound to. Binding Ethernet0 put 10.0.12.0/30 into Vrf-red, so S1 could forward H1's packets to S2. S2 itself has no VRFs, but it needs a return route to 192.168.1.0/24 — routing is per direction, and isolation in a VRF never replaces the far end's knowledge of how to get back.",
});

registerMission({
  id: "vrf-trouble-membership",
  labId: "vrf",
  kind: "troubleshoot",
  level: "beginner",
  title: "H1 cut off from H3",
  summary:
    "After a change on S1 last night, H1 (192.168.1.10) can no longer reach H3 (192.168.3.10). H1 still answers pings from its gateway. Restore connectivity; the tenant must stay isolated from the default VRF.",
  inject(api) {
    api.runCliScript(api.deviceId("S1"), ["configure terminal", "ip vrf Vrf-Red", "interface Ethernet 1", "ip vrf forwarding Vrf-Red", "end"]);
  },
  objectives: [
    {
      id: "reach",
      title: "H1 reaches H3",
      hints: [
        "traceroute from H1 dies right after the first hop, so S1 has a problem forwarding. Which table does S1 use for H1's packets?",
        "In S1's Linux shell compare `show vrf` with `show ip route vrf all` — where is the connected 10.0.13.0/30 that the static route's next hop needs?",
        "Ethernet1 is bound to a VRF named `Vrf-Red` (capital R), not `Vrf-red`. Bind it to Vrf-red (interface Ethernet 1 → ip vrf forwarding Vrf-red) and delete the stray VRF.",
      ],
      check: (c) => c.ping("H1", "192.168.3.10"),
    },
    {
      id: "isolated",
      title: "H1's LAN and the uplink to S3 are both in Vrf-red, and H1 still cannot reach S2",
      check: (c) => vrfOfIf(c, "S1", "Ethernet1") === "Vrf-red" && vrfOfIf(c, "S1", "Ethernet2") === "Vrf-red" && vrfOfIf(c, "S1", "Ethernet0") === "default" && !c.ping("H1", "10.0.12.2"),
    },
  ],
  solution: [{ device: "S1", klish: ["configure terminal", "interface Ethernet 1", "ip vrf forwarding Vrf-red", "exit", "no ip vrf Vrf-Red", "end"], waitMs: 2000 }],
  explanation:
    "Ethernet1 had been bound to a new VRF `Vrf-Red` — VRF names are case-sensitive, so this was a second, empty routing table. Vrf-red lost its connected 10.0.13.0/30, its static route to 192.168.3.0/24 via 10.0.13.2 could no longer resolve its next hop, and the uplink's addresses lived in a VRF that no host used. `show vrf` lists both VRFs side by side; binding Ethernet1 back to Vrf-red returns the connected subnet to the right table and the static route resolves again.",
});

registerMission({
  id: "vrf-trouble-static",
  labId: "vrf",
  kind: "troubleshoot",
  level: "intermediate",
  title: "Route re-entered, still no traffic",
  summary:
    "After a colleague cleaned up S1's static routes, H1 (192.168.1.10) can no longer reach H3's LAN (192.168.3.0/24). He says he re-entered the route to 192.168.3.0/24 via 10.0.13.2 exactly as it was. Restore H1 ↔ H3 without changing S3 or the VRF membership of S1's interfaces.",
  inject(api) {
    api.runCliScript(api.deviceId("S1"), ["configure terminal", "no ip route vrf Vrf-red 192.168.3.0/24 10.0.13.2", "ip route 192.168.3.0/24 10.0.13.2", "end"]);
  },
  objectives: [
    {
      id: "reach",
      title: "H1 reaches H3 (192.168.3.10)",
      hints: [
        "H1 is attached to Ethernet2. Which VRF is Ethernet2 in (`show vrf` in S1's Linux shell), and which table holds a route to 192.168.3.0/24 (`show ip route vrf Vrf-red`)?",
        "A plain `ip route …` goes into the default VRF — where 10.0.13.2 is not even a connected next hop (compare `show ip route` and `show ip route vrf all`), so it was never installed.",
        "Configure the route inside the VRF: `ip route vrf Vrf-red 192.168.3.0/24 10.0.13.2` (and remove the useless global one).",
      ],
      check: (c) => c.ping("H1", "192.168.3.10"),
    },
    {
      id: "in-vrf",
      title: "The route to 192.168.3.0/24 lives in Vrf-red and the interfaces are unchanged",
      check: (c) =>
        hasStatic(c, "S1", "192.168.3.0/24", "10.0.13.2", "Vrf-red") &&
        vrfOfIf(c, "S1", "Ethernet1") === "Vrf-red" &&
        vrfOfIf(c, "S1", "Ethernet2") === "Vrf-red" &&
        vrfOfIf(c, "S1", "Ethernet0") === "default",
    },
  ],
  solution: [{ device: "S1", klish: ["configure terminal", "no ip route 192.168.3.0/24 10.0.13.2", "ip route vrf Vrf-red 192.168.3.0/24 10.0.13.2", "end"], waitMs: 2000 }],
  explanation:
    "The static route had been re-entered without `vrf Vrf-red`, so it went into the default table — where its next hop 10.0.13.2 is not reachable at all, because Ethernet1 is a Vrf-red interface. Packets from H1 arrive on Ethernet2, also in Vrf-red, and are looked up only in Vrf-red; the default table is never consulted. Every VRF has its own RIB and FIB and resolves next hops only within itself, so per-VRF statics must name the VRF (`ip route vrf <name> …`), and `show ip route vrf Vrf-red` is the table that matters for the tenant.",
});
