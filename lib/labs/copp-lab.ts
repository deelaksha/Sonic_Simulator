/**
 * CoPP feature lab: one SONiC switch routing between two hosts.
 *
 *   H1 192.168.1.10 ── Ethernet0 192.168.1.1/24  S1  Ethernet1 192.168.2.1/24 ── H2 192.168.2.10
 *
 * The IP2ME trap (ICMP/SSH/... to the switch's own addresses) is re-bound to a
 * lab action group policed at 50 pps / 50 packets burst on CPU queue 7, so a
 * ping flood from H1 to 192.168.1.1 visibly exceeds the CIR while H1 → H2
 * transit traffic (forwarded in hardware, never trapped) is unaffected.
 */
import { registerLab } from "./registry";

export const COPP_LAB_ACTION = "copp-lab-ip2me";

registerLab("copp", (api) => {
  api.newLab();
  const s1 = api.addDevice("switch", { x: 360, y: 160 }, 4);
  const h1 = api.addDevice("pc", { x: 100, y: 340 });
  const h2 = api.addDevice("pc", { x: 620, y: 340 });
  [["S1", s1], ["H1", h1], ["H2", h2]].forEach(([n, id]) => api.rename(id, n));
  api.setInterfaceIp(s1, `${s1}-if0`, "192.168.1.1", 24);
  api.setInterfaceIp(s1, `${s1}-if1`, "192.168.2.1", 24);
  api.setInterfaceIp(h1, `${h1}-if0`, "192.168.1.10", 24);
  api.setInterfaceIp(h2, `${h2}-if0`, "192.168.2.10", 24);
  api.setDefaultGateway(h1, "192.168.1.1");
  api.setDefaultGateway(h2, "192.168.2.1");
  api.connect(h1, `${h1}-if0`, s1, `${s1}-if0`);
  api.connect(h2, `${h2}-if0`, s1, `${s1}-if1`);
  api.exec(s1, "exit"); // KLISH → Linux shell for the Click CoPP commands
  for (const cmd of [
    `config copp action add ${COPP_LAB_ACTION}`,
    `config copp action set ${COPP_LAB_ACTION} trap-action trap`,
    `config copp action set ${COPP_LAB_ACTION} trap-queue 7`,
    `config copp action set ${COPP_LAB_ACTION} police cir 50 cbs 50`,
    `config copp classifier add ${COPP_LAB_ACTION}`,
    `config copp classifier match ${COPP_LAB_ACTION} ip2me`,
    `config copp bind ${COPP_LAB_ACTION} ${COPP_LAB_ACTION}`,
  ]) api.exec(s1, cmd);
  api.hint(s1, [
    "CoPP lab — control-plane policing on S1's CPU path",
    "IP2ME (traffic to S1's own IPs) is bound to action group copp-lab-ip2me: queue 7, police 50 pps / 50 pkts burst.",
    "Defaults for every other trap come from copp_cfg.j2 (ARP 3000 pps q10, BGP 10000 q14, LLDP 500 q18, LACP 500 q23 ...).",
    "Storm:   Traffic generator on H1 → 192.168.1.1, ICMP, interval 0, continuous (a ping flood at the switch)",
    "Transit: Traffic generator / ping on H1 → 192.168.2.10 keeps flowing — it is routed in hardware, never trapped.",
    "Watch:   show copp counters   |   show queue counters CPU   |   show copp configuration",
    "         show copp configuration detailed --trapid ip2me   |   show copp policy",
    "Drops:   excess packets are dropped by the policer (drop reason COPP_POLICER, queue 7 drop counters).",
    "Tune:    config copp action set copp-lab-ip2me police cir 500 cbs 500   → fewer drops",
    "Also:    show services | docker ps | show feature status | config feature state lldp disabled",
  ]);
  api.finish("CoPP — control-plane policing", s1);
});
