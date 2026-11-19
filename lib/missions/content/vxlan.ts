/** Missions on the VXLAN lab (lib/labs/vxlan-lab.ts: LEAF1 VTEP 10.0.0.1 / LEAF2 VTEP 10.0.0.2 over eBGP SPINE, VLAN 100 ↔ VNI 10100, H1 172.16.100.11 / H2 .12). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** KLISH `show vxlan remote vni` on `leaf` has a row VlanN | vtep | vni. */
const remoteVni = (c: CheckCtx, leaf: string, vlan: number, vtep: string, vni: number) =>
  new RegExp(`\\|\\s*Vlan${vlan}\\s*\\|\\s*${vtep.replace(/\./g, "\\.")}\\s*\\|\\s*${vni}\\s*\\|`).test(c.klish(leaf, "show vxlan remote vni"));
const localMap = (c: CheckCtx, leaf: string, vlan: number, vni: number) =>
  new RegExp(`\\|\\s*Vlan${vlan}\\s*\\|\\s*${vni}\\s*\\|`).test(c.klish(leaf, "show vxlan vlanvnimap"));

registerMission({
  id: "vxlan-evpn-extend",
  labId: "vxlan",
  kind: "mission",
  level: "intermediate",
  title: "Stretch a second VLAN over EVPN",
  summary:
    "VLAN 100 is stretched between LEAF1 and LEAF2 as VNI 10100. Follow how EVPN builds the overlay — session, flood list, MAC routes — then stretch VLAN 200 as VNI 10200 the same way.",
  objectives: [
    {
      id: "session",
      title: "On LEAF1, check the L2VPN EVPN session to the SPINE",
      hints: ["KLISH on LEAF1: show bgp l2vpn evpn summary — the State/PfxRcd column shows a number once the session is Established."],
      check: (c) =>
        c.typed("LEAF1", /show bgp l2vpn evpn summary/) &&
        /^10\.0\.11\.2\s+4\s+65100(\s+\d+){5}\s+\S+\s+\d+/m.test(c.klish("LEAF1", "show bgp l2vpn evpn summary")),
    },
    {
      id: "flood-list",
      title: "On LEAF1, find LEAF2 in VNI 10100's remote VTEP list",
      hints: ["show vxlan remote vni — built from LEAF2's type-3 (inclusive multicast) route; it is the head-end replication list for BUM traffic."],
      check: (c) => c.typed("LEAF1", /show vxlan remote vni/) && remoteVni(c, "LEAF1", 100, "10.0.0.2", 10100),
    },
    {
      id: "mac-route",
      title: "Ping H2 from H1; LEAF1 learns H2's MAC behind VTEP 10.0.0.2",
      hints: ["On H1: ping -c 1 172.16.100.12. Then on LEAF1: show vxlan remote mac (or `show bgp l2vpn evpn` for the type-2 route)."],
      check: (c) => {
        const out = c.klish("LEAF1", "show vxlan remote mac").toLowerCase();
        return c.typed("H1", /ping\b.*172\.16\.100\.12/) && out.includes(c.dev("H2").interfaces[0].mac.toLowerCase()) && /10\.0\.0\.2/.test(out);
      },
    },
    {
      id: "vni-10200",
      title: "VLAN 200 ↔ VNI 10200 on both leaves; each sees the other as a remote VTEP for 10200",
      hints: [
        "The VTEP is configured with the Click `config` commands: `exit` to the shell first.",
        "On each leaf: sudo config vlan add 200, then sudo config vxlan map add vtep1 200 10200 — advertise-all-vni announces the new VNI by itself.",
      ],
      check: (c) => remoteVni(c, "LEAF1", 200, "10.0.0.2", 10200) && remoteVni(c, "LEAF2", 200, "10.0.0.1", 10200),
    },
  ],
  solution: [
    { device: "LEAF1", shell: ["show bgp l2vpn evpn summary", "show vxlan remote vni"] },
    { device: "H1", shell: ["ping -c 1 172.16.100.12"] },
    { device: "LEAF1", shell: ["show vxlan remote mac", "exit", "sudo config vlan add 200", "sudo config vxlan map add vtep1 200 10200"] },
    { device: "LEAF2", shell: ["exit", "sudo config vlan add 200", "sudo config vxlan map add vtep1 200 10200"], waitMs: 3000 },
  ],
  explanation:
    "Each leaf advertises one EVPN type-3 route per VNI (RFC 8365 §9 / RFC 7432 §11): receiving it puts the originating VTEP into that VNI's ingress-replication list, which carries ARP and other BUM traffic. Once a host is learned, its MAC is advertised as a type-2 route, so the far leaf forwards unicast straight to the right VTEP.\nWith `advertise-all-vni`, mapping a new VLAN to a VNI is enough: both leaves originated a type-3 route for 10200 and the segment came up without any BGP change.",
});

registerMission({
  id: "vxlan-trouble-vni",
  labId: "vxlan",
  kind: "troubleshoot",
  level: "intermediate",
  title: "VLAN 100 split in two",
  summary:
    "H1 (on LEAF1) and H2 (on LEAF2) are both in VLAN 100 but cannot reach each other. BGP between the leaves and the spine is Established and the loopbacks are reachable. LEAF1 is the reference — do not change it.",
  inject(api) {
    const l2 = api.deviceId("LEAF2");
    api.exec(l2, "exit");
    api.exec(l2, "sudo config vxlan map del vtep1 100 10100");
    api.exec(l2, "sudo config vxlan map add vtep1 100 10101");
    api.exec(l2, "sonic-cli");
  },
  objectives: [
    {
      id: "reach",
      title: "H1 reaches H2 (172.16.100.12)",
      hints: [
        "ARP from H1 is never answered: is LEAF2 in LEAF1's flood list? `show vxlan remote vni` on LEAF1.",
        "LEAF2's type-3 route is in `show bgp l2vpn evpn` — compare its route target (RT:65002:…) and the VNIs in `show vxlan vlanvnimap` on both leaves.",
        "LEAF2 maps VLAN 100 to VNI 10101. In LEAF2's shell: sudo config vxlan map del vtep1 100 10101, then sudo config vxlan map add vtep1 100 10100",
      ],
      check: (c) => c.ping("H1", "172.16.100.12"),
    },
    {
      id: "flood-list",
      title: "LEAF1 lists LEAF2 as remote VTEP for VNI 10100",
      check: (c) => remoteVni(c, "LEAF1", 100, "10.0.0.2", 10100),
    },
    {
      id: "leaf1-untouched",
      title: "LEAF1 still maps VLAN 100 to VNI 10100",
      check: (c) => localMap(c, "LEAF1", 100, 10100),
    },
  ],
  solution: [{ device: "LEAF2", shell: ["exit", "sudo config vxlan map del vtep1 100 10101", "sudo config vxlan map add vtep1 100 10100"], waitMs: 3000 }],
  explanation:
    "LEAF2 mapped VLAN 100 to VNI 10101 while LEAF1 used 10100. The VNI is the segment identifier carried in every VXLAN header (RFC 7348) and in the EVPN route targets, so the leaves built two separate segments: LEAF1 ignored LEAF2's type-3 route for 10101, never added it to the 10100 flood list, and H1's ARP never reached H2. Mapping the VLAN to the same VNI on both leaves joins the segment again.",
});

registerMission({
  id: "vxlan-trouble-underlay",
  labId: "vxlan",
  kind: "troubleshoot",
  level: "advanced",
  title: "The overlay is up, the hosts are not",
  summary:
    "After LEAF2 was re-provisioned, H1 and H2 (both VLAN 100) lost connectivity. The BGP sessions from both leaves to the spine are Established and the VLAN-to-VNI mappings are identical on both leaves.",
  inject(api) {
    api.runCliScript(api.deviceId("LEAF2"), ["configure terminal", "router bgp 65002", "address-family ipv4 unicast", "no network 10.0.0.2/32", "end"]);
  },
  objectives: [
    {
      id: "underlay",
      title: "LEAF1 has a BGP route to LEAF2's VTEP address 10.0.0.2/32",
      hints: [
        "LEAF1's `show vxlan remote vni` is empty and `show bgp l2vpn evpn` has no routes from RD 10.0.0.2:2. EVPN routes are only usable if their next hop — the remote VTEP — is reachable.",
        "Check the underlay: `show ip route` on LEAF1 and on the SPINE. Which loopback is missing?",
        "LEAF2 no longer originates its loopback: router bgp 65002 → address-family ipv4 unicast → network 10.0.0.2/32",
      ],
      check: (c) => c.route("LEAF1", "10.0.0.2/32")?.type === "bgp",
    },
    {
      id: "reach",
      title: "H1 reaches H2 (172.16.100.12)",
      check: (c) => c.ping("H1", "172.16.100.12"),
    },
  ],
  solution: [{ device: "LEAF2", klish: ["configure terminal", "router bgp 65002", "address-family ipv4 unicast", "network 10.0.0.2/32", "end"], waitMs: 5000 }],
  explanation:
    "LEAF2 had lost its `network 10.0.0.2/32` statement, so its VTEP loopback was no longer in the underlay. EVPN routes carry the VTEP address as BGP next hop, and BGP does not use a route whose next hop is unreachable (RFC 4271 §9.1.2), so LEAF2's type-3 and type-2 routes were dropped and no tunnel could be built — even though every session stayed Established. Re-originating the loopback makes the next hop resolvable and the overlay comes back.",
});
