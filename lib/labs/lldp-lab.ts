/**
 * LLDP feature lab on routedTriangle(): lldpd runs on S1/S2/S3 (front-panel
 * ports + eth0) and on the MGMT switch; hosts do not run it. Defaults from
 * dockers/docker-lldp/lldpmgrd:38-39 — 30 s tx-interval, hold 4 → TTL 120 s.
 */
import { registerLab } from "./registry";
import { routedTriangle } from "./topologies";

registerLab("lldp", (api) => {
  const t = routedTriangle(api);
  api.hint(t.s1, [
    "LLDP lab — lldpd on S1/S2/S3 and MGMT (hosts H1/H3/NMS do not run LLDP)",
    "First LLDPDUs leave ~5 s after boot, then every 30 s (TTL 120 s = 30 s x hold 4).",
    "Watch:   show lldp table   |   show lldp neighbors Ethernet0   |   show lldp statistics",
    "Packets: sudo tcpdump -i Ethernet0 -nn -e   (ethertype 0x88cc to 01:80:c2:00:00:0e)",
    "Try:     config lldp no-transmit on S2 → S1 keeps S2 until the 120 s TTL expires;",
    "         shut S1 Ethernet0 → its neighbour is removed at once (link down).",
    "         config lldp system-name CORE-1 → a new LLDPDU goes out immediately.",
  ]);
  api.finish("LLDP — link layer discovery (lldpd)", t.s1);
});
