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
 *   show ipv6 ospf6 interface [IF]  ospf6_interface.c:1011 ospf6_interface_show,
 *                              show_ospf6_interface_common (:1348, every
 *                              interface of the VRF, "No such Interface: %s")
 *   show ipv6 ospf6            ospf6_top.c:1165 ospf6_show + ospf6_area.c
 *                              ospf6_area_show (defaults: lib/libospf.h SPF
 *                              0/50/5000 ms, LS arrival 1000 ms; maximum-paths
 *                              = MULTIPATH_NUM, debian/rules --enable-multipath=256)
 */
import { Device } from "../models/device";
import { vrfOf, DEFAULT_VRF } from "../models/vrf";
import { ospf6Config } from "./ospf6-config";
import { ospf6Runtime, nsm6Name, lsa6Age, mtu6Of, Ospf6Rt, Lsa6Entry } from "./ospf6-daemon";
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

const isLoopback = (name: string) => /^(Loopback|lo)/.test(name);

/** `show ipv6 ospf6 interface [IF]` (ospf6_interface.c ospf6_interface_show). */
export function renderOspf6Interface(device: Device, nowMs: number, ifname?: string): string[] {
  const rt = ospf6Runtime(device);
  const ifs = device.interfaces.filter((i) => vrfOf(device, i) === DEFAULT_VRF);
  const pick = ifname ? ifs.filter((i) => i.name === ifname) : ifs;
  if (ifname && !pick.length) return [`No such Interface: ${ifname}`];
  const out: string[] = [];
  for (const iface of pick) {
    const idx = device.interfaces.indexOf(iface) + 1;
    const oif = rt?.oifs.find((o) => o.ifId === iface.id);
    const operative = iface.adminState === "up" && (iface.operState === "up" || isLoopback(iface.name));
    const deftype = isLoopback(iface.name) ? "LOOPBACK" : "BROADCAST";
    out.push(`${iface.name} is ${operative ? "up" : "down"}, type ${deftype}`, `  Interface ID: ${oif?.ifIndex ?? idx}`);
    if (!oif) {
      out.push("   OSPF not enabled on this interface");
      continue;
    }
    const type = oif.type === "point-to-point" ? "POINTOPOINT" : oif.type === "loopback" ? "LOOPBACK" : "BROADCAST";
    if (operative && type !== deftype) out.push(`  Operating as type ${type}`);
    out.push("  Internet Address:");
    for (const a of iface.ipv4) out.push(`    inet : ${a.address}/${a.prefix}`);
    for (const a of iface.ipv6) out.push(`    inet6: ${a.address}/${a.prefix}`);
    const mtu = mtu6Of(device);
    out.push(`  Instance ID 0, Interface MTU ${mtu} (autodetect: ${mtu})`, "  MTU mismatch detection: enabled", `  Area ID ${oif.area}, Cost ${oif.cost}`);
    out.push(`  State ${oif.state}, Transmit Delay 1 sec, Priority ${oif.priority}`, "  Timer intervals configured:");
    // %pTHd: time until the Hello thread fires, seconds with 3 decimals ("-" when not scheduled).
    const hello = oif.helloDue !== undefined ? (Math.max(0, oif.helloDue - nowMs) / 1000).toFixed(3) : "-";
    out.push(oif.passive ? "   No Hellos (Passive interface)" : `   Hello ${oif.hello}(${hello}), Dead ${oif.dead}, Retransmit ${oif.rxmt}`);
    out.push(`  DR: ${oif.dr} BDR: ${oif.bdr}`, `  Number of I/F scoped LSAs is ${Object.keys(rt?.linkDb[oif.name] ?? {}).length}`);
    // LS updates / acks go out at once in the simulator: nothing is ever pending.
    out.push("    0 Pending LSAs for LSUpdate in Time 00:00:00 [thread off]", "    0 Pending LSAs for LSAck in Time 00:00:00 [thread off]");
  }
  return out;
}

/** `show ipv6 ospf6` (ospf6_top.c ospf6_show + ospf6_area.c ospf6_area_show). */
export function renderOspf6Summary(device: Device, nowMs: number): string[] {
  const rt = ospf6Runtime(device);
  if (!rt) return [];
  const cfg = ospf6Config(device);
  const areas = [...new Set(rt.oifs.map((o) => o.area))].sort((a, b) => ipToInt(a) - ipToInt(b));
  const out = [
    ` OSPFv3 Routing Process (0) with Router-ID ${rt.routerId}`,
    ` Running ${timerstring(nowMs - rt.startedMs)}`,
    " LSA minimum arrival 1000 msecs",
    " Maximum-paths 256",
    " Administrative distance 110",
    " Initial SPF scheduling delay 0 millisec(s)",
    " Minimum hold time between consecutive SPFs 50 millsecond(s)",
    " Maximum hold time between consecutive SPFs 5000 millsecond(s)",
    " Hold time multiplier is currently 1",
  ];
  // The simulator does not record SPF trigger reasons; SPF itself is instantaneous.
  if (rt.spf.lastMs !== undefined) out.push(` SPF algorithm last executed ${timerstring(nowMs - rt.spf.lastMs)} ago, reason R+`, " Last SPF duration 0 sec 0 usec");
  else out.push(" SPF algorithm has not been run");
  out.push(rt.spfDirty ? " SPF timer due in 00:00:00" : " SPF timer is inactive");
  out.push(" Number of AS scoped LSAs is 0", ` Number of areas in this router is ${areas.length}`);
  out.push(" Authentication Sequence number info", "  Higher sequence no 0, Lower sequence no 0");
  const lac = cfg?.logAdjacencyChanges ?? true; // datacenter profile default (ospf6_top.c:50)
  if (lac) out.push(lac === "detail" ? " All adjacency changes are logged" : " Adjacency changes are logged");
  out.push("");
  for (const area of areas) {
    out.push(` Area ${area}`, `     Number of Area scoped LSAs is ${Object.keys(rt.lsdb[area] ?? {}).length}`);
    out.push(`     Interface attached to this area:${rt.oifs.filter((o) => o.area === area).map((o) => ` ${o.name}`).join("")}`);
    if (rt.spf.lastMs !== undefined) {
      const us = Math.max(0, nowMs - rt.spf.lastMs) * 1000;
      // "%ld.%lds" — the microseconds are printed unpadded, as ospf6d does.
      out.push(us >= 1e6 ? `     SPF last executed ${Math.floor(us / 1e6)}.${us % 1e6}s ago` : `     SPF last executed ${us}us ago`);
    } else out.push("SPF has not been run");
  }
  return out;
}
