/**
 * Port media-fec — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# interface media-fec port <slot/port> mode <ieee|custom>   store
 *   sonic(config)# no interface media-fec port <slot/port>                    clear
 *   sonic# show media-fec                                                     render stored
 *
 * Mirrors CONFIG_DB PORT|<ifname> field `media-fec-mode` (see
 * data/device-capture/klish-xml/port_media_fec.xml). Config is stored per
 * front-panel port and rendered back exactly as configured — nothing fabricated.
 *
 * KLISH DISPATCH NOTE: the real command lives in configure-view keyed on the
 * shared "interface" first token (`interface media-fec port ... mode ...`). The
 * modal core (lib/commands/sonic-cli.ts) special-cases the bare "interface"
 * keyword for per-interface sub-view entry BEFORE consulting feature handlers, so
 * in the live CLI a raw `interface media-fec ...` line is caught there. This
 * handler is written to the registry contract (returns null for any non-media-fec
 * "interface" line) and is exercised through runModalHandlers, exactly as the core
 * dispatches configure-view feature commands.
 *
 * REAL SHOW: the box surfaces media-fec via `show running-configuration`
 * (render_command_cb=show_running_media_fec_mode) and `show interface <name>`;
 * there is no dedicated `show port_media_fec`. This lab adds `show media-fec` to
 * render exactly the stored per-port media-fec modes.
 *
 * DATA-PLANE: the on-the-wire FEC negotiation (the box's "media-fec on port
 * in-progress" transition) is NOT simulated — only CONFIG_DB state is modelled.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpUpsert, cpRemove, cpList } from "../config-plane";

const MODES = ["ieee", "custom"]; // MEDIA_FEC_MODE ptype: "ieee custom"
const IN_PROGRESS = "media-fec on port in-progress, use 'show interface interface-name' to check status.";

// configure-view: `interface media-fec port <slot/port> mode <mode>` / `no ...`.
registerModal({
  id: "port_media_fec",
  views: ["configure-view"],
  keywords: ["interface"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "media-fec") return null; // not ours (interface <name>, breakout, ...)
    if (args[1]?.toLowerCase() !== "port" || !args[2])
      return { output: [err("% usage: interface media-fec port <slot/port> mode <ieee|custom>")] };
    const port = args[2];
    if (isNo) {
      cpRemove(ctx.device, "port_media_fec", "ports", "port", port);
      return { output: [muted(IN_PROGRESS)] };
    }
    if (args[3]?.toLowerCase() !== "mode" || !args[4])
      return { output: [err("% media-fec mode required (ieee|custom)")] };
    const mode = args[4].toLowerCase();
    if (!MODES.includes(mode)) return { output: [err(`% media-fec mode must be one of ${MODES.join("|")}`)] };
    cpUpsert(ctx.device, "port_media_fec", "ports", { port, mode }, "port");
    return { output: [muted(IN_PROGRESS)] };
  },
});

// enable-view: `show media-fec` renders the configured per-port media-fec modes.
registerModal({
  id: "port_media_fec-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "media-fec") return null; // not ours
    const ports = cpList(ctx.device, "port_media_fec", "ports");
    if (!ports.length) return { output: [muted("No media-fec configured")] };
    const dash = "-".repeat(26);
    const out = [line(dash), line("PORT".padEnd(12) + "MEDIA-FEC-MODE"), line(dash)];
    for (const p of ports) out.push(line(String(p.port ?? "").padEnd(12) + String(p.mode ?? "")));
    return { output: out };
  },
});
