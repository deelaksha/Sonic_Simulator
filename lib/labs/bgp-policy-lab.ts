/**
 * BGP policy lab: an enterprise AS dual-homed to two ISPs (two exits), both
 * transit providers of a remote AS. Every speaker redistributes its connected
 * networks, so policy has something to filter. Configured through KLISH; the
 * policy itself (route-maps, prefix-lists, communities) is the student's task.
 *
 *          ISPA AS65002 (2.2.2.2)
 *         /  10.0.12.0/30     \ 10.0.24.0/30
 *   E1 AS65001 (1.1.1.1)        REMOTE AS65004 (4.4.4.4) — H4 192.168.4.0/24
 *   H1 192.168.1.0/24   \ 10.0.13.0/30     / 10.0.34.0/30
 *          ISPB AS65003 (3.3.3.3)
 */
import { registerLab } from "./registry";

function bgpScript(as: number, rid: string, peers: [string, number][]): string[] {
  const lines = ["configure terminal", `router bgp ${as}`, `router-id ${rid}`];
  for (const [ip, ras] of peers) lines.push(`neighbor ${ip}`, `remote-as ${ras}`, "exit");
  lines.push("address-family ipv4 unicast", "redistribute connected", "exit", "end");
  return lines;
}

registerLab("bgp-policy", (api) => {
  api.newLab();
  const e1 = api.addDevice("switch", { x: 200, y: 260 }, 4);
  const ispa = api.addDevice("switch", { x: 470, y: 100 }, 4);
  const ispb = api.addDevice("switch", { x: 470, y: 420 }, 4);
  const remote = api.addDevice("switch", { x: 740, y: 260 }, 4);
  const h1 = api.addDevice("pc", { x: 20, y: 260 });
  const h4 = api.addDevice("pc", { x: 920, y: 260 });
  [["E1", e1], ["ISPA", ispa], ["ISPB", ispb], ["REMOTE", remote], ["H1", h1], ["H4", h4]].forEach(([n, id]) => api.rename(id, n));
  for (const s of [e1, ispa, ispb, remote]) api.setPortSpeed(s, 25000);

  const ip = (dev: string, idx: number, a: string, p: number) => api.setInterfaceIp(dev, `${dev}-if${idx}`, a, p);
  ip(e1, 0, "10.0.12.1", 30);
  ip(ispa, 0, "10.0.12.2", 30);
  ip(e1, 1, "10.0.13.1", 30);
  ip(ispb, 0, "10.0.13.2", 30);
  ip(ispa, 1, "10.0.24.1", 30);
  ip(remote, 0, "10.0.24.2", 30);
  ip(ispb, 1, "10.0.34.1", 30);
  ip(remote, 1, "10.0.34.2", 30);
  ip(e1, 2, "192.168.1.1", 24);
  ip(remote, 2, "192.168.4.1", 24);
  ip(h1, 0, "192.168.1.10", 24);
  ip(h4, 0, "192.168.4.10", 24);
  api.setDefaultGateway(h1, "192.168.1.1");
  api.setDefaultGateway(h4, "192.168.4.1");
  api.connect(e1, `${e1}-if0`, ispa, `${ispa}-if0`);
  api.connect(e1, `${e1}-if1`, ispb, `${ispb}-if0`);
  api.connect(ispa, `${ispa}-if1`, remote, `${remote}-if0`);
  api.connect(ispb, `${ispb}-if1`, remote, `${remote}-if1`);
  api.connect(h1, `${h1}-if0`, e1, `${e1}-if2`);
  api.connect(h4, `${h4}-if0`, remote, `${remote}-if2`);

  api.runCliScript(e1, bgpScript(65001, "1.1.1.1", [["10.0.12.2", 65002], ["10.0.13.2", 65003]]));
  api.runCliScript(ispa, bgpScript(65002, "2.2.2.2", [["10.0.12.1", 65001], ["10.0.24.2", 65004]]));
  api.runCliScript(ispb, bgpScript(65003, "3.3.3.3", [["10.0.13.1", 65001], ["10.0.34.2", 65004]]));
  api.runCliScript(remote, bgpScript(65004, "4.4.4.4", [["10.0.24.1", 65002], ["10.0.34.1", 65003]]));

  api.hint(e1, [
    "BGP policy lab — E1 (AS65001) has two exits: ISPA AS65002 and ISPB AS65003, both reaching REMOTE AS65004 (H4 192.168.4.0/24).",
    "Everyone runs `redistribute connected`. Start with: show ip bgp   ·   show ip bgp 192.168.4.0/24   (best (Older Path) / Router ID)",
    "Task 1 — prefer ISPB for outbound traffic with LOCAL_PREF:",
    "  route-map PREFER-B permit 10  ·  set local-preference 200  ·  exit",
    "  router bgp 65001 · neighbor 10.0.13.2 · address-family ipv4 unicast · route-map PREFER-B in",
    "  → show ip bgp: LocPrf 200 *> via 10.0.13.2, best (Local Pref); show ip route: B>* via 10.0.13.2",
    "Task 2 — make REMOTE send traffic for 192.168.1.0/24 through ISPB: prepend towards ISPA",
    "  route-map PREPEND-A permit 10 · set as-path prepend 65001 65001 → neighbor 10.0.12.2 … route-map PREPEND-A out",
    "  → on REMOTE: show ip bgp 192.168.1.0/24   (65003 65001 wins over 65002 65001 65001 65001)",
    "Task 3 — filter with prefix-lists: only announce the LAN, only accept 192.168.0.0/16 up to /24",
    "  ip prefix-list ONLY-LAN seq 5 permit 192.168.1.0/24   ·   neighbor … prefix-list ONLY-LAN out (both ISPs)",
    "  ip prefix-list FROM-ISP seq 5 permit 192.168.0.0/16 le 24   ·   neighbor … prefix-list FROM-ISP in",
    "  → show ip bgp neighbors 10.0.12.2 advertised-routes   (Total number of prefixes 1)",
    "Task 4 — tag communities: set community 65001:100 additive in the outbound route-maps",
    "  → on REMOTE: show ip bgp 192.168.1.0/24 (Community: 65001:100) · show ip bgp community 65001:100",
    "  → try `set community no-export`: ISPB keeps the route but no longer passes it to REMOTE",
    "Watch the attributes on the wire: sudo tcpdump -i Ethernet1 -nn -v port 179",
  ]);
  api.finish("BGP Policy Lab — two exits, local-pref / prepend / prefix-lists / communities", e1);
});
