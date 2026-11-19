/**
 * Missions on the dual-stack lab (lib/labs/ipv6-lab.ts): routedTriangle with IPv6 on
 * every link, OSPFv3 area 0, H1/H3 autoconfigured by SLAAC from S1/S3 Ethernet2 RAs.
 */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** A host's global (SLAAC) IPv6 address in `prefix`, or "" before it has one. */
const globalAddr = (c: CheckCtx, host: string, prefix: string) => c.dev(host).interfaces[0]?.ipv6.find((a) => a.address.startsWith(prefix))?.address ?? "";
const h1ToH3 = (c: CheckCtx) => {
  const h3 = globalAddr(c, "H3", "2001:db8:3:");
  return h3 !== "" && c.ping6("H1", h3);
};
const route6 = (c: CheckCtx, sw: string, dest: string) => c.dev(sw).routingTable6.find((r) => r.destination === dest && r.prefix === 64 && r.type === "ospf");
const ospf6Full = (c: CheckCtx, sw: string, rid: string) => new RegExp(`^${rid.replace(/\./g, "\\.")}\\s+\\d+\\s+\\S+\\s+Full/`, "m").test(c.shell(sw, "show ipv6 ospf6 neighbor"));

registerMission({
  id: "ipvx-steer-v6",
  labId: "ipvx",
  kind: "mission",
  level: "beginner",
  title: "Follow an IPv6 packet and steer it",
  summary:
    "Find how H1 got its IPv6 address, prove it reaches H3 over IPv6, then make S1 send IPv6 traffic for H3's subnet (2001:db8:3::/64) through S2 instead of the direct link — without breaking the S1–S3 OSPFv3 adjacency.",
  objectives: [
    {
      id: "slaac",
      title: "On H1, look at its IPv6 addresses",
      hints: ["ip -6 addr — the global address was built by SLAAC from S1's Router Advertisement (prefix + EUI-64 of the MAC).", "ip -6 route shows the default route learned from the same RA (proto ra)."],
      check: (c) => c.typed("H1", /ip -6 a/) && globalAddr(c, "H1", "2001:db8:1:") !== "",
    },
    {
      id: "ping6",
      title: "From H1, ping6 an address in H3's subnet 2001:db8:3::/64",
      hints: ["H3's own address: run ip -6 addr on H3. Or ping S3's gateway address 2001:db8:3::1.", "ping6 -c 2 <address>"],
      check: (c) => c.typed("H1", /ping6?\s.*2001:db8:3::/) && h1ToH3(c),
    },
    {
      id: "via-s2",
      title: "S1 routes 2001:db8:3::/64 via S2 (Ethernet0) while its OSPFv3 neighbour S3 stays Full",
      hints: [
        "show ipv6 route on S1: the direct path costs 4 + 4, the path through S2 4 + 4 + 4.",
        "OSPFv3 cost is set per interface, like OSPFv2. Raise it on S1's link to S3 (Ethernet1).",
        "sonic-cli → configure terminal → interface Ethernet 1 → ipv6 ospf6 cost 100",
      ],
      check: (c) => {
        const r = route6(c, "S1", "2001:db8:3::");
        return !!r && c.dev("S1").interfaces.find((i) => i.id === r.interfaceId)?.name === "Ethernet0" && ospf6Full(c, "S1", "3.3.3.3");
      },
    },
    {
      id: "reach",
      title: "H1 still reaches H3 over IPv6",
      check: (c) => h1ToH3(c),
    },
  ],
  solution: [
    { device: "H1", shell: ["ip -6 addr", "ping6 -c 2 2001:db8:3::1"] },
    { device: "S1", klish: ["configure terminal", "interface Ethernet 1", "ipv6 ospf6 cost 100", "end"], waitMs: 3000 },
  ],
  explanation:
    "H1 has no static IPv6 address: S1's Router Advertisements announce 2001:db8:1::/64 and H1 builds its address from that prefix plus its EUI-64 interface ID (RFC 4862), and takes S1's link-local address as default gateway. OSPFv3 (RFC 5340) runs over link-locals but selects paths exactly like OSPFv2: the lowest total cost wins. At cost 100 the direct S1→S3 link sums to 104, so the 12 via S2 wins while the S1–S3 adjacency stays Full as the backup.",
});

registerMission({
  id: "ipvx-trouble-ospf6-interface",
  labId: "ipvx",
  kind: "troubleshoot",
  level: "intermediate",
  title: "IPv6 from H1's subnet is a dead end",
  summary:
    "H1 has its IPv6 address and default route, but ping6 from H1 to H3 fails, and so does ping6 to S3's 2001:db8:3::1. All OSPFv3 adjacencies in the triangle are Full. Fix IPv6 reachability between the two host subnets.",
  inject(api) {
    api.runCliScript(api.deviceId("S1"), ["configure terminal", "interface Ethernet 2", "no ipv6 ospf6 area 0", "end"]);
  },
  objectives: [
    {
      id: "advertised",
      title: "S3 learns H1's subnet 2001:db8:1::/64 through OSPFv3",
      hints: [
        "A ping needs a route in both directions. On S3: show ipv6 route — is 2001:db8:1::/64 there?",
        "show ipv6 ospf6 database: each router advertises its prefixes in Intra-Area-Prefix (INAP) LSAs. Which prefixes does 1.1.1.1 advertise?",
        "S1's host-facing interface is not part of OSPFv3. On S1: interface Ethernet 2 → ipv6 ospf6 area 0",
      ],
      check: (c) => !!route6(c, "S3", "2001:db8:1::"),
    },
    {
      id: "reach",
      title: "H1 reaches H3 over IPv6",
      check: (c) => h1ToH3(c),
    },
  ],
  solution: [{ device: "S1", klish: ["configure terminal", "interface Ethernet 2", "ipv6 ospf6 area 0", "end"], waitMs: 3000 }],
  explanation:
    "S1's Ethernet2 had lost `ipv6 ospf6 area 0`. In OSPFv3 an interface is enabled per interface, and only enabled interfaces contribute their prefixes to the router's Intra-Area-Prefix LSA (RFC 5340 §4.4.3.9), so 2001:db8:1::/64 vanished from everyone else's table even though all adjacencies were Full. H1's packets reached H3, but the replies had no route back. Re-enabling OSPFv3 on the (passive) interface advertises the prefix again.",
});

registerMission({
  id: "ipvx-trouble-ra-prefix",
  labId: "ipvx",
  kind: "troubleshoot",
  level: "intermediate",
  title: "H3 has no IPv6 address",
  summary:
    "H3's owner reports that `ip -6 addr` on H3 shows no global IPv6 address, so nothing can reach H3 over IPv6. Hosts must keep autoconfiguring by SLAAC — no static addresses on H3.",
  inject(api) {
    api.runCliScript(api.deviceId("S3"), ["configure terminal", "interface Ethernet 2", "no ipv6 address 2001:db8:3::1/64", "end"]);
  },
  objectives: [
    {
      id: "slaac",
      title: "H3 autoconfigures an address in 2001:db8:3::/64",
      hints: [
        "SLAAC builds the address from the prefix in the router's Router Advertisement. What does S3 advertise on Ethernet2?",
        "On S3: show ipv6 interfaces — compare Ethernet2 with S1's Ethernet2.",
        "radvd advertises the prefixes of the interface's own addresses. On S3: interface Ethernet 2 → ipv6 address 2001:db8:3::1/64",
      ],
      check: (c) => globalAddr(c, "H3", "2001:db8:3:") !== "",
    },
    {
      id: "reach",
      title: "H1 reaches H3 over IPv6",
      check: (c) => h1ToH3(c),
    },
  ],
  solution: [{ device: "S3", klish: ["configure terminal", "interface Ethernet 2", "ipv6 address 2001:db8:3::1/64", "end"], waitMs: 3000 }],
  explanation:
    "S3's Ethernet2 had lost its global address 2001:db8:3::1/64, so its Router Advertisements carried no Prefix Information option and H3 had nothing to build an address from (RFC 4862 §5.5.3); OSPFv3 also stopped advertising the subnet. Restoring the address makes S3 send an RA with the /64 at once: H3 autoconfigures its EUI-64 address and the prefix is back in OSPFv3.",
});
