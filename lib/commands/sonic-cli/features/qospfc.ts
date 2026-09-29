/**
 * PFC / PFC-watchdog modal behaviour (feature "qospfc"). The KLISH grammar puts
 * this feature's config in two EXISTING views (no dedicated sub-mode):
 *
 * configure-view (global, qos_pfc.xml):
 *   priority-flow-control watchdog polling-interval <100-3000>
 *                                            -> config pfcwd interval <n>
 *
 * configure-if-view (per physical interface, qos_interface.xml):
 *   priority-flow-control priority <dot1p>   -> config pfc priority <if> <p> on
 *   no priority-flow-control priority <dot1p>-> config pfc priority <if> <p> off
 *   priority-flow-control asymmetric         -> config pfc asymmetric <if> on
 *   no priority-flow-control asymmetric      -> config pfc asymmetric <if> off
 *
 * Delegates to the tested Click module (lib/commands/sonic/qospfc.ts); behaviour,
 * validation and warnings (e.g. the platform "asymmetric not applied" notice) are
 * NOT duplicated here — the Click command owns them.
 */
import { err } from "../../types";
import { registerModal } from "../registry";

// configure-view: only the global watchdog polling-interval maps to a Click command.
registerModal({
  id: "qospfc-global",
  views: ["configure-view"],
  keywords: ["priority-flow-control"],
  run({ isNo, args, delegate }) {
    if (args[0]?.toLowerCase() === "watchdog" && args[1]?.toLowerCase() === "polling-interval") {
      // `no ... polling-interval` resets to default, which `config pfcwd interval`
      // cannot express (it requires a value) — not ours, fall through.
      if (isNo) return null;
      const ms = args[2];
      if (!ms) return { output: [err("% Watchdog polling-interval value required.")] };
      return { output: delegate(`config pfcwd interval ${ms}`) };
    }
    return null; // e.g. `... watchdog counter-poll` — not supported by the Click module
  },
});

// configure-if-view: per-interface PFC priority + asymmetric.
registerModal({
  id: "qospfc",
  views: ["configure-if-view"],
  keywords: ["priority-flow-control"],
  run({ isNo, args, ifname, delegate }) {
    const name = ifname ?? "";
    const sub = args[0]?.toLowerCase();

    if (sub === "asymmetric") {
      return { output: delegate(`config pfc asymmetric ${name} ${isNo ? "off" : "on"}`) };
    }

    if (sub === "priority") {
      const dot1p = args[1];
      if (!dot1p) return { output: [err("% PFC priority value (0-7) required.")] };
      // Click validates the range/value and emits its own usage error.
      return { output: delegate(`config pfc priority ${name} ${dot1p} ${isNo ? "off" : "on"}`) };
    }

    return null; // `... watchdog on|off|action|restore-time` map to pfcwd_if_* (not in this module)
  },
});
