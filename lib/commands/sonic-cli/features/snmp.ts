/**
 * SNMP modal behaviour (KLISH, sonic-mgmt-framework CLI/clitree/cli-xml/snmp.xml +
 * actioner/sonic-cli-snmp.py + renderer/templates/show_snmp*.j2).
 *
 * configure-view:
 *   snmp-server location|contact <text>       -> config snmp location|contact add (Click)
 *   snmp-server community <name> ro|rw [group <g>]   (snmp.xml:414-438; type is mandatory)
 *   snmp-server user <name> ...               -> config snmp user add <name>
 *   snmp-server host <ip> [port N] [version v2c|v3] [community C] [user U] [source-interface I]
 *   snmp-server agentaddress <ip> [port N] [interface <vrf>]
 *   snmp-server enable traps | enable authen-traps   (SNMP|TRAPS traps_enabled / authen_traps)
 *   and their `no` forms.
 * Every write is applied by snmp_post_xfmr's debounced snmp service restart
 * (xfmr_snmp.go:770-842), modelled by requestSnmpRestart(…, "klish"). KLISH config
 * commands are silent on success, so only errors are shown.
 *
 * enable-view:
 *   show snmp-server [community|host|agentaddress|traps], show snmp counters,
 *   show running-configuration snmp.
 * Group/engine/view and the per-interface `snmp trap` are not modelled (grammar fallback).
 */
import { CommandContext, OutputLine, err, line } from "../../types";
import { registerModal } from "../registry";
import { SnmpState, TrapHost, peekAgent, peekSnmpConfig, requestSnmpRestart, snmpConfig } from "../../../protocols/snmp-config";

const isIpv4 = (s: string | undefined) => !!s && /^(\d{1,3}\.){3}\d{1,3}$/.test(s);

/** Value after a keyword in the token list (KLISH optional `keyword value` params). */
function kw(args: string[], key: string): string | undefined {
  const i = args.findIndex((a) => a.toLowerCase() === key);
  return i >= 0 ? args[i + 1] : undefined;
}

const errorsOnly = (out: OutputLine[]) => out.filter((o) => o.kind === "error");

function applied(ctx: CommandContext, out: OutputLine[] = []): { output: OutputLine[] } {
  requestSnmpRestart(ctx.device, "klish");
  return { output: out };
}

registerModal({
  id: "snmp",
  views: ["configure-view"],
  keywords: ["snmp-server"],
  run({ ctx, isNo, args, delegate }) {
    const sub = args[0]?.toLowerCase();
    const rest = args.slice(1);

    if (sub === "location" || sub === "contact") {
      if (isNo) return applied(ctx, errorsOnly(delegate(`config snmp ${sub} del`)));
      const text = rest.join(" ").trim();
      if (!text) return { output: [err(`% SNMP ${sub} text required.`)] };
      return applied(ctx, errorsOnly(delegate(`config snmp ${sub} add ${text}`)));
    }

    if (sub === "community") {
      const name = rest[0];
      if (!name) return { output: [err("% SNMP community name required.")] };
      if (isNo) return applied(ctx, errorsOnly(delegate(`config snmp community del ${name}`)));
      const type = rest[1]?.toLowerCase();
      // snmp.xml:416 — the ro|rw switch is not optional.
      if (type !== "ro" && type !== "rw") return { output: [err("% Community access type required: snmp-server community <name> ro|rw [group <group-name>]")] };
      // The optional `group <g>` VACM binding is not modelled; the community keeps its RO/RW type.
      return applied(ctx, errorsOnly(delegate(`config snmp community add ${name} ${type}`)));
    }

    if (sub === "user") {
      const name = rest[0];
      if (!name) return { output: [err("% SNMP user name required.")] };
      // group/auth/priv parameters are not modelled; the user is still created.
      return applied(ctx, errorsOnly(delegate(`config snmp user ${isNo ? "del" : "add"} ${name}`)));
    }

    if (sub === "host") {
      const ip = rest[0];
      if (!isIpv4(ip)) return { output: [err("% Trap destination IP address required.")] };
      const port = Number(kw(rest, "port") ?? "162");
      const st = snmpConfig(ctx.device);
      const hosts = st.trapHosts ?? [];
      if (isNo) {
        if (!hosts.some((h) => h.ip === ip && h.port === port)) return { output: [line(`%Error: Host '${ip}' port ${port} not found`)] };
        st.trapHosts = hosts.filter((h) => !(h.ip === ip && h.port === port));
        return applied(ctx);
      }
      const version = kw(rest, "version");
      if (version !== undefined && version !== "v2c" && version !== "v3") return { output: [err(`% Invalid version "${version}" (v2c or v3).`)] };
      const h: TrapHost = { ip: ip!, port };
      if (version) h.version = version as TrapHost["version"];
      const community = kw(rest, "community");
      const user = kw(rest, "user");
      const src = kw(rest, "source-interface");
      if (community) h.community = community;
      if (user) h.user = user;
      if (src) h.sourceInterface = src;
      st.trapHosts = [...hosts.filter((x) => !(x.ip === ip && x.port === port)), h];
      return applied(ctx);
    }

    if (sub === "agentaddress") {
      const ip = rest[0];
      if (!isIpv4(ip)) return { output: [err("% Agent listening IP address required.")] };
      const port = kw(rest, "port") ?? "161";
      const vrfIn = kw(rest, "interface") ?? "default";
      const vrf = vrfIn === "default" ? "" : vrfIn;
      const st = snmpConfig(ctx.device);
      const list = st.agentAddresses ?? [];
      const same = (a: { ip: string; port: string; vrf: string }) => a.ip === ip && a.port === port && a.vrf === vrf;
      if (isNo) {
        if (!list.some(same)) return { output: [line(`%Error: Agent address '${ip}' port ${port} vrf '${vrfIn}' not found`)] };
        st.agentAddresses = list.filter((a) => !same(a));
        return applied(ctx);
      }
      // xfmr_snmp.go:1114-1126 — reject an address the device does not own.
      const local = ip === "0.0.0.0" || ctx.device.interfaces.some((i) => i.ipv4.some((a) => a.address === ip));
      if (!local) return { output: [line(`%Error: agent-address is not a local interface IP: ${ip}`)] };
      st.agentAddresses = [...list.filter((a) => !same(a)), { ip: ip!, port, vrf }];
      return applied(ctx);
    }

    if (sub === "enable") {
      const what = rest[0]?.toLowerCase();
      const st = snmpConfig(ctx.device);
      if (what === "traps") st.trapsEnabled = !isNo;
      else if (what === "authen-traps") st.authenTraps = !isNo;
      else return null;
      return applied(ctx);
    }

    // engine-id / group / view and bare "snmp-server": grammar fallback.
    return null;
  },
});

// --------------------------------------------------------------------------- show

const pad = (s: string | number, n: number) => String(s).padEnd(n);

function engineId(ctx: CommandContext): string {
  const mgmt = ctx.device.interfaces.find((i) => i.management) ?? ctx.device.interfaces[0];
  return mgmt ? `80:00:01:37:03:${mgmt.mac.toLowerCase()}` : "Auto-generated";
}

function showGlobal(ctx: CommandContext, st: SnmpState | undefined): OutputLine[] {
  // show_snmp.j2
  const out = [line(`${pad("EngineID", 11)}: ${engineId(ctx)}`)];
  if (st?.contact) out.push(line(`${pad("Contact", 11)}: ${st.contact}`));
  if (st?.location) out.push(line(`${pad("Location", 11)}: ${st.location}`));
  return out;
}

function showCommunity(st: SnmpState | undefined): OutputLine[] {
  // show_snmp_community.j2 (sorted by name, sonic-cli-snmp.py:274)
  const list = [...(st?.communities ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (!list.length) return [line("No SNMP communities configured")];
  return [
    line("Community Name                    Type"),
    line("-------------------------------- ------"),
    ...list.map((c) => line(`${pad(c.name, 32)} ${pad(c.access, 6)}`)),
  ];
}

const hostName = (h: TrapHost) => `${h.ip}_${h.port}`; // target name (sonic-cli-snmp.py:841)
const sortedHosts = (st: SnmpState | undefined) => [...(st?.trapHosts ?? [])].sort((a, b) => (hostName(a) < hostName(b) ? -1 : 1));

function showHost(st: SnmpState | undefined): OutputLine[] {
  // show_snmp_host.j2
  const hosts = sortedHosts(st);
  if (!hosts.length) return [line("No SNMP trap hosts configured")];
  return [
    line("Host Name                         Host IP          Port   Source Interface"),
    line("-------------------------------- ---------------- ------ ----------------"),
    ...hosts.map((h) => line(`${pad(hostName(h), 32)} ${pad(h.ip, 16)} ${pad(h.port, 6)} ${h.sourceInterface || "-"}`)),
  ];
}

function showAgentAddress(st: SnmpState | undefined): OutputLine[] {
  // show_snmp_agentaddress.j2 (sorted by ip, sonic-cli-snmp.py:346)
  const list = [...(st?.agentAddresses ?? [])].sort((a, b) => (a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0));
  if (!list.length) return [line("No SNMP agent addresses configured")];
  return [
    line("Listen IP       Listen Port  Listen VRF"),
    line("--------------- ------------ ------------"),
    ...list.map((a) => line(`${pad(a.ip, 15)} ${pad(a.port || "161", 12)} ${pad(a.vrf && a.vrf !== "default" ? a.vrf : "", 12)}`)),
  ];
}

function showTraps(st: SnmpState | undefined): OutputLine[] {
  // show_snmp_traps.j2: an absent `enabled` leaf renders as Yes.
  const out = [
    line(`Traps Enabled  : ${st?.trapsEnabled === false ? "No" : "Yes"}`),
    line(`Authen Traps   : ${st?.authenTraps ? "Yes" : "No"}`),
    line(""),
  ];
  const hosts = st?.trapHosts ?? [];
  if (!hosts.length) return [...out, line("No trap hosts configured")];
  return [
    ...out,
    line("Trap Hosts:"),
    line("Host Name                         Host IP          Port"),
    line("-------------------------------- ---------------- ------"),
    ...hosts.map((h) => line(`${pad(hostName(h), 32)} ${pad(h.ip, 16)} ${h.port}`)),
  ];
}

function showCounters(ctx: CommandContext): OutputLine[] {
  const rt = peekAgent(ctx.device);
  if (!rt) return [line("%Error: SNMP counters not available (the SNMP service is not running or has not published statistics yet)")];
  const c = (k: string) => rt.stats[k] ?? 0;
  // show_snmp_counters.j2
  return [
    "    SNMP Counters",
    "    =============================================================",
    `    ${c("snmpInPkts")} SNMP packets input`,
    `    ${c("snmpInBadVersions")} Bad SNMP version errors`,
    `    ${c("snmpInBadCommunityNames")} Unknown community name`,
    `    ${c("snmpInBadCommunityUses")} Illegal operation for community name supplied`,
    `    ${c("snmpInASNParseErrs")} Encoding errors`,
    `    ${c("snmpInTotalReqVars")} Number of requested variables`,
    `    ${c("snmpInTotalSetVars")} Number of altered variables`,
    `    ${c("snmpInGetRequests")} Get-request PDUs`,
    `    ${c("snmpInGetNexts")} Get-next PDUs`,
    `    ${c("snmpInSetRequests")} Set-request PDUs`,
    `    ${c("snmpOutPkts")} SNMP packets output`,
    `    ${c("snmpInTooBigs")} Too big errors`,
    `    ${c("snmpInNoSuchNames")} No such name errors`,
    `    ${c("snmpInBadValues")} Bad values errors`,
    `    ${c("snmpInGenErrs")} General errors`,
    `    ${c("snmpOutGetResponses")} Response PDUs`,
    `    ${c("snmpOutTraps")} Trap PDUs`,
  ].map((t) => line(t));
}

const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

function showRunning(st: SnmpState | undefined): OutputLine[] {
  // Command order of the snmp.xml:308-337 DOCGEN example.
  const out = ["!"];
  if (st?.contact) out.push(`snmp-server contact ${q(st.contact)}`);
  if (st?.location) out.push(`snmp-server location ${q(st.location)}`);
  for (const c of st?.communities ?? []) out.push(`snmp-server community ${c.name} ${c.access.toLowerCase()}`);
  for (const u of st?.users ?? []) out.push(`snmp-server user ${u.name}`);
  for (const a of st?.agentAddresses ?? []) out.push(`snmp-server agentaddress ${a.ip}${a.port && a.port !== "161" ? ` port ${a.port}` : ""}${a.vrf ? ` interface ${a.vrf}` : ""}`);
  if (st?.trapsEnabled) out.push("snmp-server enable traps");
  if (st?.authenTraps) out.push("snmp-server enable authen-traps");
  for (const h of st?.trapHosts ?? []) {
    out.push(
      `snmp-server host ${h.ip} port ${h.port}${h.version ? ` version ${h.version}` : ""}${h.community ? ` community ${h.community}` : ""}${h.user ? ` user ${h.user}` : ""}${h.sourceInterface ? ` source-interface ${h.sourceInterface}` : ""}`,
    );
  }
  out.push("!");
  return out.map((t) => line(t));
}

registerModal({
  id: "snmp-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ ctx, args }) {
    const a = args.map((x) => x.toLowerCase());
    const st = peekSnmpConfig(ctx.device);
    if (a[0] === "snmp-server") {
      switch (a[1]) {
        case undefined:
          return { output: showGlobal(ctx, st) };
        case "community":
          return { output: showCommunity(st) };
        case "host":
          return { output: showHost(st) };
        case "agentaddress":
          return { output: showAgentAddress(st) };
        case "traps":
          return { output: showTraps(st) };
        default:
          return null;
      }
    }
    if (a[0] === "snmp" && a[1] === "counters") return { output: showCounters(ctx) };
    if ((a[0] === "running-configuration" || a[0] === "running-config") && a[1] === "snmp") return { output: showRunning(st) };
    return null;
  },
});
