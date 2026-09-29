/**
 * RADIUS SONiC feature module. Source: radius.txt. Follows the ./vlan.ts pattern;
 * config-plane state lives in device.config.features via feature-state.ts.
 *
 * radius.txt is written in the klish `radius-server ...` config-terminal form;
 * this module implements the equivalent SONiC click forms dispatched by the
 * central config/show handlers (path ["radius", ...]):
 *
 *   config radius add <ip> [-o auth-port] [-a auth-type] [-p priority] \
 *        [-k key] [-r retransmit] [-t timeout] [-s source-interface] [--vrf n]
 *                                     -> radius-server host <ip> ...  (TC-4,25..44)
 *   config radius delete <ip>         -> no radius-server host <ip>   (TC-51,52)
 *   config radius nasip <ip>          -> radius-server nas-ip <ip>    (TC-3,21,22)
 *   config radius passkey <key>       -> radius-server key <key>      (TC-20)
 *   config radius authtype <type>     -> radius-server auth-type ...  (TC-18,19)
 *   config radius timeout <1-60>      -> radius-server timeout ...    (TC-13..15)
 *   config radius retransmit <0-10>   -> radius-server retransmit ... (TC-16,17)
 *   config radius statistics <en|dis> -> radius-server statistics ... (TC-54)
 *   config radius source-interface .. -> REJECTED: global form not supported (TC-23)
 *   show radius                       -> show radius-server           (TC-5,24,38..)
 *
 * State is simulated only (no real RADIUS server is contacted); show renders the
 * stored config, mirroring the `show radius-server` layout in radius.txt.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { isValidIpv4, isValidHostname } from "../../models/ip";
import { isValidIpv6 } from "../../models/ipv6";

interface RadiusServer {
  ip: string;
  key?: string;
  authType?: string;
  authPort?: number;
  priority?: number;
  timeout?: number;
  retransmit?: number;
  sourceInterface?: string;
  vrf?: string;
}

interface RadiusState {
  servers: RadiusServer[];
  global: Record<string, string>;
}

const AUTH_TYPES = ["pap", "chap", "mschapv2"];

function radiusState(ctx: CommandContext): RadiusState {
  return featureState<RadiusState>(ctx.device, "radius", () => ({ servers: [], global: {} }));
}

/** Value token following any of the given flag aliases, or undefined. */
function flagValue(args: string[], ...flags: string[]): string | undefined {
  for (const f of flags) {
    const i = args.indexOf(f);
    if (i >= 0 && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

/** Validate an optional integer in [min,max]; returns the value and/or an error. */
function intInRange(name: string, raw: string | undefined, min: number, max: number): { val?: number; error?: string } {
  if (raw === undefined) return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { error: `% Error: Invalid input for ${name} (valid range ${min}-${max})` };
  }
  return { val: n };
}

const config: SonicCmd[] = [
  {
    path: ["radius", "add"],
    summary: "Add/update a RADIUS server (config radius add <ip> [-o -a -p -k -r -t -s --vrf])",
    run(args, ctx): CommandResult {
      const st = radiusState(ctx);
      const ip = positional(args)[0];
      if (!ip) {
        return {
          output: [
            err("Usage: config radius add <ip> [-o auth-port] [-a auth-type] [-p priority] [-k key] [-r retransmit] [-t timeout] [-s source-interface] [--vrf name]"),
          ],
        };
      }
      // Real device accepts A.B.C.D | X:X::X:X | hostname for radius-server host.
      if (!isValidIpv4(ip) && !isValidIpv6(ip) && !isValidHostname(ip)) {
        return { output: [err(`% Error: "${ip}" is not a valid IPv4/IPv6 address or hostname`)] };
      }

      const authPort = intInRange("auth-port", flagValue(args, "-o", "--auth-port"), 1, 65535);
      if (authPort.error) return { output: [err(authPort.error)] };
      const priority = intInRange("priority", flagValue(args, "-p", "--priority"), 1, 64);
      if (priority.error) return { output: [err(priority.error)] };
      const timeout = intInRange("timeout", flagValue(args, "-t", "--timeout"), 1, 60);
      if (timeout.error) return { output: [err(timeout.error)] };
      const retransmit = intInRange("retransmit", flagValue(args, "-r", "--retransmit"), 0, 10);
      if (retransmit.error) return { output: [err(retransmit.error)] };

      const authType = flagValue(args, "-a", "--auth-type");
      if (authType !== undefined && !AUTH_TYPES.includes(authType)) {
        return { output: [err(`% Error: Invalid input for auth-type (${AUTH_TYPES.join("|")})`)] };
      }
      let vrf = flagValue(args, "--vrf");
      if (args.includes("-m") || args.includes("--use-mgmt-vrf")) vrf = "mgmt";
      if (vrf !== undefined && !/^(mgmt|default)$/.test(vrf)) {
        return { output: [err(`% Error: vrf "${vrf}" does not match pattern ^(mgmt|default)$`)] };
      }
      const key = flagValue(args, "-k", "--key");
      const srcIntf = flagValue(args, "-s", "--source-interface");

      const updates: Partial<RadiusServer> = {};
      if (authPort.val !== undefined) updates.authPort = authPort.val;
      if (priority.val !== undefined) updates.priority = priority.val;
      if (timeout.val !== undefined) updates.timeout = timeout.val;
      if (retransmit.val !== undefined) updates.retransmit = retransmit.val;
      if (authType !== undefined) updates.authType = authType;
      if (key !== undefined) updates.key = key;
      if (srcIntf !== undefined) updates.sourceInterface = srcIntf;
      if (vrf !== undefined) updates.vrf = vrf;

      const existing = st.servers.find((s) => s.ip === ip);
      if (existing) Object.assign(existing, updates); // idempotent update in place (TC-41..44)
      else st.servers.push({ ip, ...updates });
      return { output: [muted(`RADIUS server ${ip} configured`)] };
    },
  },
  {
    path: ["radius", "delete"],
    summary: "Delete a RADIUS server (config radius delete <ip>)",
    run(args, ctx): CommandResult {
      const st = radiusState(ctx);
      const ip = positional(args)[0];
      if (!ip) return { output: [err("Usage: config radius delete <ip>")] };
      const before = st.servers.length;
      st.servers = st.servers.filter((s) => s.ip !== ip);
      if (st.servers.length === before) return { output: [err(`% Error: RADIUS server ${ip} is not configured`)] };
      return { output: [muted(`RADIUS server ${ip} deleted`)] };
    },
  },
  {
    path: ["radius", "nasip"],
    summary: "Set the global RADIUS NAS IP (config radius nasip <ip>)",
    run(args, ctx): CommandResult {
      const st = radiusState(ctx);
      const ip = positional(args)[0];
      if (!ip || !isValidIpv4(ip)) return { output: [err("Usage: config radius nasip <ipv4>")] };
      st.global["nas-ip"] = ip;
      return { output: [muted(`RADIUS nas-ip set to ${ip}`)] };
    },
  },
  {
    path: ["radius", "passkey"],
    summary: "Set the global RADIUS shared secret (config radius passkey <key>)",
    run(args, ctx): CommandResult {
      const st = radiusState(ctx);
      const key = positional(args)[0];
      if (!key) return { output: [err("Usage: config radius passkey <secret>")] };
      st.global["key"] = key;
      return { output: [muted("RADIUS shared secret configured")] };
    },
  },
  {
    path: ["radius", "authtype"],
    summary: "Set the global RADIUS auth-type (config radius authtype <pap|chap|mschapv2>)",
    run(args, ctx): CommandResult {
      const st = radiusState(ctx);
      const type = positional(args)[0];
      if (!type || !AUTH_TYPES.includes(type)) {
        return { output: [err(`% Error: Invalid input for auth-type (${AUTH_TYPES.join("|")})`)] };
      }
      st.global["auth-type"] = type;
      return { output: [muted(`RADIUS auth-type set to ${type}`)] };
    },
  },
  {
    path: ["radius", "timeout"],
    summary: "Set the global RADIUS timeout (config radius timeout <1-60>)",
    run(args, ctx): CommandResult {
      const st = radiusState(ctx);
      const t = intInRange("timeout", positional(args)[0], 1, 60);
      if (t.error || t.val === undefined) return { output: [err(t.error ?? "Usage: config radius timeout <1-60>")] };
      st.global["timeout"] = String(t.val);
      return { output: [muted(`RADIUS timeout set to ${t.val}`)] };
    },
  },
  {
    path: ["radius", "retransmit"],
    summary: "Set the global RADIUS retransmit count (config radius retransmit <0-10>)",
    run(args, ctx): CommandResult {
      const st = radiusState(ctx);
      const r = intInRange("retransmit", positional(args)[0], 0, 10);
      if (r.error || r.val === undefined) return { output: [err(r.error ?? "Usage: config radius retransmit <0-10>")] };
      st.global["retransmit"] = String(r.val);
      return { output: [muted(`RADIUS retransmit set to ${r.val}`)] };
    },
  },
  {
    path: ["radius", "statistics"],
    summary: "Enable/disable RADIUS statistics (config radius statistics <enable|disable>)",
    run(args, ctx): CommandResult {
      const st = radiusState(ctx);
      const v = positional(args)[0];
      if (v !== "enable" && v !== "disable") return { output: [err("Usage: config radius statistics <enable|disable>")] };
      st.global["statistics"] = v;
      return { output: [muted(`RADIUS statistics ${v}d`)] };
    },
  },
  {
    path: ["radius", "source-interface"],
    summary: "Global RADIUS source-interface (unsupported — per-host only)",
    run(_args, _ctx): CommandResult {
      // radius.txt TC-23: the GLOBAL `radius-server source-interface` form does
      // not exist (source-interface is a per-host attribute only) and is rejected.
      return {
        output: [
          err('% Error: Invalid input detected at "^" marker.'),
          muted("radius source-interface is a per-host option: config radius add <ip> -s <intf>"),
        ],
      };
    },
  },
];

function renderRadius(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<RadiusState>(ctx.device, "radius") ?? { servers: [], global: {} };
  const g = st.global;
  const out: OutputLine[] = [line("RADIUS Global Configuration")];
  if (g["nas-ip"]) out.push(line(`nas-ip-addr : ${g["nas-ip"]}`));
  if (g["timeout"]) out.push(line(`timeout : ${g["timeout"]}`));
  if (g["auth-type"]) out.push(line(`auth-type : ${g["auth-type"].toUpperCase()}`));
  out.push(line(`key configured : ${g["key"] ? "Yes" : "No"}`));
  if (g["retransmit"]) out.push(line(`retransmit : ${g["retransmit"]}`));

  if (st.servers.length > 0) {
    out.push(line("HOST AUTH-TYPE KEY-CONFIG AUTH-PORT PRIORITY TIMEOUT RTSMT VRF SRC-INTF"));
    for (const s of st.servers) {
      out.push(
        line(
          [
            s.ip,
            s.authType ? s.authType.toUpperCase() : "-",
            s.key ? "Yes" : "No",
            s.authPort ?? "-",
            s.priority ?? "-",
            s.timeout ?? "-",
            s.retransmit ?? "-",
            s.vrf ?? "-",
            s.sourceInterface ?? "-",
          ].join(" "),
        ),
      );
    }
  }
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["radius"],
    summary: "Show configured RADIUS servers and global settings",
    run: (_a, ctx) => ({ output: renderRadius(ctx) }),
  },
];

export const radiusModule: SonicFeatureModule = { id: "radius", config, show };
