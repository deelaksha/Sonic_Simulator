/**
 * System — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 *   sonic(config)# suppress-fib-pending                          store DEVICE_METADATA flag
 *   sonic(config)# no suppress-fib-pending                       clear it
 *   sonic(config)# switching-mode cut-through                    store SWITCH/switching_mode
 *   sonic(config)# no switching-mode cut-through                 clear it (default: store-and-forward)
 *   sonic(config)# system resource-stats-polling-interval <s>   store DEVICE_METADATA interval
 *   sonic(config)# no system resource-stats-polling-interval    revert to default (120s)
 *   sonic(config)# system adjust-txrx-clock-freq                store SWITCH/adjust_txrx_clock_freq
 *   sonic(config)# no system adjust-txrx-clock-freq             rollback to default clock freq
 *   sonic# show switching-mode                                   render SWITCH/switching_mode
 *   sonic# show system txrx-clock-freq-correction                render SWITCH/adjust_txrx_clock_freq
 *
 * Mirrors the real box's DEVICE_METADATA/localhost and SWITCH CONFIG_DB tables
 * (data/device-capture/klish-xml/system.xml): config is stored honestly and the
 * two dedicated config-render `show` commands reflect exactly what was set.
 * `show system` / `show system status|memory|cpu|processes` are OPERATIONAL
 * (live system state) and are NOT fabricated here — this handler returns null for
 * them so they fall through to the tested `show` layer. suppress-fib-pending and
 * resource-stats-polling-interval have no dedicated `show` on the real box (they
 * surface via `show running-configuration`, which this sim does not model), so we
 * store them faithfully but invent no show output for them.
 *
 * NOTE: the runtime effect of these knobs (BGP FIB-suppression behaviour, the
 * ASIC switching mode, the resource-stats poller, the TX/RX clock adjustment) is
 * a data-plane concern this simulator does not model — only config is stored.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

// configure-view: DEVICE_METADATA / SWITCH system config knobs.
registerModal({
  id: "system",
  views: ["configure-view"],
  keywords: ["system", "switching-mode", "suppress-fib-pending"],
  run({ head, isNo, args, ctx }) {
    const dev = ctx.device;

    // `suppress-fib-pending` (DEVICE_METADATA/localhost/suppress-fib-pending).
    if (head === "suppress-fib-pending") {
      if (isNo) cpUnset(dev, "system", "suppress_fib_pending");
      else cpSet(dev, "system", "suppress_fib_pending", true);
      return { output: [] };
    }

    // `switching-mode cut-through` (SWITCH/switching_mode=CUT_THROUGH).
    if (head === "switching-mode") {
      if ((args[0] ?? "").toLowerCase() !== "cut-through")
        return { output: [err("% switching-mode: only `cut-through` is supported")] };
      if (isNo) cpUnset(dev, "system", "switching_mode");
      else cpSet(dev, "system", "switching_mode", "cut-through");
      return { output: [] };
    }

    // `system ...` — shared keyword; only the two system-scalar knobs are ours.
    const sub = (args[0] ?? "").toLowerCase();
    if (sub === "resource-stats-polling-interval") {
      if (isNo) {
        cpUnset(dev, "system", "resource_stats_polling_interval");
        return { output: [] };
      }
      const val = args[1];
      if (!/^\d+$/.test(val ?? ""))
        return { output: [err("% resource-stats-polling-interval requires an interval in seconds")] };
      cpSet(dev, "system", "resource_stats_polling_interval", val);
      return { output: [] };
    }
    if (sub === "adjust-txrx-clock-freq") {
      if (isNo) cpUnset(dev, "system", "adjust_txrx_clock_freq");
      else cpSet(dev, "system", "adjust_txrx_clock_freq", true);
      return { output: [] };
    }
    return null; // not ours (e.g. `system vlan <id> ...`) — let the core handle it
  },
});

// enable-view: the two dedicated config-render `show` commands.
registerModal({
  id: "system-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const st = cpGet(ctx.device, "system") ?? {};
    const sub0 = args[0]?.toLowerCase();

    // `show switching-mode` — renders SWITCH/switching_mode.
    if (sub0 === "switching-mode") {
      if (st.switching_mode) return { output: [line(`Switching mode : ${String(st.switching_mode)}`)] };
      return { output: [muted("Switching-mode not configured (default: store-and-forward)")] };
    }

    // `show system txrx-clock-freq-correction` — renders SWITCH/adjust_txrx_clock_freq.
    if (sub0 === "system" && args[1]?.toLowerCase() === "txrx-clock-freq-correction") {
      if (st.adjust_txrx_clock_freq === true)
        return { output: [line("TX/RX clock frequency correction : Enabled")] };
      return { output: [muted("TX/RX clock frequency correction not configured")] };
    }

    return null; // not ours — `show system`, `show system status`, ... are operational
  },
});
