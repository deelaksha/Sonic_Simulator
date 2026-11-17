/**
 * BFD feature lab on routedTriangle(): single-hop BFD sessions on the three
 * routed /30 links, configured through KLISH (`bfd` → `peer <ip> interface <if>`,
 * sonic-mgmt-framework bfd.xml). Defaults (FRR bfd.h): 300 ms tx/rx, multiplier
 * 3 → 900 ms detection time once Up.
 */
import { registerLab } from "./registry";
import { routedTriangle } from "./topologies";

/** [device, peer address, local interface] for both ends of every link. */
const PEERS = (t: { s1: string; s2: string; s3: string }): [string, string, string][] => [
  [t.s1, "10.0.12.2", "Ethernet0"],
  [t.s1, "10.0.13.2", "Ethernet1"],
  [t.s2, "10.0.12.1", "Ethernet0"],
  [t.s2, "10.0.23.2", "Ethernet1"],
  [t.s3, "10.0.13.1", "Ethernet0"],
  [t.s3, "10.0.23.1", "Ethernet1"],
];

registerLab("bfd", (api) => {
  const t = routedTriangle(api);
  for (const dev of [t.s1, t.s2, t.s3]) {
    const lines = ["configure terminal", "bfd"];
    for (const [d, peer, ifname] of PEERS(t)) if (d === dev) lines.push(`peer ${peer} interface ${ifname}`, "exit");
    lines.push("end");
    api.runCliScript(dev, lines);
  }
  api.hint(t.s1, [
    "BFD lab — single-hop BFD on every routed link (300 ms x 3 = 900 ms detection)",
    "Sessions come Up within ~2 s (slow 1 s packets until Up, then Poll/Final to 300 ms).",
    "Watch:   show bfd peers brief   |   show bfd peer 10.0.12.2   |   show bfd peers counters",
    "Packets: tcpdump -i Ethernet0 -nn udp port 3784   (add -v for every field)",
    "Try:     shut Ethernet0 on S2 and watch S1's session to 10.0.12.2 go Down within ~900 ms",
    "         (Diagnostics: control detection time expired), then no shutdown → Up again.",
    "Also:    bfd → peer 10.0.12.2 → shutdown on S1: S1 shows admin-down, S2 shows",
    "         'neighbor signaled session down' with remote diag 'administratively down'.",
  ]);
  api.finish("BFD — bidirectional forwarding detection", t.s1);
});
