/**
 * `show ip ospf …` renderers.
 *
 * FRR 10.3 vtysh layouts (ospfd/ospf_vty.c):
 *   show ip ospf               show_ip_ospf_common :3032, show_ip_ospf_area :2682
 *   show ip ospf neighbor      show_ip_ospf_neighbour_header :4428, _brief :4436
 *   show ip ospf interface     show_ip_ospf_interface_sub :3573
 *   show ip ospf database      show_ip_ospf_database_common :7173, show_lsa_summary
 *                              :6139, show_database_header :6297, router/network
 *                              detail :6312-6560
 *   show ip ospf route         show_ip_ospf_route_network :10797, _common :11500
 * Timer text: ospf_timeval_dump / ospf_timer_dump (ospfd/ospf_dump.c:174-246).
 *
 * KLISH (sonic-cli) `show ip ospf neighbor` uses the mgmt-framework template
 * renderer/templates/show_ip_ospf_neighbor.j2 (no Up Time column, 36-wide
 * Interface, " " framing lines) — renderKlishNeighbors.
 */
import { Device } from "../models/device";
import { broadcastAddress, ipToInt } from "../models/ip";
import { ospfConfig, ospfInterfaces, ospfAreas, ospfRouterId, areaType, OspfConfig } from "./ospf-config";
import { ospfRuntime, lsaAge, lsaHeaderNow, mtuOf, OspfIf, OspfNbr, OspfRt, LsaEntry } from "./ospf-daemon";
import { LSA_ROUTER, LSA_NETWORK, MAX_AGE, decodeRouterBody, decodeNetworkBody, parseLsaHeader } from "./ospf-wire";

const NOT_ENABLED = "% OSPF is not enabled in vrf default";
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);
const p2 = (n: number) => String(n).padStart(2, "0");
const hex8 = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, "0")}`;
const hex4 = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;

/** ospf_timeval_dump (ospfd/ospf_dump.c:174). */
export function frrTimeval(ms: number): string {
  ms = Math.max(0, Math.floor(ms));
  let s = Math.floor(ms / 1000);
  const msr = ms % 1000;
  let w = 0;
  let d = 0;
  let h = 0;
  let m = 0;
  if (s > 604800) {
    w = Math.floor(s / 604800);
    s -= w * 604800;
  }
  if (s > 86400) {
    d = Math.floor(s / 86400);
    s -= d * 86400;
  }
  if (s >= 3600) {
    h = Math.floor(s / 3600);
    s -= h * 3600;
  }
  if (s >= 60) {
    m = Math.floor(s / 60);
    s -= m * 60;
  }
  if (w > 99) return `${w}w${d}d`;
  if (w) return `${w}w${d}d${p2(h)}h`;
  if (d) return `${d}d${p2(h)}h${p2(m)}m`;
  if (h) return `${h}h${p2(m)}m${p2(s)}s`;
  if (m) return `${m}m${p2(s)}s`;
  if (s > 0 || msr > 0) return `${s}.${String(msr).padStart(3, "0")}s`;
  return "0 usecs";
}

function areaDesc(cfg: OspfConfig, area: string): string {
  const t = areaType(cfg, area);
  return t === "stub" ? `${area} [Stub]` : t === "nssa" ? `${area} [NSSA]` : area;
}

const nbrStateMsg = (oif: OspfIf, n: OspfNbr) =>
  oif.type === "point-to-point" ? `${n.state}/-` : `${n.state}/${n.ip === oif.dr ? "DR" : n.ip === oif.bdr ? "Backup" : "DROther"}`;

function liveLsas(rt: OspfRt | undefined, area: string, now: number): { key: string; e: LsaEntry }[] {
  const db = rt?.lsdb[area] ?? {};
  return Object.entries(db)
    .filter(([, e]) => lsaAge(e, now) < MAX_AGE)
    .map(([key, e]) => ({ key, e }))
    .sort((a, b) => {
      const x = parseLsaHeader(a.e.lsa);
      const y = parseLsaHeader(b.e.lsa);
      return x.type - y.type || ipToInt(x.id) - ipToInt(y.id) || ipToInt(x.adv) - ipToInt(y.adv);
    });
}

// --- show ip ospf ---
export function renderOspfSummary(device: Device, now: number): string[] {
  const cfg = ospfConfig(device);
  if (!cfg) return [NOT_ENABLED];
  const rt = ospfRuntime(device);
  const out = [
    ` OSPF Routing Process, Router ID: ${rt?.routerId ?? ospfRouterId(device, cfg)}`,
    " Supports only single TOS (TOS0) routes",
    " This implementation conforms to RFC2328",
    " RFC1583Compatibility flag is disabled",
    " OpaqueCapability flag is disabled",
    " Initial SPF scheduling delay 0 millisec(s)",
    " Minimum hold time between consecutive SPFs 50 millisec(s)",
    " Maximum hold time between consecutive SPFs 5000 millisec(s)",
    " Hold time multiplier is currently 1",
  ];
  if (rt?.spf.lastMs !== undefined) {
    out.push(` SPF algorithm last executed ${frrTimeval(now - rt.spf.lastMs)} ago`);
    out.push(` Last SPF duration ${rt.spf.durUs < 1000 ? `${rt.spf.durUs} usecs` : frrTimeval(rt.spf.durUs / 1000)}`);
  } else out.push(" SPF algorithm has not been run");
  out.push(
    " SPF timer is inactive",
    " LSA minimum interval 5000 msecs",
    " LSA minimum arrival 1000 msecs",
    " Write Multiplier set to 20 ",
    " Refresh timer 10 secs",
    " Maximum multiple paths(ECMP) supported 256",
    " Administrative distance 110",
    " Number of external LSA 0. Checksum Sum 0x00000000",
    " Number of opaque AS LSA 0. Checksum Sum 0x00000000",
  );
  const areas = ospfAreas(cfg);
  out.push(` Number of areas attached to this router: ${areas.length}`);
  const specs = ospfInterfaces(device, cfg);
  for (const a of areas) {
    if (a.id === "0.0.0.0") out.push(` Area ID: ${a.id} (Backbone)`);
    else {
      out.push(` Area ID: ${a.id}${a.type === "stub" ? " (Stub)" : a.type === "nssa" ? " (NSSA)" : ""}`);
      out.push("   Shortcutting mode: Default, S-bit consensus: no");
    }
    const oifs = rt?.oifs.filter((o) => o.area === a.id) ?? [];
    out.push(`   Number of interfaces in this area: Total: ${specs.filter((s) => s.area === a.id).length}, Active: ${oifs.length}`);
    if (a.type === "nssa") {
      out.push("   It is an NSSA configuration.", "   Elected NSSA/ABR performs type-7/type-5 LSA translation.", "   It is not ABR, therefore not Translator.");
    }
    out.push(`   Number of fully adjacent neighbors in this area: ${oifs.reduce((n, o) => n + o.nbrs.filter((x) => x.state === "Full").length, 0)}`);
    out.push("   Area has no authentication");
    if (a.id !== "0.0.0.0") out.push("   Number of full virtual adjacencies going through this area: 0");
    out.push(`   SPF algorithm executed ${rt?.spf.perArea[a.id] ?? 0} times`);
    const lsas = liveLsas(rt, a.id, now).map((x) => parseLsaHeader(x.e.lsa));
    const count = (t: number) => lsas.filter((h) => h.type === t);
    const sum = (t: number) => count(t).reduce((s, h) => s + h.checksum, 0);
    out.push(`   Number of LSA ${lsas.length}`);
    out.push(`   Number of router LSA ${count(LSA_ROUTER).length}. Checksum Sum ${hex8(sum(LSA_ROUTER))}`);
    out.push(`   Number of network LSA ${count(LSA_NETWORK).length}. Checksum Sum ${hex8(sum(LSA_NETWORK))}`);
    out.push("   Number of summary LSA 0. Checksum Sum 0x00000000");
    out.push("   Number of ASBR summary LSA 0. Checksum Sum 0x00000000");
    out.push("   Number of NSSA LSA 0. Checksum Sum 0x00000000");
    out.push("   Number of opaque link LSA 0. Checksum Sum 0x00000000");
    out.push("   Number of opaque area LSA 0. Checksum Sum 0x00000000");
    out.push("");
  }
  out.push("");
  return out;
}

// --- show ip ospf neighbor ---
interface NbrRow {
  oif: OspfIf;
  n: OspfNbr;
}

function nbrRows(rt: OspfRt | undefined, filter?: string): NbrRow[] {
  const rows: NbrRow[] = [];
  for (const oif of rt?.oifs ?? []) {
    for (const n of oif.nbrs) {
      if (n.state === "Down") continue;
      if (filter && filter !== oif.name && filter !== n.rid) continue;
      rows.push({ oif, n });
    }
  }
  return rows;
}

export function renderNeighbors(device: Device, now: number, filter?: string): string[] {
  if (!ospfConfig(device)) return [NOT_ENABLED];
  const out = [
    "",
    `${pad("Neighbor ID", 15)} ${pad("Pri", 3)} ${pad("State", 15)} ${pad("Up Time", 15)} ${pad("Dead Time", 9)} ${pad("Address", 15)} ${pad("Interface", 32)} ${lpad("RXmtL", 5)} ${lpad("RqstL", 5)} ${lpad("DBsmL", 5)}`,
  ];
  for (const { oif, n } of nbrRows(ospfRuntime(device), filter)) {
    out.push(
      `${pad(n.rid, 15)} ${lpad(n.priority, 3)} ${pad(nbrStateMsg(oif, n), 15)} ${pad(frrTimeval(now - n.progressMs), 15)} ${lpad(frrTimeval(n.deadDue - now), 9)} ${pad(n.ip, 15)} ${pad(`${oif.name}:${oif.ip}`, 32)} ${lpad(Object.keys(n.rxmt).length, 5)} ${lpad(n.reqs.length, 5)} ${lpad(n.summary?.length ?? 0, 5)}`,
    );
  }
  out.push("");
  return out;
}

/** sonic-cli rendering (show_ip_ospf_neighbor.j2). */
export function renderKlishNeighbors(device: Device, now: number, filter?: string): string[] {
  const rows = ospfConfig(device) ? nbrRows(ospfRuntime(device), filter) : [];
  if (!ospfConfig(device)) return ["No OSPF neighbors found."];
  if (!rows.length) return ["No OSPF neighbors found.", " "];
  const out = [
    " ",
    `${pad("Neighbor ID", 15)} ${lpad("Pri", 3)} ${pad("State", 15)} ${lpad("Dead Time", 9)} ${pad("Address", 15)} ${pad("Interface", 36)} ${lpad("RXmtL", 5)} ${lpad("RqstL", 5)} ${lpad("DBsmL", 5)}`,
  ];
  for (const { oif, n } of rows) {
    const role = oif.dr === "0.0.0.0" ? "-" : n.ip === oif.dr ? "DR" : n.ip === oif.bdr ? "Backup" : "DROther";
    const ms = Math.max(0, n.deadDue - now);
    const dead = ms < 60000 ? `${(ms / 1000).toFixed(3)}s` : `${Math.floor(ms / 3600000)}h${Math.floor((ms % 3600000) / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
    out.push(
      `${pad(n.rid, 15)} ${lpad(n.priority, 3)} ${pad(`${n.state}/${role}`, 15)} ${lpad(dead, 9)} ${pad(n.ip, 15)} ${pad(`${oif.name}:${oif.ip}`, 36)} ${lpad(Object.keys(n.rxmt).length, 5)} ${lpad(n.reqs.length, 5)} ${lpad(n.summary?.length ?? 0, 5)}`,
    );
  }
  out.push(" ");
  return out;
}

// --- show ip ospf interface [IFNAME] ---
export function renderInterfaces(device: Device, now: number, ifname?: string): string[] {
  const cfg = ospfConfig(device);
  if (!cfg) return [NOT_ENABLED];
  const rt = ospfRuntime(device);
  const specs = ospfInterfaces(device, cfg);
  const out: string[] = [];
  let targets = device.interfaces.filter((i) => specs.some((s) => s.iface.id === i.id));
  if (ifname) {
    const i = device.interfaces.find((x) => x.name === ifname);
    if (!i) return ["No such interface name", ""];
    targets = [i];
  }
  for (const iface of targets) {
    const up = iface.adminState === "up" && iface.operState === "up";
    const loop = /^(Loopback|lo)/.test(iface.name);
    const flags = loop
      ? "<UP,LOWER_UP,LOOPBACK,RUNNING>"
      : iface.adminState !== "up"
        ? "<BROADCAST,MULTICAST>"
        : up
          ? "<UP,LOWER_UP,BROADCAST,RUNNING,MULTICAST>"
          : "<UP,BROADCAST,MULTICAST>";
    out.push(`${iface.name} is ${up ? "up" : "down"}`);
    out.push(`  ifindex ${device.interfaces.indexOf(iface) + 1}, MTU ${loop ? 65536 : mtuOf(device)} bytes, BW ${iface.speed || 10000} Mbit ${flags}`);
    const spec = specs.find((s) => s.iface.id === iface.id);
    if (!spec) {
      out.push("  OSPF not enabled on this interface");
      continue;
    }
    const oif = rt?.oifs.find((o) => o.ifId === iface.id);
    if (!up || !oif) {
      out.push("  OSPF is enabled, but not running on this interface");
      continue;
    }
    out.push(`  Internet Address ${oif.ip}/${oif.prefix}, Broadcast ${broadcastAddress(oif.ip, oif.prefix)}, Area ${areaDesc(cfg, oif.area)}`);
    out.push("  MTU mismatch detection: enabled");
    out.push(`  Router ID ${rt!.routerId}, Network Type ${oif.type === "point-to-point" ? "POINTOPOINT" : oif.type === "loopback" ? "LOOPBACK" : "BROADCAST"}, Cost: ${oif.cost}`);
    out.push(`  Transmit Delay is 1 sec, State ${oif.state}, Priority ${oif.priority}`);
    const who = (ip: string) => (ip === oif.ip ? { rid: rt!.routerId, ip } : oif.nbrs.find((n) => n.ip === ip));
    if (oif.dr === "0.0.0.0") out.push("  No backup designated router on this network");
    else {
      const dr = who(oif.dr);
      if (dr) out.push(`  Designated Router (ID) ${dr.rid} Interface Address ${dr.ip}/${oif.prefix}`);
      const bdr = oif.bdr === "0.0.0.0" ? undefined : who(oif.bdr);
      out.push(bdr ? `  Backup Designated Router (ID) ${bdr.rid}, Interface Address ${bdr.ip}` : "  No backup designated router on this network");
    }
    const groups = oif.passive || loop ? [] : ["OSPFAllRouters", ...(oif.state === "DR" || oif.state === "Backup" ? ["OSPFDesignatedRouters"] : [])];
    out.push(`  Multicast group memberships: ${groups.length ? groups.join(" ") : "<None>"}`);
    out.push(`  Timer intervals configured, Hello ${oif.hello}s, Dead ${oif.dead}s, Wait ${oif.dead}s, Retransmit ${oif.rxmt}`);
    out.push(oif.passive ? "    No Hellos (Passive interface)" : `    Hello due in ${oif.helloDue === undefined ? "inactive" : frrTimeval(oif.helloDue - now)}`);
    out.push(`  Neighbor Count is ${oif.nbrs.length}, Adjacent neighbor count is ${oif.nbrs.filter((n) => n.state === "Full").length}`);
    if (oif.bfd) out.push("  BFD: Detect Multiplier: 3, Min Rx interval: 300, Min Tx interval: 300");
    out.push(`  LSA retransmissions: ${oif.lsRxmt}`);
  }
  out.push("");
  return out;
}

// --- show ip ospf database ---
const DB_DESC: Record<number, string> = { 1: "Router Link States", 2: "Net Link States" };
const DB_HEADER: Record<number, string> = {
  1: "Link ID         ADV Router      Age  Seq#       CkSum  Link count",
  2: "Link ID         ADV Router      Age  Seq#       CkSum",
};

export function renderDatabase(device: Device, now: number, args: string[] = []): string[] {
  const cfg = ospfConfig(device);
  if (!cfg) return [NOT_ENABLED];
  const rt = ospfRuntime(device);
  const rid = rt?.routerId ?? ospfRouterId(device, cfg);
  const out = ["", `       OSPF Router with ID (${rid})`, ""];
  const self = args.includes("self-originate");
  const typeTok = args.find((a) => /^(router|network)$/.test(a));
  const lsid = args.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const areas = ospfAreas(cfg).map((a) => a.id);
  if (!typeTok) {
    for (const area of areas) {
      for (const t of [LSA_ROUTER, LSA_NETWORK]) {
        const lsas = liveLsas(rt, area, now).filter((x) => parseLsaHeader(x.e.lsa).type === t && (!self || x.e.self));
        if (!lsas.length) continue;
        out.push(`                ${DB_DESC[t]} (Area ${areaDesc(cfg, area)})`, "", DB_HEADER[t]);
        for (const { e } of lsas) {
          const h = lsaHeaderNow(e, now);
          let row = `${pad(h.id, 15)}${pad(h.adv, 15)} ${lpad(h.age, 4)} ${hex8(h.seq)} ${hex4(h.checksum)}`;
          if (t === LSA_ROUTER) row += ` ${decodeRouterBody(e.lsa).links.length}`;
          out.push(row);
        }
        out.push("");
      }
    }
    out.push("");
    return out;
  }
  const t = typeTok === "router" ? LSA_ROUTER : LSA_NETWORK;
  for (const area of areas) {
    out.push("", `                ${DB_DESC[t]} (Area ${areaDesc(cfg, area)})`, "");
    for (const { e } of liveLsas(rt, area, now)) {
      const h = lsaHeaderNow(e, now);
      if (h.type !== t || (lsid && h.id !== lsid) || (self && !e.self)) continue;
      out.push(`  LS age: ${h.age}`);
      out.push(`  Options: 0x${h.options.toString(16).padEnd(2)} : *|-|-|-|-|-|${h.options & 0x02 ? "E" : "-"}|-`);
      out.push(`  LS Flags: 0x${(e.self ? 0x3 : 0x6).toString(16).padEnd(2)} `);
      if (t === LSA_ROUTER) out.push(`  Flags: 0x${decodeRouterBody(e.lsa).flags.toString(16)}`);
      out.push(`  LS Type: ${t === LSA_ROUTER ? "router-LSA" : "network-LSA"}`);
      out.push(`  Link State ID: ${h.id} ${t === LSA_NETWORK ? "(address of Designated Router)" : ""}`);
      out.push(`  Advertising Router: ${h.adv}`);
      out.push(`  LS Seq Number: ${(h.seq >>> 0).toString(16).padStart(8, "0")}`);
      out.push(`  Checksum: ${hex4(h.checksum)}`);
      out.push(`  Length: ${h.length}`, "");
      if (t === LSA_ROUTER) {
        const links = decodeRouterBody(e.lsa).links;
        out.push(`   Number of Links: ${links.length}`, "");
        const TYPE = ["(null)", "another Router (point-to-point)", "a Transit Network", "Stub Network", "a Virtual Link"];
        const ID = ["(null)", "Neighboring Router ID", "Designated Router address", "Net", "Neighboring Router ID"];
        const DATA = ["(null)", "Router Interface address", "Router Interface address", "Network Mask", "Router Interface address"];
        for (const l of links) {
          out.push(`    Link connected to: ${TYPE[l.type]}`);
          out.push(`     (Link ID) ${ID[l.type]}: ${l.linkId}`);
          out.push(`     (Link Data) ${DATA[l.type]}: ${l.linkData}`);
          out.push("      Number of TOS metrics: 0");
          out.push(`       TOS 0 Metric: ${l.metric}`, "");
        }
        out.push("");
      } else {
        const nb = decodeNetworkBody(e.lsa);
        out.push(`  Network Mask: /${(ipToInt(nb.mask).toString(2).match(/1/g) ?? []).length}`);
        for (const r of nb.routers) out.push(`        Attached Router: ${r}`, "");
        out.push("");
      }
    }
  }
  out.push("");
  return out;
}

// --- show ip ospf route ---
export function renderRoutes(device: Device): string[] {
  const cfg = ospfConfig(device);
  if (!cfg) return [NOT_ENABLED];
  const rt = ospfRuntime(device);
  if (!rt?.routes) return ["No OSPF routing information exist"];
  const out = ["============ OSPF network routing table ============"];
  for (const r of rt.routes) {
    out.push(`N    ${pad(`${r.dest}/${r.prefix}`, 18)}    [${r.cost}] area: ${r.area}`);
    for (const p of r.paths) out.push(`${" ".repeat(24)}   ${p.nh === null ? `directly attached to ${p.ifName}` : `via ${p.nh}, ${p.ifName}`}`);
  }
  out.push("", "============ OSPF router routing table =============", "", "============ OSPF external routing table ===========", "", "");
  return out;
}
