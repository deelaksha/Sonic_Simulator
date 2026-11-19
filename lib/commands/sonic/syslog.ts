/**
 * Syslog — Click `show logging`, `show syslog`, `config syslog add|del`.
 *
 * Sources (sonic-buildimage/src/sonic-utilities):
 *   show/main.py:1603-1629  `show logging [PROCESS] [-l N] [-f]`: `cat syslog.1 syslog`
 *                           | grep '<PROCESS>' | tail -N; -f runs `tail -F` (last 10 lines, then follows).
 *   data/device-capture/click-show-tree.txt:1198-1215 adds --level (that severity and higher) and
 *                           --severity (exactly that severity) on the captured device.
 *   config/syslog.py:370-450 `config syslog add <ip> [-s source] [-p port] [-r vrf]` / `del <ip>`
 *                           → SYSLOG_SERVER, restart rsyslog-config, log_notice(...) on success.
 *   show/syslog.py:28-61    `show syslog`: tabulate "simple" SERVER IP / SOURCE IP / PORT / VRF, N/A defaults.
 *
 * SYSLOG_SERVER is shared with KLISH `logging server` (features.cp_logging.servers); the syslog daemon
 * (lib/protocols/syslog-daemon.ts) forwards new lines to every row.
 *
 * `-f` prints the `tail -F` snapshot (last 10 lines) and returns: following needs a live terminal
 * session driven by the store, like tcpdump's.
 */
import { CommandContext, CommandResult, OutputLine, line, err } from "../types";
import { SonicCmd, SonicFeatureModule } from "./types";
import { isValidIpv4 } from "../../models/ip";
import { peekFeatureState } from "../../models/feature-state";
import { cpList, cpRemove, cpUpsert } from "../sonic-cli/config-plane";
import { SEVERITIES, Severity, formatSyslog, logEvent, peekSyslog } from "../../control/syslog";

const LEVELS = ["DEBUG", "INFO", "WARNING", "NOTICE", "ERR", "CRIT"];

function opt(args: string[], short: string, long: string): { value?: string; present: boolean } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === short || a === long) return { value: args[i + 1], present: true };
    if (a.startsWith(long + "=")) return { value: a.slice(long.length + 1), present: true };
  }
  return { present: false };
}

/** Positional tokens, skipping option values. */
function positionals(args: string[], withValue: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (withValue.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const usageErr = (usage: string, help: string, msg: string): CommandResult => ({
  output: [err(`Usage: ${usage}`), err(`Try "${help} -h" for help.`), err(""), err(`Error: ${msg}`)],
});

/** The device's syslog as text lines (oldest first). */
export function syslogText(ctx: CommandContext): string[] {
  const st = peekSyslog(ctx.device);
  return (st?.lines ?? []).map((l) => formatSyslog(ctx.device, l));
}

function showLogging(args: string[], ctx: CommandContext): CommandResult {
  const usage = "show logging [OPTIONS] [PROCESS]";
  const linesOpt = opt(args, "-l", "--lines");
  const follow = args.includes("-f") || args.includes("--follow");
  const level = opt(args, "--level", "--level");
  const sev = opt(args, "--severity", "--severity");
  let n: number | undefined;
  if (linesOpt.present) {
    if (linesOpt.value === undefined) return usageErr(usage, "show logging", "Option '-l' requires an argument.");
    if (!/^-?\d+$/.test(linesOpt.value)) return usageErr(usage, "show logging", `Invalid value for '-l' / '--lines': '${linesOpt.value}' is not a valid integer.`);
    n = Number(linesOpt.value);
  }
  for (const [name, o] of [["--level", level], ["--severity", sev]] as const) {
    if (o.present && !LEVELS.includes(o.value ?? "")) {
      return usageErr(usage, "show logging", `Invalid value for '${name}': '${o.value ?? ""}' is not one of ${LEVELS.map((l) => `'${l}'`).join(", ")}.`);
    }
  }
  const process = positionals(args, ["-l", "--lines", "--level", "--severity", "--since"])[0];
  const st = peekSyslog(ctx.device);
  let lines = (st?.lines ?? []).filter((l) => {
    if (level.present && SEVERITIES.indexOf(l.severity) > SEVERITIES.indexOf(level.value as Severity)) return false;
    if (sev.present && l.severity !== sev.value) return false;
    return true;
  }).map((l) => formatSyslog(ctx.device, l));
  if (follow) return { output: lines.slice(-10).map((t) => line(t)) }; // `tail -F`: last 10 lines
  if (process !== undefined) lines = lines.filter((t) => t.includes(process)); // grep '<process>'
  if (n !== undefined) lines = n <= 0 ? [] : lines.slice(-n); // tail -N
  return { output: lines.map((t) => line(t)) };
}

/** python-tabulate tablefmt="simple", numalign/stralign left (show/syslog.py:23-24). */
function simpleTable(header: string[], rows: string[][]): string[] {
  const w = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const fmt = (cells: string[]) => cells.map((v, c) => v.padEnd(w[c])).join("  ").trimEnd();
  return [fmt(header), w.map((x) => "-".repeat(x)).join("  "), ...rows.map(fmt)];
}

function showSyslog(_args: string[], ctx: CommandContext): CommandResult {
  const rows = cpList(ctx.device, "logging", "servers")
    .map((s) => [String(s.host), s.source !== undefined ? String(s.source) : "N/A", s.port !== undefined ? String(s.port) : "N/A", s.vrf !== undefined ? String(s.vrf) : "N/A"])
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  return { output: simpleTable(["SERVER IP", "SOURCE IP", "PORT", "VRF"], rows).map((t) => line(t)) };
}

const isIpv6 = (s: string) => s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s);
const validIp = (s: string) => isValidIpv4(s) || isIpv6(s);
const ownIps = (ctx: CommandContext) => ctx.device.interfaces.flatMap((i) => i.ipv4.map((a) => a.address));

const config: SonicCmd[] = [
  {
    path: ["syslog", "add"],
    summary: "Add a remote syslog server: <ip> [-s source] [-p port] [-r vrf]",
    run(args, ctx): CommandResult {
      const usage = "config syslog add [OPTIONS] SERVER_IP_ADDRESS";
      const pos = positionals(args, ["-s", "--source", "-p", "--port", "-r", "--vrf"]);
      const server = pos[0];
      if (!server) return usageErr(usage, "config syslog add", "Missing argument 'SERVER_IP_ADDRESS'.");
      if (!validIp(server)) return usageErr(usage, "config syslog add", `Invalid value for "SERVER_IP_ADDRESS": '${server}' does not appear to be an IPv4 or IPv6 address`);
      const source = opt(args, "-s", "--source").value;
      const portTok = opt(args, "-p", "--port").value;
      const vrf = opt(args, "-r", "--vrf").value;
      if (cpList(ctx.device, "logging", "servers").some((s) => s.host === server)) {
        return usageErr(usage, "config syslog add", `Invalid value for "server_ip_address": ${server} is a valid syslog server`);
      }
      const data: Record<string, unknown> = { host: server };
      if (source !== undefined) {
        if (!validIp(source)) return usageErr(usage, "config syslog add", `Invalid value for "-s" / "--source": '${source}' does not appear to be an IPv4 or IPv6 address`);
        if (/^127\.|^22[4-9]\.|^23\d\.|^169\.254\./.test(source)) return usageErr(usage, "config syslog add", `Invalid value for "source": ${source} is a loopback/multicast/link-local IP address`);
        if (isValidIpv4(server) !== isValidIpv4(source)) return usageErr(usage, "config syslog add", `Invalid value for "server_ip_address" / "source": ${server} / ${source} IP address family mismatch`);
        data.source = source;
      }
      if (portTok !== undefined) {
        const p = Number(portTok);
        if (!/^\d+$/.test(portTok) || p > 65535) return usageErr(usage, "config syslog add", `Invalid value for "-p" / "--port": ${portTok} is not in the valid range of 0 to 65535.`);
        data.port = p;
      }
      if (vrf !== undefined) {
        const vrfs = ["default", "mgmt", ...(peekFeatureState<{ vrfs: { name: string }[] }>(ctx.device, "vrf")?.vrfs ?? []).map((v) => v.name)];
        if (!vrfs.includes(vrf)) return usageErr(usage, "config syslog add", `Invalid value for "vrf": invalid choice: ${vrf}. (choose from ${vrfs.join(", ")})`);
        data.vrf = vrf;
      }
      if (source !== undefined && (vrf === undefined || vrf === "default") && !ownIps(ctx).includes(source)) {
        return usageErr(usage, "config syslog add", `Invalid value for "source": ${source} IP doesn't exist in Linux default VRF`);
      }
      cpUpsert(ctx.device, "logging", "servers", data, "host");
      logEvent(ctx.device, Date.now(), "NOTICE", "config", `Added remote syslog logging: server=${server},source=${data.source ?? "N/A"},port=${data.port ?? "N/A"},vrf=${data.vrf ?? "N/A"}`);
      return { output: restartLines() };
    },
  },
  {
    path: ["syslog", "del"],
    summary: "Delete a remote syslog server",
    run(args, ctx): CommandResult {
      const usage = "config syslog del [OPTIONS] SERVER_IP_ADDRESS";
      const server = positionals(args, [])[0];
      if (!server) return usageErr(usage, "config syslog del", "Missing argument 'SERVER_IP_ADDRESS'.");
      if (!validIp(server)) return usageErr(usage, "config syslog del", `Invalid value for "SERVER_IP_ADDRESS": '${server}' does not appear to be an IPv4 or IPv6 address`);
      if (!cpList(ctx.device, "logging", "servers").some((s) => s.host === server)) {
        return usageErr(usage, "config syslog del", `Invalid value for "server_ip_address": ${server} is not a valid syslog server`);
      }
      cpRemove(ctx.device, "logging", "servers", "host", server);
      logEvent(ctx.device, Date.now(), "NOTICE", "config", `Removed remote syslog logging: server=${server}`);
      return { output: restartLines() };
    },
  },
];

/** clicommon.run_command(..., display_cmd=True) echoes (utilities_common/cli.py:755-756). */
function restartLines(): OutputLine[] {
  return [line("Running command: systemctl reset-failed rsyslog-config rsyslog"), line("Running command: systemctl restart rsyslog-config")];
}

const show: SonicCmd[] = [
  { path: ["logging"], summary: "Show system log: [PROCESS] [-l N] [-f] [--level L] [--severity S]", run: showLogging },
  { path: ["syslog"], summary: "Show syslog server configuration", run: showSyslog },
  { path: ["syslog", "server"], summary: "Show syslog configDB configuration", run: showSyslog },
];

export const syslogModule: SonicFeatureModule = { id: "syslog", config, show };
