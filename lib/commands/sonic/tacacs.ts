/**
 * TACACS+ SONiC feature module. Config-plane only (simulated CONFIG_DB): commands
 * mutate per-device feature state and `show tacacs` renders it. Nothing reaches a
 * real TACACS+ server.
 *
 * Commands are the SONiC click `config tacacs` family (path ["tacacs", ...]); the
 * fields, enum values and validation ranges are taken from tacacs.txt, which
 * drives the equivalent management-framework forms:
 *
 *   config tacacs add <ip> [-a type] [-o port] [-p pri] [-t timeout] [-k key] [-m]
 *        <- tacacs-server host <ip> type <t> port <n> priority <n> timeout <n> key <k> [vrf mgmt]
 *   config tacacs delete <ip>          <- no tacacs-server host <ip>
 *   config tacacs authtype <type>      <- tacacs-server auth-type <type>   (global)
 *   config tacacs passkey <key>        <- tacacs-server passkey <key>      (global)
 *   config tacacs timeout <n>          <- tacacs-server timeout <n>        (global)
 *   show tacacs                        <- show tacacs-server
 *
 * Ranges/enums from tacacs.txt: auth-type pap|chap|mschap|login (TC-14/TC-27),
 * host port 1-65535 (TC-23/TC-24), priority 1-64 (TC-25), timeout 1-60
 * (TC-16/TC-17/TC-26), vrf mgmt-only (TC-28), IPv4 validated (TC-29).
 * Per-host defaults: type pap, port 49, priority 1, timeout 5, vrf default (TC-21).
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional } from "./types";
import { featureState, peekFeatureState } from "../../models/feature-state";
import { isValidIpv4, isValidHostname } from "../../models/ip";
import { isValidIpv6 } from "../../models/ipv6";

interface TacacsServer {
  ip: string;
  key?: string;
  priority?: number;
  type?: string;
  timeout?: number;
  port?: number;
  vrf?: string;
}

interface TacacsState {
  servers: TacacsServer[];
  globalKey: string | undefined;
  authType: string | undefined;
  timeout: number | undefined;
}

const AUTH_TYPES = ["pap", "chap", "mschap", "login"];
const PORT = { min: 1, max: 65535 };
const PRIORITY = { min: 1, max: 64 };
const TIMEOUT = { min: 1, max: 60 };
const DEFAULTS = { type: "pap", port: 49, priority: 1, timeout: 5, vrf: "default" };

function state(ctx: CommandContext): TacacsState {
  return featureState<TacacsState>(ctx.device, "tacacs", () => ({
    servers: [],
    globalKey: undefined,
    authType: undefined,
    timeout: undefined,
  }));
}

/** `-a`/`--auth_type`, `-o`/`--port`, `-p`/`--pri`, `-t`/`--timeout`, `-k`/`--key`. */
const OPT_ALIASES: Record<string, keyof TacacsServer> = {
  "-a": "type",
  "--auth_type": "type",
  "-o": "port",
  "--port": "port",
  "-p": "priority",
  "--pri": "priority",
  "-t": "timeout",
  "--timeout": "timeout",
  "-k": "key",
  "--key": "key",
};
const MGMT_VRF_FLAGS = ["-m", "--use-mgmt-vrf"];

function parseAddOpts(args: string[]): { pos: string[]; opts: Partial<Record<keyof TacacsServer, string>>; mgmtVrf: boolean } {
  const pos: string[] = [];
  const opts: Partial<Record<keyof TacacsServer, string>> = {};
  let mgmtVrf = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (MGMT_VRF_FLAGS.includes(a)) {
      mgmtVrf = true;
    } else if (a in OPT_ALIASES) {
      opts[OPT_ALIASES[a]] = args[i + 1];
      i++;
    } else if (!a.startsWith("-")) {
      pos.push(a);
    }
  }
  return { pos, opts, mgmtVrf };
}

/** Validated integer in [min,max], or an error message. */
function parseRange(raw: string | undefined, label: string, r: { min: number; max: number }): { value?: number; error?: string } {
  if (raw === undefined) return {};
  const n = Number(raw);
  if (!Number.isInteger(n) || n < r.min || n > r.max) {
    return { error: `${label} must be an integer in ${r.min}-${r.max} (got '${raw}')` };
  }
  return { value: n };
}

const config: SonicCmd[] = [
  {
    path: ["tacacs", "add"],
    summary: "Add/update a TACACS+ server (-a type -o port -p pri -t timeout -k key -m)",
    run(args, ctx): CommandResult {
      const { pos, opts, mgmtVrf } = parseAddOpts(args);
      const ip = pos[0];
      if (!ip) return { output: [err("Usage: config tacacs add <ip> [-a type] [-o port] [-p pri] [-t timeout] [-k key] [-m]")] };
      // Real device accepts A.B.C.D | X:X::X:X | hostname for tacacs-server host.
      if (!isValidIpv4(ip) && !isValidIpv6(ip) && !isValidHostname(ip)) {
        return { output: [err(`config tacacs add: invalid IPv4/IPv6 address or hostname '${ip}'`)] };
      }

      if (opts.type !== undefined && !AUTH_TYPES.includes(opts.type)) {
        return { output: [err(`config tacacs add: auth-type must be one of ${AUTH_TYPES.join("|")} (got '${opts.type}')`)] };
      }
      const port = parseRange(opts.port, "port", PORT);
      if (port.error) return { output: [err(`config tacacs add: ${port.error}`)] };
      const priority = parseRange(opts.priority, "priority", PRIORITY);
      if (priority.error) return { output: [err(`config tacacs add: ${priority.error}`)] };
      const timeout = parseRange(opts.timeout, "timeout", TIMEOUT);
      if (timeout.error) return { output: [err(`config tacacs add: ${timeout.error}`)] };

      const st = state(ctx);
      let srv = st.servers.find((s) => s.ip === ip);
      if (!srv) {
        srv = { ip };
        st.servers.push(srv);
      }
      if (opts.type !== undefined) srv.type = opts.type;
      if (opts.key !== undefined) srv.key = opts.key;
      if (port.value !== undefined) srv.port = port.value;
      if (priority.value !== undefined) srv.priority = priority.value;
      if (timeout.value !== undefined) srv.timeout = timeout.value;
      if (mgmtVrf) srv.vrf = "mgmt";
      return { output: [muted(`TACACS+ server ${ip} configured`)] };
    },
  },
  {
    path: ["tacacs", "delete"],
    summary: "Delete a TACACS+ server",
    run(args, ctx): CommandResult {
      const ip = positional(args)[0];
      if (!ip) return { output: [err("Usage: config tacacs delete <ip>")] };
      const st = state(ctx);
      const before = st.servers.length;
      st.servers = st.servers.filter((s) => s.ip !== ip);
      if (st.servers.length === before) return { output: [err(`config tacacs delete: no TACACS+ server ${ip}`)] };
      return { output: [muted(`TACACS+ server ${ip} deleted`)] };
    },
  },
  {
    path: ["tacacs", "authtype"],
    summary: "Set the global TACACS+ authentication type (pap|chap|mschap|login)",
    run(args, ctx): CommandResult {
      const type = positional(args)[0];
      if (!type) return { output: [err("Usage: config tacacs authtype <pap|chap|mschap|login>")] };
      if (!AUTH_TYPES.includes(type)) {
        return { output: [err(`config tacacs authtype: must be one of ${AUTH_TYPES.join("|")} (got '${type}')`)] };
      }
      state(ctx).authType = type;
      return { output: [muted(`TACACS+ global auth-type set to ${type}`)] };
    },
  },
  {
    path: ["tacacs", "passkey"],
    summary: "Set the global TACACS+ shared secret",
    run(args, ctx): CommandResult {
      const key = positional(args)[0];
      if (!key) return { output: [err("Usage: config tacacs passkey <secret>")] };
      state(ctx).globalKey = key;
      return { output: [muted("TACACS+ global passkey configured")] };
    },
  },
  {
    path: ["tacacs", "timeout"],
    summary: "Set the global TACACS+ timeout (1-60)",
    run(args, ctx): CommandResult {
      const raw = positional(args)[0];
      const t = parseRange(raw, "timeout", TIMEOUT);
      if (raw === undefined) return { output: [err("Usage: config tacacs timeout <1-60>")] };
      if (t.error) return { output: [err(`config tacacs timeout: ${t.error}`)] };
      state(ctx).timeout = t.value;
      return { output: [muted(`TACACS+ global timeout set to ${t.value}`)] };
    },
  },
];

function renderTacacs(ctx: CommandContext): OutputLine[] {
  const st = peekFeatureState<TacacsState>(ctx.device, "tacacs");
  const out: OutputLine[] = [line("TACACS+ Global Configuration", "heading")];
  const hasGlobal = !!st && (st.authType !== undefined || st.timeout !== undefined || st.globalKey !== undefined);
  if (!hasGlobal) {
    out.push(muted("No TACACS+ global configuration found."));
  } else {
    if (st!.authType !== undefined) out.push(line(`Authentication Type : ${st!.authType.toUpperCase()}`));
    if (st!.timeout !== undefined) out.push(line(`Global Timeout : ${st!.timeout}`));
    if (st!.globalKey !== undefined) out.push(line("Key Configured : Yes"));
  }

  out.push(line("TACACS+ Servers", "heading"));
  if (!st || st.servers.length === 0) {
    out.push(muted("No TACACS+ servers configured."));
    return out;
  }
  out.push(line("HOST             AUTH-TYPE  KEY  PORT   PRIORITY  TIMEOUT  VRF"));
  for (const s of st.servers) {
    const type = (s.type ?? DEFAULTS.type).toUpperCase();
    const key = s.key ? "Yes" : "No";
    const port = s.port ?? DEFAULTS.port;
    const pri = s.priority ?? DEFAULTS.priority;
    const to = s.timeout ?? DEFAULTS.timeout;
    const vrf = (s.vrf ?? DEFAULTS.vrf).toUpperCase();
    out.push(
      line(
        `${s.ip.padEnd(16)} ${type.padEnd(9)}  ${key.padEnd(3)}  ${String(port).padEnd(5)}  ${String(pri).padEnd(8)}  ${String(to).padEnd(7)}  ${vrf}`,
      ),
    );
  }
  return out;
}

const show: SonicCmd[] = [
  {
    path: ["tacacs"],
    summary: "Show TACACS+ global settings and configured servers",
    run: (_a, ctx) => ({ output: renderTacacs(ctx) }),
  },
];

export const tacacsModule: SonicFeatureModule = { id: "tacacs", config, show };
