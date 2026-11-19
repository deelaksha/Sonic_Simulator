/**
 * Missions on the ACL lab (lib/labs/acl-lab.ts: routedTriangle, static routes
 * H1 192.168.1.10 ⇄ H3 192.168.3.10 over S1 Ethernet1 ↔ S3; IPv4 ACL H1-POLICY
 * pre-configured on S1 but not bound).
 */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

const INGRESS = /Ingress IP access-list H1-POLICY on Ethernet2/;
const boundIn = (c: CheckCtx) => INGRESS.test(c.klish("S1", "show ip access-group"));
/** `nc -z` from H1: "refused" = the SYN reached H3 (RST back), "timed out" = dropped on the way. */
const nc = (c: CheckCtx, port: number) => c.shell("H1", `nc -zv -w 1 192.168.3.10 ${port}`);
const reachesPort = (c: CheckCtx, port: number) => /refused|succeeded/.test(nc(c, port));
const blockedPort = (c: CheckCtx, port: number) => /timed out/.test(nc(c, port));

/** Value of an installed debug drop counter (extra column after TX_DROPS) on a port, -1 if none. */
function debugDrops(c: CheckCtx, port: string): number {
  const lines = c.shell("S1", "show dropcounters counts").split("\n");
  const hdr = lines[0]?.trim().split(/\s{2,}/) ?? [];
  if (hdr.length <= 6) return -1;
  const row = lines.find((l) => l.trim().startsWith(port + " "))?.trim().split(/\s{2,}/);
  return Number(row?.[hdr.length - 1] ?? -1);
}

registerMission({
  id: "acl-bind-and-count",
  labId: "acl",
  kind: "mission",
  level: "beginner",
  title: "Apply an ACL and read its drops",
  summary:
    "S1 carries an IPv4 ACL called H1-POLICY, but nothing enforces it yet. Bind it to H1's port, then use rule counters and drop counters to see what it drops. Finally, an approved change lets H1 ping H3 again while HTTP to H3 stays blocked.",
  objectives: [
    {
      id: "bind",
      title: "Bind H1-POLICY inbound on S1 Ethernet2. H1 can no longer ping H3",
      hints: [
        "Read the policy first: `show ip access-lists H1-POLICY` in sonic-cli on S1. An ACL does nothing until you bind it to an interface.",
        "Bind it in the interface's configuration mode, in the direction the traffic enters S1 (from H1, that's inbound).",
        "configure terminal → interface Ethernet 2 → ip access-group H1-POLICY in. Then on H1: ping 192.168.3.10",
      ],
      check: (c) => boundIn(c) && !c.ping("H1", "192.168.3.10"),
    },
    {
      id: "debug-counter",
      title: "Install a drop counter for reason ACL_ANY on S1 and watch it count H1's pings",
      hints: [
        "`exit` sonic-cli and run `show dropcounters counts`. RX_DROPS on Ethernet2 goes up, but it doesn't tell you why.",
        "A debug drop counter counts only the reasons you give it: `config dropcounters install <name> PORT_INGRESS_DROPS <reasons>`. A new counter starts at 0, so ping again after you install it.",
        "config dropcounters install ACLDROP PORT_INGRESS_DROPS ACL_ANY, then on H1 run ping -c 2 192.168.3.10, then on S1 run show dropcounters counts",
      ],
      check: (c) => debugDrops(c, "Ethernet2") > 0 && /ACL_ANY/.test(c.shell("S1", "show dropcounters configuration")),
    },
    {
      id: "which-rule",
      title: "Find the rule that matched: its packet counter in show ip access-lists",
      hints: [
        "Once an ACL is bound, every rule has a packets/bytes counter (`show ip access-lists` in sonic-cli, or `aclshow -a` in the shell).",
        "ACL rules are evaluated in seq order and the first match wins. Which seq counted your pings?",
      ],
      check: (c) =>
        (c.typed("S1", /show ip access-lists|aclshow/)) &&
        /seq 10 deny icmp .*\(([1-9]\d*) packets\)/.test(c.klish("S1", "show ip access-lists H1-POLICY")),
    },
    {
      id: "allow-ping",
      title: "Change approved: H1 can ping H3 again, TCP/80 stays blocked, and the ACL stays bound",
      hints: [
        "Edit the ACL itself, not the binding: `configure terminal` → `ip access-list H1-POLICY`.",
        "Remove the rule that denies ICMP (or put a more specific permit before it). seq 20 (HTTP) must stay.",
        "ip access-list H1-POLICY → no seq 10. Check with `nc -zv -w 1 192.168.3.10 80` on H1: it should time out, while ping works.",
      ],
      check: (c) => boundIn(c) && c.ping("H1", "192.168.3.10") && blockedPort(c, 80) && reachesPort(c, 22),
    },
  ],
  solution: [
    { device: "S1", shell: ["show ip access-lists H1-POLICY"] },
    { device: "S1", klish: ["configure terminal", "interface Ethernet 2", "ip access-group H1-POLICY in", "end"] },
    { device: "H1", shell: ["ping -c 2 192.168.3.10"] },
    { device: "S1", shell: ["exit", "show dropcounters counts", "config dropcounters install ACLDROP PORT_INGRESS_DROPS ACL_ANY"] },
    { device: "H1", shell: ["ping -c 2 192.168.3.10"] },
    { device: "S1", shell: ["show dropcounters counts", "aclshow -a"] },
    { device: "S1", klish: ["configure terminal", "ip access-list H1-POLICY", "no seq 10", "end"] },
  ],
  explanation:
    "An ACL is just a list until it is bound. `ip access-group H1-POLICY in` on Ethernet2 installs it in the ingress ACL stage of H1's port, so every IPv4 packet from H1 is checked against the rules in seq order and the first match decides. Your pings matched seq 10, and the per-rule counters show that.\nPort drop counters only say that packets were dropped. A debug counter (`config dropcounters install … ACL_ANY`) uses the SAI drop reason to show that the ACL dropped them, which is how you rule out routing or CoPP drops. Removing seq 10 lets ICMP fall through to `permit ip any any`, while seq 20 still drops TCP/80.",
});

registerMission({
  id: "acl-trouble-order",
  labId: "acl",
  kind: "troubleshoot",
  level: "beginner",
  title: "The new permit rule does nothing",
  summary:
    "Change CR-2231 was approved: the monitoring host H1 (192.168.1.10) must be able to ping H3 (192.168.3.10). Last night an engineer added a permit for it to H1-POLICY on S1, but H1's pings still fail. HTTP (TCP/80) from H1 to H3 must stay blocked, and the policy must stay bound.",
  inject(api) {
    api.runCliScript(api.deviceId("S1"), [
      "configure terminal",
      "ip access-list H1-POLICY",
      "seq 50 permit icmp host 192.168.1.10 host 192.168.3.10",
      "exit",
      "interface Ethernet 2",
      "ip access-group H1-POLICY in",
      "end",
    ]);
  },
  objectives: [
    {
      id: "ping",
      title: "H1 can ping H3",
      hints: [
        "Ping from H1, then look at S1: `show ip access-lists H1-POLICY`. Which rule's packet counter goes up?",
        "ACL rules are evaluated in ascending seq and the first match wins. A permit placed after a matching deny is never reached.",
        "In ip access-list H1-POLICY, move the permit in front of the deny (e.g. `seq 5 permit icmp host 192.168.1.10 host 192.168.3.10` and `no seq 50`), or remove seq 10.",
      ],
      check: (c) => c.ping("H1", "192.168.3.10"),
    },
    {
      id: "http-blocked",
      title: "TCP/80 from H1 to H3 is still dropped, and SSH (TCP/22) still passes",
      hints: ["On H1: `nc -zv -w 1 192.168.3.10 80` should time out. Port 22 should say 'refused' (H3 answers with a reset, so the SYN got through)."],
      check: (c) => blockedPort(c, 80) && reachesPort(c, 22),
    },
    {
      id: "bound",
      title: "H1-POLICY is still bound inbound on Ethernet2",
      check: boundIn,
    },
  ],
  solution: [
    {
      device: "S1",
      klish: ["configure terminal", "ip access-list H1-POLICY", "no seq 50", "seq 5 permit icmp host 192.168.1.10 host 192.168.3.10", "end"],
    },
  ],
  explanation:
    "The new rule was added as seq 50, but seq 10 (`deny icmp host 192.168.1.10 host 192.168.3.10`) matches the same packets first. SONiC turns seq into ACL rule priority (higher seq, lower priority), and the first matching rule is final, so the per-rule counters showed every ping hitting seq 10 while seq 50 stayed at 0. Giving the permit a lower seq than the deny (seq 5) makes it match first. The HTTP deny at seq 20 is untouched.",
});

registerMission({
  id: "acl-trouble-direction",
  labId: "acl",
  kind: "troubleshoot",
  level: "intermediate",
  title: "The ACL is bound but filters nothing",
  summary:
    "Security audit finding: H1 can still ping H3 and open TCP/80 on it, although S1's H1-POLICY is supposed to block exactly that. `show ip access-lists` shows the ACL with live counters. SSH and other traffic from H1 to H3 must keep working.",
  inject(api) {
    api.runCliScript(api.deviceId("S1"), ["configure terminal", "interface Ethernet 2", "ip access-group H1-POLICY out", "end"]);
  },
  objectives: [
    {
      id: "icmp-blocked",
      title: "H1's pings to H3 are dropped",
      hints: [
        "Look at the counters in `show ip access-lists H1-POLICY` while H1 pings. The deny rules stay at 0. Which rule does count, and which packets are those?",
        "`show ip access-group` shows where the ACL is bound and in which direction. The policy describes traffic from H1, which enters S1 on Ethernet2.",
        "Rebind it: interface Ethernet 2 → no ip access-group H1-POLICY out → ip access-group H1-POLICY in",
      ],
      check: (c) => !c.ping("H1", "192.168.3.10"),
    },
    {
      id: "http-blocked",
      title: "TCP/80 from H1 to H3 is dropped",
      hints: ["`nc -zv -w 1 192.168.3.10 80` on H1 times out when the SYN is dropped, and says 'refused' when it reaches H3."],
      check: (c) => blockedPort(c, 80),
    },
    {
      id: "rest-allowed",
      title: "SSH (TCP/22) and other TCP ports (e.g. 443) from H1 still reach H3",
      check: (c) => reachesPort(c, 22) && reachesPort(c, 443),
    },
  ],
  solution: [
    {
      device: "S1",
      klish: ["configure terminal", "interface Ethernet 2", "no ip access-group H1-POLICY out", "ip access-group H1-POLICY in", "end"],
    },
  ],
  explanation:
    "H1-POLICY was bound egress on Ethernet2 (`show ip access-group`: 'Egress IP access-list'). In that direction it only sees packets S1 sends towards H1, which are H3's replies with source 192.168.3.10. They never match the deny rules (source 192.168.1.x) and fall through to `permit ip any any`, so only seq 40 counted. An ACL filters in the stage it is bound to, so a policy written for H1's traffic has to be bound ingress on H1's port.",
});
