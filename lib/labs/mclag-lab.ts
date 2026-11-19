/**
 * MCLAG feature lab: two MCLAG peers (P1, P2) with a peer-link and a routed
 * keepalive link, and a third switch S3 dual-homed to both through PortChannel1.
 *
 *                 10.0.0.1/30  Ethernet2 ──── keepalive (ICCP TCP 8888) ──── Ethernet2  10.0.0.2/30
 *   H1 ─ Ethernet3  P1  Ethernet1 ════════════ peer-link (VLAN 10) ═══════════ Ethernet1  P2  Ethernet3 ─ H2
 *                   Ethernet0 (PortChannel1, mclag 10)          (PortChannel1, mclag 10) Ethernet0
 *                        \                                                       /
 *                         Ethernet0 ─────────── S3 PortChannel1 ─────────── Ethernet1
 *                                               Ethernet2 ─ H3
 *
 * Hosts are in VLAN 10 (192.168.10.0/24): H1 .11 (orphan on P1), H2 .12 (orphan on
 * P2), H3 .13 behind S3. P1 has the lower source IP → ICCP Active (iccp_csm.c:851).
 */
import { registerLab, LabApi } from "./registry";

export interface MclagLab {
  p1: string;
  p2: string;
  s3: string;
  h1: string;
  h2: string;
  h3: string;
}

function peerScript(src: string, peer: string): string[] {
  return [
    "configure terminal",
    "vlan 10",
    "interface Ethernet 2",
    `ip address ${src}/30`,
    "exit",
    "mclag domain 10",
    `source-ip ${src}`,
    `peer-ip ${peer}`,
    "peer-link Ethernet 1",
    "exit",
    "interface PortChannel 1",
    "fast_rate",
    "switchport access Vlan 10",
    "mclag 10",
    "exit",
    "interface Ethernet 0",
    "channel-group 1",
    "exit",
    "interface Ethernet 1",
    "switchport access Vlan 10",
    "exit",
    "interface Ethernet 3",
    "switchport access Vlan 10",
    "exit",
    "end",
  ];
}

export function buildMclagLab(api: LabApi): MclagLab {
  api.newLab();
  const p1 = api.addDevice("switch", { x: 240, y: 120 }, 4);
  const p2 = api.addDevice("switch", { x: 640, y: 120 }, 4);
  const s3 = api.addDevice("switch", { x: 440, y: 380 }, 3);
  const h1 = api.addDevice("pc", { x: 40, y: 120 });
  const h2 = api.addDevice("pc", { x: 840, y: 120 });
  const h3 = api.addDevice("pc", { x: 440, y: 560 });
  [["P1", p1], ["P2", p2], ["S3", s3], ["H1", h1], ["H2", h2], ["H3", h3]].forEach(([n, id]) => api.rename(id, n));
  for (const s of [p1, p2, s3]) api.setPortSpeed(s, 25000);
  [h1, h2, h3].forEach((h, i) => api.setInterfaceIp(h, `${h}-if0`, `192.168.10.${11 + i}`, 24));
  api.connect(p1, `${p1}-if0`, s3, `${s3}-if0`);
  api.connect(p2, `${p2}-if0`, s3, `${s3}-if1`);
  api.connect(p1, `${p1}-if1`, p2, `${p2}-if1`); // peer-link
  api.connect(p1, `${p1}-if2`, p2, `${p2}-if2`); // keepalive
  api.connect(h1, `${h1}-if0`, p1, `${p1}-if3`);
  api.connect(h2, `${h2}-if0`, p2, `${p2}-if3`);
  api.connect(h3, `${h3}-if0`, s3, `${s3}-if2`);
  api.runCliScript(p1, peerScript("10.0.0.1", "10.0.0.2"));
  api.runCliScript(p2, peerScript("10.0.0.2", "10.0.0.1"));
  api.runCliScript(s3, [
    "configure terminal",
    "vlan 10",
    "interface PortChannel 1",
    "fast_rate",
    "switchport access Vlan 10",
    "exit",
    "interface Ethernet 0",
    "channel-group 1",
    "exit",
    "interface Ethernet 1",
    "channel-group 1",
    "exit",
    "interface Ethernet 2",
    "switchport access Vlan 10",
    "exit",
    "end",
  ]);
  return { p1, p2, s3, h1, h2, h3 };
}

registerLab("mclag", (api) => {
  const t = buildMclagLab(api);
  api.hint(t.p1, [
    "MCLAG lab — P1/P2 MCLAG domain 10, S3 dual-homed via PortChannel1 (one LAG to both peers)",
    "ICCP (TCP 8888) comes up over the 10.0.0.0/30 keepalive link within ~2 s; P1 (lower IP) is Active,",
    "P2 Standby rewrites its PortChannel1 MAC to P1's system ID so S3 bonds both links.",
    "Watch:   show mclag brief   |   show mclag interface 1 10   |   show PortChannel summary (on S3)",
    "Packets: tcpdump -i Ethernet2 -nn tcp port 8888   (ICCP heartbeats every 1 s)",
    "Try:     ping H1/H2 from H3; MACs learned on one peer appear on the other (show mac);",
    "         delete P1–S3: traffic to H3 crosses the peer-link and leaves P2 (isolation lifted).",
    "ARP sync: give P1/P2 `interface Vlan 10` addresses, ping P1's from H1 → the ARP entry appears on P2;",
    "         bash: mclagdctl dump arp -i 10 (L = local, R = from the peer)  |  mclagdctl dump mac -i 10",
  ]);
  api.finish("MCLAG — two peers + dual-homed switch", t.p1);
});
