/**
 * EVPN symmetric IRB lab — one tenant VRF routed across VTEPs with an L3 VNI,
 * distributed anycast gateway (SAG) and ARP suppression:
 *
 *                              SPINE  AS65100
 *          Ethernet0 10.0.11.2   Ethernet1 10.0.12.2   Ethernet2 10.0.13.2
 *               |                      |                      |
 *   LEAF1 AS65001 Lo0 10.0.0.1  LEAF2 AS65002 Lo0 10.0.0.2  LEAF3 AS65003 Lo0 10.0.0.3
 *   Vlan10 (Ethernet2)          Vlan20 (Ethernet2)          Vlan10 (Ethernet2) Vlan20 (Ethernet3)
 *   (Ethernet1 is free on every leaf, e.g. for an EVPN multihoming PortChannel)
 *        |                           |                         |                  |
 *   H1 10.1.0.11/24             H2 10.2.0.22/24          H3 10.1.0.13/24    H4 10.2.0.24/24
 *
 * Tenant VRF Vrf-red, L3 VNI 50000 on VLAN 500 (SVI Vlan500 bound to the VRF, no IP —
 * its MAC is the router MAC). VLAN 10 = VNI 10010 (10.1.0.0/24), VLAN 20 = VNI 10020
 * (10.2.0.0/24). Every leaf with a VLAN has the same anycast gateway (`ip anycast-address
 * 10.1.0.1/24` / `10.2.0.1/24`, `ip anycast-mac-address 00:00:5e:00:01:01`) plus a
 * unique SVI address, and `neigh-suppress` on its VLANs. The VRF's BGP instance
 * advertises its connected subnets as type-5 (`advertise ipv4 unicast`).
 * Underlay / overlay sessions as in the "vxlan" lab (eBGP, l2vpn evpn activate,
 * advertise-all-vni); the VTEP, VNI maps and VRF↔VNI map use the Click commands.
 */
import { registerLab } from "./registry";

const SAG_MAC = "00:00:5e:00:01:01";

interface Leaf {
  as: number;
  lo: string;
  peer: string;
  /** vid → unique SVI address */
  vlans: Record<number, string>;
}

const VLAN = {
  10: { vni: 10010, gw: "10.1.0.1/24" },
  20: { vni: 10020, gw: "10.2.0.1/24" },
} as Record<number, { vni: number; gw: string }>;

function leafScript(l: Leaf): string[] {
  const svis = Object.entries(l.vlans).flatMap(([vid, ip]) => [`interface Vlan ${vid}`, "ip vrf forwarding Vrf-red", `ip address ${ip}`, `ip anycast-address ${VLAN[Number(vid)].gw}`, "neigh-suppress", "exit"]);
  return [
    "configure terminal",
    "interface Loopback 0",
    `ip address ${l.lo}/32`,
    "exit",
    "ip vrf Vrf-red",
    "vlan 500",
    `ip anycast-mac-address ${SAG_MAC}`,
    ...svis,
    "interface Vlan 500",
    "ip vrf forwarding Vrf-red",
    "exit",
    `router bgp ${l.as}`,
    `router-id ${l.lo}`,
    `neighbor ${l.peer}`,
    "remote-as 65100",
    "address-family l2vpn evpn",
    "activate",
    "exit",
    "exit",
    "address-family ipv4 unicast",
    `network ${l.lo}/32`,
    "exit",
    "address-family l2vpn evpn",
    "advertise-all-vni",
    "exit",
    "exit",
    `router bgp ${l.as} vrf Vrf-red`,
    "address-family l2vpn evpn",
    "advertise ipv4 unicast",
    "exit",
    "end",
  ];
}

registerLab("evpn-irb", (api) => {
  api.newLab();
  const spine = api.addDevice("switch", { x: 420, y: 70 }, 4);
  const l1 = api.addDevice("switch", { x: 150, y: 260 }, 4);
  const l2 = api.addDevice("switch", { x: 420, y: 260 }, 4);
  const l3 = api.addDevice("switch", { x: 690, y: 260 }, 4);
  const h1 = api.addDevice("pc", { x: 90, y: 450 });
  const h2 = api.addDevice("pc", { x: 420, y: 450 });
  const h3 = api.addDevice("pc", { x: 620, y: 450 });
  const h4 = api.addDevice("pc", { x: 780, y: 450 });
  const names: [string, string][] = [["SPINE", spine], ["LEAF1", l1], ["LEAF2", l2], ["LEAF3", l3], ["H1", h1], ["H2", h2], ["H3", h3], ["H4", h4]];
  names.forEach(([n, id]) => api.rename(id, n));
  for (const s of [spine, l1, l2, l3]) api.setPortSpeed(s, 25000);

  const leaves: [string, Leaf, string][] = [
    [l1, { as: 65001, lo: "10.0.0.1", peer: "10.0.11.2", vlans: { 10: "10.1.0.2/24" } }, "10.0.11.1"],
    [l2, { as: 65002, lo: "10.0.0.2", peer: "10.0.12.2", vlans: { 20: "10.2.0.3/24" } }, "10.0.12.1"],
    [l3, { as: 65003, lo: "10.0.0.3", peer: "10.0.13.2", vlans: { 10: "10.1.0.4/24", 20: "10.2.0.4/24" } }, "10.0.13.1"],
  ];
  leaves.forEach(([id, , ip], i) => {
    api.setInterfaceIp(spine, `${spine}-if${i}`, `10.0.1${i + 1}.2`, 30);
    api.setInterfaceIp(id, `${id}-if0`, ip, 30);
    api.connect(id, `${id}-if0`, spine, `${spine}-if${i}`);
  });
  const hosts: [string, string, string, string, number][] = [
    [h1, "10.1.0.11", "10.1.0.1", l1, 2],
    [h2, "10.2.0.22", "10.2.0.1", l2, 2],
    [h3, "10.1.0.13", "10.1.0.1", l3, 2],
    [h4, "10.2.0.24", "10.2.0.1", l3, 3],
  ];
  for (const [h, ip, gw, leaf, port] of hosts) {
    api.setInterfaceIp(h, `${h}-if0`, ip, 24);
    api.setDefaultGateway(h, gw);
    api.connect(h, `${h}-if0`, leaf, `${leaf}-if${port}`);
    api.setAccessVlan(leaf, `${leaf}-if${port}`, ip.startsWith("10.1.") ? 10 : 20);
  }

  api.runCliScript(spine, [
    "configure terminal",
    "router bgp 65100",
    "router-id 10.0.0.100",
    ...leaves.flatMap(([, l, ip]) => [`neighbor ${ip}`, `remote-as ${l.as}`, "address-family l2vpn evpn", "activate", "exit", "exit"]),
    "end",
  ]);
  for (const [id, l] of leaves) {
    api.runCliScript(id, leafScript(l));
    api.exec(id, "exit"); // KLISH → Linux shell for the Click VXLAN commands
    api.exec(id, `config vxlan add vtep1 ${l.lo}`);
    api.exec(id, "config vxlan evpn_nvo add nvo1 vtep1");
    for (const vid of Object.keys(l.vlans)) api.exec(id, `config vxlan map add vtep1 ${vid} ${VLAN[Number(vid)].vni}`);
    api.exec(id, "config vxlan map add vtep1 500 50000");
    api.exec(id, "config vrf add_vrf_vni_map Vrf-red 50000");
    api.exec(id, "sonic-cli");
  }

  api.hint(l1, [
    "EVPN symmetric IRB lab — tenant VRF Vrf-red, L3 VNI 50000 (VLAN 500), anycast gateway 10.1.0.1 / 10.2.0.1 on every leaf",
    "1. On H1: ping 10.2.0.22   — routed on LEAF1 in Vrf-red, VXLAN vni 50000 to LEAF2, routed again into Vlan20",
    "2. show bgp l2vpn evpn      — [5]:[0]:[24]:[10.2.0.0] (type-5) and [2]:…:[32]:[10.2.0.22] (MAC+IP, RT:65002:50000 Rmac:…)",
    "3. show ip route vrf Vrf-red — B>* 10.2.0.22/32 [20/0] via 10.0.0.2, Vlan500 (VTEP next hop, router MAC neighbour)",
    "4. show evpn vni detail / show evpn rmac vni 50000 / show evpn next-hops vni 50000 / show vxlan remotemac all",
    "5. On H1: ping 10.1.0.13 (same subnet on LEAF3) — ARP answered by LEAF1 itself (neigh-suppress): show evpn arp-cache vni 10010",
    "6. show ip static-anycast-gateway — the same gateway IP/MAC on LEAF1 and LEAF3; move H3 to LEAF1 Ethernet3 (Vlan10) and ping on",
    "7. exit, then sudo tcpdump -i Ethernet0 -nn udp port 4789 — VXLAN, flags [I] (0x08), vni 50000 + inner frame between router MACs",
  ]);
  api.finish("EVPN IRB Lab — L3 VNI symmetric IRB, anycast gateway, ARP suppression", l1);
});
