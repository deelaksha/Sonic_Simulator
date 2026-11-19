/**
 * Missions on the ARP lab (lib/labs/arp-lab.ts, registered as "arp" and
 * "arpnd": SW1 Vlan10 192.168.10.1/24, PC1–PC3 192.168.10.11–13 on
 * Ethernet0–2). Hosts age neighbours with Linux's 30 s base_reachable_time,
 * SW1's SVI with SONiC's 1800 s.
 */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";
import { peekFeatureState } from "../../models/feature-state";
import { ArpRuntime, ARP_RT } from "../../protocols/arp";

const hasArp = (c: CheckCtx, dev: string, ip: string) => c.dev(dev).arpTable.some((e) => e.ip === ip);
const owners = (c: CheckCtx, ip: string) => Object.values(c.net.devices).filter((d) => d.interfaces.some((i) => i.ipv4.some((a) => a.address === ip))).length;

registerMission({
  id: "arpnd-cache-aging",
  labId: "arpnd",
  kind: "mission",
  level: "beginner",
  title: "Follow an ARP entry from birth to STALE",
  summary:
    "Watch ARP resolve an address on a host and on the switch, change how long SW1 keeps its entries, and watch a host's entry age from REACHABLE to STALE.",
  objectives: [
    {
      id: "host-cache",
      title: "Ping PC2 from PC1, then show PC1's ARP cache",
      hints: ["On PC1: `ping -c 1 192.168.10.12`, then `ip neigh` (or `arp -n`). The entry maps PC2's IP to its MAC, state REACHABLE."],
      check: (c) => c.typed("PC1", /ip neigh|ip n\b|arp -n|\barp$/) && hasArp(c, "PC1", "192.168.10.12"),
    },
    {
      id: "switch-cache",
      title: "Make SW1 learn PC1, then find PC1 in SW1's ARP table",
      hints: [
        "SW1 only learns a host when it talks to SW1 itself (its gateway 192.168.10.1). PC1 → PC2 traffic is switched and SW1's ARP table never sees it.",
        "On PC1: `ping -c 1 192.168.10.1`. On SW1: `show ip arp` in sonic-cli, or `show arp` in the shell, which also lists the FDB port.",
      ],
      check: (c) => c.typed("SW1", /show (ip )?arp/) && hasArp(c, "SW1", "192.168.10.11"),
    },
    {
      id: "timeout",
      title: "Set SW1's ARP aging on Vlan10 to 300 seconds",
      hints: [
        "SONiC keeps SVI neighbours for 1800 s, much longer than a Linux host's 30 s. The timer is set per interface.",
        "sonic-cli → configure terminal → interface Vlan 10 → ip arp timeout 300",
      ],
      check: (c) => peekFeatureState<ArpRuntime>(c.dev("SW1"), ARP_RT)?.timeouts?.Vlan10 === 300,
    },
    {
      id: "stale",
      title: "Wait until PC1's entry for PC2 turns STALE, and show it",
      hints: [
        "Linux keeps an unused entry REACHABLE for about base_reachable_time (30 s), then marks it STALE. A STALE entry is still used, and the next packet triggers a re-check.",
        "Wait half a minute, then run `ip neigh` on PC1 again.",
      ],
      check: (c) => c.typed("PC1", /ip neigh|arp -n/) && /^192\.168\.10\.12 .*STALE/m.test(c.shell("PC1", "ip neigh")),
    },
  ],
  solution: [
    { device: "PC1", shell: ["ping -c 1 192.168.10.12", "ip neigh"] },
    { device: "PC1", shell: ["ping -c 1 192.168.10.1"] },
    { device: "SW1", shell: ["show ip arp"] },
    { device: "SW1", klish: ["configure terminal", "interface Vlan 10", "ip arp timeout 300", "end"], waitMs: 35000 },
    { device: "PC1", shell: ["ip neigh"] },
  ],
  explanation:
    "ARP (RFC 826) maps an IPv4 address to a MAC with a broadcast request and a unicast reply, and both ends cache the result. PC1 resolved PC2 directly because they share the subnet. SW1 learned PC1 only once PC1 talked to the SVI. The Linux neighbour state machine marks an entry STALE after base_reachable_time (30 s on hosts) and re-checks it on next use. SONiC raises the SVI default to 1800 s so that a router with thousands of hosts doesn't keep re-ARPing them. `ip arp timeout` on the interface sets that timer (base_reachable_time) per SVI.",
});

registerMission({
  id: "arpnd-trouble-static",
  labId: "arpnd",
  kind: "troubleshoot",
  level: "intermediate",
  title: "PC2 can't reach its gateway",
  summary:
    "PC2 (192.168.10.12) can talk to PC1 and PC3, but not to its default gateway 192.168.10.1 on SW1. PC1 and PC3 reach the gateway fine. PC2's cabling and IP settings were checked twice. Don't change PC2.",
  inject(api) {
    api.runCliScript(api.deviceId("SW1"), ["configure terminal", "interface Vlan 10", "ip arp 192.168.10.12 00:11:22:33:44:55", "end"]);
  },
  objectives: [
    {
      id: "gateway",
      title: "PC2 can ping 192.168.10.1",
      hints: [
        "PC2's request reaches SW1, but does the reply come back? Compare PC2's MAC (`ip link` on PC2) with what SW1 has for 192.168.10.12 (`show ip arp` / `show arp`).",
        "The entry is of type STATIC, and in `show arp` it has no FDB port. A static entry is never refreshed by ARP replies and survives `clear ip arp`.",
        "Delete it at SW1's Linux shell: sudo ip neigh del 192.168.10.12 dev Vlan10. SW1 then resolves PC2 dynamically again.",
      ],
      check: (c) => c.ping("PC2", "192.168.10.1"),
    },
    {
      id: "correct-mac",
      title: "SW1 has no wrong entry for 192.168.10.12 (any entry must carry PC2's MAC)",
      check: (c) => {
        const mac = c.dev("PC2").interfaces[0].mac.toLowerCase();
        return c.dev("SW1").arpTable.filter((e) => e.ip === "192.168.10.12").every((e) => e.mac.toLowerCase() === mac);
      },
    },
    {
      id: "pc2-unchanged",
      title: "PC2 still uses 192.168.10.12",
      check: (c) => c.dev("PC2").interfaces[0].ipv4.some((a) => a.address === "192.168.10.12"),
    },
  ],
  solution: [{ device: "SW1", shell: ["exit", "show arp", "sudo ip neigh del 192.168.10.12 dev Vlan10"] }],
  explanation:
    "Someone had configured a static ARP entry on SW1 mapping 192.168.10.12 to 00:11:22:33:44:55, a MAC that doesn't exist in VLAN 10. PC2's echo requests reached SW1, but SW1 sent every reply to the bogus MAC, and the switch flooded those frames as unknown unicast where PC2 discarded them. PC2 ↔ PC1/PC3 traffic never needs SW1's ARP table, so it kept working. A static (PERMANENT) neighbour overrides ARP: replies never update it and `clear ip arp` keeps it. Deleting it lets SW1 learn PC2's real MAC with a normal request/reply.",
});

registerMission({
  id: "arpnd-trouble-duplicate",
  labId: "arpnd",
  kind: "troubleshoot",
  level: "intermediate",
  title: "A new PC and a vanishing neighbour",
  summary:
    "Since a new workstation was plugged into SW1 port Ethernet2 (PC3), users say PC2 (192.168.10.12) drops their sessions at random. On top of that, nobody can reach 192.168.10.13, the address IPAM assigned to that new workstation.",
  inject(api) {
    const pc3 = api.deviceId("PC3");
    api.exec(pc3, "ip addr del 192.168.10.13/24 dev eth0");
    api.exec(pc3, "ip addr add 192.168.10.12/24 dev eth0");
  },
  objectives: [
    {
      id: "pc3-reachable",
      title: "PC1 can ping 192.168.10.13",
      hints: [
        "Ping 192.168.10.12 from PC1 a few times and watch `ip neigh` on PC1 and `show arp` / `show mac address-table` on SW1. Does the MAC (and port) behind .12 stay the same?",
        "`arping -D -c 2 192.168.10.12` on PC1 checks whether someone answers for an address. Then look at `ip addr` on the machines in the VLAN.",
        "PC3 is configured with PC2's address. On PC3: ip addr del 192.168.10.12/24 dev eth0, then ip addr add 192.168.10.13/24 dev eth0",
      ],
      check: (c) => c.ping("PC1", "192.168.10.13"),
    },
    {
      id: "unique",
      title: "Only one machine owns 192.168.10.12, and PC1 reaches it",
      check: (c) => owners(c, "192.168.10.12") === 1 && c.ping("PC1", "192.168.10.12"),
    },
  ],
  solution: [{ device: "PC3", shell: ["ip addr", "ip addr del 192.168.10.12/24 dev eth0", "ip addr add 192.168.10.13/24 dev eth0"] }],
  explanation:
    "PC3 had been configured with 192.168.10.12, PC2's address. Both hosts answered ARP for it, so the neighbours' caches (and SW1's ARP/FDB view of .12) kept flipping between the two MACs, and sessions to PC2 broke whenever traffic landed on PC3. Nobody answers ARP for .13, so it was simply unreachable. ARP has no ownership check of its own. Duplicate address detection with arping -D (RFC 5227) is how you find a conflict. Giving PC3 its assigned .13 makes every address unique again.",
});
