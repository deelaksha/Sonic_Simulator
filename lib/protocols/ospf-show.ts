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
 *   show ip ospf route         show_ip_ospf_route_network :10797, _router :10954,
 *                              _external :11097, _common :11506
 *   summary / ASBR-summary / external / NSSA LSA detail :6581-6730
 *   `show ip ospf vrf NAME …`  "VRF Name: NAME" first (ospf_show_vrf_name :161)
 * Timer text: ospf_timeval_dump / ospf_timer_dump (ospfd/ospf_dump.c:174-246).
 *
 * KLISH (sonic-cli) `show ip ospf neighbor` uses the mgmt-framework template
 * renderer/templates/show_ip_ospf_neighbor.j2 (no Up Time column, 36-wide
 * Interface, " " framing lines) — renderKlishNeighbors.
 */
import { Device } from "../models/device";
import { broadcastAddress, ipToInt, networkAddress } from "../models/ip";
import { DEFAULT_VRF } from "../models/vrf";
import { ospfConfig, ospfInterfaces, ospfAreas, ospfRouterId, areaType, OspfConfig } from "./ospf-config";
import { ospfRuntime, lsaAge, lsaHeaderNow, mtuOf, OspfIf, OspfNbr, OspfRt, OspfRoutePath, LsaEntry, AS_SCOPE } from "./ospf-daemon";
import {
  LSA_ROUTER,
  LSA_NETWORK,
  LSA_SUMMARY,
  LSA_ASBR_SUMMARY,
  LSA_EXTERNAL,
  LSA_NSSA,
  MAX_AGE,
  decodeRouterBody,
  decodeNetworkBody,
  decodeSummaryBody,
  decodeExternalBody,
  parseLsaHeader,
} from "./ospf-wire";

const notEnabled = (vrf?: string) => `% OSPF is not enabled in vrf ${vrf ?? DEFAULT_VRF}`;
/** "VRF Name: X" header when the command named a VRF (ospf_show_vrf_name). */
const vrfHeader = (vrf?: string) => (vrf ? [`VRF Name: ${vrf}`] : []);
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

const maskLen = (mask: string) => (ipToInt(mask).toString(2).match(/1/g) ?? []).length;

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
export function renderOspfSummary(device: Device, now: number, vrf?: string): string[] {
  const cfg = ospfConfig(device, vrf);
  if (!cfg) return [notEnabled(vrf)];
  const rt = ospfRuntime(device, vrf);
  const out = [
    ...vrfHeader(vrf),
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
  );
  if (rt?.abr) out.push(" This router is an ABR, ABR type is: Alternative Cisco");
  if (rt?.asbr) out.push(" This router is an ASBR (injecting external routing information)");
  const ext = liveLsas(rt, AS_SCOPE, now).map((x) => parseLsaHeader(x.e.lsa));
  out.push(
    ` Number of external LSA ${ext.length}. Checksum Sum ${hex8(ext.reduce((n, h) => n + h.checksum, 0))}`,
    " Number of opaque AS LSA 0. Checksum Sum 0x00000000",
  );
  const areas = ospfAreas(cfg);
  out.push(` Number of areas attached to this router: ${areas.length}`);
  if (cfg.logAdjacencyChanges) out.push(cfg.logAdjacencyChanges === "detail" ? " All adjacency changes are logged" : " Adjacency changes are logged");
  const specs = ospfInterfaces(device, cfg, vrf);
  for (const a of areas) {
    if (a.id === "0.0.0.0") out.push(` Area ID: ${a.id} (Backbone)`);
    else {
      const ns = a.noSummary ? ", no summary" : "";
      out.push(` Area ID: ${a.id}${a.type === "stub" ? ` (Stub${ns})` : a.type === "nssa" ? ` (NSSA${ns})` : ""}`);
      out.push("   Shortcutting mode: Default, S-bit consensus: no");
    }
    const oifs = rt?.oifs.filter((o) => o.area === a.id) ?? [];
    out.push(`   Number of interfaces in this area: Total: ${specs.filter((s) => s.area === a.id).length}, Active: ${oifs.length}`);
    if (a.type === "nssa") {
      out.push("   It is an NSSA configuration.", "   Elected NSSA/ABR performs type-7/type-5 LSA translation.");
      if (!rt?.abr) out.push("   It is not ABR, therefore not Translator.");
      else if (rt.xlt?.[a.id]) out.push("   We are an ABR and the NSSA Elected Translator.");
      else out.push("   We are an ABR, but not the NSSA Elected Translator.");
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
    out.push(`   Number of summary LSA ${count(LSA_SUMMARY).length}. Checksum Sum ${hex8(sum(LSA_SUMMARY))}`);
    out.push(`   Number of ASBR summary LSA ${count(LSA_ASBR_SUMMARY).length}. Checksum Sum ${hex8(sum(LSA_ASBR_SUMMARY))}`);
    out.push(`   Number of NSSA LSA ${count(LSA_NSSA).length}. Checksum Sum ${hex8(sum(LSA_NSSA))}`);
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

export function renderNeighbors(device: Device, now: number, filter?: string, vrf?: string): string[] {
  if (!ospfConfig(device, vrf)) return [notEnabled(vrf)];
  const out = [
    ...vrfHeader(vrf),
    "",
    `${pad("Neighbor ID", 15)} ${pad("Pri", 3)} ${pad("State", 15)} ${pad("Up Time", 15)} ${pad("Dead Time", 9)} ${pad("Address", 15)} ${pad("Interface", 32)} ${lpad("RXmtL", 5)} ${lpad("RqstL", 5)} ${lpad("DBsmL", 5)}`,
  ];
  for (const { oif, n } of nbrRows(ospfRuntime(device, vrf), filter)) {
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
export function renderInterfaces(device: Device, now: number, ifname?: string, vrf?: string): string[] {
  const cfg = ospfConfig(device, vrf);
  if (!cfg) return [notEnabled(vrf)];
  const rt = ospfRuntime(device, vrf);
  const specs = ospfInterfaces(device, cfg, vrf);
  const out: string[] = [...vrfHeader(vrf)];
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
const DB_DESC: Record<number, string> = {
  1: "Router Link States",
  2: "Net Link States",
  3: "Summary Link States",
  4: "ASBR-Summary Link States",
  5: "AS External Link States",
  7: "NSSA-external Link States",
};
const DB_HEADER: Record<number, string> = {
  1: "Link ID         ADV Router      Age  Seq#       CkSum  Link count",
  2: "Link ID         ADV Router      Age  Seq#       CkSum",
  3: "Link ID         ADV Router      Age  Seq#       CkSum  Route",
  4: "Link ID         ADV Router      Age  Seq#       CkSum",
  5: "Link ID         ADV Router      Age  Seq#       CkSum  Route",
  7: "Link ID         ADV Router      Age  Seq#       CkSum  Route",
};
const AREA_TYPES = [LSA_ROUTER, LSA_NETWORK, LSA_SUMMARY, LSA_ASBR_SUMMARY, LSA_NSSA];
/** `show ip ospf database <type>` keywords, matched like ospf_vty.c:7265-7282. */
const TYPE_KW: [RegExp, number][] = [
  [/^r/, LSA_ROUTER],
  [/^ne/, LSA_NETWORK],
  [/^ns/, LSA_NSSA],
  [/^su/, LSA_SUMMARY],
  [/^a/, LSA_ASBR_SUMMARY],
  [/^e/, LSA_EXTERNAL],
];
const LS_TYPE_NAME: Record<number, string> = { 1: "router-LSA", 2: "network-LSA", 3: "summary-LSA", 4: "summary-LSA", 5: "AS-external-LSA", 7: "NSSA-LSA" };
const LSID_DESC: Record<number, string> = {
  1: "",
  2: "(address of Designated Router)",
  3: "(summary Network Number)",
  4: "(AS Boundary Router address)",
  5: "(External Network Number)",
  7: "(External Network Number for NSSA)",
};

/** ospf_options_dump (ospf_dump_api.c:90). */
const optionsDump = (o: number) => `*|${o & 0x40 ? "O" : "-"}|${o & 0x20 ? "DC" : "-"}|${o & 0x10 ? "EA" : "-"}|${o & 0x08 ? "N/P" : "-"}|${o & 0x04 ? "MC" : "-"}|${o & 0x02 ? "E" : "-"}|${o & 0x01 ? "M/T" : "-"}`;

/** show_lsa_summary (ospf_vty.c:6139): the row of one LSA. */
function summaryRow(e: LsaEntry, now: number): string {
  const h = lsaHeaderNow(e, now);
  let row = `${pad(h.id, 15)}${pad(h.adv, 15)} ${lpad(h.age, 4)} ${hex8(h.seq)} ${hex4(h.checksum)}`;
  if (h.type === LSA_ROUTER) row += ` ${decodeRouterBody(e.lsa).links.length}`;
  if (h.type === LSA_SUMMARY) {
    const len = maskLen(decodeSummaryBody(e.lsa).mask);
    row += ` ${networkAddress(h.id, len)}/${len}`;
  }
  if (h.type === LSA_EXTERNAL || h.type === LSA_NSSA) {
    const x = decodeExternalBody(e.lsa);
    const len = maskLen(x.mask);
    row += ` ${x.e2 ? "E2" : "E1"} ${networkAddress(h.id, len)}/${len} [0x${x.tag.toString(16)}]`;
  }
  return row;
}

/** show_ip_ospf_database_header + the per-type detail (ospf_vty.c:6312-6730). */
function detailLines(e: LsaEntry, now: number): string[] {
  const h = lsaHeaderNow(e, now);
  const t = h.type;
  const out = [`  LS age: ${h.age}`, `  Options: 0x${h.options.toString(16).padEnd(2)} : ${optionsDump(h.options)}`];
  out.push(`  LS Flags: 0x${(e.self ? 0x3 : 0x6).toString(16).padEnd(2)} ${e.xlt ? "(Translated from Type-7)" : ""}`);
  if (t === LSA_ROUTER) {
    const f = decodeRouterBody(e.lsa).flags;
    out.push(`  Flags: 0x${f.toString(16)}${f ? ` :${f & 0x01 ? " ABR" : ""}${f & 0x02 ? " ASBR" : ""}${f & 0x04 ? " VL-endpoint" : ""}` : ""}`);
  }
  out.push(`  LS Type: ${LS_TYPE_NAME[t]}`);
  out.push(`  Link State ID: ${h.id} ${LSID_DESC[t]}`);
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
  } else if (t === LSA_NETWORK) {
    const nb = decodeNetworkBody(e.lsa);
    out.push(`  Network Mask: /${maskLen(nb.mask)}`);
    for (const r of nb.routers) out.push(`        Attached Router: ${r}`, "");
    out.push("");
  } else if (t === LSA_SUMMARY || t === LSA_ASBR_SUMMARY) {
    const sb = decodeSummaryBody(e.lsa);
    out.push(`  Network Mask: /${maskLen(sb.mask)}`, `        TOS: 0  Metric: ${sb.metric}`, "");
  } else {
    const x = decodeExternalBody(e.lsa);
    out.push(`  Network Mask: /${maskLen(x.mask)}`);
    out.push(`        Metric Type: ${x.e2 ? "2 (Larger than any link state path)" : "1"}`);
    out.push("        TOS: 0");
    out.push(`        Metric: ${x.metric}`);
    out.push(`        ${t === LSA_NSSA ? "NSSA: " : ""}Forward Address: ${x.fwd}`);
    out.push(`        External Route Tag: ${x.tag}`, "");
  }
  return out;
}

export function renderDatabase(device: Device, now: number, args: string[] = [], vrf?: string): string[] {
  const cfg = ospfConfig(device, vrf);
  if (!cfg) return [notEnabled(vrf)];
  const rt = ospfRuntime(device, vrf);
  const rid = rt?.routerId ?? ospfRouterId(device, cfg);
  const out = [...vrfHeader(vrf), "", `       OSPF Router with ID (${rid})`, ""];
  const self = args.includes("self-originate");
  const typeTok = args.find((a) => TYPE_KW.some(([re]) => re.test(a)) && a !== "self-originate" && a !== "adv-router");
  const lsid = args.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const areas = ospfAreas(cfg).map((a) => a.id);
  if (!typeTok) {
    // show_ip_ospf_database_summary (ospf_vty.c:6971): per-area types, then the AS-scope types.
    for (const area of areas) {
      for (const t of AREA_TYPES) {
        const lsas = liveLsas(rt, area, now).filter((x) => parseLsaHeader(x.e.lsa).type === t && (!self || x.e.self));
        if (!lsas.length) continue;
        out.push(`                ${DB_DESC[t]} (Area ${areaDesc(cfg, area)})`, "", DB_HEADER[t]);
        for (const { e } of lsas) out.push(summaryRow(e, now));
        out.push("");
      }
    }
    const ext = liveLsas(rt, AS_SCOPE, now).filter((x) => !self || x.e.self);
    if (ext.length) {
      out.push(`                ${DB_DESC[LSA_EXTERNAL]}`, "", DB_HEADER[LSA_EXTERNAL]);
      for (const { e } of ext) out.push(summaryRow(e, now));
      out.push("");
    }
    out.push("");
    return out;
  }
  const t = TYPE_KW.find(([re]) => re.test(typeTok))![1];
  const match = (e: LsaEntry) => {
    const h = parseLsaHeader(e.lsa);
    return h.type === t && (!lsid || h.id === lsid) && (!self || !!e.self);
  };
  if (t === LSA_EXTERNAL) {
    // show_lsa_detail (ospf_vty.c:6814): AS-scope types have no area heading.
    out.push(`                ${DB_DESC[t]} `, "");
    for (const { e } of liveLsas(rt, AS_SCOPE, now)) if (match(e)) out.push(...detailLines(e, now));
  } else {
    for (const area of areas) {
      out.push("", `                ${DB_DESC[t]} (Area ${areaDesc(cfg, area)})`, "");
      for (const { e } of liveLsas(rt, area, now)) if (match(e)) out.push(...detailLines(e, now));
    }
  }
  out.push("");
  return out;
}

// --- show ip ospf route ---
const pathLines = (paths: OspfRoutePath[]) =>
  paths.map((p) => `${" ".repeat(24)}   ${p.nh === null ? `directly attached to ${p.ifName}` : `via ${p.nh}, ${p.ifName}`}`);

export function renderRoutes(device: Device, vrf?: string): string[] {
  const cfg = ospfConfig(device, vrf);
  if (!cfg) return [notEnabled(vrf)];
  const rt = ospfRuntime(device, vrf);
  if (!rt?.routes) return [...vrfHeader(vrf), "No OSPF routing information exist"];
  const out = [...vrfHeader(vrf), "============ OSPF network routing table ============"];
  for (const r of rt.routes) {
    const net = pad(`${r.dest}/${r.prefix}`, 18);
    if (r.kind === "discard") {
      out.push(`D IA ${net}    Discard entry`);
      continue;
    }
    out.push(`${r.kind === "inter" ? "N IA" : "N   "} ${net}    [${r.cost}] area: ${r.area}`);
    out.push(...pathLines(r.paths));
  }
  out.push("", "============ OSPF router routing table =============");
  let last = "";
  for (const r of rt.rtrs ?? []) {
    // A router reachable in several areas: later entries are indented under the first (show_ip_ospf_route_router).
    const lead = r.rid === last ? " ".repeat(24) : `R    ${pad(r.rid, 15)}    `;
    last = r.rid;
    out.push(`${lead}${r.ia ? "IA" : "  "} [${r.cost}] area: ${r.area}${r.flags & 0x01 ? ", ABR" : ""}${r.flags & 0x02 ? ", ASBR" : ""}`);
    out.push(...pathLines(r.paths));
  }
  out.push("", "============ OSPF external routing table ===========");
  for (const r of rt.ext ?? []) {
    const net = pad(`${r.dest}/${r.prefix}`, 18);
    out.push(r.e2 ? `N E2 ${net}    [${r.cost}/${r.type2}] tag: ${r.tag}` : `N E1 ${net}    [${r.cost}] tag: ${r.tag}`);
    out.push(...pathLines(r.paths));
  }
  out.push("", "");
  return out;
}
