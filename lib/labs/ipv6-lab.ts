/**
 * IPv4/IPv6 ("ipvx") feature lab: routedTriangle() dual-stacked.
 *
 *   S1–S2 2001:db8:12::/64, S2–S3 2001:db8:23::/64, S1–S3 2001:db8:13::/64
 *   (point-to-point OSPFv3 links, RAs suppressed), H1 on 2001:db8:1::/64 behind
 *   S1 Ethernet2 and H3 on 2001:db8:3::/64 behind S3 Ethernet2 (passive,
 *   advertising). The hosts get their IPv6 address by SLAAC (EUI-64) and their
 *   default route from S1/S3's Router Advertisements; OSPFv3 area 0 carries the
 *   host prefixes across the triangle. IPv4 runs the OSPF lab's OSPFv2 config
 *   (OSPF_LAB_SCRIPTS), so H1 reaches H3 over both families.
 */
import { registerLab } from "./registry";
import { routedTriangle } from "./topologies";
import { OSPF_LAB_SCRIPTS } from "./ospf-lab";

const fabric = (n: number, addr: string) => [`interface Ethernet ${n}`, `ipv6 address ${addr}`, "ipv6 nd suppress-ra", "ipv6 ospf6 area 0", "ipv6 ospf6 network point-to-point", "exit"];
const edge = (n: number, addr: string) => [`interface Ethernet ${n}`, `ipv6 address ${addr}`, "ipv6 ospf6 area 0", "ipv6 ospf6 passive", "exit"];
const ospf6 = (rid: string) => ["router ospf6", `ospf6 router-id ${rid}`, "end"];

export const IPV6_LAB_SCRIPTS: Record<"S1" | "S2" | "S3", string[]> = {
  S1: ["configure terminal", ...fabric(0, "2001:db8:12::1/64"), ...fabric(1, "2001:db8:13::1/64"), ...edge(2, "2001:db8:1::1/64"), ...ospf6("1.1.1.1")],
  S2: ["configure terminal", ...fabric(0, "2001:db8:12::2/64"), ...fabric(1, "2001:db8:23::1/64"), ...ospf6("2.2.2.2")],
  S3: ["configure terminal", ...fabric(0, "2001:db8:13::2/64"), ...fabric(1, "2001:db8:23::2/64"), ...edge(2, "2001:db8:3::1/64"), ...ospf6("3.3.3.3")],
};

registerLab("ipvx", (api) => {
  const t = routedTriangle(api);
  api.runCliScript(t.s1, OSPF_LAB_SCRIPTS.S1);
  api.runCliScript(t.s2, OSPF_LAB_SCRIPTS.S2);
  api.runCliScript(t.s3, OSPF_LAB_SCRIPTS.S3);
  api.runCliScript(t.s1, IPV6_LAB_SCRIPTS.S1);
  api.runCliScript(t.s2, IPV6_LAB_SCRIPTS.S2);
  api.runCliScript(t.s3, IPV6_LAB_SCRIPTS.S3);
  api.hint(t.s1, [
    "Dual-stack lab: IPv4 routed by OSPFv2 exactly as in the OSPF lab (ping 192.168.3.10 from H1), plus IPv6 on every link; OSPFv3 area 0 (router-ids 1.1.1.1 / 2.2.2.2 / 3.3.3.3).",
    "S1/S3 Ethernet2 send Router Advertisements (radvd): H1/H3 autoconfigure 2001:db8:1::/64 and 2001:db8:3::/64 by SLAAC (EUI-64).",
    "On H1:  ip -6 addr   ·   ip -6 route   (default via S1's fe80:: link-local, proto ra)",
    "OSPFv3 adjacencies are Full after the second Hello (~10 s):  show ipv6 ospf6 neighbor   ·   show ipv6 ospf6 database",
    "Routes:  show ipv6 route   (O>* 2001:db8:3::/64 [110/8] via fe80::…, Ethernet1)",
    "Then from H1:  ping6 <H3's 2001:db8:3:: address>   ·   traceroute6 <same>",
    "Cut the S1–S3 cable: OSPFv3 reroutes 2001:db8:3::/64 via S2 (cost 12).",
    "Watch:  tcpdump -i Ethernet2 -nn -v   (ICMP6 router advertisement)   ·   tcpdump -i Ethernet0 -nn   (OSPFv3 Hello / LS-Update)",
  ]);
  api.finish("IPv4/IPv6 Lab — dual-stack triangle, SLAAC + OSPFv3", t.h1);
});
