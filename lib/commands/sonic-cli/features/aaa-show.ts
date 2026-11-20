/**
 * KLISH `show` for the AAA / port-access-control family (enable-view):
 *
 *   show tacacs-server [global | host [<addr>]]   tacacs.xml:21-33
 *       actioner sonic_cli_tacacs.py (4.5: get_sonic_tacacs_all / _global / _server),
 *       templates show_tacacs_global.j2 + show_tacacs_server.j2
 *   show radius-server                            radius.xml:23-26
 *       sonic_cli_radius.py get_sonic_radius → show_radius_global.j2, show_radius_server.j2,
 *       show_radius_statistics.j2 (only when `radius-server statistics enable`)
 *   show radius-server dynamic-author statistics [client all|<addr>]   das.xml:47-54
 *   show authentication | interface all|<if> | clients all|<if> |
 *        authentication-history all|<if> | rest | telemetry         authmgr.xml:35-93, authentication.xml:12-19
 *   show dot1x | dot1x detail all|<if>             authmgr.xml:103-114
 *   show mab | mab interface <if>                  authmgr.xml:94-102
 *
 * Templates: sonic-mgmt-framework 4.5 CLI render-templates (show_authmgr_*.j2,
 * show_dot1x*.j2, show_mab*.j2, show_client_auth_*.j2).
 *
 * Live state: TACACS+/RADIUS servers + globals from the Click config modules
 * (feature state "tacacs" / "radius"); dot1x / MAB / authentication-manager config
 * is what the KLISH config-plane store accepted (cp_running lines — `dot1x
 * system-auth-control`, `mab request format ...`, `authentication monitor`, and the
 * per-interface `dot1x ...` / `mab ...` / `authentication ...` lines). No 802.1X
 * supplicant exists in a lab, so client / history tables are empty, exactly as the
 * actioner prints nothing when PAC has no clients (sonic_cli_authmgr.py:778-806).
 */
import { CommandContext, OutputLine } from "../../types";
import { registerModal } from "../registry";
import { peekFeatureState } from "../../../models/feature-state";
import { cpRunningLines } from "../config-plane";
import { ifArg, incomplete, lines, natCmp } from "./klish-show-util";

// ----------------------------------------------------------------- TACACS+

interface TacacsServer { ip: string; key?: string; priority?: number; type?: string; timeout?: number; port?: number; vrf?: string }
interface TacacsState { servers: TacacsServer[]; globalKey?: string; authType?: string; timeout?: number }

function tacacsGlobal(ctx: CommandContext): string[] {
  const st = peekFeatureState<TacacsState>(ctx.device, "tacacs");
  // The template body is guarded by `{% if json_output %}`: an absent TACPLUS|global row prints nothing.
  if (!st || (st.authType === undefined && st.timeout === undefined && st.globalKey === undefined)) return [];
  const out = ["-".repeat(57), "TACACS Global Configuration", "-".repeat(57), ""];
  if (st.timeout !== undefined) out.push(`timeout           : ${st.timeout}`);
  if (st.authType !== undefined) out.push(`auth-type         : ${st.authType}`);
  out.push(`key configured    : ${st.globalKey !== undefined ? "Yes" : "No"}`);
  return out;
}

function tacacsServers(ctx: CommandContext, addr?: string): string[] {
  const st = peekFeatureState<TacacsState>(ctx.device, "tacacs");
  const list = (st?.servers ?? []).filter((s) => !addr || s.ip === addr);
  const out = [""];
  if (!list.length) return out;
  // 4.5 extract_server_data: per-server defaults fall back to the global auth-type/timeout.
  const defType = st?.authType ?? "pap";
  const defTimeout = st?.timeout ?? 5;
  const f = (s: string | number, w: number) => String(s).padEnd(w);
  out.push("-".repeat(96), `${f("HOST", 20)} ${f("AUTH-TYPE", 15)} ${f("KEY-CONFIG", 12)} ${f("PORT", 10)} ${f("PRIORITY", 10)} ${f("TIMEOUT", 10)} ${f("VRF", 10)}`, "-".repeat(96), "");
  for (const s of list) {
    // show_tacacs_server.j2 tests `"key" in server`; extract_server_data always sets that key
    // (None when unset), so the real 4.5 CLI prints KEY-CONFIG "Yes" for every server.
    out.push("", "", `${f(s.ip, 20)} ${f(s.type ?? defType, 15)} ${f("Yes", 12)} ${f(s.port ?? 49, 10)} ${f(s.priority ?? 1, 10)} ${f(s.timeout ?? defTimeout, 10)} ${f(s.vrf ?? "default", 10)}`);
  }
  out.push("");
  return out;
}

// ----------------------------------------------------------------- RADIUS

interface RadiusServer { ip: string; key?: string; authType?: string; authPort?: number; priority?: number; timeout?: number; retransmit?: number; sourceInterface?: string; vrf?: string }
interface RadiusState { servers: RadiusServer[]; global: Record<string, string> }

function radiusShow(ctx: CommandContext): string[] {
  const st = peekFeatureState<RadiusState>(ctx.device, "radius");
  const g = st?.global ?? {};
  const out: string[] = [];
  // get_sonic_radius_global prints only when the server-group / radius config is non-empty.
  if (Object.keys(g).length) {
    out.push("-".repeat(57), "RADIUS Global Configuration", "-".repeat(57), "");
    if (g["nas-ip"]) out.push(`nas-ip-addr    : ${g["nas-ip"]}`);
    if (g.statistics === "enable") out.push("statistics     : True");
    if (g.timeout) out.push(`timeout        : ${g.timeout}`);
    if (g["auth-type"]) out.push(`auth-type      : ${g["auth-type"]}`);
    out.push(`key configured : ${g.key ? "Yes" : "No"}`);
    if (g.retransmit && g.retransmit !== "0") out.push(`retransmit     : ${g.retransmit}`);
  }
  const servers = st?.servers ?? [];
  if (!servers.length) return out;
  const f = (s: string | number | undefined, w: number) => String(s ?? "-").padEnd(w);
  out.push(
    "-".repeat(198),
    `${f("HOST", 66)}${f("AUTH-TYPE", 10)}${f("KEY-CONFIG", 11)}${f("AUTH-PORT", 10)}${f("PRIORITY", 9)}${f("TIMEOUT", 8)}${f("RTSMT", 6)}${f("VRF", 17)}${f("SI", 16)}${f("PROTOCOL", 10)}${f("SEC_PROFILE", 20)}${f("REQ-MSG-AUTH", 10)}`,
    "-".repeat(198),
  );
  for (const s of servers) {
    // key defaults to "-" (sonic_cli_radius.py), and the template only tests != "" → always "Yes".
    out.push(`${f(s.ip, 65)} ${f(s.authType, 9)} ${f("Yes", 10)} ${f(s.authPort, 9)} ${f(s.priority, 8)} ${f(s.timeout, 7)} ${f(s.retransmit, 5)} ${f(s.vrf, 16)} ${f(s.sourceInterface, 15)} ${f("UDP", 9)} ${f("-", 19)} ${f("False", 10)}`);
  }
  if (g.statistics === "enable") {
    // No RADIUS exchange happens in a lab: servers have no state/counters, so only the banner prints.
    out.push("-".repeat(57), "RADIUS Statistics", "-".repeat(57));
  }
  return out;
}

// ------------------------------------------------- dot1x / MAB / authmgr (config-plane lines)

/** cp_running lines for one mode context ("config" or an interface name). */
const cpLines = (ctx: CommandContext, where: string) => cpRunningLines(ctx.device).filter((l) => l.ctx === where).map((l) => l.line);

/** Interfaces that carry any line starting with one of `prefixes`. */
function ifacesWith(ctx: CommandContext, prefixes: string[]): string[] {
  const set = new Set<string>();
  for (const l of cpRunningLines(ctx.device)) {
    if (l.ctx !== "config" && /^(Ethernet|Eth)/.test(l.ctx) && prefixes.some((p) => l.line === p || l.line.startsWith(p + " "))) set.add(l.ctx);
  }
  return [...set].sort(natCmp);
}

/** Value after `prefix` on the last matching line of an interface (e.g. "dot1x timeout quiet-period"). */
function ifVal(ctx: CommandContext, ifname: string, prefix: string): string | undefined {
  const hit = cpLines(ctx, ifname).filter((l) => l.startsWith(prefix + " ")).pop();
  return hit?.slice(prefix.length + 1).trim().split(/\s+/)[0];
}

/** `all` or one interface (`Ethernet 0` / `Ethernet0`) → list of ports, or undefined if no argument. */
function portSel(ctx: CommandContext, args: string[], i: number, configured: () => string[]): string[] | undefined {
  if (args[i]?.toLowerCase() === "all") return configured();
  const p = ifArg(args, i);
  return p ? [p.name] : undefined;
}

function dot1xGlobal(ctx: CommandContext): string[] {
  const on = cpLines(ctx, "config").includes("dot1x system-auth-control");
  return [" ", `Administrative Mode............... ${on ? "Enabled" : "Disabled"}`, " "];
}

function dot1xDetail(ctx: CommandContext, ports: string[]): string[] {
  const out: string[] = [];
  for (const p of ports) {
    out.push(
      " ",
      `Interface ..................................... ${p}`,
      `PAE Capabilities .............................. ${ifVal(ctx, p, "dot1x pae") ?? "none"}`,
      `Server Timeout(secs) .......................... ${ifVal(ctx, p, "dot1x timeout server-timeout") ?? 30}`,
      `Quiet Period(secs)............................. ${ifVal(ctx, p, "dot1x timeout quiet-period") ?? 60}`,
      `Transmit Period(secs).......................... ${ifVal(ctx, p, "dot1x timeout tx-period") ?? 30}`,
      `Maximum Requests............................... ${ifVal(ctx, p, "dot1x max-req") ?? 2}`,
    );
  }
  return out;
}

function mabGlobal(ctx: CommandContext): string[] {
  // `mab request format attribute 1 groupsize <n> separator <sep> <case>`; sonic-mab.yang defaults 2 / ":" / uppercase.
  const l = cpLines(ctx, "config").filter((x) => x.startsWith("mab request format attribute 1")).pop()?.split(/\s+/) ?? [];
  const after = (k: string) => (l.indexOf(k) >= 0 ? l[l.indexOf(k) + 1] : undefined);
  const size = after("groupsize") ?? "2";
  const sep = after("separator") ?? ":";
  const cs = l.find((t) => /^(upper|lower)case$/i.test(t))?.toLowerCase() ?? "uppercase";
  const kind = sep.includes("-") ? "ietf" : sep.includes(":") ? "legacy" : "dot";
  return [
    " ",
    `MAB Request Fmt Attr1 Groupsize ........................... ${size}`,
    `MAB Request Fmt Attr1 Separator............................ ${kind}(${sep})`,
    `MAB Request Fmt Attr1 Case................................. ${cs}`,
    " ",
  ];
}

function mabPorts(ctx: CommandContext, ports: string[]): string[] {
  const out: string[] = [];
  for (const p of ports) {
    const on = cpLines(ctx, p).some((l) => l === "mab" || l.startsWith("mab auth-type"));
    const type = (ifVal(ctx, p, "mab auth-type") ?? "eap-md5").toUpperCase().replace("-", "_");
    out.push(
      " ",
      `Interface  ..................................... ${p}`,
      `Admin mode ..................................... ${on ? "Enabled" : "Disabled"}`,
      `mab_auth_type .................................. ${type}`,
      `Server Timeout(secs) ........................... ${ifVal(ctx, p, "mab timeout server-timeout") ?? 30}`,
    );
  }
  return out;
}

function authGlobal(ctx: CommandContext): string[] {
  const monitor = cpLines(ctx, "config").includes("authentication monitor");
  return [
    "-".repeat(57),
    "PAC Global configuration",
    "-".repeat(57),
    `Authentication Monitor Mode .................... ${monitor ? "Enabled" : "Disabled"}`,
    "-".repeat(57),
    "Number of PAC Clients",
    "-".repeat(57),
    "Number of Authenticated clients ................ 0",
    "Number of clients in Monitor mode .............. 0",
    " ",
  ];
}

/** show_authmgr_interface_id.j2 (4.5) — PAC port defaults where the port has no explicit setting. */
function authIfaces(ctx: CommandContext, ports: string[]): string[] {
  const out: string[] = [];
  for (const p of ports) {
    const has = (s: string) => cpLines(ctx, p).includes(s);
    const order = ifLine(ctx, p, "authentication order") ?? "dot1x mab";
    const prio = ifLine(ctx, p, "authentication priority") ?? "dot1x mab";
    out.push(
      " ",
      `Interface ..................................... ${p}`,
      `Port Control Mode.............................. ${ifVal(ctx, p, "authentication port-control") ?? "force-authorized"}`,
      `Host Mode...................................... ${ifVal(ctx, p, "authentication host-mode") ?? "multi-host"}`,
      `Open Authentication............................ ${has("authentication open") ? "Enabled" : "Disabled"}`,
      `Configured method order........................ ${order}`,
      "Enabled method order........................... undefined undefined",
      `Configured method priority..................... ${prio}`,
      "Enabled method priority........................ undefined undefined",
      `Reauthentication Enabled....................... ${has("authentication periodic") ? "TRUE" : "FALSE"}`,
      `Reauthentication Session timeout from server .. ${has("authentication timer reauthenticate server") ? "TRUE" : "FALSE"}`,
      `Reauthentication Period (secs)................. ${ifVal(ctx, p, "authentication timer reauthenticate") ?? 3600}`,
      `Maximum Users.................................. ${ifVal(ctx, p, "authentication max-users") ?? 16}`,
      `Guest VLAN ID.................................. ${ifVal(ctx, p, "authentication event no-response action authorize vlan") ?? 0}`,
      `Allow VLAN ID(WoL)............................. ${ifVal(ctx, p, "authentication allow vlan") ?? 0}`,
      `Unauthenticated VLAN ID........................ ${ifVal(ctx, p, "authentication event fail action authorize vlan") ?? 0}`,
      `Authentication retry attempts.................. ${ifVal(ctx, p, "authentication event fail retry") ?? 3}`,
    );
  }
  return out;
}

/** Whole remainder after `prefix` on the last matching interface line. */
function ifLine(ctx: CommandContext, ifname: string, prefix: string): string | undefined {
  return cpLines(ctx, ifname).filter((l) => l.startsWith(prefix + " ")).pop()?.slice(prefix.length + 1).trim();
}

const PAC_PREFIXES = ["authentication", "dot1x", "mab"];

registerModal({
  id: "aaa-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx }) {
    const a = args.map((x) => x.toLowerCase());
    const out = (rows: string[]): { output: OutputLine[] } => lines(rows);

    if (a[0] === "tacacs-server") {
      if (a[1] === undefined) return out([...tacacsGlobal(ctx), ...tacacsServers(ctx)]);
      if (a[1] === "global" && a.length === 2) return out(tacacsGlobal(ctx));
      if (a[1] === "host" && a.length <= 3) return out(tacacsServers(ctx, args[2]));
      return null;
    }

    if (a[0] === "radius-server") {
      if (a[1] === undefined) return out(radiusShow(ctx));
      // das.xml:47-54 — no Dynamic Authorization client ever talks to a lab switch: no rows.
      if (a[1] === "dynamic-author" && a[2] === "statistics") return { output: [] };
      return null;
    }

    if (a[0] === "dot1x") {
      if (a[1] === undefined) return out(dot1xGlobal(ctx));
      if (a[1] === "detail") {
        const ports = portSel(ctx, args, 2, () => ifacesWith(ctx, ["dot1x"]));
        return ports ? out(dot1xDetail(ctx, ports)) : incomplete();
      }
      return null;
    }

    if (a[0] === "mab") {
      if (a[1] === undefined) return out([...mabGlobal(ctx), ...mabPorts(ctx, ifacesWith(ctx, ["mab"]))]);
      if (a[1] === "interface") {
        const p = ifArg(args, 2);
        return p ? out(mabPorts(ctx, [p.name])) : incomplete();
      }
      return null;
    }

    if (a[0] === "authentication") {
      if (a[1] === undefined) return out(authGlobal(ctx));
      if (a[1] === "rest" || a[1] === "telemetry") {
        // show_client_auth_{rest,telemetry}.j2: unset client_auth renders the default "password,jwt".
        const title = a[1] === "rest" ? "REST Client Authentication Modes" : "Telemetry Client Authentication Modes";
        const set = cpLines(ctx, "config").filter((l) => l.startsWith(`authentication ${a[1]} `)).pop();
        return out(["-".repeat(57), title, "-".repeat(57), `client_auth: ${set ? set.split(/\s+/).slice(2).join(",") : "password,jwt"}`]);
      }
      if (a[1] === "interface") {
        const ports = portSel(ctx, args, 2, () => ifacesWith(ctx, PAC_PREFIXES));
        return ports ? out(authIfaces(ctx, ports)) : incomplete();
      }
      if (a[1] === "clients" || a[1] === "authentication-history") {
        // No supplicants / MAB hosts in a lab: the actioner returns before rendering anything.
        return portSel(ctx, args, 2, () => []) ? { output: [] } : incomplete();
      }
      return null;
    }
    return null;
  },
});

