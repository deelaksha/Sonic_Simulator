/**
 * ZTP (Zero Touch Provisioning) — CONFIG-PLANE feature (no engine backend).
 *
 *   sonic(config)# ztp enable        administratively enable ZTP
 *   sonic(config)# no ztp enable     administratively disable ZTP
 *   sonic# show ztp-status           render the stored admin mode
 *
 * Only the administrative config (ZTP Admin Mode) is a CONFIG_DB value, so that
 * is what we store and render. The ZTP provisioning runtime (DHCP discovery,
 * fetching + applying provisioning data) is NOT simulated, so the operational
 * "ZTP Service" / "ZTP Status" lines are the honest, constant "not running"
 * state — nothing dynamic is fabricated. The real box ships with ZTP enabled,
 * so an unconfigured box reflects that default (True).
 */
import { line, err } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpGet } from "../config-plane";

registerModal({
  id: "ztp",
  views: ["configure-view"],
  keywords: ["ztp"],
  run({ isNo, args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "enable") {
      return { output: [err("% Usage: [no] ztp enable")] };
    }
    cpSet(ctx.device, "ztp", "adminMode", !isNo);
    return { output: [] };
  },
});

registerModal({
  id: "ztp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "ztp-status") return null; // not ours
    const st = cpGet(ctx.device, "ztp") ?? {};
    // Reflect the configured admin mode; real SONiC defaults ZTP to enabled.
    const enabled = st.adminMode === undefined ? true : Boolean(st.adminMode);
    return {
      output: [
        line("========================================"),
        line("ZTP"),
        line("========================================"),
        line(`ZTP Admin Mode      : ${enabled ? "True" : "False"}`),
        line("ZTP Service         : Inactive"),
        line("ZTP Status          : Not Started"),
      ],
    };
  },
});
