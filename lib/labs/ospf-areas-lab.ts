/**
 * OSPF multi-area lab: a backbone with two ABRs, a stub area and an NSSA with
 * an external network redistributed by the NSSA ASBR.
 *
 *   H1 10.1.1.10                                                   EXT 198.51.100.10
 *    | Ethernet2 10.1.1.1/24                         Ethernet2 198.51.100.1/24 |
 *   S1 ──10.1.12.0/30── S2 ──10.0.23.0/30── S3 ──10.2.34.0/30── S4
 *   └──── area 1 (stub) ───┘└──── area 0 ────┘└──── area 2 (NSSA) ────┘
 *         1.1.1.1         ABR 2.2.2.2     ABR 3.3.3.3        ASBR 4.4.4.4
 *
 * S2 summarizes area 1 with `area 1 range 10.1.0.0/16`; S4 redistributes the
 * connected 198.51.100.0/24 (type-7, P-bit) which S3 translates to type-5.
 * S1 (stub) only gets the inter-area summaries plus a default route from S2.
 */
import { registerLab } from "./registry";

const p2p = (ifs: number[]) => ifs.flatMap((i) => [`interface Ethernet ${i}`, "ip ospf network point-to-point", "exit"]);

export const OSPF_AREAS_SCRIPTS: Record<"S1" | "S2" | "S3" | "S4", string[]> = {
  S1: [
    "configure terminal",
    ...p2p([0]),
    "router ospf",
    "ospf router-id 1.1.1.1",
    "log-adjacency-changes",
    "network 10.1.12.0/30 area 1",
    "network 10.1.1.0/24 area 1",
    "area 1 stub",
    "passive-interface Ethernet2",
    "end",
  ],
  S2: [
    "configure terminal",
    ...p2p([0, 1]),
    "router ospf",
    "ospf router-id 2.2.2.2",
    "log-adjacency-changes",
    "network 10.1.12.0/30 area 1",
    "network 10.0.23.0/30 area 0",
    "area 1 stub",
    "area 1 range 10.1.0.0/16",
    "end",
  ],
  S3: [
    "configure terminal",
    ...p2p([0, 1]),
    "router ospf",
    "ospf router-id 3.3.3.3",
    "log-adjacency-changes",
    "network 10.0.23.0/30 area 0",
    "network 10.2.34.0/30 area 2",
    "area 2 nssa",
    "end",
  ],
  S4: [
    "configure terminal",
    ...p2p([0]),
    "router ospf",
    "ospf router-id 4.4.4.4",
    "log-adjacency-changes",
    "network 10.2.34.0/30 area 2",
    "area 2 nssa",
    "redistribute connected",
    "end",
  ],
};

registerLab("ospf-areas", (api) => {
  api.newLab();
  const s = [0, 1, 2, 3].map((i) => api.addDevice("switch", { x: 120 + i * 230, y: 160 }, 4));
  const h1 = api.addDevice("pc", { x: 120, y: 400 });
  const ext = api.addDevice("server", { x: 810, y: 400 });
  s.forEach((id, i) => {
    api.rename(id, `S${i + 1}`);
    api.setPortSpeed(id, 25000);
  });
  api.rename(h1, "H1");
  api.rename(ext, "EXT");
  const ip = (dev: string, idx: number, a: string, p: number) => api.setInterfaceIp(dev, `${dev}-if${idx}`, a, p);
  ip(s[0], 0, "10.1.12.1", 30);
  ip(s[1], 0, "10.1.12.2", 30);
  ip(s[1], 1, "10.0.23.1", 30);
  ip(s[2], 0, "10.0.23.2", 30);
  ip(s[2], 1, "10.2.34.1", 30);
  ip(s[3], 0, "10.2.34.2", 30);
  ip(s[0], 2, "10.1.1.1", 24);
  ip(s[3], 2, "198.51.100.1", 24);
  ip(h1, 0, "10.1.1.10", 24);
  ip(ext, 0, "198.51.100.10", 24);
  api.setDefaultGateway(h1, "10.1.1.1");
  api.setDefaultGateway(ext, "198.51.100.1");
  api.connect(s[0], `${s[0]}-if0`, s[1], `${s[1]}-if0`);
  api.connect(s[1], `${s[1]}-if1`, s[2], `${s[2]}-if0`);
  api.connect(s[2], `${s[2]}-if1`, s[3], `${s[3]}-if0`);
  api.connect(h1, `${h1}-if0`, s[0], `${s[0]}-if2`);
  api.connect(ext, `${ext}-if0`, s[3], `${s[3]}-if2`);
  api.runCliScript(s[0], OSPF_AREAS_SCRIPTS.S1);
  api.runCliScript(s[1], OSPF_AREAS_SCRIPTS.S2);
  api.runCliScript(s[2], OSPF_AREAS_SCRIPTS.S3);
  api.runCliScript(s[3], OSPF_AREAS_SCRIPTS.S4);
  api.hint(s[1], [
    "OSPF areas lab: S1 —area 1 (stub)— S2 —area 0— S3 —area 2 (NSSA)— S4 —EXT 198.51.100.0/24 (redistributed)",
    "Adjacencies are Full after ~10 s. On S2 (ABR, 'area 1 range 10.1.0.0/16'):",
    "  show ip ospf                       — 'This router is an ABR', one block per area",
    "  show ip ospf database              — Router LSAs per area, Summary LSAs, AS External (translated by S3)",
    "  show ip ospf database summary      — type-3 detail;  show ip ospf database external",
    "  show ip ospf route                 — N / N IA networks, ABR/ASBR router table, N E2 external",
    "On S1 (stub): show ip route         — only O 10.0.x/10.2.x IA summaries and the default 0.0.0.0/0 from S2",
    "On S3 (translator): show ip ospf database nssa-external   — S4's type-7 with the P-bit (N/P)",
    "On S4: show ip route                — O 10.1.0.0/16 (the range) instead of the area-1 /30 and /24",
    "  (S4's redistribute connected also exports eth0's 192.168.100.0/24 — FRR does that without a route-map)",
    "From H1: ping 198.51.100.10        (stub default → S2 → E2 route via S3 → S4)",
    "Try on S2: area 1 stub no-summary   then on S1: show ip route   (totally stubby: default only)",
  ]);
  api.finish("OSPF Areas — stub area 1, backbone, NSSA area 2 + external", s[1]);
});
