/**
 * SONiC feature registry (task §8, §9, §52, §53).
 *
 * This is the UI/organisational layer only. It does NOT embed commands —
 * commands live in the generated catalog at
 * data/sonic-command-catalog/catalog.json, linked by `catalogFeatures`
 * (each entry's `features[]`). Keep this list in sync with the catalog's
 * feature ids (see docs/SONIC_ANALYSIS.md).
 */

export type FeatureGroup = "L2" | "L3" | "Security" | "Services" | "QoS" | "Other";

export type FeaturePhase = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type FeatureStatus = "planned" | "in-progress" | "implemented";

export interface SonicFeature {
  id: string;
  label: string;
  group: FeatureGroup;
  phase: FeaturePhase;
  status: FeatureStatus;
  /** Catalog `features[]` ids this maps to (source of commands). */
  catalogFeatures: string[];
  /** Cheat-sheet files backing this feature (traceability, task §49). */
  sourceFiles: string[];
  /** One-line summary shown in the feature panel. */
  description: string;
  /** Suggested lab topology hint (task §11). */
  topology: string;
  /**
   * True when the EXISTING packet engine already models the behavior, so the
   * feature can be made simulation-accurate by wiring CLI → existing state.
   * False when it needs a new protocol/feature engine first.
   */
  simReady: boolean;
}

export const SONIC_FEATURES: SonicFeature[] = [
  // ---- Phase 1: L2/L3 foundation (mostly already modeled by the engine) ----
  {
    id: "interface",
    label: "Interface",
    group: "L2",
    phase: 1,
    status: "implemented",
    catalogFeatures: ["interface"],
    sourceFiles: ["interface.txt"],
    description: "Physical/logical interfaces: admin state, MTU, speed, IP addressing.",
    topology: "PC1 — SW1 — PC2",
    simReady: true,
  },
  {
    id: "vlan",
    label: "VLAN",
    group: "L2",
    phase: 1,
    status: "implemented",
    catalogFeatures: ["vlan"],
    sourceFiles: ["vlan.txt"],
    description: "802.1Q VLANs, access/trunk membership, SVIs. First feature to implement end-to-end.",
    topology: "PC1(V10) — SW1 — PC2(V10) / PC3(V20)",
    simReady: true,
  },
  {
    id: "arpnd",
    label: "ARP / ND",
    group: "L3",
    phase: 1,
    status: "implemented",
    catalogFeatures: ["arpnd"],
    sourceFiles: ["arpnd.txt", "arpnd_DUT2.txt"],
    description: "IPv4 ARP / IPv6 ND caches with Linux aging (REACHABLE→STALE→probe), gratuitous ARP, show arp.",
    topology: "PC1 — SW1 — PC2",
    simReady: true,
  },
  {
    id: "ipvx",
    label: "IPv4 / IPv6",
    group: "L3",
    phase: 1,
    status: "implemented",
    // IPv6 now has a real packet-plane: ping6, NDP (NS/NA), ICMPv6, v6 routing.
    catalogFeatures: ["ipvx"],
    sourceFiles: ["ipvX.txt"],
    description: "IPv4/IPv6 addressing and forwarding; NDP/ICMPv6 for IPv6 (not ARP).",
    topology: "PC1 — R1 — PC2",
    simReady: true,
  },
  {
    id: "staticroute",
    label: "Static Route",
    group: "L3",
    phase: 1,
    status: "implemented",
    catalogFeatures: ["staticroute"],
    sourceFiles: ["staticroute.txt"],
    description: "Static IPv4/IPv6 routes affecting the forwarding table.",
    topology: "PC1 — R1 — R2 — PC2",
    simReady: true,
  },

  // ---- Phase 2: services + L2 neighbor/aggregation ----
  {
    id: "dhcp",
    label: "DHCP",
    group: "Services",
    phase: 2,
    status: "implemented",
    catalogFeatures: ["dhcp"],
    sourceFiles: ["dhcp_udaykum.txt"],
    description: "DHCP relay/server config; DORA over UDP 67/68.",
    topology: "Client — SW1 — DHCP Server",
    simReady: false,
  },
  {
    id: "dns",
    label: "DNS",
    group: "Services",
    phase: 2,
    status: "implemented",
    catalogFeatures: ["dns"],
    sourceFiles: ["dns_udaykum.txt"],
    description: "DNS nameserver config and resolution over UDP 53.",
    topology: "Client — SW1 — DNS Server",
    simReady: false,
  },
  {
    id: "ntp",
    label: "NTP",
    group: "Services",
    phase: 2,
    status: "implemented",
    catalogFeatures: ["ntp"],
    sourceFiles: ["ntp.txt"],
    description: "NTP client/server, source interface, VRF; UDP 123. Second feature to implement.",
    topology: "NTP Client — SW1 — NTP Server",
    simReady: false,
  },
  {
    id: "lldp",
    label: "LLDP",
    group: "L2",
    phase: 2,
    status: "implemented",
    catalogFeatures: ["lldp"],
    sourceFiles: ["lldp.txt", "lldp_DUT2.txt"],
    description: "lldpd: LLDPDUs every 30 s (TTL 120), neighbor tables with expiry, show lldp table/neighbors.",
    topology: "S1/S2/S3 routed triangle + H1/H3 + MGMT/NMS",
    simReady: true,
  },
  {
    id: "lacp",
    label: "LACP / PortChannel",
    group: "L2",
    phase: 2,
    status: "implemented",
    catalogFeatures: ["lacp"],
    sourceFiles: ["lacp.txt", "lacp_DUT2.txt"],
    description: "teamd LACP: LACPDUs (fast/slow), member selection, min-links, fallback, per-flow hashing.",
    topology: "SW1 === SW2 (PortChannel, 2 members) + hosts",
    simReady: true,
  },
  {
    id: "mclag",
    label: "MCLAG",
    group: "L2",
    phase: 2,
    status: "implemented",
    catalogFeatures: ["mclag"],
    sourceFiles: ["mclag.txt"],
    description: "iccpd: ICCP over TCP 8888, shared LACP system ID, MAC sync, peer-link isolation, failover.",
    topology: "PEER1 ⇄ PEER2 (peer-link) — dual-homed SW3",
    simReady: true,
  },

  // ---- Phase 3: VRF + dynamic routing basics ----
  {
    id: "vrf",
    label: "VRF",
    group: "L3",
    phase: 3,
    status: "implemented",
    catalogFeatures: ["vrf"],
    sourceFiles: ["vrf.txt", "vrf_DUT2.txt"],
    description: "Per-VRF routing tables: interface binding, per-VRF static routes, ping -I, show ip route vrf.",
    topology: "S1/S2/S3 triangle, S1 with Vrf-red",
    simReady: true,
  },
  {
    id: "vrrp",
    label: "VRRP",
    group: "L3",
    phase: 3,
    status: "implemented",
    catalogFeatures: ["vrrp"],
    sourceFiles: ["vrrp.txt"],
    description: "FRR vrrpd: VRRPv3 adverts, Master_Down timer, preemption, priority 0, vMAC + GARP failover.",
    topology: "H1 — ACC — {S1,S2} VIP — S3 — H2",
    simReady: true,
  },
  {
    id: "vxlan",
    label: "VXLAN / EVPN",
    group: "L3",
    phase: 4,
    status: "implemented",
    catalogFeatures: ["vxlan"],
    sourceFiles: ["vxlan.txt"],
    description: "VTEP encap/decap (UDP 4789), ingress replication, BGP L2VPN EVPN type-2/type-3 routes.",
    topology: "LEAF1 — SPINE — LEAF2 (VNI 10100)",
    simReady: true,
  },
  {
    id: "ospf",
    label: "OSPF",
    group: "L3",
    phase: 3,
    status: "implemented",
    catalogFeatures: ["ospf", "ospf-advanced"],
    sourceFiles: ["ospf.txt", "ospf_DUT2.txt", "ospfadvanced.txt", "ospfadvanced_DUT2.txt"],
    description: "ospfd: Hello/DBD/LSR/LSU/LSAck, DR/BDR, LSDB, SPF with costs, failover, FRR show ip ospf.",
    topology: "S1/S2/S3 routed triangle + H1/H3 + MGMT/NMS",
    simReady: true,
  },
  {
    id: "bfd",
    label: "BFD",
    group: "L3",
    phase: 3,
    status: "implemented",
    catalogFeatures: ["bfd"],
    sourceFiles: ["bfd.txt", "bfd_DUT2.txt"],
    description: "bfdd: RFC 5880 sessions (300 ms × 3), sub-second failure detection for OSPF/BGP, FRR show bfd.",
    topology: "S1/S2/S3 routed triangle + H1/H3 + MGMT/NMS",
    simReady: true,
  },

  // ---- Phase 4: policy + BGP ----
  {
    id: "prefixlist",
    label: "Prefix List",
    group: "L3",
    phase: 4,
    status: "implemented",
    catalogFeatures: ["prefixlist"],
    sourceFiles: ["prefixlist.txt"],
    description: "Prefix lists used by routing policy (route-maps, redistribution).",
    topology: "R1 — R2",
    simReady: false,
  },
  {
    id: "routemap",
    label: "Route Map",
    group: "L3",
    phase: 4,
    status: "implemented",
    catalogFeatures: ["routemap"],
    sourceFiles: ["routemap.txt"],
    description: "Route-maps for filtering/modifying routes in routing protocols.",
    topology: "R1 — R2",
    simReady: false,
  },
  {
    id: "bgp",
    label: "BGP",
    group: "L3",
    phase: 4,
    status: "implemented",
    catalogFeatures: ["bgp"],
    sourceFiles: ["bgp.txt", "bgp_DUT2.txt"],
    description: "bgpd: TCP 179 sessions, FSM, OPEN/UPDATE/KEEPALIVE, best path, hold timer, BFD, FRR show ip bgp.",
    topology: "S1/S2/S3 routed triangle + H1/H3 + MGMT/NMS",
    simReady: true,
  },

  // ---- Phase 5: security/QoS/telemetry ----
  {
    id: "acl",
    label: "ACL",
    group: "Security",
    phase: 5,
    status: "implemented",
    catalogFeatures: ["acl"],
    sourceFiles: ["acl.txt"],
    description: "IP/MAC/IPv6 ACLs enforced on ports, PortChannels, VLANs: first match by seq, implicit deny, counters.",
    topology: "S1/S2/S3 triangle + static routes, H1-POLICY on S1",
    simReady: true,
  },
  {
    id: "copp",
    label: "CoPP",
    group: "Security",
    phase: 5,
    status: "implemented",
    catalogFeatures: ["copp"],
    sourceFiles: ["copp.txt"],
    description: "Control-plane policing: permit/drop/rate-limit of control-plane traffic (logical model).",
    topology: "PC1 — SW1(control plane)",
    simReady: false,
  },
  {
    id: "qos",
    label: "QoS",
    group: "QoS",
    phase: 5,
    status: "implemented",
    catalogFeatures: ["qos"],
    sourceFiles: ["qos.txt", "qos_click_cli.txt"],
    description: "Classification, queues, DSCP/CoS (educational logical model, not ASIC-accurate).",
    topology: "PC1 — SW1 — PC2",
    simReady: false,
  },
  {
    id: "qos-pfc-pfcwd",
    label: "PFC / PFCWD",
    group: "QoS",
    phase: 5,
    status: "implemented",
    catalogFeatures: ["qos-pfc-pfcwd"],
    sourceFiles: ["qos_pfc_pfcwd.txt"],
    description: "Priority Flow Control and watchdog (logical model; platform limits flagged).",
    topology: "SW1 — SW2",
    simReady: false,
  },
  {
    id: "qos-counterpoll",
    label: "Counter Poll",
    group: "QoS",
    phase: 5,
    status: "implemented",
    catalogFeatures: ["qos-counterpoll"],
    sourceFiles: ["qos_counterpoll.txt"],
    description: "Counter polling configuration and intervals.",
    topology: "SW1",
    simReady: false,
  },
  {
    id: "sflow",
    label: "sFlow",
    group: "QoS",
    phase: 5,
    status: "implemented",
    catalogFeatures: ["sflow"],
    sourceFiles: ["sflow.txt"],
    description: "sflowmgrd sessions, 1-in-N ingress sampling, hsflowd datagrams decoded at a collector.",
    topology: "H1/H2 — SW1 (VLAN 100) — Collector (eth0)",
    simReady: true,
  },
  {
    id: "fbs",
    label: "FBS",
    group: "QoS",
    phase: 5,
    status: "implemented",
    catalogFeatures: ["fbs"],
    sourceFiles: ["fbs.txt"],
    description: "Flow-based services / policy-based forwarding classifiers and actions.",
    topology: "PC1 — SW1 — PC2",
    simReady: false,
  },

  // ---- Phase 6: management/AAA ----
  {
    id: "snmp",
    label: "SNMP",
    group: "Services",
    phase: 6,
    status: "implemented",
    catalogFeatures: ["snmp"],
    sourceFiles: ["snmp.txt"],
    description: "snmpd v2c agent: system/IF-MIB, GET/GETNEXT/GETBULK/SET, linkDown/linkUp traps; snmpwalk on hosts.",
    topology: "S1/S2/S3 routed triangle + H1/H3 + MGMT/NMS",
    simReady: true,
  },
  {
    id: "aaa",
    label: "AAA",
    group: "Security",
    phase: 6,
    status: "implemented",
    catalogFeatures: ["aaa"],
    sourceFiles: ["aaa.txt"],
    description: "Authentication/authorization/accounting config (simulated, no external servers).",
    topology: "SW1",
    simReady: false,
  },
  {
    id: "tacacs",
    label: "TACACS+",
    group: "Security",
    phase: 6,
    status: "implemented",
    catalogFeatures: ["tacacs"],
    sourceFiles: ["tacacs.txt"],
    description: "TACACS+ server config and state (simulated auth).",
    topology: "SW1 — TACACS Server",
    simReady: false,
  },
  {
    id: "radius",
    label: "RADIUS",
    group: "Security",
    phase: 6,
    status: "implemented",
    catalogFeatures: ["radius"],
    sourceFiles: ["radius.txt"],
    description: "RADIUS server config and state (simulated auth).",
    topology: "SW1 — RADIUS Server",
    simReady: false,
  },

  // ---- Phase 7: platform / hardware-oriented ----
  {
    id: "platform",
    label: "Platform",
    group: "Other",
    phase: 7,
    status: "implemented",
    catalogFeatures: ["platform"],
    sourceFiles: ["platform.txt"],
    description: "Platform/hardware inventory & environment; hardware-only items flagged as limitations.",
    topology: "SW1",
    simReady: false,
  },
  {
    id: "pbo",
    label: "PBO",
    group: "Other",
    phase: 7,
    status: "implemented",
    catalogFeatures: ["pbo"],
    sourceFiles: ["pbo.txt"],
    description: "Policy-based options; extract & classify, model what is representable.",
    topology: "SW1",
    simReady: false,
  },
];

export const FEATURE_GROUPS: { group: FeatureGroup; label: string }[] = [
  { group: "L2", label: "Layer 2" },
  { group: "L3", label: "Layer 3" },
  { group: "Security", label: "Security" },
  { group: "Services", label: "Services" },
  { group: "QoS", label: "Traffic / QoS" },
  { group: "Other", label: "Other" },
];

export function featuresByGroup(group: FeatureGroup): SonicFeature[] {
  return SONIC_FEATURES.filter((f) => f.group === group);
}

export function featureById(id: string): SonicFeature | undefined {
  return SONIC_FEATURES.find((f) => f.id === id);
}
