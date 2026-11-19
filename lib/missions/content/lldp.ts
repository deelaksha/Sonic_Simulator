/** Missions on the LLDP lab (lib/labs/lldp-lab.ts: routedTriangle, lldpd on S1/S2/S3 + MGMT, 30 s tx / 120 s TTL). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";
import { lldpPortMode } from "../../protocols/lldp-daemon";

/** Does `sw`'s Click `show lldp table` list `remote` on `port`? */
const sees = (c: CheckCtx, sw: string, port: string, remote: string) => new RegExp(`^${port}\\s+${remote}\\s`, "m").test(c.shell(sw, "show lldp table"));
const fullMode = (c: CheckCtx, sw: string, port: string) => {
  const m = lldpPortMode(c.dev(sw), port);
  return m.tx && m.rx;
};

registerMission({
  id: "lldp-discover",
  labId: "lldp",
  kind: "mission",
  level: "beginner",
  title: "Map the fabric with LLDP",
  summary:
    "Use LLDP to find out what is plugged into S1, rename S2 so the change shows up on its neighbour, then stop S1 from advertising itself towards the host port Ethernet2 — while keeping LLDP on the fabric links.",
  objectives: [
    {
      id: "table",
      title: "On S1, list the LLDP neighbours: S2 on Ethernet0 and S3 on Ethernet1",
      hints: ["KLISH `show lldp table`, or `exit` to the shell and run `show lldp table` / `show lldp neighbors Ethernet0`."],
      check: (c) => c.typed("S1", /show lldp (table|neighbor)/) && sees(c, "S1", "Ethernet0", "S2") && sees(c, "S1", "Ethernet1", "S3"),
    },
    {
      id: "capture",
      title: "Capture LLDPDUs on one of S1's fabric ports",
      hints: ["From S1's shell: sudo tcpdump -i Ethernet0 -nn -e — LLDP is ethertype 0x88cc sent to 01:80:c2:00:00:0e, one frame every 30 s."],
      check: (c) => c.typed("S1", /tcpdump\b.*-i\s*Ethernet[01]\b/),
    },
    {
      id: "rename",
      title: "S1 now lists its Ethernet0 neighbour as CORE-2",
      hints: [
        "The advertised System Name TLV comes from S2's LLDP configuration, not from S1.",
        "On S2: sonic-cli → configure terminal → lldp system-name CORE-2 (or `sudo config lldp system-name CORE-2` in the shell).",
      ],
      check: (c) => sees(c, "S1", "Ethernet0", "CORE-2"),
    },
    {
      id: "host-port",
      title: "LLDP is off on S1 Ethernet2 (towards H1) and still on Ethernet0/Ethernet1",
      hints: ["Per-port LLDP lives under the interface: interface Ethernet 2 → no lldp enable"],
      check: (c) => {
        const m = lldpPortMode(c.dev("S1"), "Ethernet2");
        return !m.tx && !m.rx && fullMode(c, "S1", "Ethernet0") && fullMode(c, "S1", "Ethernet1");
      },
    },
  ],
  solution: [
    { device: "S1", shell: ["exit", "show lldp table", "sudo tcpdump -i Ethernet0 -nn -e -c 1"] },
    { device: "S2", klish: ["configure terminal", "lldp system-name CORE-2", "end"], waitMs: 2000 },
    { device: "S1", klish: ["configure terminal", "interface Ethernet 2", "no lldp enable", "end"] },
  ],
  explanation:
    "Each lldpd sends an LLDPDU (IEEE 802.1AB) on every enabled port every 30 s; the receiver stores it for TTL = 30 s × hold 4 = 120 s, which is what `show lldp table` lists. Any local change such as the system name triggers an immediate LLDPDU, so S1 saw CORE-2 within a second.\nLLDP reveals model, version and management address, so operators usually disable it on edge ports; `no lldp enable` stops both transmit and receive on that port only.",
});

registerMission({
  id: "lldp-trouble-one-way",
  labId: "lldp",
  kind: "troubleshoot",
  level: "intermediate",
  title: "S2 is missing from S1's neighbour table",
  summary:
    "The topology map built from LLDP shows no link between S1 and S2, yet the cable is in and S2 does list S1 on its Ethernet0. Make the link appear on both sides without changing S1.",
  inject(api) {
    api.runCliScript(api.deviceId("S2"), ["configure terminal", "interface Ethernet 0", "no lldp transmit", "end"]);
  },
  objectives: [
    {
      id: "s1-sees-s2",
      title: "S1 lists S2 on Ethernet0",
      hints: [
        "S2 receives S1's LLDPDUs, but does S1 receive any from S2? Compare `show lldp statistics Ethernet0` on both switches (shell).",
        "S2's Transmitted counter on Ethernet0 stays at 0. Look at S2's per-port LLDP settings: KLISH `show lldp interface Ethernet 0`.",
        "Ethernet0 on S2 is rx-only: interface Ethernet 0 → lldp transmit",
      ],
      check: (c) => sees(c, "S1", "Ethernet0", "S2"),
    },
    {
      id: "s2-sees-s1",
      title: "S2 still lists S1 on Ethernet0",
      check: (c) => sees(c, "S2", "Ethernet0", "S1"),
    },
    {
      id: "s1-untouched",
      title: "S1 Ethernet0 still runs LLDP in rx+tx mode",
      check: (c) => fullMode(c, "S1", "Ethernet0"),
    },
  ],
  solution: [{ device: "S2", klish: ["configure terminal", "interface Ethernet 0", "lldp transmit", "end"], waitMs: 3000 }],
  explanation:
    "S2's Ethernet0 had `no lldp transmit`: lldpd still accepted S1's LLDPDUs but never sent its own, so the neighbour appeared on one side only. LLDP is one-way advertisement — each side only knows what the other transmits (IEEE 802.1AB adminStatus rxOnly). Re-enabling transmit made lldpd send an LLDPDU right away and S1 learned S2.",
});

registerMission({
  id: "lldp-trouble-silent-switch",
  labId: "lldp",
  kind: "troubleshoot",
  level: "intermediate",
  title: "S3 has vanished from discovery",
  summary:
    "Neither S1 nor S2 shows S3 as an LLDP neighbour any more, and S3's own neighbour table is empty. The links between the switches are up. Bring S3 back into the topology map.",
  inject(api) {
    const s3 = api.deviceId("S3");
    api.exec(s3, "exit");
    api.exec(s3, "sudo config feature state lldp disabled");
    api.exec(s3, "sonic-cli");
  },
  objectives: [
    {
      id: "s1",
      title: "S1 lists S3 on Ethernet1",
      hints: [
        "S3 neither sends nor receives LLDP on any port — think beyond one interface. Is lldpd even running? `docker ps` on S3.",
        "`show feature status` on S3 lists the state of every SONiC container.",
        "sudo config feature state lldp enabled",
      ],
      check: (c) => sees(c, "S1", "Ethernet1", "S3"),
    },
    {
      id: "s2",
      title: "S2 lists S3 on Ethernet1",
      check: (c) => sees(c, "S2", "Ethernet1", "S3"),
    },
    {
      id: "s3",
      title: "S3 lists S1 (Ethernet0) and S2 (Ethernet1)",
      check: (c) => sees(c, "S3", "Ethernet0", "S1") && sees(c, "S3", "Ethernet1", "S2"),
    },
  ],
  solution: [{ device: "S3", shell: ["exit", "sudo config feature state lldp enabled"], waitMs: 32000 }],
  explanation:
    "The lldp feature had been disabled on S3, which stops the docker-lldp container: no lldpd, so no LLDPDUs in either direction, and S3's neighbours aged it out. `show feature status` and `docker ps` show it. Enabling the feature restarts lldpd: it sends its first LLDPDUs a few seconds after start (so S1 and S2 relearn S3 at once) and fills its own table as its neighbours send their next periodic LLDPDU, within 30 s.",
});
