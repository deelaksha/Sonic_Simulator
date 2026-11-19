/**
 * VXLAN / EVPN command layer shared by the Click shell and KLISH.
 *
 * Click (sonic-utilities config/vxlan.py, show/vxlan.py):
 *   config vxlan add <vtep> <src_ip> | del <vtep>                 (vxlan.py:16-91)
 *   config vxlan evpn_nvo add <nvo> <vtep> | del <nvo>            (vxlan.py:93-141)
 *   config vxlan map add|del <vtep> <vlan_id> <vni>               (vxlan.py:143-230)
 *   config vxlan map_range add|del <vtep> <vlan_start> <vlan_end> <vni_start>
 *   show vxlan interface | vlanvnimap [count] | vrfvnimap | tunnel | name <vtep>
 *   show vxlan remotevtep [count] | remotevni <ip|all> [count] | remotemac <ip|all> [count]
 *   show vxlan counters [<tunnel>]  -> tunnelstat -T vxlan [-i <tunnel>] (show/vxlan.py:322-335,
 *                                   scripts/tunnelstat cnstat_print / cnstat_single_tunnel)
 *   Output formats: python tabulate as show/vxlan.py calls it ("simple" for
 *   tunnel/name, "grid" for the rest — min padding 2 per header, numbers right
 *   aligned, rstrip), checked against sonic-utilities tests/vxlan_test.py.
 *
 * FRR zebra (vtysh, also reachable from KLISH `show evpn ...`):
 *   show evpn vni [<vni>|detail]    zebra_vxlan.c:3937 header, zebra_evpn.c:224 row,
 *                                   zebra_evpn.c:86-190 zebra_evpn_print (detail)
 *   show evpn mac vni <vni>|all     zebra_vxlan.c:3212-3218 / :461-467 headers,
 *                                   zebra_evpn_mac.c:861 local / :918 remote rows
 *   show evpn vni <l3vni>           zebra_vxlan.c:731 zl3vni_print; L3 rows :801
 *   show evpn rmac vni <vni>|all    zebra_vxlan.c:2638 / :682 headers, :715 row
 *   show evpn next-hops vni <vni>|all  zebra_vxlan.c:2744 / :628 headers, :583 row
 *   show evpn arp-cache vni <vni>|all  zebra_vxlan.c:2930 / :250, zebra_evpn_neigh.c:1842
 *                                   header, :1895 local / :1918 remote rows
 *   show evpn es                    zebra_evpn_mh.c:3269-3271 header, :3134 row
 *
 * Click config added for symmetric IRB / ARP suppression:
 *   config vrf add_vrf_vni_map <vrf> <vni> | del_vrf_vni_map <vrf>  (config/main.py:7387-7435)
 *   config neigh_suppress enable|disable <vlan_id>  (upstream sonic-utilities vxlan.py;
 *                                   not in this tree — writes SUPPRESS_VLAN_NEIGH)
 *
 * The Click commands are contributed through the BGP module's command list
 * (lib/commands/sonic/bgp.ts) until lib/commands/sonic/index.ts lists a VXLAN
 * module of its own.
 */
import { CommandContext, CommandResult, OutputLine, err, line, muted } from "../commands/types";
import { SonicCmd } from "../commands/sonic/types";
import { cpList, cpRemove, cpUpsert } from "../commands/sonic-cli/config-plane";
import { Device } from "../models/device";
import { longestPrefixMatch } from "../models/route";
import { isValidIpv4 } from "../models/ip";
import { VxlanConfig, l2Maps, vxlanConfig, vxlanNetdev } from "./vxlan";
import { floodList, l3Vnis, peekVxlanRuntime } from "./vxlan-daemon";
import { vrfOf } from "../models/vrf";
import { sviFor } from "./switch";
import { esPeers, isDf, localEss } from "./evpn-mh";

type Row = Record<string, string>;

// ---------------------------------------------------------------------------
// python-tabulate renderers

const isNum = (s: string) => /^-?\d+(\.\d+)?$/.test(s);

function colInfo(headers: string[], rows: string[][]): { w: number[]; right: boolean[] } {
  const right = headers.map((_, i) => rows.length > 0 && rows.every((r) => r[i] === "" || isNum(r[i])) && rows.some((r) => r[i] !== ""));
  const w = headers.map((h, i) => Math.max(h.length + 2, ...rows.map((r) => r[i].length)));
  return { w, right };
}

/** tabulate(rows, headers, tablefmt="grid") */
export function tabGrid(headers: string[], rows: string[][]): string[] {
  const { w, right } = colInfo(headers, rows);
  const bar = (fill: string) => "+" + w.map((n) => fill.repeat(n + 2)).join("+") + "+";
  const fmt = (cells: string[]) => "| " + cells.map((c, i) => (right[i] ? c.padStart(w[i]) : c.padEnd(w[i]))).join(" | ") + " |";
  const out = [bar("-"), fmt(headers), bar("=")];
  for (const r of rows) out.push(fmt(r), bar("-"));
  if (!rows.length) out.push(bar("-"));
  return out;
}

/** tabulate(rows, headers) — "simple" format. */
export function tabSimple(headers: string[], rows: string[][]): string[] {
  const { w, right } = colInfo(headers, rows);
  const fmt = (cells: string[]) => cells.map((c, i) => (right[i] ? c.padStart(w[i]) : c.padEnd(w[i]))).join("  ").trimEnd();
  return [fmt(headers), w.map((n) => "-".repeat(n)).join("  "), ...rows.map(fmt)];
}

const total = (n: number) => [`Total count : ${n}`, ""];
const toLines = (ls: string[]): OutputLine[] => ls.map((l) => line(l));
const fail = (msg: string): CommandResult => ({ output: [err(`Error: ${msg}`)] });

// ---------------------------------------------------------------------------
// state views

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** VXLAN_REMOTE_VNI_TABLE rows: Vlan, remote VTEP, VNI. */
export function remoteVnis(device: Device, filter = "all"): { vlan: string; vtep: string; vni: number }[] {
  const cfg = vxlanConfig(device);
  const rt = peekVxlanRuntime(device);
  if (!cfg || !rt) return [];
  const out: { vlan: string; vtep: string; vni: number }[] = [];
  for (const [ip, vnis] of Object.entries(rt.vteps)) {
    if (filter !== "all" && ip !== filter) continue;
    for (const vni of vnis) {
      const m = cfg.maps.find((x) => x.vni === vni);
      if (m) out.push({ vlan: `Vlan${m.vlan}`, vtep: ip, vni });
    }
  }
  return out.sort((a, b) => natural(`${a.vlan}:${a.vtep}`, `${b.vlan}:${b.vtep}`));
}

/** VXLAN_FDB_TABLE rows (remote MACs from EVPN type-2 routes). */
export function remoteMacs(device: Device, filter = "all"): { vlan: string; mac: string; vtep: string; vni: number; type: string }[] {
  const rt = peekVxlanRuntime(device);
  return Object.entries(rt?.macs ?? {})
    .filter(([, m]) => filter === "all" || m.vtep === filter)
    .map(([k, m]) => ({ vlan: `Vlan${m.vid}`, mac: k.split("|")[1].toLowerCase(), vtep: m.vtep, vni: m.vni, type: "dynamic" }))
    .sort((a, b) => natural(`${a.vlan}:${a.mac}`, `${b.vlan}:${b.mac}`));
}

/** STATE_DB VXLAN_TUNNEL_TABLE: one EVPN_<dip> tunnel per remote VTEP (vxlanorch.cpp:1764, :1827-1834). */
export function remoteVteps(device: Device): { name: string; sip: string; dip: string; src: string; oper: string }[] {
  const cfg = vxlanConfig(device);
  const rt = peekVxlanRuntime(device);
  if (!cfg || !rt) return [];
  // L2 flood-list VTEPs plus L3 VNI next hops (vxlanorch creates EVPN_<dip> for both).
  return [...new Set([...Object.keys(rt.vteps), ...Object.keys(rt.nhs ?? {})])]
    .sort(natural)
    .map((dip) => ({ name: `EVPN_${dip}`, sip: cfg.sourceIp, dip, src: "EVPN", oper: longestPrefixMatch(device.routingTable, dip) ? "up" : "down" }));
}

// ---------------------------------------------------------------------------
// Click show

function showInterface(device: Device): string[] {
  const cfg = vxlanConfig(device);
  const out = ["VTEP Information:", ""];
  if (!cfg) return out;
  out.push(cfg.sourceIp ? `\tVTEP Name : ${cfg.vtep}, SIP  : ${cfg.sourceIp}` : `\tVTEP Name : ${cfg.vtep}`);
  if (cfg.sourceIp) {
    if (cfg.nvo) out.push(`\tNVO Name  : ${cfg.nvo},  VTEP : ${cfg.vtep}`);
    out.push(`\tSource interface  : ${cfg.sourceIface ?? "Not Configured"}`);
  }
  return out;
}

export function showVlanVniMap(device: Device, count: boolean): string[] {
  const rows = (cpList(device, "vxlan", "vlanmap") as Row[]).map((m) => [m.vlan, m.vni]).sort((a, b) => natural(a[0], b[0]));
  if (count) return total(rows.length);
  return [...tabGrid(["VLAN", "VNI"], rows), ...total(rows.length)];
}

export function showVrfVniMap(device: Device): string[] {
  const rows = (cpList(device, "vxlan", "vrfmap") as Row[]).map((m) => [m.vrf, m.vni]).sort((a, b) => natural(a[0], b[0]));
  return [...tabGrid(["VRF", "VNI"], rows), ...total(rows.length)];
}

function showTunnel(device: Device, name?: string): string[] {
  const header = ["vxlan tunnel name", "source ip", "destination ip", "tunnel map name", "tunnel map mapping(vni -> vlan)"];
  const cfg = vxlanConfig(device);
  const rows: string[][] = [];
  if (cfg && (!name || name === cfg.vtep)) {
    const maps = [...cfg.maps].sort((a, b) => natural(`map_${a.vni}_Vlan${a.vlan}`, `map_${b.vni}_Vlan${b.vlan}`));
    const src = (cpList(device, "vxlan", "vteps")[0] as Row | undefined)?.source_ip ?? "";
    if (!maps.length) rows.push([cfg.vtep, src, "", "", ""]);
    maps.forEach((m, i) => rows.push([i === 0 ? cfg.vtep : " ", i === 0 ? src : " ", i === 0 ? "" : " ", `map_${m.vni}_Vlan${m.vlan}`, `${m.vni} -> Vlan${m.vlan}`]));
  }
  return tabSimple(header, rows);
}

export function showRemoteVtep(device: Device, count: boolean): string[] {
  const rows = remoteVteps(device).map((t) => [t.sip, t.dip, t.src, `oper_${t.oper}`]);
  if (count) return total(rows.length);
  return [...tabGrid(["SIP", "DIP", "Creation Source", "OperStatus"], rows), ...total(rows.length)];
}

export function showRemoteVni(device: Device, ip: string, count: boolean): string[] {
  if (ip !== "all" && !isValidIpv4(ip)) return [`Remote VTEP IP ${ip} invalid format`];
  const rows = remoteVnis(device, ip).map((r) => [r.vlan, r.vtep, String(r.vni)]);
  if (count) return total(rows.length);
  return [...tabGrid(["VLAN", "RemoteVTEP", "VNI"], rows), ...total(rows.length)];
}

export function showRemoteMac(device: Device, ip: string, count: boolean): string[] {
  if (ip !== "all" && !isValidIpv4(ip)) return [`Remote VTEP IP ${ip} invalid format`];
  const rows = remoteMacs(device, ip).map((r) => [r.vlan, r.mac, r.vtep, String(r.vni), r.type]);
  if (count) return total(rows.length);
  return [...tabGrid(["VLAN", "MAC", "RemoteVTEP", "VNI", "Type"], rows), ...total(rows.length)];
}

/**
 * tunnelstat rows. COUNTERS_TUNNEL_NAME_MAP holds every tunnel vxlanorch created
 * (vxlanorch.cpp:851-856): the VTEP's P2MP tunnel and one EVPN_<dip> per remote VTEP;
 * the simulator counts encap/decap per remote VTEP. Rates are not modelled (N/A).
 */
function tunnelCounters(device: Device): { name: string; rxP: number; rxB: number; txP: number; txB: number }[] {
  const cfg = vxlanConfig(device);
  if (!cfg) return [];
  const st = peekVxlanRuntime(device)?.tunnels ?? {};
  const rows = [{ name: cfg.vtep, rxP: 0, rxB: 0, txP: 0, txB: 0 }];
  for (const t of remoteVteps(device)) {
    const c = st[t.dip];
    rows.push({ name: t.name, rxP: c?.rxPkts ?? 0, rxB: c?.rxBytes ?? 0, txP: c?.txPkts ?? 0, txB: c?.txBytes ?? 0 });
  }
  return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : natural(a.name, b.name)));
}

export function showVxlanCounters(device: Device, tunnel?: string): string[] {
  const rows = tunnelCounters(device);
  if (tunnel) {
    const r = rows.find((x) => x.name === tunnel);
    if (!r) return [`Interface ${tunnel} missing from COUNTERS_TUNNEL_NAME_MAP! Make sure it exists`];
    const n = (v: number) => String(v).padStart(10);
    return [tunnel, "-".repeat(tunnel.length), "", "        RX:", `        ${n(r.rxP)} packets`, `        ${n(r.rxB)} bytes`, "        TX:", `        ${n(r.txP)} packets`, `        ${n(r.txB)} bytes`];
  }
  // tabulate(table, header, tablefmt='simple', stralign='right')
  const header = ["IFACE", "RX_PKTS", "RX_BYTES", "RX_PPS", "TX_PKTS", "TX_BYTES", "TX_PPS"];
  const cells = rows.map((r) => [r.name, String(r.rxP), String(r.rxB), "N/A", String(r.txP), String(r.txB), "N/A"]);
  const w = header.map((h, i) => Math.max(h.length + 2, ...cells.map((c) => c[i].length)));
  const fmt = (c: string[]) => c.map((x, i) => x.padStart(w[i])).join("  ");
  return [fmt(header), w.map((n) => "-".repeat(n)).join("  "), ...cells.map(fmt)];
}

// ---------------------------------------------------------------------------
// FRR zebra: show evpn ...

interface VniView {
  vni: number;
  vid: number;
  ifname: string;
  local: { mac: string; port: string; seq: number }[];
  remote: { mac: string; vtep: string; seq: number }[];
  vteps: string[];
  svi: string;
  vrf: string;
  neighs: { ip: string; mac: string; type: "local" | "remote"; vtep: string }[];
}

function vniViews(device: Device, cfg: VxlanConfig): VniView[] {
  const rt = peekVxlanRuntime(device);
  return [...l2Maps(cfg)]
    .sort((a, b) => a.vni - b.vni)
    .map((m) => {
      const svi = sviFor(device, m.vlan);
      const ip4 = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
      const neighs = [
        ...device.arpTable.filter((a) => svi && a.interfaceId === svi.id && a.state !== "incomplete").map((a) => ({ ip: a.ip, mac: a.mac.toLowerCase(), type: "local" as const, vtep: "" })),
        ...Object.entries(rt?.neighs ?? {}).filter(([, n]) => n.vni === m.vni).map(([k, n]) => ({ ip: k.split("|")[1], mac: n.mac.toLowerCase(), type: "remote" as const, vtep: n.vtep })),
      ].sort((a, b) => ip4(a.ip) - ip4(b.ip));
      const local = device.macTable
        .filter((e) => e.vlan === m.vlan && !e.interfaceId.startsWith("vtep:"))
        .map((e) => ({ mac: e.mac.toLowerCase(), port: device.interfaces.find((i) => i.id === e.interfaceId)?.name ?? "-", seq: rt?.seq[`${m.vni}|${e.mac.toUpperCase()}`] ?? 0 }));
      const remote = Object.entries(rt?.macs ?? {})
        .filter(([, r]) => r.vni === m.vni)
        .map(([k, r]) => ({ mac: k.split("|")[1].toLowerCase(), vtep: r.vtep, seq: r.seq }));
      return { vni: m.vni, vid: m.vlan, ifname: vxlanNetdev(cfg, m.vlan), local, remote, vteps: floodList(rt, m.vni), svi: svi?.name ?? "", vrf: svi ? vrfOf(device, svi) : "default", neighs };
    });
}

function evpnEnabled(device: Device): VxlanConfig | undefined {
  const cfg = vxlanConfig(device);
  return cfg && cfg.sourceIp && cfg.nvo && device.config.features?.bgp && (device.config.features.bgp as { advertiseAllVni?: boolean }).advertiseAllVni ? cfg : undefined;
}

function vniDetail(cfg: VxlanConfig, v: VniView): string[] {
  const out = [`VNI: ${v.vni}`, " Type: L2", ` Vlan: ${v.vid}`, " Bridge: Bridge", ` Tenant VRF: ${v.vrf}`, ` VxLAN interface: ${v.ifname}`, ` VxLAN ifIndex: 0`, ` SVI interface: ${v.svi}`, " SVI ifIndex: 0", ` Local VTEP IP: ${cfg.sourceIp}`, " Mcast group: 0.0.0.0"];
  if (!v.vteps.length) out.push(" No remote VTEPs known for this VNI");
  else out.push(" Remote VTEPs for this VNI:", ...v.vteps.map((ip) => `  ${ip} flood: HER`));
  out.push(
    ` Number of MACs (local and remote) known for this VNI: ${v.local.length + v.remote.length}`,
    ` Number of ARPs (IPv4 and IPv6, local and remote) known for this VNI: ${v.neighs.length}`,
    " Advertise-gw-macip: No",
    " Advertise-svi-macip: No",
  );
  return out;
}

/** zl3vni_print (zebra_vxlan.c:731). */
function l3Detail(device: Device, cfg: VxlanConfig, vni: number): string[] {
  const l = l3Vnis(device, cfg).find((x) => x.vni === vni)!;
  const l2 = vniViews(device, cfg).filter((v) => v.vrf === l.vrf).map((v) => `${v.vni} `).join("");
  return [
    `VNI: ${l.vni}`,
    "  Type: L3",
    `  Tenant VRF: ${l.vrf}`,
    `  Vlan: ${l.vid}`,
    "  Bridge: Bridge",
    `  Local Vtep Ip: ${cfg.sourceIp}`,
    `  Vxlan-Intf: ${vxlanNetdev(cfg, l.vid)}`,
    `  SVI-If: ${l.svi?.name ?? "None"}`,
    `  State: ${l.up ? "Up" : "Down"}`,
    "  VNI Filter: none",
    `  System MAC: ${l.rmac || "00:00:00:00:00:00"}`,
    `  Router MAC: ${l.rmac || "00:00:00:00:00:00"}`,
    `  L2 VNIs: ${l2}`,
  ];
}

export function renderEvpnVni(device: Device, arg?: string): string[] {
  const cfg = evpnEnabled(device);
  if (!cfg) return [];
  const views = vniViews(device, cfg);
  const l3s = l3Vnis(device, cfg);
  if (arg === "detail") return [...views.map((v) => vniDetail(cfg, v)), ...l3s.map((l) => l3Detail(device, cfg, l.vni))].flatMap((b, i) => [...(i ? [""] : []), ...b]);
  if (arg !== undefined) {
    const v = views.find((x) => x.vni === Number(arg));
    if (v) return vniDetail(cfg, v);
    return l3s.some((l) => l.vni === Number(arg)) ? l3Detail(device, cfg, Number(arg)) : [`% VNI ${arg} does not exist`];
  }
  const rt = peekVxlanRuntime(device);
  const f = (c: string[]) => `${c[0].padEnd(10)} ${c[1].padEnd(4)} ${c[2].padEnd(21)} ${c[3].padEnd(8)} ${c[4].padEnd(8)} ${c[5].padEnd(15)} ${c[6].padEnd(37)}`;
  const l3Rows = l3s.map((l) => {
    const rmacs = Object.keys(rt?.rmacs ?? {}).filter((k) => k.startsWith(`${l.vrf}|`)).length;
    const nhs = Object.keys(rt?.nhs ?? {}).filter((ip) => rt!.rmacs[`${l.vrf}|${ip}`]).length;
    return f([String(l.vni), "L3", vxlanNetdev(cfg, l.vid), String(rmacs), String(nhs), "n/a", l.vrf]);
  });
  return [f(["VNI", "Type", "VxLAN IF", "# MACs", "# ARPs", "# Remote VTEPs", "Tenant VRF"]), ...views.map((v) => f([String(v.vni), "L2", v.ifname, String(v.local.length + v.remote.length), String(v.neighs.length), String(v.vteps.length), v.vrf])), ...l3Rows];
}

/** show evpn rmac vni <vni>|all. */
export function renderEvpnRmac(device: Device, vniArg: string): string[] {
  const cfg = evpnEnabled(device);
  if (!cfg) return [];
  const rt = peekVxlanRuntime(device);
  const l3s = l3Vnis(device, cfg);
  const rows = (vrf: string) => Object.entries(rt?.rmacs ?? {}).filter(([k]) => k.startsWith(`${vrf}|`)).map(([k, mac]) => `${mac.padEnd(17)} ${k.split("|")[1].padEnd(21)}`);
  if (vniArg === "all") return l3s.flatMap((l) => (rows(l.vrf).length ? ["", `VNI ${l.vni} #RMACs ${rows(l.vrf).length}`, "", `${"RMAC".padEnd(17)} ${"Remote VTEP".padEnd(21)}`, ...rows(l.vrf)] : []));
  const l = l3s.find((x) => x.vni === Number(vniArg));
  if (!l) return [`% L3-VNI ${vniArg} does not exist`];
  const r = rows(l.vrf);
  return r.length ? [`Number of Remote RMACs known for this VNI: ${r.length}`, `${"MAC".padEnd(17)} ${"Remote VTEP".padEnd(21)}`, ...r] : [];
}

/** show evpn next-hops vni <vni>|all. */
export function renderEvpnNextHops(device: Device, vniArg: string): string[] {
  const cfg = evpnEnabled(device);
  if (!cfg) return [];
  const rt = peekVxlanRuntime(device);
  const l3s = l3Vnis(device, cfg);
  const rows = (vrf: string) => Object.entries(rt?.nhs ?? {}).filter(([ip]) => rt!.rmacs[`${vrf}|${ip}`]).map(([ip, n]) => `${ip.padEnd(15)} ${n.rmac.toLowerCase().padEnd(17)}`);
  if (vniArg === "all") return l3s.flatMap((l) => (rows(l.vrf).length ? ["", `VNI ${l.vni} #Next-Hops ${rows(l.vrf).length}`, "", `${"IP".padEnd(15)} ${"RMAC".padEnd(17)}`, ...rows(l.vrf)] : []));
  const l = l3s.find((x) => x.vni === Number(vniArg));
  if (!l) return [`% L3-VNI ${vniArg} does not exist`];
  const r = rows(l.vrf);
  return r.length ? [`Number of NH Neighbors known for this VNI: ${r.length}`, `${"IP".padEnd(15)} ${"RMAC".padEnd(17)}`, ...r] : [];
}

/** show evpn arp-cache vni <vni>|all (zebra neighbour table: local SVI neighbours + type-2 MAC+IP). */
export function renderEvpnArpCache(device: Device, vniArg: string): string[] {
  const cfg = evpnEnabled(device);
  if (!cfg) return [];
  const views = vniViews(device, cfg);
  const block = (v: VniView) => {
    const w = Math.max(15, ...v.neighs.map((n) => n.ip.length));
    return [
      "Flags: I=local-inactive, P=peer-active, X=peer-proxy",
      `${"Neighbor".padEnd(w)} ${"Type".padEnd(6)} ${"Flags".padEnd(5)} ${"State".padEnd(8)} ${"MAC".padEnd(17)} ${"Remote ES/VTEP".padEnd(30)} Seq #'s`,
      ...v.neighs.map((n) => `${n.ip.padEnd(w)} ${n.type.padEnd(6)} ${"".padEnd(5)} ${"active".padEnd(8)} ${n.mac.padEnd(17)} ${n.vtep.padEnd(30)} 0/0`),
    ];
  };
  if (vniArg === "all") return views.flatMap((v) => (v.neighs.length ? ["", `VNI ${v.vni} #ARP (IPv4 and IPv6, local and remote) ${v.neighs.length}`, "", ...block(v)] : []));
  const v = views.find((x) => x.vni === Number(vniArg));
  if (!v) return [`% VNI ${vniArg} does not exist`];
  return v.neighs.length ? [`Number of ARPs (local and remote) known for this VNI: ${v.neighs.length}`, ...block(v)] : [];
}

/** show evpn es (zebra_evpn_mh.c:3269, :3134). */
export function renderEvpnEs(device: Device): string[] {
  const local = localEss(device);
  const out = ["Type: B bypass, L local, R remote, N non-DF", `${"ESI".padEnd(30)} ${"Type".padEnd(4)} ${"ES-IF".padEnd(21)} VTEPs`];
  for (const e of [...local].sort((a, b) => a.esi.localeCompare(b.esi))) {
    const peers = Object.keys(esPeers(device, e.esi)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const type = `L${peers.length ? "R" : ""}${isDf(device, e) ? "" : "N"}`;
    out.push(`${e.esi.padEnd(30)} ${type.padEnd(4)} ${e.ifname.padEnd(21)} ${peers.join(",")}`);
  }
  return out;
}

function macRows(v: VniView): string[] {
  const local = v.local.map((m) => `${m.mac.padEnd(17)} ${"local".padEnd(6)} ${"".padEnd(5)} ${m.port.padEnd(30)} ${String(v.vid).padEnd(5)} ${m.seq}/0`);
  const remote = v.remote.map((m) => `${m.mac.padEnd(17)} ${"remote".padEnd(6)} ${"".padEnd(5)} ${m.vtep.padEnd(30)} ${"".padEnd(5)} 0/${m.seq}`);
  return [...local, ...remote];
}

const MAC_HDR = `${"MAC".padEnd(17)} ${"Type".padEnd(6)} ${"Flags".padEnd(5)} ${"Intf/Remote ES/VTEP".padEnd(30)} ${"VLAN".padEnd(5)} Seq #'s`;
const MAC_FLAGS = "Flags: N=sync-neighs, I=local-inactive, P=peer-active, X=peer-proxy";

export function renderEvpnMac(device: Device, vniArg: string): string[] {
  const cfg = evpnEnabled(device);
  if (!cfg) return [];
  const views = vniViews(device, cfg);
  if (vniArg === "all") {
    return views.flatMap((v) => (v.local.length + v.remote.length ? ["", `VNI ${v.vni} #MACs (local and remote) ${v.local.length + v.remote.length}`, "", MAC_FLAGS, MAC_HDR, ...macRows(v)] : []));
  }
  const v = views.find((x) => x.vni === Number(vniArg));
  if (!v) return [`% VNI ${vniArg} does not exist`];
  if (!v.local.length && !v.remote.length) return [];
  return [`Number of MACs (local and remote) known for this VNI: ${v.local.length + v.remote.length}`, MAC_FLAGS, MAC_HDR, ...macRows(v)];
}

// ---------------------------------------------------------------------------
// Click config

function vlanExists(device: Device, vid: number): boolean {
  return (device.config.vlans ?? []).some((v) => v.id === vid);
}

function vtepRow(device: Device, name: string): Row | undefined {
  return (cpList(device, "vxlan", "vteps") as Row[]).find((v) => v.name === name);
}

function mapAdd(ctx: CommandContext, vtep: string, vlan: string, vni: string): CommandResult | null {
  if (!/^\d+$/.test(vlan)) return fail(`Invalid vlan ${vni}. Only valid vlan is accepted`);
  if (Number(vlan) < 1 || Number(vlan) > 4094) return fail(" Invalid Vlan Id , Valid Range : 1 to 4094 ");
  if (!/^\d+$/.test(vni)) return fail(`Invalid VNI ${vni}. Only valid VNI is accepted`);
  if (Number(vni) < 1 || Number(vni) > 16777215) return fail(`Invalid VNI ${vni}. Valid range [1 to 16777215].`);
  if (!vtepRow(ctx.device, vtep)) return fail(`VTEP ${vtep} not configured`);
  if (!vlanExists(ctx.device, Number(vlan))) return fail(`Vlan${vlan} not configured`);
  const maps = cpList(ctx.device, "vxlan", "vlanmap") as Row[];
  if (maps.some((m) => m.vlan === `Vlan${vlan}`)) return fail(" Vlan Id already mapped ");
  if (maps.some((m) => m.vni === vni)) return fail(" VNI Id already mapped ");
  cpUpsert(ctx.device, "vxlan", "vlanmap", { vlan: `Vlan${vlan}`, vni, vtep }, "vlan");
  return null;
}

const ok: CommandResult = { output: [] };

const vrfExists = (device: Device, name: string) => !!(device.config.features?.vrf as { vrfs?: { name: string }[] } | undefined)?.vrfs?.some((v) => v.name === name);

export const vxlanClickConfig: SonicCmd[] = [
  {
    path: ["vrf", "add_vrf_vni_map"],
    summary: "Map a VRF to its L3 VNI (config vrf add_vrf_vni_map <vrf-name> <vni>)",
    run(a, ctx) {
      const [vrf, vni] = a;
      if (!vrf || !vni) return { output: [err("Usage: config vrf add_vrf_vni_map [OPTIONS] <vrf-name> <vni>")] };
      if (!vrfExists(ctx.device, vrf)) return fail(`vrf ${vrf} doesnt exists`);
      if (!/^\d+$/.test(vni)) return fail(`Invalid VNI ${vni}. Only valid VNI is accepted`);
      if (Number(vni) < 1 || Number(vni) > 16777215) return fail(`Invalid VNI ${vni}. Valid range [1 to 16777215].`);
      if (!(cpList(ctx.device, "vxlan", "vlanmap") as Row[]).some((m) => m.vni === vni)) return fail("VLAN VNI not mapped. Please create VLAN VNI map entry first");
      const other = (cpList(ctx.device, "vxlan", "vrfmap") as Row[]).find((m) => m.vni === vni && m.vrf !== vrf);
      if (other) return fail(`VNI already mapped to vrf ${other.vrf}`);
      cpUpsert(ctx.device, "vxlan", "vrfmap", { vrf, vni }, "vrf");
      return ok;
    },
  },
  {
    path: ["vrf", "del_vrf_vni_map"],
    summary: "Remove a VRF's L3 VNI",
    run(a, ctx) {
      if (!a[0]) return { output: [err("Usage: config vrf del_vrf_vni_map [OPTIONS] <vrf-name>")] };
      if (!vrfExists(ctx.device, a[0])) return fail(`vrf ${a[0]} doesnt exists`);
      cpRemove(ctx.device, "vxlan", "vrfmap", "vrf", a[0]);
      return ok;
    },
  },
  {
    path: ["neigh_suppress"],
    summary: "ARP/ND suppression on a VLAN (config neigh_suppress enable|disable <vlan_id>)",
    run(a, ctx) {
      const [op, vid] = a;
      if ((op !== "enable" && op !== "disable") || !vid) return { output: [err("Usage: config neigh_suppress enable|disable <vlan_id>")] };
      if (!vlanExists(ctx.device, Number(vid))) return fail(`Vlan${vid} not configured`);
      if (op === "enable") cpUpsert(ctx.device, "vxlan", "suppress", { name: `Vlan${vid}`, suppress: "on" }, "name");
      else cpRemove(ctx.device, "vxlan", "suppress", "name", `Vlan${vid}`);
      return ok;
    },
  },
  {
    path: ["vxlan", "add"],
    summary: "Add the VTEP (config vxlan add <vxlan_name> <src_ip>)",
    run(a, ctx) {
      const [name, src] = a;
      if (!name || !src) return { output: [err("Usage: config vxlan add [OPTIONS] <vxlan_name> <src_ip>")] };
      if (!isValidIpv4(src)) return fail(`${src} invalid src ip address`);
      if (name.length > 15) return fail("'vxlan_name' length should not exceed 15 characters");
      if (cpList(ctx.device, "vxlan", "vteps").length) return fail("VTEP already configured.");
      cpUpsert(ctx.device, "vxlan", "vteps", { name, source_ip: src }, "name");
      return ok;
    },
  },
  {
    path: ["vxlan", "del"],
    summary: "Delete the VTEP",
    run(a, ctx) {
      const name = a[0];
      if (!name || !vtepRow(ctx.device, name)) return fail(`Vxlan tunnel ${name ?? ""} does not exist`);
      if ((cpList(ctx.device, "vxlan", "nvo") as Row[]).some((n) => n.source_vtep === name)) return fail("Please delete the EVPN NVO configuration.");
      if (cpList(ctx.device, "vxlan", "vlanmap").length) return fail("Please delete all VLAN VNI mappings.");
      cpRemove(ctx.device, "vxlan", "vteps", "name", name);
      return ok;
    },
  },
  {
    path: ["vxlan", "evpn_nvo", "add"],
    summary: "Add the EVPN NVO (config vxlan evpn_nvo add <nvo_name> <vxlan_name>)",
    run(a, ctx) {
      const [nvo, vtep] = a;
      if (!nvo || !vtep) return { output: [err("Usage: config vxlan evpn_nvo add [OPTIONS] <nvo_name> <vxlan_name>")] };
      if (cpList(ctx.device, "vxlan", "nvo").length) return fail("EVPN NVO already configured");
      if (!vtepRow(ctx.device, vtep)) return fail(`VTEP ${vtep} not configured`);
      cpUpsert(ctx.device, "vxlan", "nvo", { name: nvo, source_vtep: vtep }, "name");
      return ok;
    },
  },
  {
    path: ["vxlan", "evpn_nvo", "del"],
    summary: "Delete the EVPN NVO",
    run(a, ctx) {
      if (cpList(ctx.device, "vxlan", "vlanmap").length) return fail("Please delete all VLAN VNI mappings.");
      cpRemove(ctx.device, "vxlan", "nvo", "name", a[0]);
      return ok;
    },
  },
  {
    path: ["vxlan", "map", "add"],
    summary: "Add a VLAN-VNI map (config vxlan map add <vxlan_name> <vlan_id> <vni>)",
    run(a, ctx) {
      if (a.length < 3) return { output: [err("Usage: config vxlan map add [OPTIONS] <vxlan_name> <vlan_id> <vni>")] };
      return mapAdd(ctx, a[0], a[1], a[2]) ?? ok;
    },
  },
  {
    path: ["vxlan", "map", "del"],
    summary: "Delete a VLAN-VNI map",
    run(a, ctx) {
      if (a.length < 3) return { output: [err("Usage: config vxlan map del [OPTIONS] <vxlan_name> <vlan_id> <vni>")] };
      if (!vtepRow(ctx.device, a[0])) return fail(`VTEP ${a[0]} not configured`);
      cpRemove(ctx.device, "vxlan", "vlanmap", "vlan", `Vlan${a[1]}`);
      return ok;
    },
  },
  {
    path: ["vxlan", "map_range", "add"],
    summary: "Add VLAN-VNI maps for a VLAN range",
    run(a, ctx) {
      const [vtep, s, e, v] = a;
      if (a.length < 4) return { output: [err("Usage: config vxlan map_range add [OPTIONS] <vxlan_name> <vlan_start> <vlan_end> <vni_start>")] };
      if (Number(e) < Number(s)) return fail("vlan_end should be greater or equal to vlan_start");
      const out: OutputLine[] = [];
      for (let vid = Number(s); vid <= Number(e); vid++) {
        if (!vlanExists(ctx.device, vid)) {
          out.push(line(`Vlan${vid} not configured`));
          continue;
        }
        const r = mapAdd(ctx, vtep, String(vid), String(Number(v) + vid - Number(s)));
        if (r) return r;
      }
      return { output: out };
    },
  },
  {
    path: ["vxlan", "map_range", "del"],
    summary: "Delete VLAN-VNI maps for a VLAN range",
    run(a, ctx) {
      const [, s, e] = a;
      for (let vid = Number(s); vid <= Number(e); vid++) cpRemove(ctx.device, "vxlan", "vlanmap", "vlan", `Vlan${vid}`);
      return ok;
    },
  },
];

const showCmd = (path: string[], summary: string, render: (a: string[], d: Device) => string[]): SonicCmd => ({ path, summary, run: (a, ctx) => ({ output: toLines(render(a, ctx.device)) }) });

export const vxlanClickShow: SonicCmd[] = [
  showCmd(["vxlan", "interface"], "Show VXLAN VTEP Information", (_a, d) => showInterface(d)),
  showCmd(["vxlan", "vlanvnimap"], "Show VLAN VNI Mapping Information", (a, d) => showVlanVniMap(d, a[0] !== undefined)),
  showCmd(["vxlan", "vrfvnimap"], "Show VRF VNI Mapping Information", (_a, d) => showVrfVniMap(d)),
  showCmd(["vxlan", "tunnel"], "Show vxlan tunnel information", (_a, d) => showTunnel(d)),
  showCmd(["vxlan", "name"], "Show vxlan name <vxlan_name> information", (a, d) => showTunnel(d, a[0] ?? "")),
  {
    path: ["vxlan", "remotevtep"],
    summary: "Show All Remote VTEP Information",
    run: (a, ctx) => ({ output: a[0] !== undefined && a[0] !== "count" ? [line(`Unacceptable argument ${a[0]}`)] : toLines(showRemoteVtep(ctx.device, a[0] === "count")) }),
  },
  {
    path: ["vxlan", "remotevni"],
    summary: "Show Vlans extended to the remote VTEP",
    run: (a, ctx) => (a[0] ? { output: toLines(showRemoteVni(ctx.device, a[0], a[1] !== undefined)) } : { output: [err("Usage: show vxlan remotevni [OPTIONS] REMOTE_VTEP_IP [COUNT]")] }),
  },
  {
    path: ["vxlan", "remotemac"],
    summary: "Show MACs pointing to the remote VTEP",
    run(a, ctx) {
      if (!a[0]) return { output: [err("Usage: show vxlan remotemac [OPTIONS] REMOTE_VTEP_IP [COUNT]")] };
      // count with a specific VTEP prints the filtered count (show/vxlan.py:283-305)
      const lines = showRemoteMac(ctx.device, a[0], a[1] !== undefined);
      return { output: toLines(a[1] !== undefined && a[0] !== "all" ? total(remoteMacs(ctx.device, a[0]).length) : lines) };
    },
  },
  showCmd(["vxlan", "counters"], "Show VxLAN counters", (a, d) => showVxlanCounters(d, a.find((x) => !x.startsWith("-")))),
  showCmd(["evpn", "vni"], "Show EVPN VNIs (FRR zebra)", (a, d) => renderEvpnVni(d, a[0])),
  {
    path: ["evpn", "mac", "vni"],
    summary: "Show EVPN MACs of a VNI (FRR zebra)",
    run: (a, ctx) => (a[0] ? { output: toLines(renderEvpnMac(ctx.device, a[0])) } : { output: [muted("% Command incomplete: show evpn mac vni <1-16777215|all>")] }),
  },
  {
    path: ["evpn", "rmac", "vni"],
    summary: "Show remote router MACs of an L3 VNI (FRR zebra)",
    run: (a, ctx) => (a[0] ? { output: toLines(renderEvpnRmac(ctx.device, a[0])) } : { output: [muted("% Command incomplete: show evpn rmac vni <1-16777215|all>")] }),
  },
  {
    path: ["evpn", "next-hops", "vni"],
    summary: "Show remote VTEP next hops of an L3 VNI (FRR zebra)",
    run: (a, ctx) => (a[0] ? { output: toLines(renderEvpnNextHops(ctx.device, a[0])) } : { output: [muted("% Command incomplete: show evpn next-hops vni <1-16777215|all>")] }),
  },
  {
    path: ["evpn", "arp-cache", "vni"],
    summary: "Show the EVPN neighbour (ARP) cache of a VNI (FRR zebra)",
    run: (a, ctx) => (a[0] ? { output: toLines(renderEvpnArpCache(ctx.device, a[0])) } : { output: [muted("% Command incomplete: show evpn arp-cache vni <1-16777215|all>")] }),
  },
  showCmd(["evpn", "es"], "Show EVPN Ethernet segments (FRR zebra)", (_a, d) => renderEvpnEs(d)),
];
