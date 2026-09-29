/**
 * Warm restart — CONFIG-PLANE feature (no engine backend).
 *
 * The real box stores warm-restart settings in two CONFIG_DB tables keyed by
 * module: WARM_RESTART_ENABLE (the per-module `enable` flag) and WARM_RESTART
 * (per-module timers + the BGP `bgp_eoiu` flag). We model that CONFIG_DB honestly:
 * config commands write to the config-plane store and `show warm-restart [config]`
 * renders exactly what was configured. Nothing operational is fabricated.
 *
 *   sonic(config)# warm-restart bgp enable
 *   sonic(config)# warm-restart bgp eoiu
 *   sonic(config)# warm-restart bgp timer 60
 *   sonic(config)# warm-restart swss timer 3600
 *   sonic(config)# warm-restart teamd enable
 *   sonic(config)# warm-restart system [enable]
 *   sonic(config)# no warm-restart bgp timer
 *   sonic# show warm-restart [config|check|system]
 *
 * Real KLISH grammar: data/device-capture/klish-xml/warm_restart.xml (the config
 * commands live in hidden-view, reachable from configure-view; `show warm-restart`
 * variants live in enable-view).
 *
 * Data-plane note: the sim does NOT actually warm-restart any service. Operational
 * reads (`show warm-restart` restore counts / per-module runtime status, `show
 * warm-restart check`) reflect no runtime data — only the stored config.
 */
import { line, err, muted, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, CpState } from "../config-plane";

const MODULES = ["bgp", "swss", "teamd", "system"];

function intInRange(v: string, lo: number, hi: number): number | null {
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= lo && n <= hi ? n : null;
}

// configure-view: `warm-restart <module> ...` writes the config-plane store.
registerModal({
  id: "warm_restart",
  views: ["configure-view"],
  keywords: ["warm-restart"],
  run({ isNo, args, ctx }) {
    const dev = ctx.device;
    const mod = (args[0] ?? "").toLowerCase();
    if (!MODULES.includes(mod)) return { output: [err(`% warm-restart module must be one of ${MODULES.join("|")}`)] };
    const sub = (args[1] ?? "").toLowerCase();

    // system: `warm-restart system [enable]` toggles WARM_RESTART_ENABLE|system.
    if (mod === "system") {
      if (sub && sub !== "enable") return { output: [err('% warm-restart system takes only an optional "enable"')] };
      if (isNo) cpUnset(dev, "warm_restart", "system_enable");
      else cpSet(dev, "warm_restart", "system_enable", true);
      return { output: [] };
    }

    // bgp / swss / teamd
    if (sub === "enable") {
      if (isNo) cpUnset(dev, "warm_restart", `${mod}_enable`);
      else cpSet(dev, "warm_restart", `${mod}_enable`, true);
      return { output: [] };
    }
    if (sub === "eoiu") {
      if (mod !== "bgp") return { output: [err("% eoiu is only valid for warm-restart bgp")] };
      if (isNo) cpUnset(dev, "warm_restart", "bgp_eoiu");
      else cpSet(dev, "warm_restart", "bgp_eoiu", true);
      return { output: [] };
    }
    if (sub === "timer") {
      if (isNo) { cpUnset(dev, "warm_restart", `${mod}_timer`); return { output: [] }; }
      const hi = mod === "bgp" ? 3600 : 9999;
      const n = intInRange(args[2] ?? "", 1, hi);
      if (n === null) return { output: [err(`% warm-restart ${mod} timer must be an integer 1..${hi}`)] };
      cpSet(dev, "warm_restart", `${mod}_timer`, n);
      return { output: [] };
    }
    return { output: [err(`% Unknown warm-restart ${mod} option "${sub}"`)] };
  },
});

// Render the stored WARM_RESTART / WARM_RESTART_ENABLE config as a table.
function renderConfig(st: CpState): OutputLine[] {
  const rows = MODULES.map((m) => ({
    module: m,
    enable: st[`${m}_enable`],
    timer: st[`${m}_timer`],
    eoiu: m === "bgp" ? st["bgp_eoiu"] : undefined,
  })).filter((r) => r.enable !== undefined || r.timer !== undefined || r.eoiu !== undefined);
  if (!rows.length) return [];
  const out = [
    line("Module      Enable   Timer   EOIU"),
    line("-------------------------------------"),
  ];
  for (const r of rows) {
    const enable = r.enable !== undefined ? "true" : "";
    const timer = r.timer !== undefined ? String(r.timer) : "";
    const eoiu = r.eoiu !== undefined ? "true" : "";
    out.push(line(`${r.module.padEnd(12)}${enable.padEnd(9)}${timer.padEnd(8)}${eoiu}`.trimEnd()));
  }
  return out;
}

// enable-view: `show warm-restart [config|check|system]` renders from stored state.
registerModal({
  id: "warm_restart-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "warm-restart") return null; // not ours
    const view = args[1]?.toLowerCase();

    // `check` is a purely operational read — nothing configured to reflect.
    if (view === "check") {
      return { output: [muted("% show warm-restart check: operational warm-restart state is not simulated (config-plane only)")] };
    }

    const st: CpState = cpGet(ctx.device, "warm_restart") ?? {};
    const rows = renderConfig(st);
    if (!rows.length) return { output: [muted("No warm restart configuration")] };
    const out = [...rows];
    // The plain / system views normally include operational restore counts + status.
    if (view !== "config") out.push(muted("Note: operational restore counts / runtime status are not simulated (config-plane only)."));
    return { output: out };
  },
});
