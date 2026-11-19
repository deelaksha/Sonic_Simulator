/**
 * PIM (IPv4 Protocol Independent Multicast) + interface IGMP — KLISH config and
 * operational shows. The configuration is stored as CONFIG_DB holds it
 * (PIM_GLOBALS / PIM_GLOBALS_RENDEZVOUS_POINT / PIM_INTERFACE, and
 * IGMP_INTERFACE_QUERY under config-plane id "igmp") and RUNS: the pimd model in
 * lib/protocols/pim-daemon.ts sends Hellos, elects the IGMP querier, builds
 * (*,G)/(S,G) state with Join/Prune + Register, and forwards multicast.
 *
 * Wired from data/device-capture/klish-xml/pim.xml + igmp.xml:
 *
 * configure-view (global, PIM_GLOBALS keyed by vrf; RP list per vrf+rp):
 *   ip pim [vrf <name>] ecmp [rebalance]
 *   ip pim [vrf <name>] join-prune-interval <60-600>
 *   ip pim [vrf <name>] keep-alive-timer <31-60000>
 *   ip pim [vrf <name>] ssm prefix-list <name>
 *   ip pim [vrf <name>] rp-address <A.B.C.D> [prefix-list <name>]
 *   ip pim [vrf <name>] spt-threshold infinity [prefix-list <name>]
 *   no ip pim [vrf <name>] <same>            clear / reset to default
 *
 * configure-if-view / -vlan-view / -lag-view / -lo-view (PIM_INTERFACE):
 *   ip pim sparse-mode
 *   ip pim drpriority <1-4294967295>
 *   ip pim hello <1-255>
 *   ip pim bfd [profile <name>]
 *   no ip pim <same>                         clear
 * and IGMP (igmp.xml:231-420, IGMP_INTERFACE_QUERY):
 *   ip igmp                                  enable IGMP (querier) on the interface
 *   ip igmp version <2-3>                    default 3
 *   ip igmp query-interval <1-1800>          seconds, default 125
 *   ip igmp query-max-response-time <1-25>   seconds, default 10
 *   ip igmp last-member-query-count <1-7>    default 2
 *   ip igmp last-member-query-interval <1-255>  deciseconds, default 10
 *   no ip igmp [<same>]
 *
 * enable-view:
 *   show running-configuration pim | igmp    the stored config
 *   show ip pim [vrf default] neighbor [<addr>]          (pim.xml EXAMPLE)
 *   show ip pim [vrf default] topology [<grp> [<src>]]   (pim.xml EXAMPLE)
 *   show ip igmp groups                                  (igmp.xml EXAMPLE)
 * Other `show ip pim …` forms fall through to the FRR vtysh renderers
 * (lib/protocols/mcast-show.ts: show ip pim join / rp-info, show ip mroute …).
 */
import { line, err, muted, OutputLine } from "../../types";
import { Device } from "../../../models/device";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";
import { klishIgmpGroups, klishPimNeighbor, klishPimTopology } from "../../../protocols/mcast-show";

const FEATURE = "pim";
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Parse a decimal integer in [lo,hi]; null if not an integer or out of range. */
function intInRange(s: string | undefined, lo: number, hi: number): number | null {
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= lo && n <= hi ? n : null;
}

/** Delete one field from a stored list item; drop the item if only its id remains. */
function unsetField(device: Device, key: string, idField: string, idValue: string, field: string): void {
  const item = cpList(device, FEATURE, key).find((e) => e[idField] === idValue);
  if (!item) return;
  delete item[field];
  if (Object.keys(item).length === 1) cpRemove(device, FEATURE, key, idField, idValue);
}

// --- configure-view: global PIM (PIM_GLOBALS, keyed by vrf) ---
registerModal({
  id: "pim",
  views: ["configure-view"],
  keywords: ["ip"],
  run({ isNo, args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "pim") return null; // not ours (ip route, ...)
    const dev = ctx.device;

    // optional `vrf <name>` (defaults to "default")
    let rest = args.slice(1);
    let vrf = "default";
    if ((rest[0] ?? "").toLowerCase() === "vrf") {
      if (!rest[1]) return { output: [err("% VRF name required.")] };
      vrf = rest[1];
      rest = rest.slice(2);
    }
    const sub = (rest[0] ?? "").toLowerCase();
    const setG = (patch: Record<string, unknown>) => cpUpsert(dev, FEATURE, "globals", { vrf, ...patch }, "vrf");

    if (sub === "ecmp") {
      const rebalance = (rest[1] ?? "").toLowerCase() === "rebalance";
      if (isNo) {
        unsetField(dev, "globals", "vrf", vrf, "ecmpRebalance");
        if (!rebalance) unsetField(dev, "globals", "vrf", vrf, "ecmp");
        return { output: [] };
      }
      setG(rebalance ? { ecmp: true, ecmpRebalance: true } : { ecmp: true });
      return { output: [] };
    }

    if (sub === "join-prune-interval") {
      if (isNo) {
        unsetField(dev, "globals", "vrf", vrf, "joinPruneInterval");
        return { output: [] };
      }
      const n = intInRange(rest[1], 60, 600);
      if (n === null) return { output: [err("% Join Prune Interval must be 60-600 seconds.")] };
      setG({ joinPruneInterval: n });
      return { output: [] };
    }

    if (sub === "keep-alive-timer") {
      if (isNo) {
        unsetField(dev, "globals", "vrf", vrf, "keepAliveTimer");
        return { output: [] };
      }
      const n = intInRange(rest[1], 31, 60000);
      if (n === null) return { output: [err("% Keep Alive timer must be 31-60000 seconds.")] };
      setG({ keepAliveTimer: n });
      return { output: [] };
    }

    if (sub === "ssm") {
      if ((rest[1] ?? "").toLowerCase() !== "prefix-list") return { output: [err("% Usage: ip pim ssm prefix-list <name>")] };
      if (isNo) {
        unsetField(dev, "globals", "vrf", vrf, "ssmPrefixList");
        return { output: [] };
      }
      if (!rest[2]) return { output: [err("% Prefix list name required.")] };
      setG({ ssmPrefixList: rest[2] });
      return { output: [] };
    }

    if (sub === "rp-address") {
      const rp = rest[1];
      if (!rp || !IP_RE.test(rp)) return { output: [err("% A valid IPv4 RP address is required.")] };
      const hasPfx = (rest[2] ?? "").toLowerCase() === "prefix-list";
      const id = `${vrf}|${rp}`;
      if (isNo) {
        if (hasPfx) unsetField(dev, "rps", "id", id, "prefixList");
        else cpRemove(dev, FEATURE, "rps", "id", id);
        return { output: [] };
      }
      if (hasPfx && !rest[3]) return { output: [err("% Prefix list name required.")] };
      cpUpsert(dev, FEATURE, "rps", hasPfx ? { id, vrf, rp, prefixList: rest[3] } : { id, vrf, rp }, "id");
      return { output: [] };
    }

    if (sub === "spt-threshold") {
      if ((rest[1] ?? "").toLowerCase() !== "infinity") return { output: [err("% Usage: ip pim spt-threshold infinity [prefix-list <name>]")] };
      if (isNo) {
        unsetField(dev, "globals", "vrf", vrf, "sptPrefixList");
        unsetField(dev, "globals", "vrf", vrf, "sptInfinity");
        return { output: [] };
      }
      const hasPfx = (rest[2] ?? "").toLowerCase() === "prefix-list";
      if (hasPfx && !rest[3]) return { output: [err("% Prefix list name required.")] };
      setG(hasPfx ? { sptInfinity: true, sptPrefixList: rest[3] } : { sptInfinity: true });
      return { output: [] };
    }

    return null; // bare `ip pim` / unknown option — leave to grammar fallback
  },
});

// --- configure-if/vlan/lag-view: per-interface PIM (PIM_INTERFACE, keyed by iface) ---
registerModal({
  id: "pim-if",
  views: ["configure-if-view", "configure-vlan-view", "configure-lag-view", "configure-lo-view"],
  keywords: ["ip"],
  run({ isNo, args, ifname, ctx }) {
    if ((args[0] ?? "").toLowerCase() === "igmp" && (args[1] ?? "").toLowerCase() !== "snooping") return igmpIf(ctx.device, ifname ?? "", isNo, args.slice(1));
    if ((args[0] ?? "").toLowerCase() !== "pim") return null; // not ours
    const dev = ctx.device;
    const iface = ifname ?? "";
    const rest = args.slice(1);
    const sub = (rest[0] ?? "").toLowerCase();
    const setI = (patch: Record<string, unknown>) => cpUpsert(dev, FEATURE, "interfaces", { iface, ...patch }, "iface");

    if (sub === "sparse-mode") {
      if (isNo) {
        unsetField(dev, "interfaces", "iface", iface, "sparseMode");
        return { output: [] };
      }
      setI({ sparseMode: true });
      return { output: [] };
    }

    if (sub === "drpriority") {
      if (isNo) {
        unsetField(dev, "interfaces", "iface", iface, "drPriority");
        return { output: [] };
      }
      const n = intInRange(rest[1], 1, 4294967295);
      if (n === null) return { output: [err("% DR priority must be 1-4294967295.")] };
      setI({ drPriority: n });
      return { output: [] };
    }

    if (sub === "hello") {
      if (isNo) {
        unsetField(dev, "interfaces", "iface", iface, "helloInterval");
        return { output: [] };
      }
      const n = intInRange(rest[1], 1, 255);
      if (n === null) return { output: [err("% Hello interval must be 1-255 seconds.")] };
      setI({ helloInterval: n });
      return { output: [] };
    }

    if (sub === "bfd") {
      const hasProfile = (rest[1] ?? "").toLowerCase() === "profile";
      if (isNo) {
        if (hasProfile) unsetField(dev, "interfaces", "iface", iface, "bfdProfile");
        else {
          unsetField(dev, "interfaces", "iface", iface, "bfdProfile");
          unsetField(dev, "interfaces", "iface", iface, "bfd");
        }
        return { output: [] };
      }
      if (hasProfile) {
        if (!rest[2]) return { output: [err("% BFD profile name required.")] };
        setI({ bfd: true, bfdProfile: rest[2] });
      } else {
        setI({ bfd: true });
      }
      return { output: [] };
    }

    return null; // bare `ip pim` / unknown option — leave to grammar fallback
  },
});


// --- interface IGMP (IGMP_INTERFACE_QUERY, config-plane id "igmp") ---
const IGMP_PARAMS: Record<string, { field: string; lo: number; hi: number; msg: string }> = {
  version: { field: "version", lo: 2, hi: 3, msg: "% IGMP version must be 2 or 3." },
  "query-interval": { field: "queryInterval", lo: 1, hi: 1800, msg: "% Query interval must be 1-1800 seconds." },
  "query-max-response-time": { field: "queryMaxResponseTime", lo: 1, hi: 25, msg: "% Query max response time must be 1-25 seconds." },
  "last-member-query-count": { field: "lastMemberQueryCount", lo: 1, hi: 7, msg: "% Last member query count must be 1-7." },
  "last-member-query-interval": { field: "lastMemberQueryInterval", lo: 1, hi: 255, msg: "% Last member query interval must be 1-255 deciseconds." },
};

function igmpIf(dev: Device, iface: string, isNo: boolean, rest: string[]) {
  const sub = (rest[0] ?? "").toLowerCase();
  if (!sub) {
    if (isNo) cpRemove(dev, "igmp", "interfaces", "iface", iface);
    else cpUpsert(dev, "igmp", "interfaces", { iface, enabled: true }, "iface");
    return { output: [] };
  }
  const p = IGMP_PARAMS[sub];
  if (!p) return null; // ip igmp join … — left to the grammar fallback
  const item = cpList(dev, "igmp", "interfaces").find((e) => e.iface === iface);
  if (isNo) {
    if (item) delete item[p.field];
    return { output: [] };
  }
  const n = intInRange(rest[1], p.lo, p.hi);
  if (n === null) return { output: [err(p.msg)] };
  cpUpsert(dev, "igmp", "interfaces", { iface, [p.field]: n }, "iface");
  return { output: [] };
}

// --- enable-view: `show running-configuration pim` — render only stored config ---
interface PimGlobal {
  vrf: string;
  ecmp?: boolean;
  ecmpRebalance?: boolean;
  joinPruneInterval?: number;
  keepAliveTimer?: number;
  ssmPrefixList?: string;
  sptInfinity?: boolean;
  sptPrefixList?: string;
}
interface PimRp {
  id: string;
  vrf: string;
  rp: string;
  prefixList?: string;
}
interface PimIf {
  iface: string;
  sparseMode?: boolean;
  drPriority?: number;
  helloInterval?: number;
  bfd?: boolean;
  bfdProfile?: string;
}

registerModal({
  id: "pim-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "running-configuration" || (args[1] ?? "").toLowerCase() !== "pim") return null;
    const dev = ctx.device;
    const globals = cpList(dev, FEATURE, "globals") as unknown as PimGlobal[];
    const rps = cpList(dev, FEATURE, "rps") as unknown as PimRp[];
    const ifaces = cpList(dev, FEATURE, "interfaces") as unknown as PimIf[];

    const out: OutputLine[] = [];

    // Global config, grouped by VRF (default VRF has no `vrf` qualifier).
    const vrfs = Array.from(new Set([...globals.map((g) => g.vrf), ...rps.map((r) => r.vrf)]));
    for (const vrf of vrfs) {
      const v = vrf === "default" ? "" : ` vrf ${vrf}`;
      const g = globals.find((x) => x.vrf === vrf);
      if (g) {
        if (g.ecmpRebalance) out.push(line(`ip pim${v} ecmp rebalance`));
        else if (g.ecmp) out.push(line(`ip pim${v} ecmp`));
        if (g.joinPruneInterval !== undefined) out.push(line(`ip pim${v} join-prune-interval ${g.joinPruneInterval}`));
        if (g.keepAliveTimer !== undefined) out.push(line(`ip pim${v} keep-alive-timer ${g.keepAliveTimer}`));
        if (g.ssmPrefixList) out.push(line(`ip pim${v} ssm prefix-list ${g.ssmPrefixList}`));
        if (g.sptInfinity) out.push(line(`ip pim${v} spt-threshold infinity${g.sptPrefixList ? ` prefix-list ${g.sptPrefixList}` : ""}`));
      }
      for (const r of rps.filter((x) => x.vrf === vrf)) {
        out.push(line(`ip pim${v} rp-address ${r.rp}${r.prefixList ? ` prefix-list ${r.prefixList}` : ""}`));
      }
    }

    // Per-interface config.
    for (const i of ifaces) {
      const block: OutputLine[] = [];
      if (i.sparseMode) block.push(line(" ip pim sparse-mode"));
      if (i.drPriority !== undefined) block.push(line(` ip pim drpriority ${i.drPriority}`));
      if (i.helloInterval !== undefined) block.push(line(` ip pim hello ${i.helloInterval}`));
      if (i.bfd) block.push(line(` ip pim bfd${i.bfdProfile ? ` profile ${i.bfdProfile}` : ""}`));
      if (block.length) {
        out.push(line(`interface ${i.iface}`));
        out.push(...block);
      }
    }

    if (!out.length) return { output: [muted("No PIM configuration")] };
    return { output: out };
  },
});

// --- enable-view: `show running-configuration igmp` ---
interface IgmpIf {
  iface: string;
  enabled?: boolean;
  version?: number;
  queryInterval?: number;
  queryMaxResponseTime?: number;
  lastMemberQueryCount?: number;
  lastMemberQueryInterval?: number;
}
registerModal({
  id: "igmp-show-running",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "running-configuration" || (args[1] ?? "").toLowerCase() !== "igmp") return null;
    const out: OutputLine[] = [];
    for (const i of cpList(ctx.device, "igmp", "interfaces") as unknown as IgmpIf[]) {
      out.push(line(`interface ${i.iface}`));
      if (i.enabled) out.push(line(" ip igmp"));
      if (i.version !== undefined) out.push(line(` ip igmp version ${i.version}`));
      if (i.queryInterval !== undefined) out.push(line(` ip igmp query-interval ${i.queryInterval}`));
      if (i.queryMaxResponseTime !== undefined) out.push(line(` ip igmp query-max-response-time ${i.queryMaxResponseTime}`));
      if (i.lastMemberQueryCount !== undefined) out.push(line(` ip igmp last-member-query-count ${i.lastMemberQueryCount}`));
      if (i.lastMemberQueryInterval !== undefined) out.push(line(` ip igmp last-member-query-interval ${i.lastMemberQueryInterval}`));
    }
    return { output: out.length ? out : [muted("No IGMP configuration")] };
  },
});

// --- enable-view: operational `show ip pim neighbor|topology`, `show ip igmp groups` ---
registerModal({
  id: "pim-oper-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    const now = Date.now();
    const lines = (ls: string[]) => ({ output: ls.map((l) => line(l)) });
    if (a[0] === "ip" && a[1] === "igmp" && a[2] === "groups") return lines(klishIgmpGroups(ctx.device, now));
    if (a[0] !== "ip" || a[1] !== "pim") return null;
    let rest = args.slice(2);
    if ((rest[0] ?? "").toLowerCase() === "vrf") {
      if (rest[1] && rest[1] !== "default" && rest[1] !== "all") return lines([`% PIM is not configured in VRF ${rest[1]}`]);
      rest = rest.slice(2);
    }
    const sub = (rest[0] ?? "").toLowerCase();
    if (sub === "neighbor") return lines(klishPimNeighbor(ctx.device, now, IP_RE.test(rest[1] ?? "") ? rest[1] : undefined));
    if (sub === "topology") return lines(klishPimTopology(ctx.device, now, rest[1], rest[2]));
    return null; // join / rp-info / … → FRR vtysh renderers in the Click layer
  },
});
