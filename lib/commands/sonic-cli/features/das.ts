/**
 * DAS — RADIUS Dynamic Authorization Server / CoA (CONFIG-PLANE feature).
 *
 * No engine/packet backend: this feature mirrors the box's DAS_GLOBAL_CONFIG_TABLE
 * and DAS_CLIENT_CONFIG_TABLE (CONFIG_DB) honestly — config is stored and rendered
 * back by `show`. Nothing is fabricated.
 *
 * configure-view:
 *   sonic(config)# authentication command bounce-port ignore    ignore_bounce_port
 *   sonic(config)# authentication command disable-port ignore   ignore_disable_port
 *   sonic(config)# no authentication command bounce-port ignore
 *   sonic(config)# aaa server radius dynamic-author             enable DAS + enter sub-mode
 *   sonic(config)# no aaa server radius dynamic-author          disable DAS (clear all)
 *
 * configure-das-view  (sonic(config-radius-da)#):
 *   auth-type <all|any|session-key>      das_auth_type
 *   port <1025-65535>                    das_port
 *   request-timeout <1-30>               das_request_timeout
 *   vrf <mgmt|name>                      das_vrf_name
 *   server-key <key> [encrypted]         global_server_key
 *   ignore server-key | session-key      ignore_server_key / ignore_session_key
 *   client <ip|host> [server-key <k>]    DAS_CLIENT_CONFIG_TABLE row
 *   no <...>                             clears the corresponding field/row
 *
 * enable-view:
 *   sonic# show radius-server dynamic-author    render the two tables from store
 *
 * Real KLISH grammar: data/device-capture/klish-xml/das.xml. The `show ... statistics`
 * and `clear ...` commands are runtime CoA counters/state — NOT simulated here, so this
 * handler declines them (returns null) rather than fabricate numbers. The DATA plane
 * (actual CoA request processing, live DAC sessions) is not simulated either.
 */
import { OutputLine, line, err, muted } from "../../types";
import { Device } from "../../../models/device";
import { registerModal } from "../registry";
import { cpSet, cpUnset, cpGet, cpUpsert, cpRemove, cpList } from "../config-plane";
import { subViewFrame } from "../../../sonic/grammar";

const FEATURE = "das";
const AUTH_TYPES = ["all", "any", "session-key"];

// DAS_GLOBAL_CONFIG_TABLE scalar fields (order = golden `show` output order).
const GLOBAL_KEYS = [
  "das_admin_mode",
  "das_port",
  "das_auth_type",
  "global_server_key",
  "ignore_server_key",
  "ignore_session_key",
  "ignore_bounce_port",
  "ignore_disable_port",
  "das_vrf_name",
  "das_request_timeout",
];

function clearDas(device: Device): void {
  for (const k of GLOBAL_KEYS) cpUnset(device, FEATURE, k);
  cpUnset(device, FEATURE, "clients");
}

// configure-view: `authentication command ... ignore` and `aaa server radius dynamic-author`.
registerModal({
  id: "das",
  views: ["configure-view"],
  keywords: ["authentication", "aaa"],
  run({ head, isNo, args, ctx }) {
    const dev = ctx.device;

    if (head === "authentication") {
      // authentication command <bounce-port|disable-port> ignore
      if (args[0]?.toLowerCase() !== "command") return null; // not ours (dot1x `authentication ...`)
      if (args[2]?.toLowerCase() !== "ignore") return null;
      const which = args[1]?.toLowerCase();
      const key = which === "bounce-port" ? "ignore_bounce_port" : which === "disable-port" ? "ignore_disable_port" : null;
      if (!key) return null;
      if (isNo) cpUnset(dev, FEATURE, key);
      else cpSet(dev, FEATURE, key, "true");
      return { output: [] };
    }

    // head === "aaa": only `aaa server radius dynamic-author` is ours.
    if (args[0]?.toLowerCase() !== "server" || args[1]?.toLowerCase() !== "radius" || args[2]?.toLowerCase() !== "dynamic-author") {
      return null; // e.g. `aaa authentication ...` — handled by the aaa feature
    }
    if (isNo) {
      clearDas(dev);
      return { output: [] };
    }
    cpSet(dev, FEATURE, "das_admin_mode", "true");
    return { output: [], enter: subViewFrame("configure-das-view", "GLOBAL") };
  },
});

// configure-das-view (sonic(config-radius-da)#): per-server / per-client config.
registerModal({
  id: "das-config",
  views: ["configure-das-view"],
  keywords: ["auth-type", "port", "request-timeout", "vrf", "server-key", "ignore", "client"],
  run({ head, isNo, args, ctx }) {
    const dev = ctx.device;

    switch (head) {
      case "auth-type": {
        if (isNo) {
          cpUnset(dev, FEATURE, "das_auth_type");
          return { output: [] };
        }
        const t = (args[0] ?? "").toLowerCase();
        if (!AUTH_TYPES.includes(t)) return { output: [err(`% auth-type must be one of ${AUTH_TYPES.join("|")}`)] };
        cpSet(dev, FEATURE, "das_auth_type", t);
        return { output: [] };
      }
      case "port": {
        if (isNo) {
          cpUnset(dev, FEATURE, "das_port");
          return { output: [] };
        }
        const p = Number(args[0]);
        if (!Number.isInteger(p) || p < 1025 || p > 65535) return { output: [err("% port must be an integer in the range 1025-65535")] };
        cpSet(dev, FEATURE, "das_port", String(p));
        return { output: [] };
      }
      case "request-timeout": {
        if (isNo) {
          cpUnset(dev, FEATURE, "das_request_timeout");
          return { output: [] };
        }
        const t = Number(args[0]);
        if (!Number.isInteger(t) || t < 1 || t > 30) return { output: [err("% request-timeout must be an integer in the range 1-30")] };
        cpSet(dev, FEATURE, "das_request_timeout", String(t));
        return { output: [] };
      }
      case "vrf": {
        if (isNo) {
          cpUnset(dev, FEATURE, "das_vrf_name");
          return { output: [] };
        }
        const v = args[0];
        if (!v) return { output: [err("% VRF name required")] };
        cpSet(dev, FEATURE, "das_vrf_name", v);
        return { output: [] };
      }
      case "server-key": {
        if (isNo) {
          cpUnset(dev, FEATURE, "global_server_key");
          return { output: [] };
        }
        const k = args[0];
        if (!k) return { output: [err("% shared secret required")] };
        cpSet(dev, FEATURE, "global_server_key", k);
        return { output: [] };
      }
      case "ignore": {
        const what = (args[0] ?? "").toLowerCase();
        const key = what === "server-key" ? "ignore_server_key" : what === "session-key" ? "ignore_session_key" : null;
        if (!key) return { output: [err("% ignore <server-key|session-key>")] };
        if (isNo) cpUnset(dev, FEATURE, key);
        else cpSet(dev, FEATURE, key, "true");
        return { output: [] };
      }
      case "client": {
        const addr = args[0];
        if (!addr) return { output: [err("% client IP address or hostname required")] };
        if (isNo) {
          cpRemove(dev, FEATURE, "clients", "address", addr);
          return { output: [] };
        }
        const item: Record<string, unknown> = { address: addr };
        if (args[1]?.toLowerCase() === "server-key") {
          const key = args[2];
          if (!key) return { output: [err("% server-key value required")] };
          item.server_key = key; // args[3] may be the hidden `encrypted` marker — no stored effect
        }
        cpUpsert(dev, FEATURE, "clients", item, "address");
        return { output: [] };
      }
      default:
        return null;
    }
  },
});

// enable-view: `show radius-server dynamic-author` renders the stored DAS config.
registerModal({
  id: "das-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    if (args[0]?.toLowerCase() !== "radius-server" || args[1]?.toLowerCase() !== "dynamic-author") return null; // not ours
    if (args[2]) return null; // `... statistics` — runtime counters, not simulated (don't fabricate)

    const st = cpGet(ctx.device, FEATURE);
    const clients = cpList(ctx.device, FEATURE, "clients");
    const hasGlobal = !!st && GLOBAL_KEYS.some((k) => st[k] !== undefined);
    if (!hasGlobal && clients.length === 0) return { output: [muted("Dynamic authorization is not configured")] };

    const g = (k: string): unknown => st?.[k];
    const onOff = (v: unknown) => (String(v).toLowerCase() === "true" ? "Enabled" : "Disabled");
    const coa = (v: unknown) => (String(v).toLowerCase() === "true" ? "Ignore" : "Accept");
    const dot = (label: string, value: string) => line(label.padEnd(48, ".") + " " + value);

    const out: OutputLine[] = [
      dot("Admin Mode", onOff(g("das_admin_mode"))),
      dot("Port", String(g("das_port") ?? "7676")),
      dot("Auth Type", String(g("das_auth_type") ?? "all")),
      dot("Global Secret Key", String(g("global_server_key") ?? "")),
      dot("Ignore Server Key", onOff(g("ignore_server_key"))),
      dot("Ignore Session Key", onOff(g("ignore_session_key"))),
      dot("CoA Bounce-Host-Port", coa(g("ignore_bounce_port"))),
      dot("CoA Disable-Host-Port", coa(g("ignore_disable_port"))),
      dot("VRF", String(g("das_vrf_name") ?? "Not Configured")),
      dot("Request Timeout", String(g("das_request_timeout") ?? "3")),
    ];

    if (clients.length) {
      const dash = "-".repeat(68);
      out.push(line(""), line(dash), line("Client Address".padEnd(30) + "Secret"), line(dash));
      for (const c of clients) {
        out.push(line(String(c.address).padEnd(30) + String(c.server_key ?? "N/A")));
      }
    }
    return { output: out };
  },
});
