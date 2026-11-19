/**
 * Multicast show commands, rendered from the running pimd / IGMP snooping state.
 *
 * FRR 10.3 vtysh layouts (SONiC runs these in the bgp container; here they are
 * reachable as Click `show ip …` like the other FRR shows, and from KLISH for
 * the forms its grammar does not render itself):
 *   show ip pim neighbor   pim_cmd_common.c:3250-3330 pim_show_neighbors
 *   show ip pim join       pim_cmd_common.c:1684-1860 pim_show_join(_helper)
 *   show ip pim rp-info    pim_rp.c:1185-1300 pim_rp_show_information
 *   show ip igmp groups    pim_cmd.c:915-1043 igmp_group_print, :1135-1160 header
 *   show ip mroute         pim_cmd_common.c:3719-4100 show_mroute
 * All ttables are TTSTYLE_BLANK restyled with rpad 2 (lib/termtable.c:48-77,
 * ttable_dump :293-470), followed by the blank line vty_out("%s\n") adds.
 * Timers: pim_time.c (uptime HH:MM:SS, expiry MM:SS / HH:MM:SS, "--:--" when
 * no timer runs).
 *
 * SONiC KLISH layouts (data/device-capture/klish-xml EXAMPLE blocks):
 *   show ip pim neighbor / topology   pim.xml
 *   show ip igmp groups               igmp.xml
 *   show ip mroute [summary]          mroute.xml
 *   show ip igmp snooping groups      igmp_snooping.xml
 */
import { Device, interfaceByName } from "../models/device";
import { primaryIpv4 } from "../models/interface";
import { CommandContext, CommandResult, OutputLine, line } from "../commands/types";
import { SonicFeatureModule } from "../commands/sonic/types";
import {
  Pimd, peekPimd, iifOf, oilSg, oilStar, oifProto, rpAddress, rpfOf, iAmRp, starGroups, localMembers,
} from "./pim-daemon";
import { snoopGroups, snoopConfig } from "./igmp-snooping";
import { ipCmp } from "./mcast-wire";

const two = (n: number) => String(Math.floor(n)).padStart(2, "0");
export function hhmmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${two(s / 3600)}:${two((s % 3600) / 60)}:${two(s % 60)}`;
}
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${two(s / 60)}:${two(s % 60)}`;
}
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const addrOf = (d: Device, iface: string) => {
  const i = interfaceByName(d, iface);
  return (i && primaryIpv4(i)?.address) ?? "0.0.0.0";
};

/** FRR ttable TTSTYLE_BLANK with cell rpad 2, plus the trailing blank line. */
function frrTable(rows: string[][]): string[] {
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return [...rows.map((r) => (" " + r.map((v, c) => v.padEnd(w[c] + 2)).join("")).trimEnd()), ""];
}

const empty = (): Pimd => ({ helloNext: {}, nbrs: [], igmpIf: {}, groups: [], ifch: [], rptPrunes: [], sg: [], starSince: {}, adv: [], stats: {} });

// ---------------------------------------------------------------------------
// FRR

export function frrPimNeighbor(d: Device, now: number): string[] {
  const st = peekPimd(d) ?? empty();
  const rows = [["Interface", "Neighbor", "Uptime", "Holdtime", "DR Pri"]];
  for (const n of st.nbrs.filter((x) => x.expiresMs > now).sort((a, b) => byName(a.iface, b.iface) || ipCmp(a.addr, b.addr))) {
    rows.push([n.iface, n.addr, hhmmss(now - n.sinceMs), hhmmss(n.expiresMs - now), String(n.drPriority)]);
  }
  return frrTable(rows);
}

export function frrPimJoin(d: Device, now: number): string[] {
  const st = peekPimd(d) ?? empty();
  type Row = { iface: string; src: string; group: string; cells: string[] };
  const rows: Row[] = [];
  for (const c of st.ifch.filter((x) => x.expiresMs > now)) {
    rows.push({ iface: c.iface, src: c.src, group: c.group, cells: [c.iface, addrOf(d, c.iface), c.src, c.group, "JOIN", hhmmss(now - c.sinceMs), mmss(c.expiresMs - now), "--:--"] });
  }
  for (const c of st.rptPrunes.filter((x) => x.expiresMs > now)) {
    rows.push({ iface: c.iface, src: c.src, group: c.group, cells: [c.iface, addrOf(d, c.iface), c.src, c.group, "SGRpt(P)", hhmmss(now - c.sinceMs), mmss(c.expiresMs - now), "--:--"] });
  }
  for (const g of starGroups(d, st, now)) {
    for (const i of localMembers(d, st, g, now)) {
      if (rows.some((r) => r.iface === i && r.src === "*" && r.group === g)) continue;
      rows.push({ iface: i, src: "*", group: g, cells: [i, addrOf(d, i), "*", g, "NOINFO", "--:--:--", "--:--", "--:--"] });
    }
  }
  const srcKey = (s: string) => (s === "*" ? "0.0.0.0" : s);
  rows.sort((a, b) => byName(a.iface, b.iface) || ipCmp(srcKey(a.src), srcKey(b.src)) || ipCmp(a.group, b.group));
  return frrTable([["Interface", "Address", "Source", "Group", "State", "Uptime", "Expire", "Prune"], ...rows.map((r) => r.cells)]);
}

export function frrRpInfo(d: Device): string[] {
  const rp = rpAddress(d);
  const rows = [["RP address", "group/prefix-list", "OIF", "I am RP", "Source", "Group-Type"]];
  if (rp) rows.push([rp, "224.0.0.0/4", rpfOf(d, rp)?.iface ?? "Unknown", iAmRp(d) ? "yes" : "no", "Static", "ASM"]);
  return frrTable(rows);
}

export function frrIgmpGroups(d: Device, now: number): string[] {
  const st = peekPimd(d) ?? empty();
  const groups = st.groups.filter((g) => g.expiresMs > now).sort((a, b) => byName(a.iface, b.iface) || ipCmp(a.group, b.group));
  const out = [`Total IGMP groups: ${groups.length}`, "Watermark warn limit(Not Set): 0", "Interface        Group           Mode Timer    Srcs V Uptime"];
  for (const g of groups) {
    const mode = g.version === 3 ? "EXCL" : "----";
    out.push(`${g.iface.padEnd(16)} ${g.group.padEnd(15)} ${mode.padStart(4)} ${hhmmss(g.expiresMs - now).padStart(8)} ${"1".padStart(4)} ${g.version} ${hhmmss(now - g.sinceMs).padStart(8)}`);
  }
  return out;
}

interface MrouteRow {
  src: string;
  group: string;
  flags: string;
  iif: string;
  oifs: { name: string; proto: string }[];
  sinceMs: number;
}

/** Installed multicast routes (channel_oil): (*,G) and (S,G). */
export function mroutes(d: Device, now: number): MrouteRow[] {
  const st = peekPimd(d);
  if (!st) return [];
  const rows: MrouteRow[] = [];
  const rp = rpAddress(d);
  for (const g of starGroups(d, st, now)) {
    const oil = oilStar(d, st, g, now);
    const iif = rp ? rpfOf(d, rp)?.iface ?? "<iif?>" : "<iif?>";
    const flags = "S" + (localMembers(d, st, g, now).length ? "C" : "") + (oil.length ? "" : "P");
    rows.push({ src: "*", group: g, flags, iif, oifs: oil.filter((o) => o !== iif).map((o) => ({ name: o, proto: oifProto(d, st, "*", g, o, now) })), sinceMs: st.starSince[g] ?? now });
  }
  for (const sg of st.sg) {
    const oifs = oilSg(d, st, sg, now).map((o) => ({ name: o, proto: oifProto(d, st, sg.src, sg.group, o, now) }));
    if (sg.fhr && sg.regState === "Join" && !iAmRp(d)) oifs.push({ name: "pimreg", proto: "PIM" });
    const flags = "S" + (sg.fhr ? "F" : "") + (sg.sptBit ? "T" : "") + (oifs.length ? "" : "P");
    rows.push({ src: sg.src, group: sg.group, flags, iif: iifOf(d, sg) ?? "<iif?>", oifs, sinceMs: sg.sinceMs });
  }
  const key = (s: string) => (s === "*" ? "0.0.0.0" : s);
  return rows.sort((a, b) => ipCmp(a.group, b.group) || ipCmp(key(a.src), key(b.src)));
}

export function frrMroute(d: Device, now: number): string[] {
  const rows = [["Source", "Group", "Flags", "Proto", "Input", "Output", "TTL", "Uptime"]];
  for (const r of mroutes(d, now)) {
    const up = hhmmss(now - r.sinceMs);
    if (!r.oifs.length) {
      rows.push([r.src, r.group, r.flags, "none", r.iif, "none", "0", "--:--:--"]);
      continue;
    }
    r.oifs.forEach((o, i) => rows.push(i === 0 ? [r.src, r.group, r.flags, o.proto, r.iif, o.name, "1", up] : ["", "", "", o.proto, "", o.name, "1", ""]));
  }
  return ["IP Multicast Routing Table", "Flags: S - Sparse, C - Connected, P - Pruned", "       R - SGRpt Pruned, F - Register flag, T - SPT-bit set", ...frrTable(rows)];
}

// ---------------------------------------------------------------------------
// KLISH

export function klishPimNeighbor(d: Device, now: number, addr?: string): string[] {
  const st = peekPimd(d) ?? empty();
  const out = ["", "PIM neighbor information for VRF: default", `${"Interface".padEnd(16)}${"Neighbor".padEnd(16)}${"Uptime".padEnd(15)}${"Expirytime".padEnd(17)}DR-Priority`];
  for (const n of st.nbrs.filter((x) => x.expiresMs > now && (!addr || x.addr === addr)).sort((a, b) => byName(a.iface, b.iface) || ipCmp(a.addr, b.addr))) {
    out.push(`${n.iface.padEnd(16)}${n.addr.padEnd(16)}${hhmmss(now - n.sinceMs).padEnd(15)}${hhmmss(n.expiresMs - now).padEnd(17)}${n.drPriority}`);
  }
  return out;
}

export function klishPimTopology(d: Device, now: number, group?: string, source?: string): string[] {
  const st = peekPimd(d) ?? empty();
  const out = ["", "PIM multicast routing table for VRF: default"];
  for (const r of mroutes(d, now)) {
    if (group && r.group !== group) continue;
    if (source && (r.src === "*" ? "0.0.0.0" : r.src) !== source) continue;
    const sg = r.src === "*" ? undefined : st.sg.find((s) => s.src === r.src && s.group === r.group);
    const rpfAddr = (r.src === "*" ? (rpAddress(d) ? rpfOf(d, rpAddress(d)!) : undefined) : rpfOf(d, r.src))?.nbr ?? "0.0.0.0";
    out.push(`(${r.src}, ${r.group}), uptime ${hhmmss(now - r.sinceMs)}, expires ${sg ? hhmmss(sg.lastDataMs + 210_000 - now) : "--:--:--"}`);
    out.push(`  Incoming interface: ${r.iif}, RPF neighbor ${rpfAddr}`);
    out.push("  Outgoing interface list:");
    for (const o of r.oifs) {
      const ch = st.ifch.find((c) => c.iface === o.name && c.group === r.group && (c.src === r.src || (o.proto !== "PIM" && c.src === "*")));
      const memb = st.groups.find((g) => g.iface === o.name && g.group === r.group);
      const exp2 = ch ? hhmmss(ch.expiresMs - now) : memb ? hhmmss(memb.expiresMs - now) : "Never";
      const since = ch?.sinceMs ?? memb?.sinceMs ?? r.sinceMs;
      out.push(`    ${o.name.padEnd(10)}uptime/expiry-time: ${hhmmss(now - since)}/${exp2}`);
    }
    out.push("");
  }
  return out;
}

export function klishIgmpGroups(d: Device, now: number): string[] {
  const st = peekPimd(d) ?? empty();
  const out = ["", "Interface        Address         Group              Mode Timer    Srcs    V    Uptime  "];
  for (const g of st.groups.filter((x) => x.expiresMs > now).sort((a, b) => byName(a.iface, b.iface) || ipCmp(a.group, b.group))) {
    out.push(`${g.iface.padEnd(17)}${addrOf(d, g.iface).padEnd(16)}${g.group.padEnd(16)}${g.version === 3 ? "EXCL" : "----"} ${hhmmss(g.expiresMs - now)}    1         ${g.version}    ${hhmmss(now - g.sinceMs)}`);
  }
  return out;
}

/** (S,G) rows of `show ip mroute` (KLISH): source, group, input, outputs, uptime. */
export function klishMrouteRows(d: Device, now: number): { source: string; group: string; input: string; outputs: string[]; uptime: string }[] {
  return mroutes(d, now)
    .filter((r) => r.src !== "*" && r.oifs.some((o) => o.name !== "pimreg"))
    .map((r) => ({ source: r.src, group: r.group, input: r.iif, outputs: r.oifs.filter((o) => o.name !== "pimreg").map((o) => o.name), uptime: hhmmss(now - r.sinceMs) }));
}

/** Snooping table for `show ip igmp snooping groups` (static + learned). */
export function klishSnoopGroups(d: Device, vid: number, now: number): { source: string; group: string; ports: string[] }[] {
  return snoopConfig(d, vid) ? snoopGroups(d, vid, now) : [];
}

// ---------------------------------------------------------------------------
// Click (`show ip pim …`, `show ip igmp groups`, `show ip mroute`)

const res = (lines: string[]): CommandResult => ({ output: lines.map((l): OutputLine => line(l)) });
const now = () => Date.now();

export const mcastModule: SonicFeatureModule = {
  id: "multicast",
  config: [],
  show: [
    { path: ["ip", "pim", "neighbor"], summary: "PIM neighbors (FRR pimd)", run: (_a, ctx: CommandContext) => res(frrPimNeighbor(ctx.device, now())) },
    { path: ["ip", "pim", "join"], summary: "PIM downstream join state", run: (_a, ctx) => res(frrPimJoin(ctx.device, now())) },
    { path: ["ip", "pim", "rp-info"], summary: "PIM rendezvous points", run: (_a, ctx) => res(frrRpInfo(ctx.device)) },
    { path: ["ip", "igmp", "groups"], summary: "IGMP group membership", run: (_a, ctx) => res(frrIgmpGroups(ctx.device, now())) },
    { path: ["ip", "mroute"], summary: "IP multicast routing table", run: (_a, ctx) => res(frrMroute(ctx.device, now())) },
  ],
};
