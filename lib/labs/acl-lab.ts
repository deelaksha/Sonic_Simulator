/**
 * ACL feature lab on routedTriangle(): static routes make H1 (192.168.1.10,
 * behind S1 Ethernet2) and H3 (192.168.3.10, behind S3 Ethernet2) reach each
 * other over S1 Ethernet1 ↔ S3 Ethernet0. S1 carries a ready-made IPv4 ACL
 * (KLISH acl.xml) that is NOT bound yet, so traffic flows until the student
 * applies it with `ip access-group ... in` on Ethernet2.
 */
import { registerLab } from "./registry";
import { routedTriangle } from "./topologies";

export const ACL_LAB_ACL = [
  "ip access-list H1-POLICY",
  "remark Block ping and HTTP from H1 to H3, allow the rest",
  "seq 10 deny icmp host 192.168.1.10 host 192.168.3.10",
  "seq 20 deny tcp 192.168.1.0/24 host 192.168.3.10 eq 80",
  "seq 30 permit tcp 192.168.1.0/24 any eq 22",
  "seq 40 permit ip any any",
  "exit",
];

registerLab("acl", (api) => {
  const t = routedTriangle(api);
  api.runCliScript(t.s1, ["configure terminal", "ip route 192.168.3.0/24 10.0.13.2", ...ACL_LAB_ACL, "end"]);
  api.runCliScript(t.s3, ["configure terminal", "ip route 192.168.1.0/24 10.0.13.1", "end"]);
  api.hint(t.s1, [
    "ACL lab — IPv4 ACL H1-POLICY is configured on S1 but not bound yet",
    "First:   ping 192.168.3.10 from H1 works (static routes S1 ⇄ S3).",
    "Bind:    configure terminal → interface Ethernet 2 → ip access-group H1-POLICY in",
    "Then:    H1 ping 192.168.3.10 fails (seq 10); a TCP SYN to port 80 is dropped (seq 20),",
    "         port 22 still passes (seq 30). Use the traffic generator on H1 for TCP.",
    "Watch:   show ip access-lists H1-POLICY   (per-rule packets/bytes once bound)",
    "         show ip access-group | show acl table | show acl rule",
    "Try:     no seq 40 → only SSH passes: the implicit deny drops every other IPv4 packet",
    "         (ARP is not IPv4, so it still resolves). clear ip access-list counters.",
    "Undo:    no ip access-group H1-POLICY in — traffic flows again.",
  ]);
  api.finish("ACL — access control lists", t.s1);
});
