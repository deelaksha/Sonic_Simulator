/**
 * KLISH operational shows for PIM / interface IGMP that had no handler, rendered
 * from the live pimd model (lib/protocols/pim-daemon.ts) and the stored config:
 *
 *   show ip pim [vrf <v>|all] interface [<if>] [detail|traffic]   pim.xml:17 → show_pim.j2 show_interface(_detail|_traffic)
 *   show ip pim [vrf <v>|all] rpf | ssm | rp [<grp>|mapping] | assert | multicast
 *                                                                 show_pim.j2 show_rpf / show_ssm / show_rp(_group|_mapping) / show_assert / show_multicast
 *   show ip igmp interface [<if>] [detail]                        igmp.xml:54 → show_ip_igmp_interface.j2
 *   show ip igmp join | sources                                   igmp.xml:35/106 → show_ip_igmp_joins.j2 / show_ip_igmp_sources.j2
 *   show ip igmp statistics [interface <if>]                      igmp.xml:125 → show_ip_igmp_statistics(_interface).j2
 *   show ip igmp vrf <v>|all interface|statistics|groups|sources|join   igmp.xml:156
 * Templates: sm-occli/brcm_files/version4.5/cli/render-templates (sonic_cli_pim.py / sonic_cli_igmp.py).
 * `show ip pim neighbor|topology` and `show ip igmp groups` stay in pim.ts.
 */
import { OutputLine, line } from "../../types";
import { registerModal } from "../registry";
import { Device, interfaceByName } from "../../../models/device";
import { networkAddress } from "../../../models/ip";
import { primaryIpv4 } from "../../../models/interface";
import { routeDistance } from "../../../models/route";
import { cpList, cpRunningLines } from "../config-plane";
import { Pimd, peekPimd, pimIfCfgs, igmpIfCfgs, rpAddress, rpfOf, drOf, IgmpIfCfg } from "../../../protocols/pim-daemon";
import { hhmmss, mroutes, klishIgmpGroups } from "../../../protocols/mcast-show";

const L = (rows: string[]): { output: OutputLine[] } => ({ output: rows.map((r) => line(r)) });
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const ljust = (v: unknown, n: number) => String(v).padEnd(n);
const addrOf = (d: Device, ifname: string) => {
  const i = interfaceByName(d, ifname);
  return (i && primaryIpv4(i)?.address) ?? "0.0.0.0";
};
const operOf = (d: Device, ifname: string) => (interfaceByName(d, ifname)?.operState === "up" ? "up" : "down");
const ifIndex = (d: Device, ifname: string) => Math.max(0, d.interfaces.findIndex((i) => i.name === ifname)) + 1;
const emptyPimd = (): Pimd => ({ helloNext: {}, nbrs: [], igmpIf: {}, groups: [], ifch: [], rptPrunes: [], sg: [], starSince: {}, adv: [], stats: {} });

/** "Ethernet 0" / "Ethernet0" / "Vlan 10" → interface name; returns [name, tokens consumed]. */
function ifArg(t: string[]): [string | undefined, number] {
  if (!t[0] || !/^[A-Za-z]/.test(t[0]) || ["detail", "traffic"].includes(t[0].toLowerCase())) return [undefined, 0];
  if (t[1] && /^\d/.test(t[1])) return [t[0] + t[1], 2];
  return [t[0], 1];
}

// --- PIM ----------------------------------------------------------------------

function pimInterface(d: Device, now: number, vrf: string, want?: string): string[] {
  const st = peekPimd(d) ?? emptyPimd();
  const out = ["", `PIM interface information for VRF: ${vrf}`, `${ljust("Interface", 23)}${ljust("State", 10)}${ljust("Address", 18)}${ljust("PIM Nbrs", 12)}${ljust("PIM DR", 18)}${ljust("Hello-interval", 18)}${ljust("PIM DR-Priority", 15)}`];
  for (const c of pimIfCfgs(d).filter((x) => !want || x.iface === want).sort((a, b) => natural(a.iface, b.iface))) {
    const nbrs = st.nbrs.filter((n) => n.iface === c.iface && n.expiresMs > now).length;
    out.push(`${ljust(c.iface, 23)}${ljust(operOf(d, c.iface), 10)}${ljust(addrOf(d, c.iface), 18)}${ljust(nbrs, 12)}${ljust(drOf(d, c.iface, now), 18)}${ljust(c.helloInterval ?? 30, 18)}${ljust(c.drPriority ?? 1, 15)}`);
  }
  return [...out, " "];
}

function pimInterfaceDetail(d: Device, now: number, vrf: string, want?: string): string[] {
  const st = peekPimd(d) ?? emptyPimd();
  const out = ["", `PIM interface detail information for VRF: ${vrf}`];
  for (const c of pimIfCfgs(d).filter((x) => !want || x.iface === want).sort((a, b) => natural(a.iface, b.iface))) {
    const hello = c.helloInterval ?? 30;
    const s = st.stats[c.iface];
    const nbrs = st.nbrs.filter((n) => n.iface === c.iface && n.expiresMs > now);
    const dr = drOf(d, c.iface, now);
    const timer = st.helloNext[c.iface] !== undefined ? hhmmss(st.helloNext[c.iface] - now) : "--:--:--";
    out.push(`Interface  : ${c.iface}`, `State      : ${operOf(d, c.iface)}`, `Address    : ${addrOf(d, c.iface)} (primary)`, " ");
    const block = (uptime: string, gen: string) => [
      "Designated Router",
      "-----------------",
      `Address                : ${dr}`,
      `Local DR Priority      : ${c.drPriority ?? 1}`,
      "Neighbors that didnot",
      " advertise DR Priority : 0",
      `Uptime                 : ${uptime}`,
      "Elections              : 1",
      "Changes                : 0",
      " ",
      "Hellos",
      "------",
      `Period         : ${hello}`,
      `HoldTime       : ${Math.floor(hello * 3.5)}`,
      `Timer          : ${timer}`,
      `Receive        : ${s?.helloRx ?? 0}`,
      "Receive Failed : 0",
      `Send           : ${s?.helloTx ?? 0}`,
      "Send Failed    : 0",
      `Generation ID  : ${gen}`,
      " ",
    ];
    if (!nbrs.length) out.push(...block("--:--:--", "00000000"));
    for (const n of nbrs) {
      out.push("PIM Neighbors", "-------------", `${dr}        : ${operOf(d, c.iface)} for ${hhmmss(now - n.sinceMs)},holdtime expires in ${hhmmss(n.expiresMs - now)}`, " ");
      out.push(...block(hhmmss(now - n.sinceMs), n.genId.toString(16).padStart(8, "0")));
    }
    out.push(
      "Flags",
      "-----",
      "All Multicast   : no",
      "Broadcast       : yes",
      "Multicast       : yes",
      " ",
      "Join Prune Interval",
      "-------------------",
      "LAN Delay                    : yes",
      "Join Prune Override Interval : 2500 msec ",
      " ",
      "LAN Prune Delay",
      "---------------",
      "Propagation Delay            : 500 msec ",
      "Override Interval            : 2500 msec ",
      " ",
      " ",
    );
  }
  return [...out, " "];
}

function pimTraffic(d: Device, vrf: string, want?: string): string[] {
  const st = peekPimd(d) ?? emptyPimd();
  const cols = ["HELLO", "JOIN", "PRUNE", "REGISTER", "REGISTER-STOP", "ASSERT", "BSM"];
  const out = ["", `PIM interface traffic information for VRF: ${vrf}`, ljust("Interface", 16) + cols.map((c) => ljust(c, 22)).join(""), ljust("", 16) + cols.map(() => ljust("Rx/Tx", 22)).join(""), "-".repeat(170)];
  for (const c of pimIfCfgs(d).filter((x) => !want || x.iface === want).sort((a, b) => natural(a.iface, b.iface))) {
    const s = st.stats[c.iface];
    const v = [`${s?.helloRx ?? 0}/${s?.helloTx ?? 0}`, `${s?.jpRx ?? 0}/${s?.jpTx ?? 0}`, "0/0", `${s?.regRx ?? 0}/${s?.regTx ?? 0}`, `${s?.regStopRx ?? 0}/${s?.regStopTx ?? 0}`, "0/0", "0/0"];
    out.push(ljust(c.iface, 16) + v.map((x) => ljust(x, 22)).join(""));
  }
  return [...out, " "];
}

/** RIB route that resolves `addr` (longest match) for the RPF metric / preference columns. */
function ribRoute(d: Device, addr: string) {
  return d.routingTable.filter((r) => (r.vrf ?? "default") === "default" && networkAddress(addr, r.prefix) === r.destination).sort((a, b) => b.prefix - a.prefix)[0];
}

function pimRpf(d: Device, now: number, vrf: string): string[] {
  const out = ["", `PIM RPF information for VRF: ${vrf}`, `${ljust("Source", 18)}${ljust("Group", 18)}${ljust("RpfIface", 23)}${ljust("RpfAddress", 18)}${ljust("RpfNextHop", 18)}${ljust("Metric", 12)}${ljust("Pref", 12)}`];
  const rp = rpAddress(d);
  for (const r of mroutes(d, now)) {
    const target = r.src === "*" ? rp : r.src;
    if (!target) continue;
    const rpf = rpfOf(d, target);
    const route = ribRoute(d, target);
    const nh = rpf?.nbr ?? (rpf?.local ? target : "0.0.0.0");
    out.push(`${ljust(r.src, 18)}${ljust(r.group, 18)}${ljust(rpf?.iface ?? "<iif?>", 23)}${ljust(nh, 18)}${ljust(nh, 18)}${ljust(route?.metric ?? 0, 12)}${ljust(route ? routeDistance(route) : 0, 12)}`);
  }
  return [...out, " "];
}

function pimRp(d: Device, vrf: string, sub?: string): string[] {
  const rps = (cpList(d, "pim", "rps") as { vrf: string; rp: string; prefixList?: string }[]).filter((r) => r.vrf === vrf);
  const grp = (r: { prefixList?: string }) => r.prefixList ?? "224.0.0.0/4";
  if (sub === "mapping") return ["", `PIM RP information for VRF: ${vrf}`, ...rps.flatMap((r) => [`Group(s):${grp(r)}, Static`, `RP:${r.rp}, v2`]), " "];
  return ["", `PIM RP information for VRF: ${vrf}`, `${ljust("Group", 18)}${ljust("RP", 18)}`, ...rps.map((r) => `${ljust(grp(r), 18)}${ljust(r.rp, 18)}`), " "];
}

function pimMulticast(d: Device, now: number, vrf: string): string[] {
  const g = (cpList(d, "pim", "globals") as { vrf: string; joinPruneInterval?: number; ecmp?: boolean; ecmpRebalance?: boolean }[]).find((x) => x.vrf === vrf);
  const jp = g?.joinPruneInterval ?? 60;
  const n = mroutes(d, now).length;
  const out = [
    "",
    " ",
    `PIM multicast information for VRF: ${vrf}`,
    `VRF Name :${vrf}`,
    " ",
    `Total Dynamic Multicast Routes In VRF :${n}`,
    "Total Dynamic Uninstalled Multicast Routes In VRF :0",
    " ",
  ];
  if (vrf === "default") out.push(`Total Dynamic Multicast Routes Across All VRFs :${n}`, "Total Dynamic Uninstalled Multicast Routes Across All VRFs :0", " ");
  out.push(
    `Upstream Join Timer in secs :${jp}`,
    `JoinPrune Holdtime in secs :${Math.floor(jp * 3.5)}`,
    `PIM ECMP :${g?.ecmp ? "Enable" : "Disable"}`,
    `PIM ECMP Rebalance :${g?.ecmpRebalance ? "Enable" : "Disable"}`,
    " ",
    "rpfCacheRefreshDelayMsecs :50",
    "rpfCacheRefreshTimer :0",
    "rpfCacheRefreshRequests :0",
    "rpfCacheRefreshEvents :0",
    "rpfCacheRefreshLast :--:--:--",
    "nexthopLookups :0",
    "nexthopLookupsAvoided :0",
    " ",
    "Multicast Count:",
    "---------------",
    `${ljust("Interface", 18)}${ljust("State", 10)}${ljust("Address", 18)}${ljust("ifIndex", 12)}${ljust("Vif", 10)}${ljust("PktsIn", 15)}${ljust("PktsOut", 15)}${ljust("BytesIn", 15)}${ljust("BytesOut", 15)}`,
  );
  const ifs = [...new Set([...pimIfCfgs(d).map((c) => c.iface), ...igmpIfCfgs(d).map((c) => c.iface)])].sort(natural);
  ifs.forEach((i, vif) => out.push(`${ljust(i, 18)}${ljust(operOf(d, i), 10)}${ljust(addrOf(d, i), 18)}${ljust(ifIndex(d, i), 12)}${ljust(vif + 1, 10)}${ljust(0, 15)}${ljust(0, 15)}${ljust(0, 15)}${ljust(0, 15)}`));
  return [...out, " "];
}

registerModal({
  id: "klish-pim-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] !== "ip" || a[1] !== "pim") return null;
    let i = 2;
    const vrfs = ["default"];
    if (a[i] === "vrf") {
      if (args[i + 1] && args[i + 1] !== "default" && a[i + 1] !== "all") return null; // pim.ts answers unknown VRFs
      i += 2;
    }
    const sub = a[i];
    const d = ctx.device;
    const now = Date.now();
    const per = (f: (v: string) => string[]) => L(vrfs.flatMap(f));
    if (sub === "interface") {
      const [want, used] = ifArg(args.slice(i + 1));
      const mode = a[i + 1 + used];
      if (mode === "detail") return per((v) => pimInterfaceDetail(d, now, v, want));
      if (mode === "traffic") return per((v) => pimTraffic(d, v, want));
      return per((v) => pimInterface(d, now, v, want));
    }
    if (sub === "rpf") return per((v) => pimRpf(d, now, v));
    if (sub === "ssm") {
      const g = (cpList(d, "pim", "globals") as { vrf: string; ssmPrefixList?: string }[]).find((x) => x.vrf === "default");
      return per((v) => ["", `PIM SSM information for VRF: ${v}`, `SSM group range: ${g?.ssmPrefixList ?? "232.0.0.0/8"}`, " "]);
    }
    if (sub === "rp") return per((v) => pimRp(d, v, a[i + 1] === "mapping" ? "mapping" : undefined));
    // The pimd model runs no assert election (single forwarder per LAN in every lab).
    if (sub === "assert") return per((v) => ["", `PIM assert information for VRF: ${v}`, `${ljust("Interface", 23)}${ljust("Address", 18)}${ljust("Source", 18)}${ljust("Group", 18)}${ljust("State", 9)}${ljust("Winner", 18)}${ljust("Uptime", 15)}${ljust("Timer", 15)}`, " "]);
    if (sub === "multicast") return per((v) => pimMulticast(d, now, v));
    return null;
  },
});

// --- IGMP ---------------------------------------------------------------------

function igmpTimers(c: IgmpIfCfg) {
  const qi = c.queryInterval ?? 125;
  const qri = c.queryMaxResponseTime ?? 10;
  const lmqc = c.lastMemberQueryCount ?? 2;
  const lmqi = c.lastMemberQueryInterval ?? 10; // deciseconds
  const rv = 2;
  return { qi, qri, lmqc, lmqt: (lmqi * lmqc) / 10, gmi: rv * qi + qri, ohpi: rv * qi + qri, oqpi: rv * qi + qri / 2, rv, sqi: Math.floor(qi / 4) };
}

function igmpInterface(d: Device, now: number, vrf: string, detail: boolean, want?: string): string[] {
  const st = peekPimd(d) ?? emptyPimd();
  const cfgs = igmpIfCfgs(d).filter((c) => !want || c.iface === want).sort((a, b) => natural(a.iface, b.iface));
  const q = (c: IgmpIfCfg) => {
    const s = st.igmpIf[c.iface];
    const me = addrOf(d, c.iface);
    return { s, me, local: !s || s.querier === me, querier: s?.querier ?? me };
  };
  if (!detail) {
    const out = ["", `IGMP interface information for VRF: ${vrf}`, `${ljust("Interface", 23)}${ljust("State", 10)}${ljust("Address", 18)}${ljust("V", 12)}${ljust("Querier", 18)}${ljust("QuerierIp", 18)}${ljust("Uptime", 15)}`];
    for (const c of cfgs) {
      const x = q(c);
      out.push(`${ljust(c.iface, 23)}${ljust(operOf(d, c.iface), 10)}${ljust(x.me, 18)}${ljust(c.version ?? 3, 12)}${ljust(x.local ? "local" : "other", 18)}${ljust(x.querier, 18)}${ljust(x.s ? hhmmss(now - x.s.sinceMs) : "--:--:--", 15)}`, "");
    }
    return out;
  }
  const out: string[] = [];
  for (const c of cfgs) {
    const x = q(c);
    const t = igmpTimers(c);
    out.push(
      "  ",
      "",
      `Interface : ${c.iface}`,
      `UpTime    : ${x.s ? hhmmss(now - x.s.sinceMs) : "--:--:--"}`,
      `State     : ${operOf(d, c.iface)}`,
      `Address   : ${x.me}`,
      `Version   : ${c.version ?? 3}`,
      "  ",
      "Querier",
      "-------",
      `Querier     : ${x.local ? "local" : "other"}`,
      `Start Count : ${x.s?.startupLeft ?? 0}`,
      `Query Timer : ${x.local && x.s ? hhmmss(x.s.nextQueryMs - now) : "--:--:--"}`,
      `Other Timer : ${!x.local && x.s?.otherUntil ? hhmmss(x.s.otherUntil - now) : "--:--:--"}`,
      "  ",
      "",
      "Timers",
      "------",
      `Group Membership Interval      : ${t.gmi}s`,
      `Last Member Query Count        : ${t.lmqc}`,
      `Last Member Query Time         : ${t.lmqt}s`,
      `Older Host Present Interval    : ${t.ohpi}s`,
      `Other Querier Present Interval : ${t.oqpi}s`,
      `Query Interval                 : ${t.qi}s`,
      `Query Response Interval        : ${t.qri}s`,
      `Robustness Variable            : ${t.rv}`,
      `Startup Query Interval         : ${t.sqi}s`,
      "  ",
      "",
      "Flags",
      "-----",
      "All Multicast   : no",
      "Broadcast       : yes",
      "Deleted         : no",
      `Interface Index : ${ifIndex(d, c.iface)}`,
      "Multicast       : yes",
      "Multicast Loop  : 0",
      "Promiscuous     : no",
    );
  }
  return out;
}

/** Stored `ip igmp join <group> [<source>]` lines (interface config, generic store). */
function igmpJoins(d: Device): { iface: string; group: string; source: string }[] {
  return cpRunningLines(d)
    .map((l) => ({ ctx: l.ctx, t: l.line.split(/\s+/) }))
    .filter(({ t }) => t[0] === "ip" && t[1] === "igmp" && t[2] === "join" && t[3])
    .map(({ ctx, t }) => ({ iface: ctx, group: t[3], source: t[4] ?? "*" }))
    .sort((a, b) => natural(a.iface, b.iface));
}

function igmpSources(d: Device, now: number, vrfLine: boolean, vrf: string): string[] {
  const st = peekPimd(d) ?? emptyPimd();
  const groups = st.groups.filter((g) => g.expiresMs > now).sort((a, b) => natural(a.iface, b.iface) || natural(a.group, b.group));
  const out = [""];
  if (vrfLine) out.push(`VRF : ${vrf}`);
  out.push(`${ljust("Interface", 15)}${ljust("Address", 20)}${ljust("Group", 20)}${ljust("Source", 20)}${ljust("Timer", 15)}${ljust("Fwd", 10)}Uptime`);
  // IGMPv2 / v3-exclude memberships are (*,G): source "*", forwarding, no per-source timer.
  for (const g of groups) out.push(`${ljust(g.iface, 15)}${ljust(addrOf(d, g.iface), 20)}${ljust(g.group, 20)}${ljust("*", 20)}${ljust("--:--:--", 15)}${ljust("Y", 10)}${hhmmss(now - g.sinceMs)}`);
  return out;
}

function igmpStats(vrfLine: boolean, vrf: string): string[] {
  // Per-message IGMP counters are not kept by the pimd model.
  return [
    "",
    ...(vrfLine ? [`VRF : ${vrf}`] : []),
    "IGMP RX statistics",
    "Interface       : Global",
    "V1 query        :  0",
    "V2 query        :  0",
    "V3 query        :  0",
    "V2 leave        :  0",
    "V1 report       :  0",
    "V2 report       :  0",
    "V3 report       :  0",
    "mtrace response :  0",
    "mtrace request  :  0",
    "unsupported     :  0",
  ];
}

registerModal({
  id: "klish-igmp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] !== "ip" || a[1] !== "igmp" || a[2] === "snooping") return null;
    const d = ctx.device;
    const now = Date.now();
    let i = 2;
    let vrf = "default";
    let viaVrf = false;
    if (a[2] === "vrf") {
      vrf = a[3] === "all" ? "default" : args[3] ?? "default";
      if (vrf !== "default") return L([]); // multicast runs in the default VRF only
      viaVrf = true;
      i = 4;
    }
    const sub = a[i];
    if (sub === "interface") {
      const [want, used] = ifArg(args.slice(i + 1));
      const detail = a[i + 1 + used] === "detail" || !!want;
      return L(igmpInterface(d, now, vrf, detail, want));
    }
    if (sub === "join") {
      const joins = igmpJoins(d);
      if (!joins.length) return L([]);
      return L([`${ljust("Interface", 15)}${ljust("Address", 15)}${ljust("Source", 15)}${ljust("Group", 15)}${ljust("Socket", 10)}Uptime`, ...joins.map((j, n) => `${ljust(j.iface, 15)}${ljust(addrOf(d, j.iface), 15)}${ljust(j.source, 15)}${ljust(j.group, 15)}${ljust(15 + n, 10)}--:--:--`)]);
    }
    if (sub === "sources") return L(igmpSources(d, now, viaVrf, vrf));
    if (sub === "statistics") return L(igmpStats(viaVrf, vrf));
    if (sub === "groups" && viaVrf) return L(klishIgmpGroups(d, now));
    return null;
  },
});
