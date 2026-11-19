/** Missions on the BFD lab (lib/labs/bfd-lab.ts: single-hop BFD on the three routed links of S1/S2/S3, 300 ms × 3). */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

/** FRR `show bfd peer <ip>` split into the session part and the remote-timers part. */
const peer = (c: CheckCtx, sw: string, ip: string) => {
  const [local, remote = ""] = c.shell(sw, `show bfd peer ${ip}`).split("Remote timers:");
  return { local, remote };
};
const isUp = (c: CheckCtx, sw: string, ip: string) => /Status: up/.test(peer(c, sw, ip).local);
/** Every session in `show bfd peers brief` is up (and there is at least one). */
const allUp = (c: CheckCtx, sw: string, count: number) => {
  const rows = c.shell(sw, "show bfd peers brief").split("\n").slice(3).filter((l) => l.trim());
  return rows.length === count && rows.every((l) => /\sup\s*$/.test(l));
};
/** `show bfd peers counters` value for one peer. */
const counter = (c: CheckCtx, sw: string, ip: string, name: string) => {
  const block = c.shell(sw, "show bfd peers counters").split(/\n(?=\tpeer )/).find((b) => b.includes(`peer ${ip} `)) ?? "";
  return Number(block.match(new RegExp(`${name}: (\\d+)`))?.[1] ?? -1);
};

registerMission({
  id: "bfd-fast-detection",
  labId: "bfd",
  kind: "mission",
  level: "beginner",
  title: "Detect a failure in 300 ms",
  summary:
    "The S1–S2 link carries latency-sensitive traffic and must detect a failure in 300 ms instead of the default 900 ms. Tune the BFD session on both ends, then prove it works by failing the link and bringing it back.",
  objectives: [
    {
      id: "inspect",
      title: "On S1, list the BFD sessions and confirm both are up",
      hints: ["`exit` sonic-cli to reach the Linux shell (sonic-cli has its own `show bfd peers brief` too).", "show bfd peers brief"],
      check: (c) => c.typed("S1", /show bfd peers? brief/) && allUp(c, "S1", 2),
    },
    {
      id: "tuned",
      title: "The S1–S2 session runs at 100 ms in both directions (detection 3 × 100 ms)",
      hints: [
        "show bfd peer 10.0.12.2 shows Local and Remote timers. The interval actually used is the slower of my transmit and the peer's receive interval, so both ends must change.",
        "Under `bfd` → `peer <ip> interface <if>`: transmit-interval and receive-interval.",
        "S1: bfd → peer 10.0.12.2 interface Ethernet0 → transmit-interval 100 → receive-interval 100; S2: the same under peer 10.0.12.1 interface Ethernet0",
      ],
      check: (c) => {
        const p = peer(c, "S1", "10.0.12.2");
        const fast = (s: string) => /Receive interval: 100ms/.test(s) && /Transmission interval: 100ms/.test(s);
        return /Status: up/.test(p.local) && fast(p.local) && fast(p.remote);
      },
    },
    {
      id: "failed",
      title: "Fail the link: S1 sees the session go down on detection timeout",
      hints: ["Shut S2's side of the link (sonic-cli → interface Ethernet 0 → shutdown) — S1 only notices because BFD packets stop.", "show bfd peer 10.0.12.2 on S1: Diagnostics: control detection time expired"],
      check: (c) => {
        const p = peer(c, "S1", "10.0.12.2").local;
        return /Status: down/.test(p) && /Diagnostics: control detection time expired/.test(p);
      },
    },
    {
      id: "recovered",
      title: "Bring the link back: the session is up again and S1 counted the failure",
      hints: ["no shutdown on S2's Ethernet0.", "show bfd peers counters — 'Session down events' records every failure."],
      check: (c) => isUp(c, "S1", "10.0.12.2") && counter(c, "S1", "10.0.12.2", "Session down events") >= 1,
    },
  ],
  solution: [
    { device: "S1", shell: ["exit", "show bfd peers brief"] },
    { device: "S1", klish: ["configure terminal", "bfd", "peer 10.0.12.2 interface Ethernet0", "transmit-interval 100", "receive-interval 100", "end"] },
    { device: "S2", klish: ["configure terminal", "bfd", "peer 10.0.12.1 interface Ethernet0", "transmit-interval 100", "receive-interval 100", "end"], waitMs: 3000 },
    { device: "S2", klish: ["configure terminal", "interface Ethernet 0", "shutdown", "end"], waitMs: 2000 },
    { device: "S2", klish: ["configure terminal", "interface Ethernet 0", "no shutdown", "end"], waitMs: 4000 },
  ],
  explanation:
    "BFD negotiates its rate per direction: a system transmits at the slower of its own Desired Min TX and the peer's Required Min RX, and declares the session down after Detect Mult × that interval without a packet (RFC 5880 §6.8.4). Changing only S1 would leave S2's 300 ms receive interval in charge, so both ends need 100 ms; the change is applied hitlessly with a Poll/Final exchange. With S2's port shut, S1 stops receiving and drops the session after 300 ms with diagnostic 'control detection time expired'.",
});

registerMission({
  id: "bfd-trouble-admin-down",
  labId: "bfd",
  kind: "troubleshoot",
  level: "beginner",
  title: "BFD to S2 is down, but the link is fine",
  summary:
    "S1's monitoring raises an alarm: its BFD session to S2 (10.0.12.2) is down. The cable is fine and pings between the two switches work. Clear the alarm. S1's configuration is correct — do not change S1.",
  inject(api) {
    api.runCliScript(api.deviceId("S2"), ["configure terminal", "bfd", "peer 10.0.12.1 interface Ethernet0", "shutdown", "end"]);
  },
  objectives: [
    {
      id: "s1-up",
      title: "S1's session to 10.0.12.2 is up",
      hints: [
        "On S1: show bfd peer 10.0.12.2 — read Diagnostics and Remote diagnostics.",
        "'neighbor signaled session down' + remote 'administratively down': S2 is sending AdminDown on purpose. Look at the session on S2 (show bfd peer 10.0.12.1).",
        "On S2: bfd → peer 10.0.12.1 interface Ethernet0 → no shutdown",
      ],
      check: (c) => isUp(c, "S1", "10.0.12.2"),
    },
    {
      id: "s2-up",
      title: "S2's sessions are all up",
      check: (c) => allUp(c, "S2", 2),
    },
  ],
  solution: [{ device: "S2", klish: ["configure terminal", "bfd", "peer 10.0.12.1 interface Ethernet0", "no shutdown", "end"], waitMs: 4000 }],
  explanation:
    "S2's peer 10.0.12.1 had been administratively shut. An AdminDown session keeps telling its neighbour State AdminDown with diagnostic 7, and the neighbour must take its own session Down with diagnostic 3 'neighbor signaled session down' (RFC 5880 §6.8.6) — which S1 reported, while the link and pings were fine. `no shutdown` on S2 restarts the three-way handshake and both sides come Up within a couple of seconds.",
});

registerMission({
  id: "bfd-trouble-peer-address",
  labId: "bfd",
  kind: "troubleshoot",
  level: "intermediate",
  title: "New BFD session S1–S3 never comes up",
  summary:
    "BFD was rolled out on the S1–S3 link, but S1's session to S3 (10.0.13.2) has stayed down since. S1's side was reviewed and is correct — do not change S1.",
  inject(api) {
    api.runCliScript(api.deviceId("S3"), ["configure terminal", "bfd", "no peer 10.0.13.1 interface Ethernet0", "peer 10.0.13.11 interface Ethernet0", "end"]);
  },
  objectives: [
    {
      id: "s1-up",
      title: "S1's session to 10.0.13.2 is up",
      hints: [
        "On S1: show bfd peer 10.0.13.2 — 'Remote ID: 0' means S1 has never received a single packet from S3. show bfd peers counters confirms it (Control packet input).",
        "S3 must run a session towards S1's address 10.0.13.1. Compare with show bfd peers brief on S3.",
        "On S3: bfd → no peer 10.0.13.11 interface Ethernet0 → peer 10.0.13.1 interface Ethernet0",
      ],
      check: (c) => isUp(c, "S1", "10.0.13.2"),
    },
    {
      id: "s3-clean",
      title: "S3 has exactly its two link sessions, both up",
      check: (c) => allUp(c, "S3", 2),
    },
  ],
  solution: [
    { device: "S3", klish: ["configure terminal", "bfd", "no peer 10.0.13.11 interface Ethernet0", "peer 10.0.13.1 interface Ethernet0", "end"], waitMs: 4000 },
  ],
  explanation:
    "S3 had been configured with `peer 10.0.13.11` — a typo — so it sent its BFD packets to an address nobody owns and never answered S1. A single-hop session is identified by the peer address and interface (RFC 5881 §3), and S1's packets for 10.0.13.2 matched no session on S3. With the correct peer 10.0.13.1 both ends exchange discriminators and the session moves Down → Init → Up.",
});
