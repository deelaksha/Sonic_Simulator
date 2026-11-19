/**
 * Missions on the SNMP lab (lib/labs/snmp-lab.ts: routedTriangle; S1–S3 run
 * snmpd with communities public (ro) / private (rw), link traps on and v2c trap
 * host 192.168.100.250 = NMS, which runs snmptrapd). Switch management
 * addresses: S1 192.168.100.1, S2 .2, S3 .3.
 */
import { registerMission } from "../registry";
import { CheckCtx } from "../check";

const get = (c: CheckCtx, community: string, ip: string, oid: string) => c.shell("NMS", `snmpget -v2c -c ${community} ${ip} ${oid}`);
/** snmptrapd's log holds a linkDown/linkUp trap sent from this agent address. */
const linkTrapFrom = (c: CheckCtx, ip: string) =>
  new RegExp(`\\[UDP: \\[${ip.replace(/\./g, "\\.")}\\][^\\n]*\\n[^\\n]*link(Down|Up)`).test(c.shell("NMS", "snmptrapd -l"));
const adminUp = (c: CheckCtx, sw: string, port: string) => c.dev(sw).interfaces.find((i) => i.name === port)?.adminState === "up";

registerMission({
  id: "snmp-poll-and-trap",
  labId: "snmp",
  kind: "mission",
  level: "beginner",
  title: "Poll, secure and trap with SNMP",
  summary:
    "The NMS (192.168.100.250) manages S1–S3 over SNMP v2c. Poll S1, change what it reports, replace the well-known community 'public' on S1 with a private one, and make S1 send a link trap that the NMS receives.",
  objectives: [
    {
      id: "walk",
      title: "From the NMS, walk S1's system group (192.168.100.1)",
      hints: ["On the NMS: `snmpwalk -v2c -c public 192.168.100.1 system`. sysName, sysLocation and sysUpTime come from S1's snmpd."],
      check: (c) => c.typed("NMS", /snmp(bulk)?walk .*192\.168\.100\.1/),
    },
    {
      id: "location",
      title: "Move S1 to Lab-Row2-Rack7: the NMS reads the new sysLocation",
      hints: [
        "sysLocation is not writable over SNMP. It comes from the switch's configuration: sonic-cli on S1 → configure terminal → snmp-server location …",
        "snmp-server location Lab-Row2-Rack7. snmpd restarts about 2 s later, then on the NMS run snmpget -v2c -c public 192.168.100.1 sysLocation.0",
      ],
      check: (c) => /Lab-Row2-Rack7/.test(get(c, "public", "192.168.100.1", "sysLocation.0")),
    },
    {
      id: "rotate",
      title: "On S1, replace community 'public' with a read-only community 'n0c-r3ad'. 'public' then times out",
      hints: [
        "A v2c community is a shared password, and 'public' is the first one an attacker tries. Communities are set in KLISH: snmp-server community <name> ro.",
        "Add the new one first, then remove the old one: snmp-server community n0c-r3ad ro → no snmp-server community public",
        "Test from the NMS: snmpget -v2c -c n0c-r3ad 192.168.100.1 sysName.0 works, and -c public gets 'Timeout: No Response'.",
      ],
      check: (c) =>
        /STRING: S1/.test(get(c, "n0c-r3ad", "192.168.100.1", "sysName.0")) && /Timeout/.test(get(c, "public", "192.168.100.1", "sysName.0")),
    },
    {
      id: "trap",
      title: "Make S1 send a linkDown/linkUp trap and find it on the NMS. Leave the port up afterwards",
      hints: [
        "Traps are pushed by the agent when something happens. Flap a connected port on S1 (interface Ethernet 0 → shutdown, then no shutdown).",
        "On the NMS: `snmptrapd -l` shows the received notifications with the sender's address. On S1, `show logging` shows the port going down and up.",
      ],
      check: (c) => linkTrapFrom(c, "192.168.100.1") && adminUp(c, "S1", "Ethernet0"),
    },
  ],
  solution: [
    { device: "NMS", shell: ["snmpwalk -v2c -c public 192.168.100.1 system"] },
    { device: "S1", klish: ["configure terminal", "snmp-server location Lab-Row2-Rack7", "end"], waitMs: 3000 },
    { device: "NMS", shell: ["snmpget -v2c -c public 192.168.100.1 sysLocation.0"] },
    { device: "S1", klish: ["configure terminal", "snmp-server community n0c-r3ad ro", "no snmp-server community public", "end"], waitMs: 3000 },
    { device: "S1", klish: ["configure terminal", "interface Ethernet 0", "shutdown", "end"], waitMs: 2000 },
    { device: "S1", klish: ["configure terminal", "interface Ethernet 0", "no shutdown", "end"], waitMs: 2000 },
    { device: "NMS", shell: ["snmptrapd -l"] },
  ],
  explanation:
    "SNMP has two directions. The NMS polls the agent (GET/GETNEXT to UDP 161) and the agent pushes notifications (v2c traps to UDP 162). SONiC renders snmpd.conf from CONFIG_DB, so `snmp-server location` and `snmp-server community` restart snmpd with the new values. A v2c agent silently drops requests that carry an unknown community, which is why 'public' now times out. The traps still went out, because the trap host entry carries its own community. When a port changes oper state, snmpd sends IF-MIB linkDown/linkUp (RFC 2863) to every trap host.",
});

registerMission({
  id: "snmp-trouble-agent",
  labId: "snmp",
  kind: "troubleshoot",
  level: "beginner",
  title: "The NMS lost S2",
  summary:
    "The NMS can no longer poll S2: every request to 192.168.100.2 times out, while S1 and S3 answer with the same community. S2 still answers ping from the NMS and still forwards traffic.",
  inject(api) {
    const s2 = api.deviceId("S2");
    api.exec(s2, "exit");
    api.exec(s2, "sudo config feature state snmp disabled");
    api.exec(s2, "sonic-cli");
  },
  objectives: [
    {
      id: "poll",
      title: "snmpget sysName.0 on S2 (192.168.100.2) answers 'S2' with community public",
      hints: [
        "Ping works, so the network path is fine. Is anything listening on S2's UDP 161? On the NMS, `sudo tcpdump -i eth0 -nn port 161` shows requests going out and no responses coming back.",
        "On S2, at the Linux shell: `docker ps` and `show feature status`. In SONiC, snmpd runs in its own container.",
        "The snmp feature is disabled, so its container is stopped. Run sudo config feature state snmp enabled",
      ],
      check: (c) => /STRING: S2/.test(get(c, "public", "192.168.100.2", "sysName.0")),
    },
    {
      id: "others",
      title: "S1 and S3 still answer",
      check: (c) => /STRING: S1/.test(get(c, "public", "192.168.100.1", "sysName.0")) && /STRING: S3/.test(get(c, "public", "192.168.100.3", "sysName.0")),
    },
  ],
  solution: [{ device: "S2", shell: ["exit", "show feature status", "sudo config feature state snmp enabled"], waitMs: 3000 }],
  explanation:
    "The snmp FEATURE on S2 had been set to disabled, so featured stopped the snmp container (snmpd + sonic-snmpagent). The switch still routed and answered ping, but nothing was listening on UDP 161, so the NMS's GETs were silently discarded and timed out. The coldStart trap from S2 was missing from snmptrapd's log for the same reason. `show feature status` / `docker ps` show it. Enabling the feature starts the container again, and snmpd answers as soon as it is up.",
});

registerMission({
  id: "snmp-trouble-traps",
  labId: "snmp",
  kind: "troubleshoot",
  level: "intermediate",
  title: "S3's link alarms never arrive",
  summary:
    "Link alarms from S3 never show up on the NMS: when S3's ports flap there is no linkDown/linkUp trap in snmptrapd's log, though alarms from S1 and S2 arrive. Polling S3 works fine. Leave every port of S3 up when you are done.",
  inject(api) {
    api.runCliScript(api.deviceId("S3"), [
      "configure terminal",
      "no snmp-server host 192.168.100.250",
      "snmp-server host 192.168.100.25 version v2c community public",
      "end",
    ]);
  },
  objectives: [
    {
      id: "trap",
      title: "A linkDown or linkUp trap from S3 (192.168.100.3) is in the NMS's snmptrapd log",
      hints: [
        "Reproduce it: flap S3's Ethernet0 (shutdown / no shutdown) and check `snmptrapd -l` on the NMS. On S3, `show logging` confirms the port went down.",
        "If the agent sends traps but they never arrive, check where it sends them: `show running-configuration snmp` on S3, compared with S1. `sudo tcpdump -i eth0 -nn port 162` on the NMS shows nothing from .3.",
        "The trap host is 192.168.100.25 instead of .250. Run no snmp-server host 192.168.100.25 → snmp-server host 192.168.100.250 version v2c community public, wait for snmpd to restart, then flap the port again.",
      ],
      check: (c) => linkTrapFrom(c, "192.168.100.3"),
    },
    {
      id: "ports-up",
      title: "S3's Ethernet0 and Ethernet1 are admin up",
      check: (c) => adminUp(c, "S3", "Ethernet0") && adminUp(c, "S3", "Ethernet1"),
    },
  ],
  solution: [
    {
      device: "S3",
      klish: ["configure terminal", "no snmp-server host 192.168.100.25", "snmp-server host 192.168.100.250 version v2c community public", "end"],
      waitMs: 3000,
    },
    { device: "S3", klish: ["configure terminal", "interface Ethernet 0", "shutdown", "end"], waitMs: 2000 },
    { device: "S3", klish: ["configure terminal", "interface Ethernet 0", "no shutdown", "end"], waitMs: 2000 },
  ],
  explanation:
    "S3's trap destination had a typo: 192.168.100.25 instead of the NMS at .250. Polling still worked, because GETs go NMS → agent, but notifications go to the configured trap sinks only (snmpd.conf trap2sink). Every linkDown/linkUp from S3 went to an address nobody listens on, and UDP traps get no acknowledgement, so nothing on S3 complains. `show running-configuration snmp` on S3 next to S1 shows the difference. With the right host, the next port flap reaches snmptrapd.",
});
