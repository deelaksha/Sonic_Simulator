/**
 * Click `show nat translations [count]` / `show nat statistics` (sonic-utilities
 * show/nat.py → scripts/natshow -t / -c / -s). Rendered from the live NAT
 * translation table (lib/protocols/nat.ts). Configuration is the KLISH `nat`
 * sub-mode (lib/commands/sonic-cli/features/nat.ts).
 */
import { CommandContext, line } from "../types";
import { SonicCmd, SonicFeatureModule } from "./types";
import { tabulate } from "../../protocols/acl-rules";
import { renderNatTranslations, renderNatStatistics, renderNatCount } from "../../protocols/nat";
import { cpGet, cpList } from "../sonic-cli/config-plane";
import { tab } from "./interface";
import { clickGroup, clickUsageError } from "./types";

/*
 * `show nat config [static|pool|bindings|globalvalues|zones]` = scripts/natconfig -s/-p/-b/-g/-z
 * over the CONFIG_DB tables the KLISH `nat` sub-mode writes (STATIC_NAT / STATIC_NAPT,
 * NAT_POOL, NAT_BINDINGS, NAT_GLOBAL|Values, <IF>_INTERFACE nat_zone). "---" in the store is
 * an absent field; natconfig prints its defaults (dnat / snat / ---).
 */
type Row = Record<string, unknown>;
const val = (v: unknown, dflt: string) => (v === undefined || v === null || v === "---" || v === "" ? dflt : String(v));
const sortBy0 = (rows: string[][]) => rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const block = (t: string[]) => ["", ...t, ""];

function natStatic(ctx: CommandContext): string[] {
  const rows = cpList(ctx.device, "nat", "statics") as Row[];
  const conv = (r: Row) => [val(r.nat_type, "dnat"), r.ip_protocol === "all" ? "all" : String(r.ip_protocol).toUpperCase(), String(r.global_ip), val(r.global_port, "---"), String(r.local_ip), val(r.local_port, "---"), val(r.twice_nat_id, "---")];
  const nat = sortBy0(rows.filter((r) => r.ip_protocol === "all").map(conv));
  const napt = sortBy0(rows.filter((r) => r.ip_protocol !== "all").map(conv));
  return block(tab(["Nat Type", "IP Protocol", "Global IP", "Global Port", "Local IP", "Local Port", " Twice-NAT Id"], [...nat, ...napt]));
}

function natPool(ctx: CommandContext): string[] {
  const rows = (cpList(ctx.device, "nat", "pools") as Row[]).map((r) => [String(r.pool_name), String(r.nat_ip), val(r.nat_port === "NULL" ? undefined : r.nat_port, "---")]);
  return block(tab(["Pool Name", "Global IP Range", "Global Port Range"], sortBy0(rows)));
}

function natBindings(ctx: CommandContext): string[] {
  const rows = (cpList(ctx.device, "nat", "bindings") as Row[]).map((r) => [String(r.name), String(r.nat_pool), val(r.access_list, "---"), val(r.nat_type, "snat"), val(r.twice_nat_id === "NULL" ? undefined : r.twice_nat_id, "---")]);
  return block(tab(["Binding Name", "Pool Name", "Access-List", "Nat Type", "Twice-NAT Id"], sortBy0(rows)));
}

function natGlobal(ctx: CommandContext): string[] {
  const st = cpGet(ctx.device, "nat") ?? {};
  return ["", `Admin Mode     : ${val(st.admin_mode, "disabled")}`, `Global Timeout : ${val(st.nat_timeout, "600")} secs`, `TCP Timeout    : ${val(st.nat_tcp_timeout, "86400")} secs`, `UDP Timeout    : ${val(st.nat_udp_timeout, "300")} secs`, ""];
}

/** Every INTERFACE / VLAN_INTERFACE / PORTCHANNEL_INTERFACE / LOOPBACK_INTERFACE key (zone 0 unless set), sorted as strings. */
function natZones(ctx: CommandContext): string[] {
  const d = ctx.device;
  const zones = cpList(d, "nat", "zones") as Row[];
  const names = new Set([...d.interfaces.filter((i) => !i.management && (i.ipv4.length || i.ipv6.length)).map((i) => i.name), ...zones.map((z) => String(z.port))]);
  const rows = [...names].map((n) => [n, String(zones.find((z) => z.port === n)?.zone ?? "0")]);
  return block(tab(["Port", "Zone"], sortBy0(rows)));
}

const NAT_CONFIG: [string, string, (ctx: CommandContext) => string[]][] = [
  ["static", "Show static NAT configuration", natStatic],
  ["pool", "Show NAT Pool configuration", natPool],
  ["bindings", "Show NAT binding configuration", natBindings],
  ["globalvalues", "Show NAT Global configuration", natGlobal],
  ["zones", "Show NAT Zone configuration", natZones],
];

const show: SonicCmd[] = [
  {
    path: ["nat", "translations"],
    summary: "Show NAT translations (natshow -t; `count` = natshow -c)",
    run: (args, ctx) => ({ output: (args[0] === "count" ? renderNatCount(ctx.device) : renderNatTranslations(ctx.device, tabulate)).map((t) => line(t)) }),
  },
  {
    path: ["nat", "statistics"],
    summary: "Show NAT statistics (natshow -s)",
    run: (_args, ctx) => ({ output: renderNatStatistics(ctx.device, tabulate).map((t) => line(t)) }),
  },
  clickGroup(["nat"], "Show details of the nat", [
    ["config", "Show NAT config related information"],
    ["statistics", "Show NAT statistics"],
    ["translations", "Show NAT translations"],
  ]),
  {
    path: ["nat", "config"],
    summary: "Show NAT config related information",
    // invoke_without_command: natconfig -g, -s, -p, -b, -z (show/nat.py:48-72)
    run: (a, ctx) =>
      a.length
        ? { output: clickUsageError("show nat config", "COMMAND [ARGS]...", `No such command "${a[0]}".`) }
        : { output: [natGlobal, natStatic, natPool, natBindings, natZones].flatMap((f) => f(ctx)).map((t) => line(t)) },
  },
  ...NAT_CONFIG.map(([k, h, f]): SonicCmd => ({ path: ["nat", "config", k], summary: h, run: (_a, ctx) => ({ output: f(ctx).map((t) => line(t)) }) })),
];

export const natModule: SonicFeatureModule = { id: "nat", config: [], show };
