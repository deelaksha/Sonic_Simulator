/**
 * Logging — CONFIG-PLANE feature (no engine/packet backend; store + show).
 *
 *   sonic(config)# logging security-profile <name>        store scalar
 *   sonic(config)# logging server <host> [message-type <t>] [remote-port <p>]
 *                                        [protocol tcp|tls|udp]
 *                                        [source-interface <if>] [vrf <v>]
 *                                        [severity <sev>]                store list item
 *   sonic(config)# no logging server <host>               remove list item
 *   sonic(config)# no logging security-profile            clear scalar
 *   sonic(config)# no logging                             clear all
 *   sonic# show logging servers                           render from stored state
 *
 * Mirrors the real box's SYSLOG_SERVER / SYSLOG CONFIG_DB tables: config is
 * stored honestly and `show logging servers` renders exactly what was set.
 * NOTE: the runtime effect (actual syslog forwarding to the remote server, and
 * the `show logging` message stream) is NOT simulated — only config is modelled.
 */
import { line, err, muted } from "../../types";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpUpsert, cpRemove, cpList } from "../config-plane";

const PROTOCOLS = ["tcp", "tls", "udp"];
const SEVERITIES = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
const MSG_TYPES = ["audit", "auditd-system", "event", "log"];

// configure-view: `logging security-profile` / `logging server`.
registerModal({
  id: "logging",
  views: ["configure-view"],
  keywords: ["logging"],
  run({ isNo, args, ctx }) {
    const sub = (args[0] ?? "").toLowerCase();

    // `logging` / `no logging` (parent): no-op on set, clear all on `no`.
    if (!sub) {
      if (isNo) {
        cpUnset(ctx.device, "logging", "servers");
        cpUnset(ctx.device, "logging", "security_profile");
      }
      return { output: [] };
    }

    if (sub === "security-profile") {
      if (isNo) {
        cpUnset(ctx.device, "logging", "security_profile");
        return { output: [] };
      }
      const name = args[1];
      if (!name) return { output: [err("% security profile name required")] };
      cpSet(ctx.device, "logging", "security_profile", name);
      return { output: [] };
    }

    if (sub === "server") {
      const host = args[1];
      if (!host) return { output: [err("% remote syslog server host/address required")] };
      if (isNo) {
        cpRemove(ctx.device, "logging", "servers", "host", host);
        return { output: [] };
      }
      const item: Record<string, unknown> = { host };
      for (let i = 2; i < args.length; ) {
        const kw = args[i].toLowerCase();
        const val = args[i + 1];
        switch (kw) {
          case "message-type":
            if (!MSG_TYPES.includes((val ?? "").toLowerCase()))
              return { output: [err(`% message-type must be one of ${MSG_TYPES.join("|")}`)] };
            item["message-type"] = val;
            i += 2;
            break;
          case "remote-port":
            if (!/^\d+$/.test(val ?? "")) return { output: [err("% remote-port must be a number (1..65535)")] };
            item.port = val;
            i += 2;
            break;
          case "protocol":
            if (!PROTOCOLS.includes((val ?? "").toLowerCase()))
              return { output: [err(`% protocol must be one of ${PROTOCOLS.join("|")}`)] };
            item.protocol = val.toLowerCase();
            i += 2;
            break;
          case "severity":
            if (!SEVERITIES.includes((val ?? "").toLowerCase()))
              return { output: [err(`% severity must be one of ${SEVERITIES.join("|")}`)] };
            item.severity = val.toLowerCase();
            i += 2;
            break;
          case "vrf":
            item.vrf = val;
            i += 2;
            break;
          case "source-interface": {
            let sif = val ?? "";
            if (args[i + 2] && /^\d+$/.test(args[i + 2])) {
              sif += args[i + 2];
              i += 3;
            } else i += 2;
            item["source-interface"] = sif;
            break;
          }
          default:
            i += 1; // ignore stray token
        }
      }
      cpUpsert(ctx.device, "logging", "servers", item, "host");
      return { output: [] };
    }

    return { output: [err("% logging: expected `security-profile` or `server`")] };
  },
});

// enable-view: `show logging servers` renders the configured remote syslog servers.
// Other `show logging*` variants are runtime message displays — NOT fabricated here.
registerModal({
  id: "logging-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "logging") return null; // not ours
    if (args[1]?.toLowerCase() !== "servers") return null; // runtime log stream — do not fabricate
    const servers = cpList(ctx.device, "logging", "servers");
    if (!servers.length) return { output: [muted("No logging servers configured")] };
    const cell = (v: unknown) => (v === undefined || v === "" ? "-" : String(v));
    const row = (h: string, p: string, s: string, vrf: string, m: string, sev: string, proto: string) =>
      h.padEnd(16) + p.padEnd(10) + s.padEnd(20) + vrf.padEnd(15) + m.padEnd(15) + sev.padEnd(12) + proto;
    const dash = "-".repeat(96);
    const out = [
      line(dash),
      line(row("HOST", "PORT", "SOURCE-INTERFACE", "VRF", "MESSAGE-TYPE", "SEVERITY", "PROTOCOL")),
      line(dash),
    ];
    for (const s of servers) {
      out.push(
        line(
          row(
            cell(s.host),
            cell(s.port ?? "514"),
            cell(s["source-interface"]),
            cell(s.vrf),
            cell(s["message-type"] ?? "log"),
            cell(s.severity),
            cell(s.protocol),
          ),
        ),
      );
    }
    return { output: out };
  },
});
