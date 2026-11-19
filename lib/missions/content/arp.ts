/** Missions on the ARP lab (lib/labs/arp-lab.ts: SW1 Vlan10 192.168.10.1/24, PC1-PC3 192.168.10.11-13 on Ethernet0-2). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** MAC a device has cached for `ip` (lower-case), if any. */
const cached = (c: CheckCtx, dev: string, ip: string) => c.dev(dev).arpTable.find((e) => e.ip === ip && e.state !== "incomplete")?.mac.toLowerCase();
const nicMac = (c: CheckCtx, dev: string) => c.dev(dev).interfaces[0].mac.toLowerCase();
const sviMac = (c: CheckCtx) => c.dev("SW1").interfaces.find((i) => i.name === "Vlan10")!.mac.toLowerCase();

registerMission({
  id: "arp-gratuitous-move",
  labId: "arp",
  kind: "mission",
  level: "beginner",
  title: "Move an IP address with gratuitous ARP",
  summary:
    "A service address 192.168.10.12 lives on PC2 today. Let PC1 and SW1 cache it, then move it to PC3 and watch their caches follow without a single new ARP request.",
  objectives: [
    {
      id: "host-cache",
      title: "PC1 caches 192.168.10.12 with PC2's MAC — read PC1's ARP cache",
      hints: ["From PC1: ping -c 1 192.168.10.12, then `arp -n` (or `ip neigh`)."],
      check: (c) => c.typed("PC1", /\b(arp\b|ip neigh)/) && cached(c, "PC1", "192.168.10.12") === nicMac(c, "PC2"),
    },
    {
      id: "switch-cache",
      title: "SW1 also caches 192.168.10.12 — read SW1's ARP table",
      hints: [
        "SW1 only learns a host that talks to its SVI: from PC2, ping the gateway 192.168.10.1.",
        "On SW1: KLISH `show ip arp`, or `exit` to the shell and `show arp` (it also shows the FDB port).",
      ],
      check: (c) => c.typed("SW1", /show (ip )?arp/) && cached(c, "SW1", "192.168.10.12") === nicMac(c, "PC2"),
    },
    {
      id: "move",
      title: "192.168.10.12 now lives on PC3 only, and PC1 and SW1 already point it at PC3's MAC",
      hints: [
        "Optional: start `sudo tcpdump -i eth0 -nn arp` on PC1 first to see the announcement.",
        "On PC2: sudo ip addr del 192.168.10.12/24 dev eth0 — on PC3: sudo ip addr add 192.168.10.12/24 dev eth0",
        "Do not ping .12 again before checking: `arp -n` on PC1 and `show ip arp` on SW1 should already show PC3's MAC.",
      ],
      check: (c) =>
        !c.dev("PC2").interfaces[0].ipv4.some((a) => a.address === "192.168.10.12") &&
        c.dev("PC3").interfaces[0].ipv4.some((a) => a.address === "192.168.10.12") &&
        cached(c, "PC1", "192.168.10.12") === nicMac(c, "PC3") &&
        cached(c, "SW1", "192.168.10.12") === nicMac(c, "PC3"),
    },
    {
      id: "reach",
      title: "PC1 reaches 192.168.10.12 on its new home",
      check: (c) => c.ping("PC1", "192.168.10.12"),
    },
  ],
  solution: [
    { device: "PC1", shell: ["ping -c 1 192.168.10.12", "arp -n"] },
    { device: "PC2", shell: ["ping -c 1 192.168.10.1"] },
    { device: "SW1", shell: ["show ip arp"] },
    { device: "PC2", shell: ["sudo ip addr del 192.168.10.12/24 dev eth0"] },
    { device: "PC3", shell: ["sudo ip addr add 192.168.10.12/24 dev eth0"] },
  ],
  explanation:
    "ARP (RFC 826) resolves on demand and both ends cache the result, so PC1 and SW1 kept PC2's MAC for .12. When PC3 configured the address it broadcast a gratuitous ARP — a request for its own IP with its own MAC as sender. Every host that already has an entry for that IP overwrites it with the sender's MAC (RFC 5227 §3 announcements), which is how failover pairs and VRRP move an address in milliseconds instead of waiting for caches to age out.",
});

registerMission({
  id: "arp-trouble-isolated-host",
  labId: "arp",
  kind: "troubleshoot",
  level: "beginner",
  title: "PC3 is on its own",
  summary:
    "PC3 was re-cabled during a desk move. Since then it cannot reach its gateway 192.168.10.1 or the other PCs, although its link is up and its IP settings were not touched. PC1 and PC2 are fine.",
  inject(api) {
    api.runCliScript(api.deviceId("SW1"), ["configure terminal", "vlan 20", "interface Ethernet 2", "switchport access Vlan 20", "end"]);
  },
  objectives: [
    {
      id: "gateway",
      title: "PC3 reaches its gateway 192.168.10.1",
      hints: [
        "Ping the gateway from PC3, then look at `ip neigh` on PC3: is the gateway's MAC ever resolved?",
        "An unanswered ARP request means the broadcast never reaches the SVI. Compare PC3's switch port with the others: `show vlan brief` on SW1.",
        "Ethernet2 is an access port in the wrong VLAN: interface Ethernet 2 → switchport access Vlan 10",
      ],
      check: (c) => c.ping("PC3", "192.168.10.1"),
    },
    {
      id: "peers",
      title: "PC3 reaches PC1 (192.168.10.11)",
      check: (c) => c.ping("PC3", "192.168.10.11"),
    },
  ],
  solution: [{ device: "SW1", klish: ["configure terminal", "interface Ethernet 2", "switchport access Vlan 10", "end"], waitMs: 2000 }],
  explanation:
    "SW1's Ethernet2 had been made an access port of VLAN 20. An ARP request is a broadcast and a switch floods it only inside the VLAN it arrived in (IEEE 802.1Q), so PC3's requests for 192.168.10.1 never reached Vlan10 or the other PCs and stayed INCOMPLETE. Putting the port back in VLAN 10 puts PC3 in the same broadcast domain as its subnet, and ARP resolves at the next ping.",
});

registerMission({
  id: "arp-trouble-stale-gateway",
  labId: "arp",
  kind: "troubleshoot",
  level: "intermediate",
  title: "PC2 lost its gateway after maintenance",
  summary:
    "PC2 talks to PC1 and PC3 without problems, but every ping to its default gateway 192.168.10.1 times out. The other PCs reach the gateway fine. Fix PC2 without changing SW1.",
  inject(api) {
    api.exec(api.deviceId("PC2"), "sudo ip neigh add 192.168.10.1 lladdr 02:00:00:00:aa:01 dev eth0");
  },
  objectives: [
    {
      id: "gateway",
      title: "PC2 reaches 192.168.10.1",
      hints: [
        "The ping reports a timeout, not 'Host Unreachable': PC2 believes it knows where the gateway is. Check `ip neigh` on PC2.",
        "Compare the MAC PC2 uses for 192.168.10.1 with the one PC1 learns (`ping -c 1 192.168.10.1` then `arp -n` on PC1). Note the PERMANENT flag on PC2.",
        "A static neighbour never ages or gets corrected by ARP. Remove it: sudo ip neigh del 192.168.10.1 dev eth0",
      ],
      check: (c) => c.ping("PC2", "192.168.10.1"),
    },
    {
      id: "correct-mac",
      title: "PC2's neighbour entry for the gateway is SW1's real Vlan10 MAC",
      check: (c) => cached(c, "PC2", "192.168.10.1") === sviMac(c),
    },
  ],
  solution: [{ device: "PC2", shell: ["sudo ip neigh del 192.168.10.1 dev eth0", "ping -c 1 192.168.10.1"] }],
  explanation:
    "PC2 carried a static (PERMANENT) neighbour entry for 192.168.10.1 pointing at an old MAC — typical after a gateway is replaced. Linux never re-ARPs for a permanent entry, so PC2 kept sending its frames to a MAC nobody owns and SW1 never saw them. Deleting the entry lets PC2 ARP normally; the reply from Vlan10 installs the real MAC and the gateway answers.",
});
