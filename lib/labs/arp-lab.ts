/**
 * ARP feature lab: one SONiC switch with an SVI (Vlan10 192.168.10.1/24) and
 * three hosts in VLAN 10. Shows Linux/SONiC neighbour aging: hosts use the
 * Linux default base_reachable_time (30 s), the switch SVI uses SONiC's
 * 1800 s (files/image_config/sysctl/sysctl-net.conf:46). Registered as "arp"
 * and as the UI feature id "arpnd" (lib/sonic/feature-registry.ts).
 */
import { registerLab, LabBuilder } from "./registry";

const build: LabBuilder = (api) => {
  api.newLab();
  const sw = api.addDevice("switch", { x: 440, y: 240 }, 4);
  const pcs = [80, 240, 400].map((y) => api.addDevice("pc", { x: 100, y }));
  api.rename(sw, "SW1");
  pcs.forEach((pc, i) => {
    api.rename(pc, `PC${i + 1}`);
    api.setInterfaceIp(pc, `${pc}-if0`, `192.168.10.${11 + i}`, 24);
    api.setDefaultGateway(pc, "192.168.10.1");
    api.connect(pc, `${pc}-if0`, sw, `${sw}-if${i}`);
    api.setAccessVlan(sw, `${sw}-if${i}`, 10);
  });
  api.runCliScript(sw, ["configure terminal", "interface Vlan 10", "ip address 192.168.10.1/24", "end"]);
  api.hint(sw, [
    "ARP lab — SW1 Vlan10 192.168.10.1/24, PC1-PC3 192.168.10.11-13",
    "From PC1: ping -c 1 192.168.10.12 and ping -c 1 192.168.10.1, then watch:",
    "  PC1: arp -n / ip neigh   SW1: show arp   (Vlan column + FDB port)   KLISH: show ip arp",
    "Aging: hosts REACHABLE → STALE after 30 s, unused STALE entries go after 60 s;",
    "       SW1 keeps REACHABLE for 1800 s (KLISH interface Vlan 10: ip arp timeout <25-65535>).",
    "Using a STALE entry sends a unicast ARP probe 5 s later (tcpdump -i eth0 -nn arp on PC1).",
    "Gratuitous ARP: move 192.168.10.12 from PC2 to PC3 — PC3 announces it and the",
    "       peers that already knew the address update their caches.",
    "Clear: sonic-clear arp   |   KLISH: clear ip arp   (static `ip arp` entries stay)",
  ]);
  api.finish("ARP — neighbour aging and gratuitous ARP", sw);
};

registerLab("arp", build);
registerLab("arpnd", build);
