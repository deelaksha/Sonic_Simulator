/**
 * OSPF feature lab on routedTriangle(): area 0 on every routed link (configured
 * as point-to-point, the usual choice for /30 fabric links) and on the host
 * subnets (passive, no Hellos towards hosts). Explicit router-ids 1.1.1.1 /
 * 2.2.2.2 / 3.3.3.3. Every link is 25G, so FRR's auto-cost gives cost 4.
 * `log-adjacency-changes` is configured explicitly (off by default in SONiC's
 * FRR build) so the AdjChg lines show up in `show logging`.
 */
import { registerLab } from "./registry";
import { routedTriangle } from "./topologies";

export const OSPF_LAB_SCRIPTS: Record<"S1" | "S2" | "S3", string[]> = {
  S1: [
    "configure terminal",
    "router ospf",
    "ospf router-id 1.1.1.1",
    "log-adjacency-changes",
    "network 10.0.12.0/30 area 0",
    "network 10.0.13.0/30 area 0",
    "network 192.168.1.0/24 area 0",
    "passive-interface Ethernet2",
    "exit",
    "interface Ethernet 0",
    "ip ospf network point-to-point",
    "exit",
    "interface Ethernet 1",
    "ip ospf network point-to-point",
    "end",
  ],
  S2: [
    "configure terminal",
    "router ospf",
    "ospf router-id 2.2.2.2",
    "log-adjacency-changes",
    "network 10.0.12.0/30 area 0",
    "network 10.0.23.0/30 area 0",
    "exit",
    "interface Ethernet 0",
    "ip ospf network point-to-point",
    "exit",
    "interface Ethernet 1",
    "ip ospf network point-to-point",
    "end",
  ],
  S3: [
    "configure terminal",
    "router ospf",
    "ospf router-id 3.3.3.3",
    "log-adjacency-changes",
    "network 10.0.13.0/30 area 0",
    "network 10.0.23.0/30 area 0",
    "network 192.168.3.0/24 area 0",
    "passive-interface Ethernet2",
    "exit",
    "interface Ethernet 0",
    "ip ospf network point-to-point",
    "exit",
    "interface Ethernet 1",
    "ip ospf network point-to-point",
    "end",
  ],
};

registerLab("ospf", (api) => {
  const t = routedTriangle(api);
  api.runCliScript(t.s1, OSPF_LAB_SCRIPTS.S1);
  api.runCliScript(t.s2, OSPF_LAB_SCRIPTS.S2);
  api.runCliScript(t.s3, OSPF_LAB_SCRIPTS.S3);
  api.hint(t.s1, [
    "OSPF lab: S1 (1.1.1.1), S2 (2.2.2.2), S3 (3.3.3.3) in area 0 — point-to-point /30 links, cost 4 each.",
    "Adjacencies form after the second Hello (~10 s):  show ip ospf neighbor",
    "Routes:  show ip route   ·   show ip ospf route   ·   show ip ospf database",
    "From H1:  ping 192.168.3.10   (S1 → S3 directly, cost 8)",
    "Cut the S1–S3 cable: S1 drops S3 at once and reroutes via S2 (cost 12); reconnect to restore.",
    "Watch the protocol:  tcpdump -i Ethernet0 -nn   (OSPFv2 Hello / DBD / LS-Update / LS-Ack)",
  ]);
  api.finish("OSPF Lab — S1/S2/S3 area 0, H1 ↔ H3", t.s1);
});
