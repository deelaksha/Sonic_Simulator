/**
 * BGP feature lab on routedTriangle(): three eBGP speakers, one AS each, every
 * switch peering with both others over its point-to-point /30s and advertising
 * its host subnet (configured through KLISH exactly as an operator would).
 *
 *   S1 AS65001 (1.1.1.1) — 192.168.1.0/24 (H1)
 *   S2 AS65002 (2.2.2.2) — transit only
 *   S3 AS65003 (3.3.3.3) — 192.168.3.0/24 (H3)
 */
import { registerLab } from "./registry";
import { routedTriangle } from "./topologies";

function bgpScript(as: number, rid: string, peers: [string, number][], networks: string[]): string[] {
  const lines = ["configure terminal", `router bgp ${as}`, `router-id ${rid}`];
  for (const [ip, ras] of peers) lines.push(`neighbor ${ip}`, `remote-as ${ras}`, "exit");
  if (networks.length) lines.push("address-family ipv4 unicast", ...networks.map((n) => `network ${n}`), "exit");
  lines.push("end");
  return lines;
}

registerLab("bgp", (api) => {
  const t = routedTriangle(api);
  api.runCliScript(t.s1, bgpScript(65001, "1.1.1.1", [["10.0.12.2", 65002], ["10.0.13.2", 65003]], ["192.168.1.0/24"]));
  api.runCliScript(t.s2, bgpScript(65002, "2.2.2.2", [["10.0.12.1", 65001], ["10.0.23.2", 65003]], []));
  api.runCliScript(t.s3, bgpScript(65003, "3.3.3.3", [["10.0.13.1", 65001], ["10.0.23.1", 65002]], ["192.168.3.0/24"]));
  api.hint(t.s1, [
    "BGP lab — eBGP triangle: S1 AS65001 · S2 AS65002 · S3 AS65003",
    "Sessions come up by themselves (TCP/179 handshake → OPEN → KEEPALIVE → Established).",
    "1. show ip bgp summary          — three neighbors per switch, State/PfxRcd = prefixes",
    "2. show ip bgp                  — 192.168.3.0/24: *> via 10.0.13.2 (65003) beats 10.0.12.2 (65002 65003)",
    "3. show ip route                — B>* 192.168.3.0/24 [20/0] via 10.0.13.2",
    "4. On H1: ping 192.168.3.10     — reaches H3 across the ASes",
    "5. sudo tcpdump -i Ethernet0 -nn -v port 179   — KEEPALIVEs every 60 s, UPDATEs on change",
    "6. Cut the S1–S3 cable: fast-external-failover resets the session at once and",
    "   192.168.3.0/24 reroutes via AS 65002 (show ip bgp / show ip route / ping again)",
    "7. Reconnect the cable: the session re-establishes on the next connect retry",
  ]);
  api.finish("BGP Lab — eBGP triangle AS65001/65002/65003", t.s1);
});
