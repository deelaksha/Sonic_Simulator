/** Missions on the EVPN symmetric IRB lab (lib/labs/evpn-irb-lab.ts: LEAF1-3 under SPINE, tenant Vrf-red with L3 VNI 50000, VLAN 10 = VNI 10010, VLAN 20 = VNI 10020, anycast gateways). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** A BGP (EVPN-imported) route in Vrf-red for prefix via the given VTEP. */
const vrfRouteVia = (c: CheckCtx, leaf: string, prefix: string, vtep: string) => {
  const [dst, len] = prefix.split("/");
  return c.dev(leaf).routingTable.some((r) => r.destination === dst && r.prefix === Number(len) && r.vrf === "Vrf-red" && r.type === "bgp" && r.nextHop === vtep);
};
/** VRF → L3 VNI mapping shown by `show vxlan vrfvnimap`. */
const l3vni = (c: CheckCtx, leaf: string) => c.shell(leaf, "show vxlan vrfvnimap").match(/Vrf-red\s*\|\s*(\d+)/)?.[1];

registerMission({
  id: "evpn-irb-new-subnet",
  labId: "evpn-irb",
  kind: "mission",
  level: "intermediate",
  title: "Add a tenant subnet on LEAF2",
  summary:
    "The red tenant needs a new subnet 10.3.0.0/24 (gateway 10.3.0.1) on LEAF2 in VLAN 30. Find out how LEAF1 learns the tenant's remote subnets today, then add the new subnet on LEAF2 only and make sure the other leaves route to it over the L3 VNI.",
  objectives: [
    {
      id: "routes",
      title: "On LEAF1, find the EVPN route that carries 10.2.0.0/24",
      hints: [
        "In LEAF1's Linux shell: show bgp l2vpn evpn — type-5 routes look like [5]:[0]:[24]:[10.2.0.0].",
        "show ip route vrf Vrf-red shows where they land: B>* 10.2.0.0/24 via 10.0.0.2, Vlan500 (the L3 VNI SVI).",
      ],
      check: (c) => c.typed("LEAF1", /show bgp l2vpn evpn/) && vrfRouteVia(c, "LEAF1", "10.2.0.0/24", "10.0.0.2"),
    },
    {
      id: "routed",
      title: "Ping H2 (10.2.0.22) from H1 — routed across the fabric",
      hints: ["H1's gateway is the anycast address 10.1.0.1 on LEAF1; LEAF1 routes in Vrf-red and tunnels the packet with VNI 50000 to LEAF2."],
      check: (c) => c.typed("H1", /ping .*10\.2\.0\.22/) && c.ping("H1", "10.2.0.22"),
    },
    {
      id: "subnet",
      title: "LEAF1 learns 10.3.0.0/24 from LEAF2 (10.0.0.2) in Vrf-red",
      hints: [
        "On LEAF2 create the VLAN and an SVI in the tenant VRF — the VRF's BGP instance already has `advertise ipv4 unicast` and exports connected subnets as type-5 routes.",
        "LEAF2: configure terminal → vlan 30 → interface Vlan 30 → ip vrf forwarding Vrf-red → ip address 10.3.0.1/24",
        "Bind the VRF before the address: an address configured first would land in the default VRF.",
      ],
      check: (c) => vrfRouteVia(c, "LEAF1", "10.3.0.0/24", "10.0.0.2") && vrfRouteVia(c, "LEAF3", "10.3.0.0/24", "10.0.0.2"),
    },
    {
      id: "reach",
      title: "H1 reaches the new gateway 10.3.0.1",
      check: (c) => c.ping("H1", "10.3.0.1"),
    },
  ],
  solution: [
    { device: "LEAF1", shell: ["exit", "show bgp l2vpn evpn", "show ip route vrf Vrf-red"] },
    { device: "H1", shell: ["ping -c 1 10.2.0.22"] },
    { device: "LEAF2", klish: ["configure terminal", "vlan 30", "interface Vlan 30", "ip vrf forwarding Vrf-red", "ip address 10.3.0.1/24", "end"], waitMs: 5000 },
  ],
  explanation:
    "In symmetric IRB each leaf routes in the tenant VRF and sends routed traffic to the egress VTEP with the VRF's L3 VNI (50000) and the egress router MAC. Remote subnets reach the VRF as EVPN type-5 (IP prefix) routes carrying the L3 VNI's route target and the Router MAC extended community (RFC 9136); hosts additionally appear as type-2 MAC+IP routes. Because Vrf-red's BGP instance has `advertise ipv4 unicast`, LEAF2's new connected subnet was exported as [5]:[0]:[24]:[10.3.0.0] and installed on LEAF1 and LEAF3 via 10.0.0.2 — no change was needed on the other leaves.",
});

registerMission({
  id: "evpn-irb-trouble-l3vni",
  labId: "evpn-irb",
  kind: "troubleshoot",
  level: "advanced",
  title: "LEAF2 is cut off from routed traffic",
  summary:
    "LEAF2 was re-provisioned last night. Since then H1 (10.1.0.11) can no longer reach H2 (10.2.0.22); H1 still reaches H4 (10.2.0.24) on LEAF3 and H3 in its own subnet. Fix it without changing LEAF1, LEAF3 or the SPINE.",
  inject(api) {
    const l2 = api.deviceId("LEAF2");
    for (const cmd of ["exit", "config vrf del_vrf_vni_map Vrf-red", "config vxlan map del vtep1 500 50000", "config vxlan map add vtep1 500 50001", "config vrf add_vrf_vni_map Vrf-red 50001", "sonic-cli"]) api.exec(l2, cmd);
  },
  objectives: [
    {
      id: "reach",
      title: "H1 reaches H2",
      hints: [
        "On LEAF1, `show ip route vrf Vrf-red`: is there a route to 10.2.0.0/24 via LEAF2 (10.0.0.2)? Then look at the EVPN routes LEAF2 sends: `show bgp l2vpn evpn`.",
        "Compare the route targets: LEAF2's type-5 route carries RT:65002:50001 while every other leaf uses …:50000. `show evpn vni` / `show vxlan vrfvnimap` on LEAF2.",
        "LEAF2's tenant VRF must use L3 VNI 50000: config vrf del_vrf_vni_map Vrf-red · config vxlan map del vtep1 500 50001 · config vxlan map add vtep1 500 50000 · config vrf add_vrf_vni_map Vrf-red 50000",
      ],
      check: (c) => c.ping("H1", "10.2.0.22"),
    },
    {
      id: "l3vni",
      title: "All leaves use L3 VNI 50000 and LEAF1 routes 10.2.0.0/24 via LEAF2",
      check: (c) => ["LEAF1", "LEAF2", "LEAF3"].every((l) => l3vni(c, l) === "50000") && vrfRouteVia(c, "LEAF1", "10.2.0.0/24", "10.0.0.2"),
    },
  ],
  solution: [
    {
      device: "LEAF2",
      shell: ["exit", "config vrf del_vrf_vni_map Vrf-red", "config vxlan map del vtep1 500 50001", "config vxlan map add vtep1 500 50000", "config vrf add_vrf_vni_map Vrf-red 50000"],
      waitMs: 10000,
    },
  ],
  explanation:
    "LEAF2 had mapped Vrf-red to L3 VNI 50001 instead of 50000. With auto-derived route targets (AS:VNI) its type-5 and type-2 routes carried RT …:50001, which no other leaf imports into Vrf-red, and they would have tunnelled routed traffic with a VNI LEAF2 does not decapsulate into the VRF. Symmetric IRB requires the same L3 VNI per tenant VRF on every VTEP (RFC 9135 §4); `show bgp l2vpn evpn` (RT) and `show vxlan vrfvnimap` reveal the mismatch, and remapping VLAN 500 / Vrf-red to 50000 restores import and forwarding.",
});

registerMission({
  id: "evpn-irb-trouble-l2vni",
  labId: "evpn-irb",
  kind: "troubleshoot",
  level: "intermediate",
  title: "Same subnet, no reachability",
  summary:
    "H1 (10.1.0.11 on LEAF1) and H3 (10.1.0.13 on LEAF3) are in the same subnet but cannot ping each other; H1 still reaches H2 on LEAF2 and H3 reaches H4. Fix it without changing LEAF1 or LEAF2.",
  inject(api) {
    const l3 = api.deviceId("LEAF3");
    for (const cmd of ["exit", "config vxlan map del vtep1 10 10010", "sonic-cli"]) api.exec(l3, cmd);
  },
  objectives: [
    {
      id: "reach",
      title: "H1 reaches H3",
      hints: [
        "Same subnet means bridging: H1's ARP for 10.1.0.13 must be answered by LEAF1 (ARP suppression) or flooded to the other VTEPs of VNI 10010. `show evpn arp-cache vni 10010` on LEAF1.",
        "`show evpn vni` on LEAF1: VNI 10010 has 0 remote VTEPs. Which leaf should be in its flood list, and what does `show vxlan vlanvnimap` say there?",
        "LEAF3 has no VLAN 10 → VNI 10010 mapping: in LEAF3's Linux shell, config vxlan map add vtep1 10 10010",
      ],
      check: (c) => c.ping("H1", "10.1.0.13"),
    },
    {
      id: "flood",
      title: "VNI 10010 on LEAF1 lists LEAF3 as a remote VTEP, routed traffic still works",
      check: (c) => /^10010\s+L2\s+\S+\s+\d+\s+\d+\s+1\s/m.test(c.shell("LEAF1", "show evpn vni")) && c.ping("H1", "10.2.0.22"),
    },
  ],
  solution: [{ device: "LEAF3", shell: ["exit", "config vxlan map add vtep1 10 10010"], waitMs: 10000 }],
  explanation:
    "LEAF3 had lost its VLAN 10 → VNI 10010 map, so it no longer advertised a type-3 (inclusive multicast) route or H3's type-2 MAC/IP routes in VNI 10010. LEAF1 had no remote VTEP for that VNI and no ARP entry to suppress with, so H1's ARP for H3 went nowhere — routed traffic was unaffected because it uses the L3 VNI. Bridging between leaves needs the same VLAN-to-VNI mapping on every VTEP of the segment (RFC 7432 / RFC 8365); `show evpn vni` (Remote VTEPs) and `show vxlan vlanvnimap` show the gap.",
});
