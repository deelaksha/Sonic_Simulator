/**
 * Shared lab topologies for the routing/control-plane protocols.
 *
 *   routedTriangle — three SONiC switches with point-to-point routed links and a
 *   host behind S1 and S3:
 *
 *        H1 192.168.1.10                         H3 192.168.3.10
 *          | Ethernet2 192.168.1.1/24              | Ethernet2 192.168.3.1/24
 *         S1 ── Ethernet0 10.0.12.1/30 ── 10.0.12.2/30 Ethernet0 ── S2
 *          \ Ethernet1 10.0.13.1/30                     Ethernet1 10.0.23.1/30 /
 *           \                                                               /
 *            10.0.13.2/30 Ethernet0 ── S3 ── Ethernet1 10.0.23.2/30
 *
 *   Management: every switch's eth0 sits in 192.168.100.0/24 on an L2 switch
 *   (MGMT) together with an NMS host 192.168.100.250 (SNMP manager, collector).
 */
import { LabApi } from "./registry";

export interface Triangle {
  s1: string;
  s2: string;
  s3: string;
  h1: string;
  h3: string;
  mgmt: string;
  nms: string;
}

export function routedTriangle(api: LabApi): Triangle {
  api.newLab();
  const s1 = api.addDevice("switch", { x: 200, y: 120 }, 4);
  const s2 = api.addDevice("switch", { x: 620, y: 120 }, 4);
  const s3 = api.addDevice("switch", { x: 410, y: 380 }, 4);
  const h1 = api.addDevice("pc", { x: 20, y: 260 });
  const h3 = api.addDevice("pc", { x: 700, y: 470 });
  const mgmt = api.addDevice("switch", { x: 900, y: 120 }, 4);
  const nms = api.addDevice("server", { x: 900, y: 330 });
  [["S1", s1], ["S2", s2], ["S3", s3], ["H1", h1], ["H3", h3], ["MGMT", mgmt], ["NMS", nms]].forEach(([n, id]) => api.rename(id, n));
  for (const s of [s1, s2, s3]) api.setPortSpeed(s, 25000);

  const ip = (dev: string, idx: number | "mgmt", a: string, p: number) => api.setInterfaceIp(dev, idx === "mgmt" ? `${dev}-mgmt` : `${dev}-if${idx}`, a, p);
  ip(s1, 0, "10.0.12.1", 30);
  ip(s2, 0, "10.0.12.2", 30);
  ip(s2, 1, "10.0.23.1", 30);
  ip(s3, 1, "10.0.23.2", 30);
  ip(s1, 1, "10.0.13.1", 30);
  ip(s3, 0, "10.0.13.2", 30);
  ip(s1, 2, "192.168.1.1", 24);
  ip(s3, 2, "192.168.3.1", 24);
  ip(h1, 0, "192.168.1.10", 24);
  ip(h3, 0, "192.168.3.10", 24);
  api.setDefaultGateway(h1, "192.168.1.1");
  api.setDefaultGateway(h3, "192.168.3.1");
  ip(s1, "mgmt", "192.168.100.1", 24);
  ip(s2, "mgmt", "192.168.100.2", 24);
  ip(s3, "mgmt", "192.168.100.3", 24);
  ip(nms, 0, "192.168.100.250", 24);

  api.connect(s1, `${s1}-if0`, s2, `${s2}-if0`);
  api.connect(s2, `${s2}-if1`, s3, `${s3}-if1`);
  api.connect(s1, `${s1}-if1`, s3, `${s3}-if0`);
  api.connect(h1, `${h1}-if0`, s1, `${s1}-if2`);
  api.connect(h3, `${h3}-if0`, s3, `${s3}-if2`);
  api.connect(s1, `${s1}-mgmt`, mgmt, `${mgmt}-if0`);
  api.connect(s2, `${s2}-mgmt`, mgmt, `${mgmt}-if1`);
  api.connect(s3, `${s3}-mgmt`, mgmt, `${mgmt}-if2`);
  api.connect(nms, `${nms}-if0`, mgmt, `${mgmt}-if3`);
  return { s1, s2, s3, h1, h3, mgmt, nms };
}
