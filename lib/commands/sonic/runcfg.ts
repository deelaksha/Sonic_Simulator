/**
 * Click `show runningconfiguration ...` / `show startupconfiguration ...`
 * (sonic-utilities show/main.py:1735-2101, click 7.0, AliasedGroup: unique prefixes resolve).
 *
 *   runningconfiguration            group usage (no invoke_without_command)
 *     all                           sonic-cfggen -d --print-data (as `config save` writes it), plus "bgpraw" = vtysh `show running-config`
 *     acl                           sonic-cfggen -d --var-json ACL_RULE
 *     bgp                           vtysh -c "show running-config bgp"
 *     copp                          --var-json COPP_GROUP, COPP_TRAP
 *     interfaces [<ifname>]         --var-json INTERFACE [--key <ifname>]
 *     ntp                           "server" lines of /etc/chrony/chrony.conf (rendered from NTP_SERVER)
 *     ports [<port>]                --var-json PORT [--key <port>]
 *     snmp ...                      owned by ./snmp.ts (dispatched to it for abbreviations)
 *     spanning-tree                 --var-json STP, STP_PORT, STP_VLAN, STP_VLAN_PORT
 *     syslog                        omfwd targets of /etc/rsyslog.conf (rendered from SYSLOG_SERVER)
 *   startupconfiguration            group usage
 *     bgp                           "Routing-Stack is: frr" + `cat /etc/frr/bgpd.conf`
 *
 * Every JSON view is the live CONFIG_DB projection (lib/sonicdb/config-db.ts). A table that is
 * not in CONFIG_DB prints nothing, as sonic-cfggen does (`args.var_json in data` is false); the
 * simulator projects no STP tables, so spanning-tree is empty.
 */
import { CommandContext, CommandResult, OutputLine, line, err } from "../types";
import { SonicCmd, SonicFeatureModule, clickGroupUsage, matchSonic, positional } from "./types";
import { Device } from "../../models/device";
import { DEFAULT_VRF } from "../../models/vrf";
import { Route } from "../../models/route";
import { inactiveStatics } from "../../models/static-routes";
import { BgpConfig, BgpNbrAf, BgpNeighbor, afConfig } from "../../protocols/bgp";
import { configDbJson } from "../../sonicdb/project";
import { Row, Tables } from "../../sonicdb/schema";
import { isSonicDevice, projectConfigDb } from "../../sonicdb/config-db";
import { savedFile } from "../../sonicdb/persist";
import { cpList } from "../sonic-cli/config-plane";
import { natCompare, tabulateSimple } from "./arpnd";
import { snmpModule } from "./snmp";

const lines = (text: string[]): OutputLine[] => text.map((t) => line(t));
const notSonic = (): CommandResult => ({ output: [err("Error: CONFIG_DB is only available on SONiC switches")] });

// --- sonic-cfggen -d --var-json TABLE [--key K] --------------------------------

/** natsorted keys (sonic-cfggen sort_data), json.dumps indent 4. */
function varJson(t: Tables, table: string, key?: string): string[] {
  const rows = t[table];
  if (!rows) return [];
  let out: Record<string, Row> = {};
  const keys = Object.keys(rows).sort(natCompare);
  if (key === undefined) {
    for (const k of keys) out[k] = rows[k];
  } else {
    // FormatConverter.to_serialized(data, lookup_key): the FIRST key equal to it, or a
    // tuple key ("Ethernet0|10.0.0.1/31") containing it; nothing matched prints {}.
    const k = keys.find((x) => x === key || x.split("|").includes(key));
    out = k === undefined ? {} : { [k]: rows[k] };
  }
  return JSON.stringify(out, null, 4).split("\n");
}

function cfggen(tables: string[], keyed = false): SonicCmd["run"] {
  return (args, ctx) => {
    if (!isSonicDevice(ctx.device)) return notSonic();
    const t = projectConfigDb(ctx.device);
    const key = keyed ? positional(args)[0] : undefined;
    return { output: lines(tables.flatMap((tb) => varJson(t, tb, key))) };
  };
}

// --- FRR (vtysh) configuration text --------------------------------------------

/** BGP instances of a feature store (device.config.features or a `config save` snapshot). */
function bgpInstances(features: Record<string, unknown>): [string, BgpConfig][] {
  const out: [string, BgpConfig][] = [];
  const def = features.bgp as BgpConfig | undefined;
  if (def?.localAs !== undefined) out.push([DEFAULT_VRF, def]);
  const vrfs = (features.bgpvrf as { vrfs?: Record<string, BgpConfig> } | undefined)?.vrfs ?? {};
  for (const v of Object.keys(vrfs).sort(natCompare)) if (vrfs[v].localAs !== undefined) out.push([v, vrfs[v]]);
  return out;
}

function nbrGlobal(nb: BgpNeighbor): string[] {
  const p = ` neighbor ${nb.peer}`;
  const out: string[] = [];
  if (nb.remoteAs !== undefined) out.push(`${p} remote-as ${nb.remoteAs}`);
  if (nb.description) out.push(`${p} description ${nb.description}`);
  if (nb.shutdown) out.push(`${p} shutdown`);
  if (nb.bfd) out.push(`${p} bfd`);
  if (nb.ebgpMultihop !== undefined) out.push(nb.ebgpMultihop ? `${p} ebgp-multihop ${nb.ebgpMultihop}` : `${p} ebgp-multihop`);
  if (nb.updateSource) out.push(`${p} update-source ${nb.updateSource}`);
  if (nb.keepalive !== undefined && nb.holdtime !== undefined) out.push(`${p} timers ${nb.keepalive} ${nb.holdtime}`);
  if (nb.connectRetry !== undefined) out.push(`${p} timers connect ${nb.connectRetry}`);
  return out;
}

function nbrAf(peer: string, a: BgpNbrAf | undefined, activate: boolean): string[] {
  const p = `  neighbor ${peer}`;
  const out: string[] = [];
  if (activate) out.push(`${p} activate`);
  if (a?.softReconfig) out.push(`${p} soft-reconfiguration inbound`);
  if (a?.weight !== undefined) out.push(`${p} weight ${a.weight}`);
  if (a?.prefixListIn) out.push(`${p} prefix-list ${a.prefixListIn} in`);
  if (a?.prefixListOut) out.push(`${p} prefix-list ${a.prefixListOut} out`);
  if (a?.filterListIn) out.push(`${p} filter-list ${a.filterListIn} in`);
  if (a?.filterListOut) out.push(`${p} filter-list ${a.filterListOut} out`);
  if (a?.routeMapIn) out.push(`${p} route-map ${a.routeMapIn} in`);
  if (a?.routeMapOut) out.push(`${p} route-map ${a.routeMapOut} out`);
  return out;
}

/** FRR bgp_config_write: one `router bgp` block (ipv4 unicast is activated by default). */
function frrBgpBlock(vrf: string, c: BgpConfig): string[] {
  const out = [`router bgp ${c.localAs}${vrf === DEFAULT_VRF ? "" : ` vrf ${vrf}`}`];
  if (c.routerId) out.push(` bgp router-id ${c.routerId}`);
  if (c.multipathRelax) out.push(" bgp bestpath as-path multipath-relax");
  if (c.keepalive !== undefined && c.holdtime !== undefined) out.push(` timers bgp ${c.keepalive} ${c.holdtime}`);
  const nbrs = c.neighbors ?? [];
  for (const nb of nbrs) out.push(...nbrGlobal(nb));
  const af = (name: string, body: string[]) => (body.length ? [" !", ` address-family ${name}`, ...body, " exit-address-family"] : []);
  for (const fam of ["ipv4", "ipv6"] as const) {
    if (fam === "ipv6" && !c.ipv6 && !nbrs.some((n) => n.ipv6)) continue;
    const a = afConfig(c, fam);
    const body = (a.networks ?? []).map((n) => `  network ${n}`);
    for (const [proto, r] of Object.entries(a.redist ?? {})) {
      if (r) body.push(`  redistribute ${proto}${r.metric !== undefined ? ` metric ${r.metric}` : ""}${r.routeMap ? ` route-map ${r.routeMap}` : ""}`);
    }
    if (a.maxPaths !== undefined) body.push(`  maximum-paths ${a.maxPaths}`);
    if (a.maxPathsIbgp !== undefined) body.push(`  maximum-paths ibgp ${a.maxPathsIbgp}`);
    if (a.tableMap) body.push(`  table-map ${a.tableMap}`);
    for (const nb of nbrs) body.push(...nbrAf(nb.peer, nb.af?.[fam], fam === "ipv6" && !!nb.ipv6));
    out.push(...af(`${fam} unicast`, body));
  }
  const evpn = nbrs.filter((n) => n.evpn).map((n) => `  neighbor ${n.peer} activate`);
  if (c.advertiseAllVni) evpn.push("  advertise-all-vni");
  out.push(...af("l2vpn evpn", evpn));
  out.push("exit", "!");
  return out;
}

/** zebra/staticd `ip route` lines (default VRF first, then `vrf X ... exit-vrf`). */
function frrStatics(d: Device): string[] {
  const statics: Route[] = [...d.routingTable, ...inactiveStatics(d), ...d.routingTable6].filter((r) => r.type === "static" && r.nextHop);
  const byVrf = new Map<string, string[]>();
  for (const r of statics) {
    const v = r.vrf ?? DEFAULT_VRF;
    const l = `${r.destination.includes(":") ? "ipv6" : "ip"} route ${r.destination}/${r.prefix} ${r.nextHop}`;
    const arr = byVrf.get(v) ?? [];
    if (!arr.includes(l)) arr.push(l);
    byVrf.set(v, arr);
  }
  const out: string[] = [];
  for (const v of [...byVrf.keys()].sort((a, b) => (a === DEFAULT_VRF ? -1 : b === DEFAULT_VRF ? 1 : natCompare(a, b)))) {
    if (v === DEFAULT_VRF) out.push(...byVrf.get(v)!, "!");
    else out.push(`vrf ${v}`, ...byVrf.get(v)!.map((l) => ` ${l}`), "exit-vrf", "!");
  }
  return out;
}

const frrHeader = (hostname: string) => ["frr version 10.3", "frr defaults traditional", `hostname ${hostname}`, "log syslog informational", "service integrated-vtysh-config", "!"];

/**
 * vtysh `show running-config [bgp]`. Simplified: the integrated config carries
 * static routes and BGP only (OSPF and other daemons are not rendered here).
 */
function vtyshRunningConfig(d: Device, bgpOnly: boolean): string[] {
  const body = [...(bgpOnly ? [] : frrStatics(d)), ...bgpInstances(d.config.features ?? {}).flatMap(([v, c]) => frrBgpBlock(v, c))];
  return ["Building configuration...", "", "Current configuration:", "!", ...frrHeader(d.config.hostname || d.name), ...body, "end"];
}

// --- tabulate views of daemon config files ------------------------------------

function ntpServers(ctx: CommandContext): CommandResult {
  const t = projectConfigDb(ctx.device);
  const servers = Object.keys(t.NTP_SERVER ?? {});
  return { output: lines(tabulateSimple(["NTP Servers"], servers.map((s) => [s]))) };
}

function syslogServers(ctx: CommandContext): CommandResult {
  const hosts = cpList(ctx.device, "logging", "servers").map((s) => [`[${String(s.host)}]`]);
  return { output: lines(tabulateSimple(["Syslog Servers"], hosts)) };
}

// --- groups -------------------------------------------------------------------

interface Sub {
  name: string;
  help: string;
  run: SonicCmd["run"];
}

const RUN_SUBS: Sub[] = [
  { name: "acl", help: "Show acl running configuration", run: cfggen(["ACL_RULE"]) },
  {
    name: "all",
    help: "Show full running configuration",
    run(_a, ctx) {
      if (!isSonicDevice(ctx.device)) return notSonic();
      const out = { ...JSON.parse(configDbJson(ctx.device)), bgpraw: vtyshRunningConfig(ctx.device, false).join("\n") };
      return { output: lines(JSON.stringify(out, null, 4).split("\n")) };
    },
  },
  {
    name: "bgp",
    help: "Show BGP running configuration Note:...",
    run(args, ctx) {
      if (args.includes("-n") || args.includes("--namespace")) {
        return { output: [err("Usage: show runningconfiguration bgp [OPTIONS]"), err('Try "show runningconfiguration bgp -h" for help.'), err(""), err("Error: -n/--namespace is not available for single asic")] };
      }
      return { output: lines(vtyshRunningConfig(ctx.device, true)) };
    },
  },
  { name: "copp", help: "Show copp running configuration", run: cfggen(["COPP_GROUP", "COPP_TRAP"]) },
  { name: "interfaces", help: "Show interfaces running configuration", run: cfggen(["INTERFACE"], true) },
  { name: "ntp", help: "Show NTP running configuration", run: (_a, ctx) => ntpServers(ctx) },
  { name: "ports", help: "Show ports running configuration", run: cfggen(["PORT"], true) },
  {
    name: "snmp",
    help: "Show SNMP running configuration",
    run(args, ctx) {
      const m = matchSonic(snmpModule.show, ["runningconfiguration", "snmp", ...args])!;
      return m.cmd.run(m.rest, ctx);
    },
  },
  { name: "spanning-tree", help: "Show spanning_tree running configuration", run: cfggen(["STP", "STP_PORT", "STP_VLAN", "STP_VLAN_PORT"]) },
  { name: "syslog", help: "Show Syslog running configuration", run: (_a, ctx) => syslogServers(ctx) },
];

const START_SUBS: Sub[] = [
  {
    name: "bgp",
    help: "Show BGP startup configuration",
    run(_a, ctx) {
      // bgpd.conf is rendered from CONFIG_DB when the bgp container starts, i.e. from the saved
      // /etc/sonic/config_db.json. Without a `config save` the device booted from the lab's
      // running config, so that is printed.
      const snap = savedFile(ctx.device);
      const features = snap ? snap.features : (ctx.device.config.features ?? {});
      const hostname = (snap ? snap.hostname : ctx.device.config.hostname) || ctx.device.name;
      return { output: lines(["Routing-Stack is: frr", "!", ...frrHeader(hostname), ...bgpInstances(features).flatMap(([v, c]) => frrBgpBlock(v, c))]) };
    },
  },
];

/** AliasedGroup.get_command: exact name, else a unique prefix, else a Click usage error. */
function group(path: string, help: string, subs: Sub[]): SonicCmd {
  return {
    path: [path],
    summary: help,
    run(args, ctx) {
      const usage = () => ({ output: clickGroupUsage(`show ${path}`, help, subs.map((s) => [s.name, s.help] as [string, string])) });
      const name = args[0];
      if (name === undefined || ["-h", "--help", "-?"].includes(name)) return usage();
      const matches = subs.filter((s) => s.name.toLowerCase().startsWith(name.toLowerCase()));
      const exact = subs.find((s) => s.name === name);
      const sub = exact ?? (matches.length === 1 ? matches[0] : undefined);
      if (sub) return sub.run(args.slice(1), ctx);
      const msg = matches.length ? `Too many matches: ${matches.map((s) => s.name).sort().join(", ")}` : `No such command "${name}".`;
      return { output: [err(`Usage: show ${path} [OPTIONS] COMMAND [ARGS]...`), err(`Try "show ${path} -h" for help.`), err(""), err(`Error: ${msg}`)] };
    },
  };
}

const show: SonicCmd[] = [
  group("runningconfiguration", "Show current running configuration information", RUN_SUBS),
  group("startupconfiguration", "Show startup configuration information", START_SUBS),
  ...RUN_SUBS.filter((s) => s.name !== "snmp").map((s) => ({ path: ["runningconfiguration", s.name], summary: s.help, run: s.run })),
  ...START_SUBS.map((s) => ({ path: ["startupconfiguration", s.name], summary: s.help, run: s.run })),
];

export const runcfgModule: SonicFeatureModule = {
  id: "running-configuration",
  config: [],
  show,
};
