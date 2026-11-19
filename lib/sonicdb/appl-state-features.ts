/**
 * APPL_DB / STATE_DB rows of the newer features (see ./appl-state-db.ts for the base tables).
 *
 * APPL_DB (separator ":"):
 *   NAT_TABLE / NAPT_TABLE   natsyncd (sonic-swss natsyncd/natsync.cpp:376-380, 564-565, 665-666):
 *                            key "<ip>" / "<TCP|UDP>:<ip>:<port>", translated_ip [, translated_l4_port],
 *                            nat_type snat|dnat, entry_type static|dynamic — every static entry and
 *                            every live TCP/UDP translation as an SNAT/DNAT pair (ICMP is not synced,
 *                            natsync.cpp:215-217), only while NAT is enabled
 *   SUPPRESS_VLAN_NEIGH_TABLE  schema.h:88 (vxlanmgrd copy of CONFIG_DB SUPPRESS_VLAN_NEIGH)
 *   APP_L2MC_MEMBER_TABLE    "<vlan>:<group>:<source>:<port>" and APP_L2MC_MROUTER_TABLE "<vlan>:<port>"
 *                            (sonic-mgmt-common/cvl/testdata/schema/sonic-igmp-snooping.yang:38-145):
 *                            the snooped (static + learned, unexpired) group members and mrouter ports
 *
 * STATE_DB (separator "|"):
 *   MIRROR_SESSION_TABLE     schema.h:538, mirrororch.cpp:15-17 status active|inactive
 *                            (lib/protocols/mirror.ts sessionStatus)
 */
import { Device } from "../models/device";
import { listVlans } from "../models/vlan-ops";
import { mirrorSessions, sessionStatus } from "../protocols/mirror";
import { natEnabled, peekNat } from "../protocols/nat";
import { snoopGroups, mrouterPorts } from "../protocols/igmp-snooping";
import { cpList } from "../commands/sonic-cli/config-plane";
import { Tables, put, Row } from "./schema";

const PROTO_KEY: Record<string, string> = { tcp: "TCP", udp: "UDP" };

function natRow(t: Tables, proto: string, ip: string, port: string, tIp: string, tPort: string, natType: string, kind: string): void {
  const row: Row = { translated_ip: tIp, nat_type: natType, entry_type: kind };
  if (proto === "all") put(t, "NAT_TABLE", ip, row);
  else put(t, "NAPT_TABLE", `${PROTO_KEY[proto] ?? proto.toUpperCase()}:${ip}:${port}`, { ...row, translated_l4_port: tPort });
}

export function projectFeatureAppl(d: Device, t: Tables): void {
  if (natEnabled(d)) {
    for (const s of cpList(d, "nat", "statics")) {
      // static basic/napt: "dnat" (default) maps global → local; "snat" swaps the roles
      const g = [String(s.global_ip), String(s.global_port ?? "0")];
      const l = [String(s.local_ip), String(s.local_port ?? "0")];
      const [gl, lo] = s.nat_type === "snat" ? [l, g] : [g, l];
      const proto = String(s.ip_protocol);
      natRow(t, proto, lo[0], lo[1], gl[0], gl[1], "snat", "static");
      natRow(t, proto, gl[0], gl[1], lo[0], lo[1], "dnat", "static");
    }
    for (const e of peekNat(d)?.entries ?? []) {
      if (e.proto === "icmp") continue;
      natRow(t, e.proto, e.inIp, String(e.inPort), e.outIp, String(e.outPort), "snat", "dynamic");
      natRow(t, e.proto, e.outIp, String(e.outPort), e.inIp, String(e.inPort), "dnat", "dynamic");
    }
  }

  for (const s of cpList(d, "vxlan", "suppress")) put(t, "SUPPRESS_VLAN_NEIGH_TABLE", String(s.name), { suppress: String(s.suppress ?? "on") });

  if (cpList(d, "igmp_snooping", "vlans").length) {
    const now = Date.now();
    for (const v of listVlans(d)) {
      for (const g of snoopGroups(d, v.id, now)) {
        const src = g.source === "*" ? "0.0.0.0" : g.source;
        for (const p of g.ports) put(t, "APP_L2MC_MEMBER_TABLE", `Vlan${v.id}:${g.group}:${src}:${p}`);
      }
      for (const p of mrouterPorts(d, v.id, now)) put(t, "APP_L2MC_MROUTER_TABLE", `Vlan${v.id}:${p}`);
    }
  }
}

export function projectFeatureState(d: Device, t: Tables): void {
  for (const s of mirrorSessions(d)) put(t, "MIRROR_SESSION_TABLE", s.name, { status: sessionStatus(d, s) });
}
