/**
 * UDLD — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 * UDLD (UniDirectional Link Detection) exchanges protocol frames to detect
 * one-way links and can err-disable ports. The simulator has no packet backend
 * for it, so we model only CONFIG_DB honestly: config commands write to the
 * config-plane store and `show udld ...` renders exactly what was configured.
 * Operational data (neighbors, link status, frame counters) is NEVER fabricated.
 *
 * Grammar: data/device-capture/klish-xml/udld.xml
 *
 * configure-view (global):
 *   udld enable                 / no udld enable            store/clear enable
 *   udld aggressive             / no udld aggressive        store/clear mode
 *   udld message-time <1..30>   / no udld message-time      store/reset (default 1)
 *   udld multiplier <3..10>     / no udld multiplier        store/reset (default 3)
 *
 * configure-if-view / configure-if-range-view (per-interface):
 *   udld enable                 / no udld enable            store/clear per-port
 *   udld aggressive             / no udld aggressive        store per-port mode
 *
 * enable-view:
 *   show udld [global]          render global config
 *   show udld interface <if>    render per-port configured state (no neighbors)
 *   show udld neighbors|statistics  operational — not simulated
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpRemove, cpList } from "../config-plane";

const DEFAULT_MSG_TIME = 1;
const DEFAULT_MULTIPLIER = 3;

// configure-view (global) + interface views: `udld ...`
registerModal({
  id: "udld",
  views: ["configure-view", "configure-if-view", "configure-if-range-view"],
  keywords: ["udld"],
  run({ view, isNo, args, ifname, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    // Interface level: only `udld enable` and `udld aggressive`.
    if (view === "configure-if-view" || view === "configure-if-range-view") {
      const name = ifname ?? "";
      if (sub === "enable") {
        if (isNo) cpRemove(ctx.device, "udld", "ports", "ifname", name);
        else cpUpsert(ctx.device, "udld", "ports", { ifname: name, admin_enable: true }, "ifname");
        return { output: [] };
      }
      if (sub === "aggressive") {
        cpUpsert(ctx.device, "udld", "ports", { ifname: name, aggressive: !isNo }, "ifname");
        return { output: [] };
      }
      return null;
    }

    // Global level.
    if (sub === "enable") {
      if (isNo) cpUnset(ctx.device, "udld", "enable");
      else cpSet(ctx.device, "udld", "enable", true);
      return { output: [] };
    }
    if (sub === "aggressive") {
      if (isNo) cpUnset(ctx.device, "udld", "aggressive");
      else cpSet(ctx.device, "udld", "aggressive", true);
      return { output: [] };
    }
    if (sub === "message-time") {
      if (isNo) {
        cpUnset(ctx.device, "udld", "msg_time");
        return { output: [] };
      }
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 1 || n > 30) return { output: [err("% UDLD message-time must be an integer in 1..30")] };
      cpSet(ctx.device, "udld", "msg_time", n);
      return { output: [] };
    }
    if (sub === "multiplier") {
      if (isNo) {
        cpUnset(ctx.device, "udld", "multiplier");
        return { output: [] };
      }
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 3 || n > 10) return { output: [err("% UDLD multiplier must be an integer in 3..10")] };
      cpSet(ctx.device, "udld", "multiplier", n);
      return { output: [] };
    }
    return null; // bare `udld` / unknown subcommand -> grammar fallback
  },
});

// enable-view: `show udld ...` renders from the config-plane store.
registerModal({
  id: "udld-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "udld") return null; // not ours
    const st = cpGet(ctx.device, "udld") ?? {};
    const sub = (args[1] ?? "global").toLowerCase();
    const msgTime = (st.msg_time as number | undefined) ?? DEFAULT_MSG_TIME;
    const mult = (st.multiplier as number | undefined) ?? DEFAULT_MULTIPLIER;

    if (sub === "global") {
      return {
        output: [
          line("UDLD Global Information"),
          line(`  Admin State        : ${st.enable === true ? "UDLD Enabled" : "UDLD Disabled"}`),
          line(`  Mode               : ${st.aggressive === true ? "Aggressive" : "Normal"}`),
          line(`  UDLD Message Time  : ${msgTime} seconds`),
          line(`  UDLD Multiplier    : ${mult}`),
        ],
      };
    }

    if (sub === "interface") {
      const name = args[2] ?? "";
      const port = cpList(ctx.device, "udld", "ports").find((e) => e.ifname === name);
      if (!port) return { output: [muted(`UDLD not configured on ${name || "interface"}`)] };
      return {
        output: [
          line(`UDLD information for ${name}`),
          line(`  UDLD Admin State:                  ${port.admin_enable === true ? "Enabled" : "Disabled"}`),
          line(`  Mode:                              ${port.aggressive === true ? "Aggressive" : "Normal"}`),
          line(`  Message time:                      ${msgTime}`),
          line(`  Timeout interval:                  ${msgTime * mult}`),
          muted("  (neighbor / link-status data not simulated)"),
        ],
      };
    }

    if (sub === "neighbors" || sub === "statistics") {
      return { output: [muted(`UDLD ${sub}: operational data not simulated`)] };
    }

    return { output: [muted(`% Unknown 'show udld ${sub}'`)] };
  },
});
