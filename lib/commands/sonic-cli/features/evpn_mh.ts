/**
 * EVPN ESI-multihoming — global timers (config-plane) + per-PortChannel Ethernet
 * segments, which drive lib/protocols/evpn-mh.ts (DF election, split horizon,
 * aliasing) and the type-1/type-4 routes of lib/protocols/vxlan-daemon.ts:
 *
 *   sonic(config)# interface PortChannel 1
 *   sonic(conf-if-po1)# evpn ethernet-segment 00:11:22:33:44:55:66:77:88:99   (type-0)
 *   sonic(conf-if-po1)# evpn ethernet-segment auto-system-mac                (type-3)
 *   sonic(config-es-…)# df-preference 50000          (interface.xml:1480-1530)
 *   sonic(conf-if-po1)# no evpn ethernet-segment
 *   sonic# show evpn es                               (Click/FRR zebra format)
 *
 * `auto-lacp` (type-1, from the LACP partner) is not modelled.
 *
 * The global ESI-MH timers below are stored only:
 *
 *   sonic(config)# evpn esi-multihoming            -> enter the ESI-MH sub-view
 *   sonic(config-evpn-esi-mh)# startup-delay 100
 *   sonic(config-evpn-esi-mh)# mac-holdtime 2000
 *   sonic(config-evpn-esi-mh)# df-election-time 5
 *   sonic(config-evpn-esi-mh)# no startup-delay
 *   sonic(config)# no evpn esi-multihoming          -> clear all ESI-MH config
 *   sonic# show running-configuration evpn-mh        -> render from stored config
 *
 * `evpn esi-multihoming` (configure-view) has its config in a DEDICATED SUB-MODE
 * (grammar view="configure-evpn-esi-mh-view"), so we follow the sub-mode pattern:
 * the entry handler marks the global entry present and returns
 * `enter: subViewFrame(...)`, and a sub-view handler stores the scalar timers
 * (EVPN_MH_GLOBAL in CONFIG_DB). Nothing is fabricated — only configured values.
 *
 * (df-election-time / startup-delay hold-downs are not modelled).
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpRemove, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";

// Scalar timers, in render order. Each maps to a klish command with an integer
// range (from data/device-capture/klish-xml/evpn_mh.xml).
const FIELDS: { key: string; min: number; max: number }[] = [
  { key: "startup-delay", min: 0, max: 3600 },
  { key: "mac-holdtime", min: 0, max: 86400 },
  { key: "neigh-holdtime", min: 0, max: 86400 },
  { key: "df-election-time", min: 0, max: 86400 },
  { key: "es-activation-delay", min: 0, max: 1200000 },
];
const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

// configure-view: `evpn esi-multihoming` — mark the global entry present + enter
// the sub-view; `no evpn esi-multihoming` — clear the whole ESI-MH config.
registerModal({
  id: "evpn-mh-enter",
  views: ["configure-view"],
  keywords: ["evpn"],
  run({ isNo, args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "esi-multihoming") return null; // not ours (bare `evpn`)
    if (isNo) {
      cpUnset(ctx.device, "evpn_mh", "_present");
      for (const f of FIELDS) cpUnset(ctx.device, "evpn_mh", f.key);
      return { output: [] };
    }
    cpSet(ctx.device, "evpn_mh", "_present", true);
    return { output: [], enter: subViewFrame("configure-evpn-esi-mh-view", "") };
  },
});

// configure-evpn-esi-mh-view: scalar timers.
registerModal({
  id: "evpn-mh",
  views: ["configure-evpn-esi-mh-view"],
  keywords: FIELDS.map((f) => f.key),
  run({ isNo, head, args, ctx }) {
    const f = FIELD_BY_KEY.get(head);
    if (!f) return null;
    if (isNo) {
      cpUnset(ctx.device, "evpn_mh", f.key);
      return { output: [] };
    }
    if (!args[0]) return { output: [err(`% ${f.key} value required (${f.min}..${f.max}).`)] };
    const n = Number(args[0]);
    if (!Number.isInteger(n) || n < f.min || n > f.max) {
      return { output: [err(`% ${f.key} must be an integer in the range ${f.min}..${f.max}.`)] };
    }
    cpSet(ctx.device, "evpn_mh", f.key, String(n));
    return { output: [] };
  },
});

// enable-view: `show running-configuration evpn-mh` — render exactly what was configured.
registerModal({
  id: "evpn-mh-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a0 = (args[0] ?? "").toLowerCase();
    const a1 = (args[1] ?? "").toLowerCase();
    if (a0 !== "running-configuration" || a1 !== "evpn-mh") return null; // not ours
    const st = cpGet(ctx.device, "evpn_mh") ?? {};
    if (!st["_present"]) return { output: [muted("% EVPN ESI-multihoming is not configured.")] };
    const out: OutputLine[] = [line("evpn esi-multihoming")];
    for (const f of FIELDS) {
      const v = st[f.key];
      if (v !== undefined) out.push(line(` ${f.key} ${v}`));
    }
    return { output: out };
  },
});

// configure-lag-view: `[no] evpn ethernet-segment <ESI>|auto-system-mac` → ES sub-view.
const ESI_RE = /^([0-9a-fA-F]{2}:){9}[0-9a-fA-F]{2}$/;
registerModal({
  id: "evpn-mh-es",
  views: ["configure-lag-view"],
  keywords: ["evpn"],
  run({ isNo, args, ifname, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "ethernet-segment" || !ifname) return null;
    if (isNo) {
      cpRemove(ctx.device, "evpn_mh", "es", "ifname", ifname);
      return { output: [] };
    }
    const id = (args[1] ?? "").toLowerCase();
    if (id === "auto-lacp") return { output: [muted("% evpn ethernet-segment auto-lacp (type-1 ESI from LACP) is not modelled; use a type-0 ESI or auto-system-mac")] };
    if (id !== "auto-system-mac" && !ESI_RE.test(id)) return { output: [err("% Ethernet Segment Id must be 10 hex bytes (00:11:22:33:44:55:66:77:88:99) or auto-system-mac")] };
    const other = (cpList(ctx.device, "evpn_mh", "es") as Record<string, string>[]).find((e) => e.esi === id && e.ifname !== ifname && id !== "auto-system-mac");
    if (other) return { output: [err(`% ESI ${id} is already configured on ${other.ifname}`)] };
    cpUpsert(ctx.device, "evpn_mh", "es", { ifname, esi: id }, "ifname");
    return { output: [], enter: subViewFrame("configure-evpn-eth-seg", ifname) };
  },
});

// configure-evpn-eth-seg: `[no] df-preference <1-65535>`.
registerModal({
  id: "evpn-mh-es-df",
  views: ["configure-evpn-eth-seg"],
  keywords: ["df-preference"],
  run({ isNo, args, viewctx, ctx }) {
    if (!viewctx) return null;
    if (isNo) {
      cpUpsert(ctx.device, "evpn_mh", "es", { ifname: viewctx, df_pref: "" }, "ifname");
      return { output: [] };
    }
    const n = Number(args[0]);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { output: [err("% df-preference must be an integer in the range 1..65535.")] };
    cpUpsert(ctx.device, "evpn_mh", "es", { ifname: viewctx, df_pref: String(n) }, "ifname");
    return { output: [] };
  },
});
