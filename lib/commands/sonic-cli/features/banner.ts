/**
 * Banner — reference CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# banner motd <text>        store
 *   sonic(config)# no banner motd            clear
 *   sonic# show banner [motd|login|exec]     render from stored state
 *
 * Template for config-plane-only features: config commands write to the
 * config-plane store (cpSet/cpUnset/cpUpsert/cpRemove), and a `show` handler in
 * enable-view renders exactly what was configured. Nothing is fabricated.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet } from "../config-plane";

const KINDS = ["motd", "login", "exec"];

registerModal({
  id: "banner",
  views: ["configure-view"],
  keywords: ["banner"],
  run({ isNo, args, ctx }) {
    const kind = (args[0] ?? "").toLowerCase();
    if (!KINDS.includes(kind)) return { output: [err(`% banner type must be one of ${KINDS.join("|")}`)] };
    if (isNo) {
      cpUnset(ctx.device, "banner", kind);
      return { output: [] };
    }
    const text = args.slice(1).join(" ").replace(/^"|"$/g, "");
    if (!text) return { output: [err("% banner text required")] };
    cpSet(ctx.device, "banner", kind, text);
    return { output: [] };
  },
});

registerModal({
  id: "banner-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "banner") return null; // not ours
    const st = cpGet(ctx.device, "banner") ?? {};
    const kinds = args[1] && KINDS.includes(args[1].toLowerCase()) ? [args[1].toLowerCase()] : KINDS;
    const out = kinds.filter((k) => st[k]).map((k) => line(`${k}: ${st[k]}`));
    return { output: out.length ? out : [muted("No banners configured")] };
  },
});
