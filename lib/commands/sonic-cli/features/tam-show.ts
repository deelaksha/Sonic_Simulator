/**
 * KLISH `show tam` feature/session views (enable-view, telemetry.xml:18-254) that
 * telemetry.ts (switch / collectors / samplers / flowgroups) does not cover:
 *
 *   show tam                                     telemetry.xml:18 — container (no ACTION)
 *   show tam ifa | tail-stamping | drop-monitor  → show_tam_feature.j2 via
 *       sonic_cli_telemetry.py printFeatureDetails (Status / Switch ID / Enterprise ID /
 *       Version / session + collector counts / Aging Interval)
 *   show tam {ifa|tail-stamping|drop-monitor} sessions [<name>]
 *       → show_tam_{ifa,ts,mod}_session_all.j2: "Sessions are not configured." when empty
 *   show tam features [ifa|drop-monitor|tail-stamping]
 *       → show_tam_global_feature_all.j2 ("Name / Status" table) / show_tam_global_feature.j2
 *
 * The switch-id / enterprise-id come from the TAM config-plane store written in
 * `configure-tam-view` (telemetry.ts). IFA / tail-stamping / drop-monitor features
 * and sessions cannot be configured in this lab, so every feature reports the
 * not-enabled operational status "Inactive" and no sessions exist.
 */
import { registerModal } from "../registry";
import { cpGet } from "../config-plane";
import { lines, noAction } from "./klish-show-util";

const FEATURES = ["drop-monitor", "ifa", "tail-stamping"];

registerModal({
  id: "tam-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    if (a[0] !== "tam") return null;
    if (a[1] === undefined) return noAction();

    if (a[1] === "features") {
      if (a[2] === undefined || a[2] === "all") {
        return lines(["Name            Status", "--------------  ---------", ...FEATURES.map((f) => `${f.padEnd(16)}${"Inactive".padEnd(15)}`)]);
      }
      if (!FEATURES.includes(a[2])) return null;
      return lines([`Name          : ${a[2]}`, "Status        : Inactive"]);
    }

    if (!FEATURES.includes(a[1])) return null;
    if (a[2] === "sessions") return lines(["Sessions are not configured."]);
    if (a[2] !== undefined) return null;

    const st = cpGet(ctx.device, "telemetry") ?? {};
    const sw = st.switch_id ?? "-";
    const ent = st.enterprise_id ?? "-";
    const rows = ["Status               : Inactive", `Switch ID            : ${sw}`];
    if (a[1] === "ifa") {
      rows.push(`Enterprise ID        : ${ent}`, "Version              : 2.0", "Number of sessions   : 0", "Number of collectors : 0");
    } else if (a[1] === "tail-stamping") {
      rows.push("Number of sessions   : 0");
    } else {
      rows.push("Number of sessions   : 0", "Number of collectors : 0", "Aging Interval       : Not Configured");
    }
    return lines(rows);
  },
});
