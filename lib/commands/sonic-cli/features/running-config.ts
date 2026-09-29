/**
 * `show running-configuration` — surfaces config-plane commands that were
 * accepted+stored by the generic fallback (commands with no dedicated engine
 * handler). Returns null when nothing was stored so the Click layer / structured
 * feature shows can handle it instead.
 */
import { line } from "../../types";
import { registerModal } from "../registry";
import { cpRunningLines } from "../config-plane";

registerModal({
  id: "running-config-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a0 = args[0]?.toLowerCase();
    if (a0 !== "running-configuration" && a0 !== "running-config") return null;
    const lines = cpRunningLines(ctx.device);
    if (!lines.length) return null; // nothing config-plane stored → let other handlers/Click run
    const out = [line("!"), line("! Running configuration")];
    let cur = "";
    for (const l of lines) {
      if (l.ctx !== cur) { if (l.ctx && l.ctx !== "config") out.push(line(`! ${l.ctx}`)); cur = l.ctx; }
      out.push(line(l.line));
    }
    out.push(line("!"));
    return { output: out };
  },
});
