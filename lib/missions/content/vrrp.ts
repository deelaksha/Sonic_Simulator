/** Missions on the VRRP lab (lib/labs/vrrp-lab.ts: S1 prio 120 / S2 prio 100 share VIP 192.168.10.1 on Vlan10 via ACC; S3 + H2 upstream over OSPF). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** VRRP state of vrid 10 on Vlan10 from KLISH `show vrrp` (table row "Vlan10  10  Master  192.168.10.1 …"). */
const vrrpState = (c: CheckCtx, sw: string) => c.klish(sw, "show vrrp").match(/Vlan10\s+10\s+(\w+)\s+(\S+)/)?.slice(1) ?? [];
const isMaster = (c: CheckCtx, sw: string, vip = "192.168.10.1") => {
  const [state, addr] = vrrpState(c, sw);
  return state === "Master" && addr === vip;
};
const isBackup = (c: CheckCtx, sw: string) => vrrpState(c, sw)[0] === "Backup";
const allPortsUp = (c: CheckCtx, sw: string) => c.dev(sw).interfaces.filter((i) => /^Ethernet/.test(i.name)).every((i) => i.adminState === "up");

registerMission({
  id: "vrrp-planned-handover",
  labId: "vrrp",
  kind: "mission",
  level: "beginner",
  title: "Hand the gateway over to S2",
  summary:
    "S1 is today's Master for H1's gateway 192.168.10.1. S1 is due for maintenance: make S2 the active gateway in a controlled way — without shutting any port and without H1 losing its path to H2 (192.168.20.100).",
  objectives: [
    {
      id: "roles",
      title: "Check which gateway is Master for 192.168.10.1 today",
      hints: ["`show vrrp` works in sonic-cli and in the Linux shell; run it on S1 and on S2.", "The State column shows Master on one router and Backup on the other."],
      check: (c) => (c.typed("S1", /show vrrp/) || c.typed("S2", /show vrrp/)) && isMaster(c, "S1"),
    },
    {
      id: "adverts",
      title: "Watch the Master's VRRP advertisements on the LAN",
      hints: ["Only the Master sends advertisements (every 1 s). Capture them on either gateway's Vlan10.", "exit to the Linux shell, then: sudo tcpdump -i Vlan10 -nn -c 3"],
      check: (c) => c.typed("S1", /tcpdump.*Vlan10/) || c.typed("S2", /tcpdump.*Vlan10/),
    },
    {
      id: "s2-master",
      title: "S2 is Master and S1 is Backup, with every port still up",
      hints: [
        "The router with the higher priority wins; S1 has 120, S2 the default 100. Preemption is on by default.",
        "Raise S2's priority above 120 in the VRRP sub-mode of its Vlan10 interface.",
        "S2: configure terminal → interface Vlan 10 → vrrp 10 address-family ipv4 → priority 150",
      ],
      check: (c) => isMaster(c, "S2") && isBackup(c, "S1") && allPortsUp(c, "S1") && allPortsUp(c, "S2"),
    },
    {
      id: "reach",
      title: "H1 still reaches H2 through the virtual gateway",
      check: (c) => c.ping("H1", "192.168.20.100"),
    },
  ],
  solution: [
    { device: "S1", klish: ["show vrrp"] },
    { device: "S1", shell: ["exit", "sudo tcpdump -i Vlan10 -nn -c 3"] },
    { device: "S2", klish: ["configure terminal", "interface Vlan 10", "vrrp 10 address-family ipv4", "priority 150", "end"], waitMs: 6000 },
  ],
  explanation:
    "VRRP elects the router with the highest priority as Master for a virtual router ID; the Master alone answers ARP for the VIP with the virtual MAC 00:00:5e:00:01:0a and sends advertisements every second (RFC 5798 §6.4). With preemption on (the default), a Backup that hears a lower-priority advertisement ignores it, so S2 at 150 lets its Master_Down timer run out and takes over; S1 then hears priority 150, steps down to Backup, and S2's gratuitous ARP moves the vMAC on ACC. H1 keeps using 192.168.10.1, so the handover is invisible to it apart from about 3.6 s of Master_Down_Interval.",
});

registerMission({
  id: "vrrp-trouble-vip",
  labId: "vrrp",
  kind: "troubleshoot",
  level: "beginner",
  title: "H1 lost its default gateway",
  summary:
    "Since this morning H1 (192.168.10.100) cannot reach anything outside its subnet, not even its gateway 192.168.10.1. Both gateways are up and OSPF looks healthy. Restore H1's connectivity without changing S2 or H1.",
  inject(api) {
    api.runCliScript(api.deviceId("S1"), ["configure terminal", "interface Vlan 10", "vrrp 10 address-family ipv4", "no vip 192.168.10.1", "vip 192.168.10.11", "end"]);
  },
  objectives: [
    {
      id: "gateway",
      title: "H1 reaches its gateway 192.168.10.1",
      hints: [
        "From H1, `ping 192.168.10.1` fails with an ARP failure: no router answers for the VIP. Who should?",
        "Compare `show vrrp` on S1 and S2: look at the State and Virtual Address columns.",
        "S1 is Master for vrid 10, but for a different address than the one H1 uses — fix the VIP in S1's `vrrp 10 address-family ipv4` sub-mode.",
      ],
      check: (c) => c.ping("H1", "192.168.10.1"),
    },
    {
      id: "primary",
      title: "S1 is Master for 192.168.10.1 and S2 stays Backup",
      check: (c) => isMaster(c, "S1") && isBackup(c, "S2") && /Vlan10\s+10\s+\w+\s+192\.168\.10\.1\s+100\s/.test(c.klish("S2", "show vrrp")),
    },
    {
      id: "reach",
      title: "H1 reaches H2 (192.168.20.100)",
      check: (c) => c.ping("H1", "192.168.20.100"),
    },
  ],
  solution: [{ device: "S1", klish: ["configure terminal", "interface Vlan 10", "vrrp 10 address-family ipv4", "no vip 192.168.10.11", "vip 192.168.10.1", "end"], waitMs: 3000 }],
  explanation:
    "S1's virtual router 10 carried a mistyped VIP (192.168.10.11). The election is per VRID, not per address, so S2 still heard S1's priority-120 advertisements for vrid 10 and stayed Backup — while the Master owned the wrong address. Nobody answered ARP for 192.168.10.1, so H1 had no gateway. RFC 5798 requires every router of a VRID to be configured with the same address list; `show vrrp` shows the mismatch in the Virtual Address column, and restoring vip 192.168.10.1 on S1 lets the Master answer for the address H1 uses.",
});

registerMission({
  id: "vrrp-trouble-dual-master",
  labId: "vrrp",
  kind: "troubleshoot",
  level: "intermediate",
  title: "Two Masters, no traffic",
  summary:
    "After last night's maintenance H1 can no longer reach H2 (192.168.20.100), and monitoring reports that both S1 and S2 claim to be VRRP Master for 192.168.10.1. Restore a single Master and H1's connectivity without changing the VRRP configuration of S1 or S2.",
  inject(api) {
    api.runCliScript(api.deviceId("ACC"), ["configure terminal", "vlan 20", "interface Ethernet 2", "switchport access Vlan 20", "end"]);
  },
  objectives: [
    {
      id: "single-master",
      title: "Exactly one gateway is Master: S1 Master, S2 Backup",
      hints: [
        "A Backup becomes Master when it stops hearing the Master's advertisements. Does S2 receive S1's adverts? Compare `show vrrp interface Vlan 10` counters (Advertisements Rx) on S2.",
        "VRRP adverts are multicast on the LAN segment between the gateways — follow that segment through ACC: show vlan, show mac address-table.",
        "On ACC, Ethernet2 (towards S2) is an access port in the wrong VLAN; put it back into VLAN 10.",
      ],
      check: (c) => isMaster(c, "S1") && isBackup(c, "S2"),
    },
    {
      id: "reach",
      title: "H1 reaches H2 again",
      hints: ["The return path from H2 may come back through S2 (OSPF has two equal-cost paths), so S2 must reach H1 on VLAN 10 too."],
      check: (c) => c.ping("H1", "192.168.20.100"),
    },
  ],
  solution: [{ device: "ACC", klish: ["configure terminal", "interface Ethernet 2", "switchport access Vlan 10", "exit", "no vlan 20", "end"], waitMs: 5000 }],
  explanation:
    "ACC's port towards S2 had been moved into VLAN 20, so S2's Vlan10 sat on an isolated segment. VRRP advertisements are sent to 224.0.0.18 on the local LAN only; S2 stopped hearing S1, its Master_Down timer expired and it declared itself Master too (split brain, RFC 5798 §6.4.2). Worse, OSPF still offered S3 an equal-cost path back to 192.168.10.0/24 via S2, which could no longer reach H1, so H2's replies were lost. With Ethernet2 back in VLAN 10, S2 hears priority 120 again, returns to Backup, and both return paths work.",
});
