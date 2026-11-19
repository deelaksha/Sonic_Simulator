/** Missions on the L3 services lab (lib/labs/l3-services-lab.ts: S1 edge with NAPT to 100.64.0.1, PBR for H2, IP SLA-tracked default route; S2 = ISP with WEB). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

const natTable = (c: CheckCtx) => c.shell("S1", "show nat translations");
/** S1 has a default route via this next hop (the tracked primary or the floating backup). */
const defaultVia = (c: CheckCtx, nh: string) => c.dev("S1").routingTable.some((r) => r.destination === "0.0.0.0" && r.prefix === 0 && r.nextHop === nh && (r.vrf ?? "default") === "default");
/** `show ip sla` row for SLA 1: state + target. */
const sla1 = (c: CheckCtx) => c.klish("S1", "show ip sla").match(/^1\s+ICMP-echo\s+(\w+)\s+(\S+)/m)?.slice(1) ?? [];

registerMission({
  id: "l3svc-port-forward",
  labId: "l3-services",
  kind: "mission",
  level: "beginner",
  title: "Publish H2's SSH through NAT",
  summary:
    "S1 hides both LANs behind 100.64.0.1 (NAPT). Watch a dynamic translation being created, then publish H2's SSH service (192.168.2.10 port 22) on the outside as 100.64.0.1 port 2222 so WEB can connect to it.",
  objectives: [
    {
      id: "dynamic",
      title: "Open a TCP connection from H1 to WEB port 80 and find its translation on S1",
      hints: [
        "From H1: nc -z 203.0.113.10 80 — ICMP is translated too but only TCP/UDP flows are listed.",
        "On S1 (sonic-cli or Linux shell): show nat translations — look for 192.168.1.10:<port> translated to 100.64.0.1:<20000-29999>.",
      ],
      check: (c) => c.typed("S1", /show nat trans/) && /192\.168\.1\.10:\d+\s+---\s+100\.64\.0\.1:2\d{4}\b/.test(natTable(c)),
    },
    {
      id: "listener",
      title: "Start an SSH-like listener on H2 port 22",
      hints: ["On H2: nc -l 22 (it keeps listening in the background)."],
      check: (c) => c.typed("H2", /nc\s+(-\w+\s+)*-l\w*\s+22\b|nc\s+-l\s*-p\s*22\b/),
    },
    {
      id: "static",
      title: "S1 has a static NAPT entry 100.64.0.1:2222 → 192.168.2.10:22",
      hints: [
        "The existing entry for H1's web server is in sonic-cli: `show nat config static`.",
        "configure terminal → nat → static tcp 100.64.0.1 2222 192.168.2.10 22",
      ],
      check: (c) => /---\s+100\.64\.0\.1:2222\s+---\s+192\.168\.2\.10:22\b/.test(natTable(c)),
    },
    {
      id: "reach",
      title: "WEB connects to 100.64.0.1 port 2222",
      hints: ["From WEB: nc -z 100.64.0.1 2222 (each connection uses up one `nc -l` on H2 — restart it if needed)."],
      check: (c) => /succeeded/.test(c.shell("WEB", "nc -z 100.64.0.1 2222")),
    },
  ],
  solution: [
    { device: "H1", shell: ["nc -z 203.0.113.10 80"] },
    { device: "S1", klish: ["show nat translations"] },
    { device: "H2", shell: ["nc -l 22"] },
    { device: "S1", klish: ["configure terminal", "nat", "static tcp 100.64.0.1 2222 192.168.2.10 22", "end"], waitMs: 2000 },
  ],
  explanation:
    "Dynamic NAPT rewrites an inside source (192.168.1.10:45000) to the pool address and a free port (100.64.0.1:20000) when a flow crosses from zone 0 to zone 1, and keeps the mapping so replies can be translated back. A connection from outside has no such state, so the router would not know which inside host owns 100.64.0.1:2222 — a static NAPT entry creates the mapping in advance (SONiC STATIC_NAPT, `static tcp <global-ip> <global-port> <local-ip> <local-port>`), translating the destination on the way in and the source on the way out.",
});

registerMission({
  id: "l3svc-trouble-nat-zone",
  labId: "l3-services",
  kind: "troubleshoot",
  level: "intermediate",
  title: "No Internet on the primary uplink",
  summary:
    "Users behind S1 can no longer reach WEB (203.0.113.10): pings and TCP connections from H1 time out, although S1's routes and the IP SLA look normal. The ISP (S2) must not be changed.",
  inject(api) {
    api.runCliScript(api.deviceId("S1"), ["configure terminal", "interface Ethernet 0", "no nat-zone", "end"]);
  },
  objectives: [
    {
      id: "reach",
      title: "H1 reaches WEB (ping and TCP port 80)",
      hints: [
        "Open a TCP connection from H1 (nc -z 203.0.113.10 80) and check `show nat translations` on S1 — is a dynamic entry created?",
        "Capture on S2 (exit, sudo tcpdump -i Ethernet0 -nn): which source address do H1's packets carry when they reach the ISP? S2 only routes 100.64.0.0/24 back to you.",
        "NAPT only happens when a packet crosses from zone 0 to another zone. Compare `show nat config zones` with the uplinks the default route uses — Ethernet0 needs `nat-zone 1`.",
      ],
      check: (c) => c.ping("H1", "203.0.113.10") && /succeeded/.test(c.shell("H1", "nc -z 203.0.113.10 80")),
    },
    {
      id: "primary",
      title: "Traffic still uses the primary uplink (default route via 10.0.12.2)",
      check: (c) => defaultVia(c, "10.0.12.2") && sla1(c)[0] === "Up",
    },
  ],
  solution: [{ device: "S1", klish: ["configure terminal", "interface Ethernet 0", "nat-zone 1", "end"], waitMs: 2000 }],
  explanation:
    "SONiC NAT translates a packet only when it is routed from one NAT zone to another: the inside interfaces keep the default zone 0 and the uplinks must be in zone 1. Ethernet0 had lost its `nat-zone 1`, so packets leaving through the primary uplink stayed in zone 0 and went out untranslated with source 192.168.1.10; S2 had no route back to the private LANs and dropped the replies (visible in S2's RX_DROPS). `show nat config zones` lists the zone per interface; restoring zone 1 on Ethernet0 brings back the dynamic translations.",
});

registerMission({
  id: "l3svc-trouble-sla",
  labId: "l3-services",
  kind: "troubleshoot",
  level: "intermediate",
  title: "Everything rides the backup link",
  summary:
    "The ISP reports that all of our traffic arrives on the backup link (S1 Ethernet1) even though the primary link (Ethernet0) is up and clean. Users notice nothing yet. Put traffic back on the primary while keeping automatic failover to the backup; don't change S2.",
  inject(api) {
    api.runCliScript(api.deviceId("S1"), ["configure terminal", "ip sla 1", "icmp-echo 10.0.12.6", "end"]);
  },
  objectives: [
    {
      id: "primary",
      title: "S1's active default route points to 10.0.12.2",
      hints: [
        "`show ip route` on S1: only the distance-200 backup default route is installed. The primary is `track 1` — what does the tracker say?",
        "`show ip sla` and `show ip sla 1`: which address does the probe ping, and does it exist on the primary link (10.0.12.0/30)?",
        "Fix the probe target: configure terminal → ip sla 1 → icmp-echo 10.0.12.2.",
      ],
      check: (c) => defaultVia(c, "10.0.12.2"),
    },
    {
      id: "tracked",
      title: "IP SLA 1 probes the primary next hop 10.0.12.2 and is Up; the backup route is still configured",
      check: (c) => {
        const [state, target] = sla1(c);
        return state === "Up" && target === "10.0.12.2" && c.dev("S1").routingTable.some((r) => r.destination === "0.0.0.0" && r.prefix === 0 && r.nextHop === "10.0.13.2" && r.distance === 200);
      },
    },
  ],
  solution: [{ device: "S1", klish: ["configure terminal", "ip sla 1", "icmp-echo 10.0.12.2", "end"], waitMs: 12000 }],
  explanation:
    "The primary default route is installed only while IP SLA 1 reports Up (`ip route 0.0.0.0/0 10.0.12.2 track 1`). The probe had been pointed at 10.0.12.6, an address outside the primary /30, so every echo failed, the SLA stayed Down, the tracked route was withdrawn and the floating static (distance 200) via 10.0.13.2 carried everything. With the probe back on the real next hop the SLA comes Up after the next probe interval (frequency 5 s), the distance-1 route wins again, and a real failure of 10.0.12.2 still fails over to the backup.",
});
