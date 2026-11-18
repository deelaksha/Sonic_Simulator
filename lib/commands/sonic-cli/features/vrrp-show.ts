/**
 * KLISH `show vrrp ...` (enable-view). Renders the live FRR vrrpd state the
 * way sonic-mgmt-framework does (CLI/actioner/sonic_cli_vrrp.py show_vrrp →
 * show_vrrp_brief.j2 / show_vrrp.j2 / show_vrrp_summary.j2). Imported by ./vrrp.
 */
import { line } from "../../types";
import { registerModal } from "../registry";
import { renderKlishShow } from "../../sonic/vrrp";

registerModal({
  id: "vrrp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if ((args[0] ?? "").toLowerCase() !== "vrrp") return null;
    return { output: renderKlishShow(ctx.device, args.slice(1)).map((t) => line(t)) };
  },
});
