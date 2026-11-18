/**
 * VRF feature lab: the routed triangle with S1's host LAN (Ethernet2) and its
 * link to S3 (Ethernet1) in Vrf-red, and a static route in that VRF toward H3.
 * S3 routes back to H1 over the same link. S2 (default VRF on S1) is not
 * reachable from Vrf-red — that is the isolation to observe.
 */
import { registerLab } from "./registry";
import { routedTriangle } from "./topologies";

registerLab("vrf", (api) => {
  const t = routedTriangle(api);
  api.runCliScript(t.s1, [
    "configure terminal",
    "ip vrf Vrf-red",
    "interface Ethernet 2",
    "ip vrf forwarding Vrf-red",
    "exit",
    "interface Ethernet 1",
    "ip vrf forwarding Vrf-red",
    "exit",
    "ip route vrf Vrf-red 192.168.3.0/24 10.0.13.2",
    "end",
  ]);
  api.runCliScript(t.s3, ["configure terminal", "ip route 192.168.1.0/24 10.0.13.1", "end"]);
  api.hint(t.s1, [
    "VRF lab — S1: Ethernet2 (H1 LAN) and Ethernet1 (to S3) are in Vrf-red; Ethernet0 (to S2) is default",
    "1. show ip vrf                       — Vrf-red and its member interfaces",
    "2. show ip route vrf Vrf-red         — connected + S 192.168.3.0/24 via 10.0.13.2",
    "   show ip route                     — default VRF: only Ethernet0 / eth0 networks",
    "3. From H1: ping 192.168.3.10        — works, routed inside Vrf-red",
    "   From H1: ping 10.0.12.2           — fails: S2 is only in the default VRF",
    "4. exit to bash: ping -I Vrf-red 192.168.1.10   (ping without -I has no route)",
  ]);
  api.finish("VRF: S1 Vrf-red (Ethernet1, Ethernet2) — S3; S2 in default", t.s1);
});
