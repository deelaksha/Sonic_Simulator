/**
 * VXLAN / BGP EVPN feature lab — two leaf VTEPs over an eBGP-routed spine:
 *
 *                       SPINE  AS65100 (10.0.0.100)
 *            Ethernet0 10.0.11.2/30     Ethernet1 10.0.12.2/30
 *                 |                              |
 *            Ethernet0 10.0.11.1/30     Ethernet0 10.0.12.1/30
 *   LEAF1  AS65001  Lo0 10.0.0.1/32      LEAF2  AS65002  Lo0 10.0.0.2/32
 *     Ethernet2 Vlan100   Ethernet3 Vlan100 (spare)   Ethernet2 Vlan100   Ethernet3 Vlan100 (spare)
 *          |                                               |
 *     H1 172.16.100.11/24                            H2 172.16.100.12/24
 *
 * Underlay: eBGP IPv4 unicast; each leaf originates its loopback (`network`).
 * Overlay: VLAN 100 ↔ VNI 10100 on VTEP "vtep1" (source = Loopback0), EVPN NVO,
 * BGP `address-family l2vpn evpn` (neighbor activate on every session,
 * `advertise-all-vni` on the leaves). The spine only relays EVPN routes (next hop
 * unchanged), it has no VTEP.
 *
 * BGP is configured through KLISH. The VTEP is configured with the Click
 * `config vxlan ...` commands at the Linux shell (KLISH `interface vxlan vtep1`
 * is dispatched by the shared KLISH core, which does not enter that sub-mode yet).
 */
import { registerLab } from "./registry";

function leafScript(as: number, lo: string, peer: string): string[] {
  return [
    "configure terminal",
    "interface Loopback 0",
    `ip address ${lo}/32`,
    "exit",
    `router bgp ${as}`,
    `router-id ${lo}`,
    `neighbor ${peer}`,
    "remote-as 65100",
    "address-family l2vpn evpn",
    "activate",
    "exit",
    "exit",
    "address-family ipv4 unicast",
    `network ${lo}/32`,
    "exit",
    "address-family l2vpn evpn",
    "advertise-all-vni",
    "exit",
    "end",
  ];
}

registerLab("vxlan", (api) => {
  api.newLab();
  const spine = api.addDevice("switch", { x: 410, y: 80 }, 4);
  const leaf1 = api.addDevice("switch", { x: 200, y: 280 }, 4);
  const leaf2 = api.addDevice("switch", { x: 620, y: 280 }, 4);
  const h1 = api.addDevice("pc", { x: 120, y: 470 });
  const h2 = api.addDevice("pc", { x: 700, y: 470 });
  [["SPINE", spine], ["LEAF1", leaf1], ["LEAF2", leaf2], ["H1", h1], ["H2", h2]].forEach(([n, id]) => api.rename(id, n));
  for (const s of [spine, leaf1, leaf2]) api.setPortSpeed(s, 25000);

  api.setInterfaceIp(spine, `${spine}-if0`, "10.0.11.2", 30);
  api.setInterfaceIp(spine, `${spine}-if1`, "10.0.12.2", 30);
  api.setInterfaceIp(leaf1, `${leaf1}-if0`, "10.0.11.1", 30);
  api.setInterfaceIp(leaf2, `${leaf2}-if0`, "10.0.12.1", 30);
  api.setInterfaceIp(h1, `${h1}-if0`, "172.16.100.11", 24);
  api.setInterfaceIp(h2, `${h2}-if0`, "172.16.100.12", 24);

  api.connect(leaf1, `${leaf1}-if0`, spine, `${spine}-if0`);
  api.connect(leaf2, `${leaf2}-if0`, spine, `${spine}-if1`);
  api.connect(h1, `${h1}-if0`, leaf1, `${leaf1}-if2`);
  api.connect(h2, `${h2}-if0`, leaf2, `${leaf2}-if2`);
  for (const l of [leaf1, leaf2]) for (const p of [2, 3]) api.setAccessVlan(l, `${l}-if${p}`, 100);

  api.runCliScript(spine, [
    "configure terminal",
    "router bgp 65100",
    "router-id 10.0.0.100",
    ...["10.0.11.1|65001", "10.0.12.1|65002"].flatMap((x) => {
      const [ip, as] = x.split("|");
      return [`neighbor ${ip}`, `remote-as ${as}`, "address-family l2vpn evpn", "activate", "exit", "exit"];
    }),
    "end",
  ]);
  api.runCliScript(leaf1, leafScript(65001, "10.0.0.1", "10.0.11.2"));
  api.runCliScript(leaf2, leafScript(65002, "10.0.0.2", "10.0.12.2"));
  for (const [l, lo] of [[leaf1, "10.0.0.1"], [leaf2, "10.0.0.2"]]) {
    api.exec(l, "exit"); // KLISH → Linux shell for the Click VXLAN commands
    api.exec(l, `config vxlan add vtep1 ${lo}`);
    api.exec(l, "config vxlan evpn_nvo add nvo1 vtep1");
    api.exec(l, "config vxlan map add vtep1 100 10100");
    api.exec(l, "sonic-cli");
  }

  api.hint(leaf1, [
    "VXLAN / BGP EVPN lab — LEAF1 (VTEP 10.0.0.1) and LEAF2 (VTEP 10.0.0.2) stretch VLAN 100 as VNI 10100",
    "eBGP underlay via SPINE carries the loopbacks; the same sessions carry L2VPN EVPN routes.",
    "1. show bgp l2vpn evpn summary   — SPINE Established, PfxRcd = EVPN routes",
    "2. show bgp l2vpn evpn           — type-3 [3]:[0]:[32]:[10.0.0.2] (RD 10.0.0.2:2, ET:8 RT:65002:10100)",
    "3. show vxlan remote vni         — LEAF2 is in VNI 10100's flood list (ingress replication)",
    "4. On H1: ping 172.16.100.12    — ARP is head-end replicated to LEAF2, replies come back encapsulated",
    "5. show mac / show vxlan remote mac / show evpn mac vni 10100 — H2's MAC behind vtep:10.0.0.2 (type-2)",
    "6. exit, then sudo tcpdump -i Ethernet0 -nn udp port 4789 — VXLAN, flags [I] (0x08), vni 10100 + inner frame",
    "7. Move H2's cable to LEAF1 Ethernet3 and ping again: MAC mobility (MM:1) moves it; LEAF2 withdraws",
  ]);
  api.finish("VXLAN Lab — BGP EVPN, VLAN 100 ↔ VNI 10100 across two leaves", leaf1);
});
