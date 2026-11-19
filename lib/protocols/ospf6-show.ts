/**
 * FRR 10.3 ospf6d vtysh renderers:
 *   show ipv6 ospf6 neighbor   ospf6_neighbor.c:1327-1330 header, :934-939 rows
 *                              ("%-15s %3d %11s %8s/%-12s %11s %s[%s]",
 *                              state names :55-58, interface states
 *                              ospf6_interface.c:52-55, Duration = timerstring
 *                              ospf6d.h:51-64)
 *   show ipv6 ospf6 database   ospf6d.c:118-122 titles + ospf6_lsdb_show_wrapper,
 *                              ospf6_lsa.c:494-498 header, :546-585 rows (one
 *                              per payload item: Rtr nbr-rid/nbr-ifid, Net
 *                              attached router, Lnk link-local then prefixes,
 *                              INAP prefix/len — ospf6_intra.c get_prefix_str)
 */
import { Device } from "../models/device";
import { ospf6Runtime, nsm6Name, lsa6Age, Ospf6Rt, Lsa6Entry } from "./ospf6-daemon";
import {
  LSA6_ROUTER,
  LSA6_NETWORK,
  LSA6_LINK,
  LSA6_INTRA_PREFIX,
  parseLsa6Header,
  decodeRouter6,
  decodeNetwork6,
  decodeLink6,
  decodeIntraPrefix6,
  intToDotted,
} from "./ospf6-wire";
import { ipToInt } from "../models/ip";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** ospf6d.h timerstring: HH:MM:SS, with a day prefix "Nd" past 24 h. */
export function timerstring(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hms = `${pad2(Math.floor(s / 3600) % 24)}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
  return d ? `${d}d${hms}` : hms;
}

const ljust = (s: string, n: number) => s.padEnd(n);
const rjust = (s: string, n: number) => s.padStart(n);

export function renderOspf6Neighbors(device: Device, nowMs: number): string[] {
  const rt = ospf6Runtime(device);
  const out = [`${ljust("Neighbor ID", 15)} ${rjust("Pri", 3)} ${rjust("DeadTime", 11)} ${rjust("State", 8)}/${ljust("IfState", 12)} ${rjust("Duration", 11)} I/F[State]`];
  for (const oif of rt?.oifs ?? []) {
    for (const n of oif.nbrs) {
      const dead = timerstring(n.deadDue - nowMs);
      const nstate = oif.type === "point-to-point" ? "PointToPoint" : n.rid === n.dr ? "DR" : n.rid === n.bdr ? "BDR" : "DROther";
      out.push(`${ljust(n.rid, 15)} ${rjust(String(Math.max(0, n.priority)), 3)} ${rjust(dead, 11)} ${rjust(nsm6Name(n.state), 8)}/${ljust(nstate, 12)} ${rjust(timerstring(nowMs - n.progressMs), 11)} ${oif.name}[${oif.state}]`);
    }
  }
  return out;
}

const SHORT: Record<number, string> = { [LSA6_ROUTER]: "Rtr", [LSA6_NETWORK]: "Net", [LSA6_LINK]: "Lnk", [LSA6_INTRA_PREFIX]: "INAP" };

function payloads(type: number, lsa: number[]): string[] {
  if (type === LSA6_ROUTER) return decodeRouter6(lsa).map((l) => `${l.nbrRid}/${intToDotted(l.nbrIfId)}`);
  if (type === LSA6_NETWORK) return decodeNetwork6(lsa);
  if (type === LSA6_LINK) {
    const l = decodeLink6(lsa);
    return [l.linkLocal, ...l.prefixes.map((p) => p.prefix)];
  }
  if (type === LSA6_INTRA_PREFIX) return decodeIntraPrefix6(lsa).prefixes.map((p) => `${p.prefix}/${p.len}`);
  return [];
}

function lsdbLines(db: Record<string, Lsa6Entry>, nowMs: number): string[] {
  const out = [`${ljust("Type", 4)} ${ljust("LSId", 15)}${ljust("AdvRouter", 15)}${rjust("Age", 4)} ${rjust("SeqNum", 8)} ${rjust("Payload", 30)}`];
  // ospf6_lsdb order: LS type, then advertising router, then LS ID.
  const entries = Object.values(db)
    .map((e) => ({ e, h: parseLsa6Header(e.lsa) }))
    .sort((a, b) => a.h.type - b.h.type || ipToInt(a.h.adv) - ipToInt(b.h.adv) || ipToInt(a.h.id) - ipToInt(b.h.id));
  for (const { e, h } of entries) {
    const head = `${ljust(SHORT[h.type] ?? "Unk", 4)} ${ljust(h.id, 15)}${ljust(h.adv, 15)}${rjust(String(lsa6Age(e, nowMs)), 4)} ${rjust((h.seq >>> 0).toString(16), 8)}`;
    for (const p of payloads(h.type, e.lsa)) out.push(`${head} ${rjust(p, 30)}`);
  }
  return out;
}

export function renderOspf6Database(device: Device, nowMs: number): string[] {
  const rt: Ospf6Rt | undefined = ospf6Runtime(device);
  const out: string[] = [];
  const areas = [...new Set([...(rt?.oifs ?? []).map((o) => o.area), ...Object.keys(rt?.lsdb ?? {})])].sort((a, b) => ipToInt(a) - ipToInt(b));
  for (const area of areas) out.push("", `        Area Scoped Link State Database (Area ${area})`, "", ...lsdbLines(rt?.lsdb[area] ?? {}, nowMs));
  for (const area of areas) {
    for (const oif of (rt?.oifs ?? []).filter((o) => o.area === area)) {
      out.push("", `        I/F Scoped Link State Database (I/F ${oif.name} in Area ${area})`, "", ...lsdbLines(rt?.linkDb[oif.name] ?? {}, nowMs));
    }
  }
  out.push("", "        AS Scoped Link State Database", "", ...lsdbLines({}, nowMs), "");
  return out;
}
