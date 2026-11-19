/**
 * UDLD (KLISH) — config + show. The protocol (PDUs, echo, unidirectional
 * detection → err-disable) runs in lib/protocols/udld-daemon.ts; the show
 * commands render its per-port state in the layouts of the udld.xml examples.
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
 *   show udld neighbors         neighbours heard on every UDLD port
 *   show udld interface <if>    port config + status + neighbour entries
 *   show udld statistics [interface <if>]  PDU counters
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpRemove, cpList } from "../config-plane";
import { DEFAULT_MSG_TIME, DEFAULT_MULTIPLIER, aggressive, peekUdld, udldDeviceId } from "../../../protocols/udld-daemon";
import { OutputLine } from "../../types";

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

    const ports = peekUdld(ctx.device)?.ports ?? {};

    if (sub === "neighbors") {
      const out: OutputLine[] = [
        line(`${"Port".padEnd(15)}${"Device Name".padEnd(16)}${"Device ID".padEnd(18)}${"Port ID".padEnd(16)}Neighbor State`),
        line("-".repeat(81)),
      ];
      for (const [name, ps] of Object.entries(ports)) {
        for (const n of Object.values(ps.neighbors)) {
          out.push(line(`${name.padEnd(15)}${n.name.padEnd(16)}${n.deviceId.padEnd(18)}${n.portId.padEnd(16)}${ps.status}`));
        }
      }
      return { output: out };
    }

    if (sub === "interface") {
      const name = args.slice(2).join("");
      const port = cpList(ctx.device, "udld", "ports").find((e) => e.ifname === name);
      if (!port) return { output: [muted(`UDLD not configured on ${name || "interface"}`)] };
      const ps = ports[name];
      const out: OutputLine[] = [
        line(`UDLD information for ${name}`),
        line(`  UDLD Admin State:                  ${port.admin_enable === true ? "Enabled" : "Disabled"}`),
        line(`  Mode:                              ${aggressive(ctx.device, name) ? "Aggressive" : "Normal"}`),
        line(`  Status:                            ${ps?.status ?? "Undetermined"}`),
        line(`  Local device id:                   ${udldDeviceId(ctx.device)}`),
        line(`  Local port id :                    ${name}`),
        line(`  Local device name:                 ${ctx.device.config.hostname}`),
        line(`  Message time:                      ${msgTime}`),
        line(`  Timeout interval:                  ${msgTime * mult}`),
      ];
      Object.values(ps?.neighbors ?? {}).forEach((n, i) => {
        out.push(
          line(`    Neighbor Entry ${i + 1}`),
          line(`    ${"-".repeat(88)}`),
          line(`    Neighbor device id:         ${n.deviceId}`),
          line(`    Neighbor port id:           ${n.portId}`),
          line(`    Neighbor device name:       ${n.name}`),
          line(`    Neighbor message time:      ${n.msgTime}`),
          line(`    Neighbor timeout interval:  ${n.timeout}`),
        );
      });
      return { output: out };
    }

    if (sub === "statistics") {
      const only = args[2]?.toLowerCase() === "interface" ? args.slice(3).join("") : undefined;
      const out: OutputLine[] = [];
      for (const [name, ps] of Object.entries(ports)) {
        if (only && name !== only) continue;
        out.push(
          line(`UDLD Interface statistics for ${name}`),
          line(`Frames transmitted:         ${ps.tx}`),
          line(`Frames received:            ${ps.rx}`),
          line(`Frames with error:          ${ps.err}`),
        );
      }
      return { output: out };
    }

    return { output: [muted(`% Unknown 'show udld ${sub}'`)] };
  },
});
