/** Missions on the LACP lab (lib/labs/lacp-lab.ts: S1 ═ PortChannel1 (Ethernet0+1, LACP fast) ═ S2, H1/H2 on S1, H3/H4 on S2, VLAN 10). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";
import { lacpRuntime, lagConfigs } from "../../protocols/lacp-daemon";

const MEMBERS = ["Ethernet0", "Ethernet1"];
/** Members of PortChannel1 collecting/distributing on `sw`. */
const enabled = (c: CheckCtx, sw: string) => MEMBERS.filter((m) => lacpRuntime(c.dev(sw))?.lags.PortChannel1?.ports[m]?.enabled);
const pc = (c: CheckCtx, sw: string) => c.dev(sw).interfaces.find((i) => i.name === "PortChannel1");
const lag = (c: CheckCtx, sw: string) => lagConfigs(c.dev(sw)).find((l) => l.name === "PortChannel1");
const bundled = (c: CheckCtx, sw: string) => enabled(c, sw).length === 2 && pc(c, sw)?.operState === "up";

registerMission({
  id: "lacp-min-links",
  labId: "lacp",
  kind: "mission",
  level: "beginner",
  title: "Make PortChannel1 all-or-nothing",
  summary:
    "S1 and S2 are bonded by a two-member LACP PortChannel. Inspect it, look at the LACPDUs, then configure it so it goes down as a whole when it cannot offer both links — and prove it.",
  objectives: [
    {
      id: "summary",
      title: "On S1, confirm both members are up in PortChannel1",
      hints: ["KLISH `show PortChannel summary` (members flagged (P)), or in the shell `show interfaces portchannel` (members flagged (S))."],
      check: (c) => c.typed("S1", /show (PortChannel summary|interfaces? portchannel)/i) && bundled(c, "S1"),
    },
    {
      id: "lacpdu",
      title: "Capture LACPDUs on a member port",
      hints: ["From S1's shell: sudo tcpdump -i Ethernet0 -nn -v ether proto 0x8809 — one LACPDU per second at fast rate."],
      check: (c) => c.typed("S1", /tcpdump\b.*-i\s*Ethernet[01]\b/),
    },
    {
      id: "min-links",
      title: "min-links 2 on both S1 and S2, PortChannel1 still up with both members",
      hints: [
        "`min-links` is a PortChannel setting: the LAG only carries traffic while at least that many members are active.",
        "On S1 and on S2: configure terminal → interface PortChannel 1 → min-links 2",
      ],
      check: (c) => lag(c, "S1")?.minLinks === 2 && lag(c, "S2")?.minLinks === 2 && bundled(c, "S1") && bundled(c, "S2"),
    },
    {
      id: "prove",
      title: "Shut S1 Ethernet1 and see PortChannel1 go down on S1",
      hints: ["interface Ethernet 1 → shutdown. Check `show PortChannel summary`, then `no shutdown` to restore the link."],
      check: (c) =>
        lag(c, "S1")?.minLinks === 2 &&
        c.dev("S1").interfaces.find((i) => i.name === "Ethernet1")?.adminState === "down" &&
        pc(c, "S1")?.operState === "down",
    },
  ],
  solution: [
    { device: "S1", shell: ["show PortChannel summary", "exit", "sudo tcpdump -i Ethernet0 -nn -v ether proto 0x8809 -c 1"] },
    { device: "S1", klish: ["configure terminal", "interface PortChannel 1", "min-links 2", "end"] },
    { device: "S2", klish: ["configure terminal", "interface PortChannel 1", "min-links 2", "end"], waitMs: 3000 },
    { device: "S1", klish: ["configure terminal", "interface Ethernet 1", "shutdown", "end"], waitMs: 1000 },
    { device: "S1", klish: ["configure terminal", "interface Ethernet 1", "no shutdown", "end"], waitMs: 3000 },
  ],
  explanation:
    "LACP (IEEE 802.1AX) exchanges LACPDUs on every member; a member collects and distributes only once both ends agree (Sync/Collecting/Distributing). By default a PortChannel stays up while one member is active, at reduced bandwidth.\nWith min-links 2 teamd raises carrier only when at least two members are enabled, so losing one link takes the whole LAG down — useful when a half-capacity bundle is worse than failing over to another path. `no shutdown` brings the member back and the LAG up again within a few LACPDUs.",
});

registerMission({
  id: "lacp-trouble-half-capacity",
  labId: "lacp",
  kind: "troubleshoot",
  level: "beginner",
  title: "PortChannel1 runs at half speed",
  summary:
    "Traffic graphs show that PortChannel1 between S1 and S2 carries everything on one cable while the other stays idle, so the bundle runs at half capacity. Both cables are plugged in and both links are up. Restore full capacity.",
  inject(api) {
    api.runCliScript(api.deviceId("S2"), ["configure terminal", "interface Ethernet 1", "no channel-group", "end"]);
  },
  objectives: [
    {
      id: "s1",
      title: "S1: Ethernet0 and Ethernet1 both active in PortChannel1",
      hints: [
        "On S1: `show PortChannel summary` — which member is (D)? Is its link up (`show interface status` in the shell)? `show interface PortChannel 1` lists the LACP partner of each member port.",
        "A member with link up but no LACP partner is deselected. Compare `show PortChannel summary` on S2.",
        "S2's Ethernet1 is not in the bundle: on S2, interface Ethernet 1 → channel-group 1",
      ],
      check: (c) => bundled(c, "S1"),
    },
    {
      id: "s2",
      title: "S2: Ethernet0 and Ethernet1 both active in PortChannel1",
      check: (c) => bundled(c, "S2"),
    },
  ],
  solution: [{ device: "S2", klish: ["configure terminal", "interface Ethernet 1", "channel-group 1", "end"], waitMs: 4000 }],
  explanation:
    "S2's Ethernet1 had been removed from PortChannel1, so it sent no LACPDUs. On S1 the member's link was up but its partner state timed out and fell back to defaults, so LACP never selected it (partner 00:00:00:00:00:00 in `show interface PortChannel 1`) and the bundle carried traffic on Ethernet0 alone. An 802.1AX member only aggregates when both ends exchange LACPDUs with matching partner info; adding the port back to the channel on S2 restarts the exchange and both members become Collecting/Distributing.",
});

registerMission({
  id: "lacp-trouble-mode-mismatch",
  labId: "lacp",
  kind: "troubleshoot",
  level: "intermediate",
  title: "S1 and S2 are cut off",
  summary:
    "After S2 was re-provisioned from a template, H1/H2 cannot reach H3/H4 at all. Both S1–S2 cables are up and S2 reports PortChannel1 as up. S1's configuration is the reference — do not change S1.",
  inject(api) {
    const s2 = api.deviceId("S2");
    api.exec(s2, "exit");
    for (const cmd of [
      "sudo config portchannel member del PortChannel1 Ethernet0",
      "sudo config portchannel member del PortChannel1 Ethernet1",
      "sudo config portchannel del PortChannel1",
      "sudo config portchannel add PortChannel1 --static true",
      "sudo config portchannel member add PortChannel1 Ethernet0",
      "sudo config portchannel member add PortChannel1 Ethernet1",
      "sudo config vlan member add -u 10 PortChannel1",
    ])
      api.exec(s2, cmd);
    api.exec(s2, "sonic-cli");
  },
  objectives: [
    {
      id: "bundle",
      title: "S1's PortChannel1 is up with both members active",
      hints: [
        "On S1: `show PortChannel summary` — both members are (D). Does S1 receive LACPDUs? From the shell: sudo tcpdump -i Ethernet0 -nn ether proto 0x8809, and `show logging` (teamd: \"expired\" → \"defaulted\").",
        "Compare the Protocol column of `show PortChannel summary` on S1 and S2.",
        "S2's PortChannel1 is a static LAG. In S2's shell: delete members and the LAG, then `sudo config portchannel add PortChannel1 --fast-rate true`, re-add Ethernet0/Ethernet1 and `sudo config vlan member add -u 10 PortChannel1`.",
      ],
      check: (c) => bundled(c, "S1") && bundled(c, "S2"),
    },
    {
      id: "reach",
      title: "H1 reaches H3 and H2 reaches H4",
      check: (c) => c.ping("H1", "192.168.10.13") && c.ping("H2", "192.168.10.14"),
    },
    {
      id: "lacp-both",
      title: "Both ends run LACP and S1 is unchanged (no fallback)",
      check: (c) => !!lag(c, "S1") && !lag(c, "S1")!.static && !lag(c, "S1")!.fallback && !!lag(c, "S2") && !lag(c, "S2")!.static,
    },
  ],
  solution: [
    {
      device: "S2",
      shell: [
        "exit",
        "sudo config portchannel member del PortChannel1 Ethernet0",
        "sudo config portchannel member del PortChannel1 Ethernet1",
        "sudo config portchannel del PortChannel1",
        "sudo config portchannel add PortChannel1 --fast-rate true",
        "sudo config portchannel member add PortChannel1 Ethernet0",
        "sudo config portchannel member add PortChannel1 Ethernet1",
        "sudo config vlan member add -u 10 PortChannel1",
      ],
      waitMs: 4000,
    },
  ],
  explanation:
    "S2's PortChannel1 had been created as a static LAG (teamd loadbalance runner): it forwards on every member with link up and never sends LACPDUs. S1 runs LACP, so with no partner its members expired, fell to the defaulted state and were never selected — S1's LAG stayed down while S2 looked healthy. 802.1AX needs LACP on both ends (or static on both); recreating S2's LAG in LACP mode lets the members negotiate and the bundle comes up within about three fast LACPDUs.",
});
