/** Missions on the MCLAG lab (lib/labs/mclag-lab.ts: P1/P2 domain 10, peer-link Ethernet1, keepalive 10.0.0.0/30 on Ethernet2, S3 dual-homed via PortChannel1; H1 .11 on P1, H2 .12 on P2, H3 .13 on S3). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";
import { mclagRuntime } from "../../protocols/mclag-daemon";
import { lacpRuntime } from "../../protocols/lacp-daemon";

const session = (c: CheckCtx) => !!mclagRuntime(c.dev("P1"))?.session && !!mclagRuntime(c.dev("P2"))?.session;
/** S3 bundles both uplinks (one to each peer) into its PortChannel1. */
const dualHomed = (c: CheckCtx) => ["Ethernet0", "Ethernet1"].every((m) => lacpRuntime(c.dev("S3"))?.lags.PortChannel1?.ports[m]?.enabled);
const svi = (c: CheckCtx, sw: string, ip: string) => c.dev(sw).interfaces.find((i) => i.name === "Vlan10")?.ipv4.some((a) => a.address === ip) ?? false;

registerMission({
  id: "mclag-explore",
  labId: "mclag",
  kind: "mission",
  level: "intermediate",
  title: "One LAG, two switches",
  summary:
    "S3 sees P1 and P2 as a single LACP partner. Check the ICCP session and S3's bundle, then give both peers an address in VLAN 10 and show that an ARP entry learned on P1 is synchronised to P2.",
  objectives: [
    {
      id: "iccp",
      title: "On P1, confirm the MCLAG session is up",
      hints: ["KLISH `show mclag brief` — look at Role, Session Status and the MLAG interface state."],
      check: (c) => c.typed("P1", /show mclag brief/) && session(c),
    },
    {
      id: "s3-bundle",
      title: "On S3, confirm both uplinks are active in PortChannel1",
      hints: ["S3: `show PortChannel summary`. It works because P2 (Standby) advertises P1's system MAC in its LACPDUs."],
      check: (c) => c.typed("S3", /show (PortChannel summary|interfaces? portchannel)/i) && dualHomed(c),
    },
    {
      id: "arp-sync",
      title: "P1 Vlan10 = 192.168.10.1, P2 Vlan10 = 192.168.10.2, and P2 holds H1's ARP entry synced from P1",
      hints: [
        "On each peer: configure terminal → interface Vlan 10 → ip address 192.168.10.1/24 (P2: 192.168.10.2/24).",
        "Make P1 learn H1: from H1, ping -c 1 192.168.10.1.",
        "Check P2's `show ip arp`, or in the shell `mclagdctl dump arp -i 10` — R marks entries received from the peer.",
      ],
      check: (c) => svi(c, "P1", "192.168.10.1") && svi(c, "P2", "192.168.10.2") && !!mclagRuntime(c.dev("P2"))?.installedArps?.["192.168.10.11"],
    },
    {
      id: "reach",
      title: "H3 reaches both orphan hosts H1 and H2",
      check: (c) => c.ping("H3", "192.168.10.11") && c.ping("H3", "192.168.10.12"),
    },
  ],
  solution: [
    { device: "P1", shell: ["show mclag brief"] },
    { device: "S3", shell: ["show PortChannel summary"] },
    { device: "P1", klish: ["configure terminal", "interface Vlan 10", "ip address 192.168.10.1/24", "end"] },
    { device: "P2", klish: ["configure terminal", "interface Vlan 10", "ip address 192.168.10.2/24", "end"] },
    { device: "H1", shell: ["ping -c 1 192.168.10.1"] },
  ],
  explanation:
    "P1 and P2 run ICCP (RFC 7275) over TCP 8888 on the keepalive link. The Standby rewrites its PortChannel MAC to the Active's system ID, so S3 receives identical LACP actor information on both uplinks and aggregates them into one LAG.\nICCP also synchronises MACs and ARP entries: P1 learned H1 on Vlan10 and sent it to P2, which installed it (flag R) — so either peer can route for a host the other learned, without re-ARPing after a failover.",
});

registerMission({
  id: "mclag-trouble-session",
  labId: "mclag",
  kind: "troubleshoot",
  level: "intermediate",
  title: "S3's uplink LAG lost a leg",
  summary:
    "S3 is dual-homed to P1 and P2, but its PortChannel1 only uses one uplink — the other is up yet not bundled, so a failure of P1 would isolate H3. Restore the dual-homing.",
  inject(api) {
    api.runCliScript(api.deviceId("P2"), ["configure terminal", "mclag domain 10", "peer-ip 10.0.0.5", "end"]);
  },
  objectives: [
    {
      id: "session",
      title: "The MCLAG session is up on P1 and P2",
      hints: [
        "S3's second member is deselected because it sees two different LACP partners. Why would P2 stop presenting P1's system MAC? Check `show mclag brief` on both peers.",
        "Session Status is down. Compare Source/Peer Address on each side with the keepalive link addresses (10.0.0.1 and 10.0.0.2); `mclagdctl dump state -i 10` in the shell agrees.",
        "P2's peer address is wrong: mclag domain 10 → peer-ip 10.0.0.1",
      ],
      check: session,
    },
    {
      id: "dual-homed",
      title: "S3 bundles both uplinks in PortChannel1",
      check: dualHomed,
    },
  ],
  solution: [{ device: "P2", klish: ["configure terminal", "mclag domain 10", "peer-ip 10.0.0.1", "end"], waitMs: 5000 }],
  explanation:
    "P2's peer-ip pointed at 10.0.0.5, so iccpd connected to an address nobody owns and the ICCP session never came up. Without a session P2 keeps its own PortChannel MAC, S3 sees two different LACP partner systems and 802.1AX only aggregates the links that share one partner — one uplink stays out. With the correct peer address ICCP establishes, P2 adopts P1's system ID and S3 bundles both links.",
});

registerMission({
  id: "mclag-trouble-peer-link",
  labId: "mclag",
  kind: "troubleshoot",
  level: "advanced",
  title: "H1 and H2 cannot see each other",
  summary:
    "H1 (on P1) and H2 (on P2) can no longer reach each other, and H3 has lost some of its paths too. The MCLAG session and S3's LAG look healthy. Restore full reachability in VLAN 10.",
  inject(api) {
    const p2 = api.deviceId("P2");
    api.exec(p2, "exit");
    api.exec(p2, "sudo config vlan member del 10 Ethernet1");
    api.exec(p2, "sonic-cli");
  },
  objectives: [
    {
      id: "orphans",
      title: "H1 and H2 reach each other",
      hints: [
        "Traffic between the two orphan hosts can only cross the peer-link (Ethernet1). Is the peer-link forwarding VLAN 10 on both peers?",
        "Compare `show vlan brief` on P1 and P2.",
        "P2's peer-link left VLAN 10: interface Ethernet 1 → switchport access Vlan 10",
      ],
      check: (c) => c.ping("H1", "192.168.10.12") && c.ping("H2", "192.168.10.11"),
    },
    {
      id: "h3",
      title: "H3 reaches H1 and H2",
      check: (c) => c.ping("H3", "192.168.10.11") && c.ping("H3", "192.168.10.12"),
    },
    {
      id: "healthy",
      title: "MCLAG session up and S3 still dual-homed",
      check: (c) => session(c) && dualHomed(c),
    },
  ],
  solution: [{ device: "P2", klish: ["configure terminal", "interface Ethernet 1", "switchport access Vlan 10", "end"], waitMs: 2000 }],
  explanation:
    "P2's peer-link Ethernet1 had been removed from VLAN 10. ICCP runs over the separate keepalive link, so the session stayed up and S3 kept both uplinks, but no VLAN 10 frame could cross between the peers: H1↔H2 broke, and any H3 flow hashed to the peer that does not own the destination was dropped. The peer-link must carry every MCLAG VLAN so the peers can forward to orphan ports and to each other; adding it back restores those paths.",
});
