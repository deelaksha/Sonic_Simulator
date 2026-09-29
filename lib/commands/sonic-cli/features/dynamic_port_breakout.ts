/**
 * Dynamic Port Breakout (DPB) — CONFIG-PLANE feature (no engine backend; store + show).
 *
 *   sonic(config)# interface breakout port <slot/port> mode <mode>
 *                                        [total-lane-count <n>] [owner <name>]   store
 *   sonic(config)# no interface breakout port <slot/port>                        clear
 *   sonic(config)# auto-breakout                                                 global enable
 *   sonic(config)# no auto-breakout                                              global disable
 *   sonic# show interface breakout [port <slot/port> | detail]                   render stored
 *   sonic# show interface breakout modes|resources|dependencies port <p>         not simulated
 *
 * Mirrors CONFIG_DB BREAKOUT_CFG|<ifname> (brkout_mode, lane_count, breakout-owner)
 * and DEVICE_METADATA|localhost auto-breakout — see
 * data/device-capture/klish-xml/dynamic_port_breakout.xml. Config is stored per
 * front-panel port and rendered back exactly as configured — nothing fabricated.
 *
 * KLISH DISPATCH NOTE: the per-port command lives in configure-view keyed on the
 * shared "interface" first token (`interface breakout port ... mode ...`). The
 * modal core (lib/commands/sonic-cli.ts) special-cases the bare "interface"
 * keyword for per-interface sub-view entry BEFORE consulting feature handlers, so
 * in the live CLI a raw `interface breakout ...` line is caught there. This handler
 * is written to the registry contract (returns null for any non-breakout
 * "interface" line) and is exercised through runModalHandlers, exactly as the core
 * dispatches configure-view feature commands (cf. features/port_media_fec.ts).
 * `auto-breakout` is a distinct keyword and dispatches normally.
 *
 * DATA-PLANE: the actual breakout operation the box performs (creating/removing the
 * derived member interfaces, the DPB state-machine Status transitions, per-platform
 * supported modes and resource limits) is NOT simulated — only CONFIG_DB state is
 * modelled, so operational columns render "-".
 */
import { OutputLine, line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpRemove, cpList } from "../config-plane";

const ID = "dynamic_port_breakout";

// DPB_MODE ptype (sonic_types.xml): the platform-supported breakout modes.
const MODES = [
  "1x800G", "2x400G", "1x400G", "4x200G", "2x200G", "1x200G",
  "8x100G", "4x100G", "2x100G", "1x100G", "8x50G", "4x50G", "2x50G", "1x50G",
  "2x40G", "1x40G", "8x25G", "4x25G", "2x25G", "1x25G", "8x10G", "4x10G", "2x10G", "1x10G",
];

interface Brk {
  port: string;
  mode: string;
  lanecount?: string;
  owner?: string;
}

const inProgress = (port: string) =>
  `Dynamic Port Breakout in-progress, use 'show interface breakout port ${port}' to check status.`;

// configure-view: `interface breakout port <slot/port> mode <mode> ...` / `no ...`.
registerModal({
  id: ID,
  views: ["configure-view"],
  keywords: ["interface"],
  run({ isNo, args, ctx }) {
    if (args[0]?.toLowerCase() !== "breakout") return null; // not ours (interface <name>, media-fec, ...)
    if (args[1]?.toLowerCase() !== "port" || !args[2])
      return { output: [err("% usage: interface breakout port <slot/port> mode <mode> [total-lane-count <n>] [owner <name>]")] };
    const port = args[2];
    if (!/^\d+\/\d+$/.test(port)) return { output: [err("% front-panel port must be in slot/port format (e.g. 1/1)")] };

    if (isNo) {
      cpRemove(ctx.device, ID, "ports", "port", port);
      return { output: [muted(inProgress(port))] };
    }

    if (args[3]?.toLowerCase() !== "mode" || !args[4]) return { output: [err("% breakout mode required")] };
    const mode = MODES.find((m) => m.toLowerCase() === args[4].toLowerCase());
    if (!mode) return { output: [err(`% breakout mode must be one of ${MODES.join(" ")}`)] };

    const item: Brk = { port, mode };
    for (let i = 5; i < args.length; ) {
      const kw = args[i].toLowerCase();
      const val = args[i + 1];
      if (kw === "total-lane-count") {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1 || n > 32) return { output: [err("% total-lane-count must be an integer 1-32")] };
        item.lanecount = String(n);
        i += 2;
      } else if (kw === "owner") {
        if (!val) return { output: [err("% owner requires a name")] };
        item.owner = val;
        i += 2;
      } else {
        i += 1; // ignore stray token
      }
    }
    cpUpsert(ctx.device, ID, "ports", item as unknown as Record<string, unknown>, "port");
    return { output: [muted(inProgress(port))] };
  },
});

// configure-view: `auto-breakout` / `no auto-breakout` (DEVICE_METADATA global).
registerModal({
  id: `${ID}-auto`,
  views: ["configure-view"],
  keywords: ["auto-breakout"],
  run({ isNo, ctx }) {
    if (isNo) {
      cpUnset(ctx.device, ID, "auto_breakout");
      return { output: [] };
    }
    cpSet(ctx.device, ID, "auto_breakout", "ENABLE");
    return { output: [] };
  },
});

// enable-view: `show interface breakout [port <p> | detail]` renders stored config.
registerModal({
  id: `${ID}-show`,
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "interface" || args[1]?.toLowerCase() !== "breakout") return null; // not ours
    const sub = (args[2] ?? "").toLowerCase();

    // Platform capability / operational queries — not fabricated.
    if (sub === "modes" || sub === "resources" || sub === "dependencies") {
      return { output: [muted(`show interface breakout ${sub}: platform/operational data not simulated in this lab.`)] };
    }

    const ports = cpList(ctx.device, ID, "ports") as unknown as Brk[];
    const list = sub === "port" && args[3] ? ports.filter((p) => p.port === args[3]) : ports;

    const auto = cpGet(ctx.device, ID)?.auto_breakout;
    const header: OutputLine[] = auto ? [line(`Auto-breakout: ${auto}`)] : [];

    if (!list.length) return { output: [...header, muted("No port breakout configured")] };

    const cell = (v: unknown) => (v === undefined || v === "" ? "-" : String(v));

    if (sub === "detail") {
      const dash = "-".repeat(47);
      const out: OutputLine[] = [
        ...header,
        line(dash),
        line("Port".padEnd(6) + "Breakout Mode".padEnd(15) + "Lanes".padEnd(8) + "Owner"),
        line(dash),
      ];
      for (const p of list) {
        out.push(line(cell(p.port).padEnd(6) + cell(p.mode).padEnd(15) + cell(p.lanecount).padEnd(8) + cell(p.owner)));
      }
      return { output: out };
    }

    // Golden `show interface breakout` layout; Status/Interfaces are operational (not simulated).
    const dash = "-".repeat(47);
    const out: OutputLine[] = [
      ...header,
      line(dash),
      line("Port".padEnd(6) + "Breakout Mode".padEnd(15) + "Status".padEnd(14) + "Interfaces"),
      line(dash),
    ];
    for (const p of list) {
      out.push(line(cell(p.port).padEnd(6) + cell(p.mode).padEnd(15) + "-".padEnd(14) + "-"));
    }
    return { output: out };
  },
});
