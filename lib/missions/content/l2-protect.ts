/** Missions on the L2 protection lab (lib/labs/l2-protect-lab.ts: SW1 with DHCP snooping on Vlan10, storm-control on Ethernet3, link state tracking UPLINK Ethernet5 → Ethernet0). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";
import { peekDrops } from "../../control/drops";

const clientIp = (c: CheckCtx) => c.dev("Client").interfaces[0].ipv4[0]?.address ?? "";
const legitLease = (c: CheckCtx) => /^192\.168\.10\.\d+$/.test(clientIp(c));
const snooping = (c: CheckCtx) => c.klish("SW1", "show ip dhcp snooping");

registerMission({
  id: "l2-protect-snoop-storm",
  labId: "l2-protect",
  kind: "mission",
  level: "beginner",
  title: "Rogue DHCP and broadcast storms",
  summary:
    "SW1 protects its access ports: DHCP snooping keeps the Rogue server's offers away from the Client, and storm-control polices broadcasts from the Attacker. Watch both at work, then tighten the Attacker port's broadcast limit to 50 kbps.",
  objectives: [
    {
      id: "lease",
      title: "The Client gets its address from the real DHCP server (192.168.10.x)",
      hints: ["Run `dhclient` on the Client. The Rogue (10.66.66.1) is on a lower port and would answer first without snooping."],
      check: (c) => c.typed("Client", /dhclient/) && legitLease(c),
    },
    {
      id: "binding",
      title: "Find the Client's entry in SW1's snooping binding table",
      hints: ["KLISH on SW1: show ip dhcp snooping binding — built from the ACK seen on the trusted port Ethernet2."],
      check: (c) => c.typed("SW1", /show ip dhcp snooping binding/) && /Total number of Dynamic bindings: [1-9]/.test(c.klish("SW1", "show ip dhcp snooping binding")),
    },
    {
      id: "storm",
      title: "Send a broadcast storm from the Attacker and see SW1 drop it",
      hints: [
        "On the Attacker: arping -b -c 100 192.168.10.1 — every request is a broadcast.",
        "On SW1: `show storm-control`, then in the shell `show interfaces counters` (RX_DRP on Ethernet3).",
      ],
      check: (c) => c.typed("Attacker", /arping\b.*-b/) && (peekDrops(c.dev("SW1"))?.Ethernet3?.STORM_CONTROL ?? 0) > 0,
    },
    {
      id: "tighten",
      title: "Ethernet3's broadcast storm-control is 50 kbps",
      hints: ["configure terminal → interface Ethernet 3 → storm-control broadcast 50"],
      check: (c) => /^Ethernet3\s+broadcast\s+50\s*$/m.test(c.klish("SW1", "show storm-control")),
    },
  ],
  solution: [
    { device: "Client", shell: ["dhclient"] },
    { device: "SW1", shell: ["show ip dhcp snooping binding"] },
    { device: "Attacker", shell: ["arping -b -c 100 192.168.10.1"] },
    { device: "SW1", klish: ["configure terminal", "interface Ethernet 3", "storm-control broadcast 50", "end"] },
  ],
  explanation:
    "DHCP snooping lets server messages (OFFER/ACK) in only on trusted ports; the Rogue's replies on untrusted Ethernet1 were dropped and counted (DHCP_SNOOPING), and the trusted ACK built the binding table that features like IP source guard rely on.\nStorm-control is a per-port token-bucket policer on broadcast traffic: frames above the configured rate are dropped at ingress (STORM_CONTROL drops, RX_DRP), so one host cannot flood the VLAN. Lowering the rate to 50 kbps halves the broadcast budget of that port.",
});

registerMission({
  id: "l2-protect-trouble-no-lease",
  labId: "l2-protect",
  kind: "troubleshoot",
  level: "intermediate",
  title: "The Client gets no address",
  summary:
    "After a security hardening change on SW1, the Client no longer gets an IP address: `dhclient` reports that no offers were received. The DHCP server itself is healthy. Fix it without weakening the protection against the Rogue server.",
  inject(api) {
    api.runCliScript(api.deviceId("SW1"), ["configure terminal", "interface Ethernet 2", "no ip dhcp snooping trust", "end"]);
  },
  objectives: [
    {
      id: "lease",
      title: "The Client holds a 192.168.10.x lease",
      hints: [
        "Offers leave the server but never reach the Client. Where are they dropped? `show dropcounters counts` in SW1's shell: which ports drop?",
        "DHCP snooping drops server messages on untrusted ports. Check which port is trusted: KLISH `show ip dhcp snooping`.",
        "The real server's port Ethernet2 lost its trust: interface Ethernet 2 → ip dhcp snooping trust, then `dhclient` on the Client.",
      ],
      check: legitLease,
    },
    {
      id: "still-protected",
      title: "Snooping is still enabled on Vlan10 and the Rogue's port Ethernet1 is untrusted",
      check: (c) => {
        const s = snooping(c);
        return /DHCP snooping is Enabled/.test(s) && /enabled on the following VLANs:.*Vlan10/.test(s) && !/^Ethernet1\s+Yes/m.test(s);
      },
    },
  ],
  solution: [
    { device: "SW1", klish: ["configure terminal", "interface Ethernet 2", "ip dhcp snooping trust", "end"] },
    { device: "Client", shell: ["dhclient"] },
  ],
  explanation:
    "The trust setting had been removed from Ethernet2, the real server's port. With snooping on Vlan10 every port is untrusted by default, and server-to-client messages (OFFER, ACK) arriving on an untrusted port are dropped — so both servers' offers died at SW1 (DHCP_SNOOPING drops on Ethernet1 and Ethernet2). Trusting only the port where the legitimate server lives restores the leases while the Rogue stays blocked.",
});

registerMission({
  id: "l2-protect-trouble-dark-port",
  labId: "l2-protect",
  kind: "troubleshoot",
  level: "intermediate",
  title: "The Client's port stays dark",
  summary:
    "Since a config clean-up on SW1, the Client's link (SW1 Ethernet0) is down. The cable and the Client's NIC were replaced and are fine, and SW1's uplink to SW2 is up. Bring the Client back online — the port must stay protected by link state tracking.",
  inject(api) {
    api.runCliScript(api.deviceId("SW1"), [
      "configure terminal",
      "interface Ethernet 5",
      "no link state track UPLINK upstream",
      "exit",
      "interface Ethernet 7",
      "link state track UPLINK upstream",
      "end",
    ]);
  },
  objectives: [
    {
      id: "link",
      title: "SW1 Ethernet0 and the Client's NIC are up",
      hints: [
        "Ethernet0 is admin up but oper down, with nothing wrong on the cable. Something on SW1 is holding it down — `show logging` in SW1's shell.",
        "Link state tracking downs its downstream ports when all upstream ports are down: `show link state tracking UPLINK`. Which port is tracked as upstream?",
        "The group tracks the unused Ethernet7 instead of the uplink Ethernet5: interface Ethernet 7 → no link state track UPLINK upstream; interface Ethernet 5 → link state track UPLINK upstream",
      ],
      check: (c) => c.dev("SW1").interfaces.find((i) => i.name === "Ethernet0")?.operState === "up" && c.dev("Client").interfaces[0].operState === "up",
    },
    {
      id: "tracked",
      title: "UPLINK still tracks Ethernet5 upstream and controls Ethernet0",
      check: (c) => {
        const s = c.klish("SW1", "show link state tracking UPLINK");
        return /Upstream Interfaces:\n(\s+\S+ \(\w+\)\n)*\s+Ethernet5 \(Up\)/.test(s) && /Downstream Interfaces:\n\s+Ethernet0 \(Up\)/.test(s);
      },
    },
  ],
  solution: [
    {
      device: "SW1",
      klish: ["configure terminal", "interface Ethernet 7", "no link state track UPLINK upstream", "exit", "interface Ethernet 5", "link state track UPLINK upstream", "end"],
      waitMs: 12000,
    },
  ],
  explanation:
    "The upstream member of link state tracking group UPLINK had been moved from Ethernet5 to Ethernet7, a port with no cable. LST brings the downstream ports down whenever every upstream port is down, so the Client's port was held down even though SW1's real uplink was fine. Tracking Ethernet5 again makes the upstream Up; after the group's 10 s timeout LST releases Ethernet0 and the Client's link returns.",
});
