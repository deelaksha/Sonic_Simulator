/**
 * KLISH operational `show` commands of the system / platform family, rendered
 * from the live simulated box with the real renderer templates' layout
 * (Broadcom Enterprise SONiC sonic-mgmt-framework CLI, renderer/templates/*.j2
 * and actioner/*.py; syntax from data/device-capture/klish-xml/*.xml):
 *
 *   show system                         system.xml:15   system_show.j2 (Boot Time / Current Datetime / Hostname)
 *   show system memory                  system.xml:19   system_memory_show.j2 (bytes)
 *   show system cpu                     system.xml:23   system_cpu_show.j2 (polling interval = resource-stats-polling-interval)
 *   show system processes [cpu|mem-util|mem-usage|pid <n>]
 *                                       system.xml:27-43 system_processes_show.j2 / system_process_pid_show.j2,
 *                                       sort keys from sonic-cli-sys.py run()
 *   show system status [brief|detail|core]  system.xml:52-64 (sysreadyshow layout)
 *   show system config-update-time      system.xml:48   sonic-cli-sys.py (strftime "%a %d %b %Y %I:%M:%S %p" + tz)
 *   show system vlan reserved           vlan.xml:14     show_reserved_vlan.j2 (default 3967-4094)
 *   show uptime | show reboot-cause | show users [configured|all|sshKey]
 *                                       infra_cli.xml:57-77 infra_show.j2 / show_users_*.j2
 *   show image [list|status|firmware [status]|patch status|list|history]
 *                                       image.xml:30-55 show_image*.j2 / show_patch_*.j2 — the one running image
 *   show config-reload status           file_mgmt.xml:256 show_config_reload_status.j2
 *   show database map                   database.xml:13 show_database_map.j2 over database_config.json.j2
 *   show in-memory-logging [lines N|count]  in_memory_logging.xml:16-25 (syslog ring)
 *   show audit-log [all] | show auditd-system log [all]   audit.xml:16,49 show_audit_log_rpc.j2
 *   show swsslog-configuration          swsslog.xml:11  `swssloglevel -p` (loglevel.cpp:154 setw(30))
 *   show switch-profiles                config_profiles.xml:11 show_config_profiles.j2
 *   show histogram memory …             histogram.xml:13 hist.j2
 *   show tech-support [terminal|status|cancel|since <d>]   show_techsupport.xml:12-22
 *   show techsupport-export             techsupport_export.xml:14 show_techsupport_export.j2
 *   show debug ptp                      ptp.xml:189
 *   show error-database [<table>]       error_database.xml:13 show_error_database.j2
 *   show cable-diagnostics report|cable-length [Ethernet N]  test.xml:19 show_cable_diag_*.j2
 *
 * Numbers (processes, memory, CPU, uptime) come from lib/protocols/system-resources.ts:
 * the real containers/daemons of the FEATURE table, deterministic.
 */
import { OutputLine, line } from "../../types";
import { registerModal, runModalHandlers } from "../registry";
import { cpGet, cpRunningLines } from "../config-plane";
import { Device } from "../../../models/device";
import { featureState } from "../../../models/feature-state";
import { featureRows } from "../../../protocols/cpu-features";
import { bootMs, processes, memory, cpus, uptimeLine, Proc } from "../../../protocols/system-resources";
import { peekSyslog, formatSyslog } from "../../../control/syslog";
import { wallParts, datetimeformat, clockString, wdhm, ifArg, L, IMAGE, showStatus } from "./sysfmt";
import { incomplete, noAction } from "./klish-show-util";

const DASH59 = "-".repeat(59);
const BARE = ["buffer", "config-reload", "database", "debug", "hardware", "hardware tcam", "histogram", "image", "image patch"];
const lines = (t: string[]) => t.map((s) => line(s));
const attrHeader = () => [DASH59, `${L("Attribute", 20)} Value/State`, DASH59];

// ---------------------------------------------------------------- show system

function showSystem(dev: Device): string[] {
  const now = Date.now();
  const w = wallParts(dev, now);
  const off = `${w.off.slice(0, 3)}:${w.off.slice(3)}`;
  return [
    ...attrHeader(),
    `${L("Boot Time", 20)}:${wdhm(now - bootMs(dev))}`,
    `${L("Current Datetime", 20)}:${w.Y}-${w.M}-${w.D}T${w.h}:${w.m}:${w.s}${off}`,
    `${L("Hostname", 20)}:${dev.config.hostname}`,
  ];
}

function showMemory(dev: Device): string[] {
  const m = memory(dev);
  return [...attrHeader(), `${L("Total", 20)}:${m.total}`, `${L("Used", 20)}:${m.used}`, `${L("Free", 20)}:${m.free}`, `${L("Buff/Cache", 20)}:${m.buffCache}`];
}

function showCpu(dev: Device): string[] {
  const interval = Number(cpGet(dev, "system")?.resource_stats_polling_interval ?? 120);
  const d70 = "-".repeat(70);
  return [
    `Polling Interval: ${interval.toFixed(1)} seconds`,
    d70,
    `${L("CPU", 20)}${L("%KERNEL", 20)}${L("%USER", 20)}%IDLE`,
    d70,
    ...cpus(dev).map((c) => `${L(`CPU-${c.cpu}`, 20)}${L(c.kernel, 20)}${L(c.user, 20)}${c.idle}`),
  ];
}

function showProcesses(dev: Device, mode: string): string[] {
  const procs = processes(dev);
  const sorted =
    mode === "cpu" ? [...procs].sort((a, b) => b.cpuPct - a.cpuPct)
    : mode === "mem-util" ? [...procs].sort((a, b) => b.memPct - a.memPct)
    : mode === "mem-usage" ? [...procs].sort((a, b) => b.rssBytes - a.rssBytes)
    : procs;
  const j = 15;
  const d74 = "-".repeat(74);
  return [
    d74,
    `${L("PID", j)}${L("%CPU", j)}${L("%MEMORY", j)}${L("MEM-USAGE(Bytes)", j + 3)}NAME`,
    d74,
    ...sorted.map((p) => `${L(p.pid, j)}${L(p.cpuPct, j)}${L(p.memPct, j)}${L(p.rssBytes, j + 3)}${p.name}`),
  ];
}

function showPid(dev: Device, pid: string): string[] {
  const p: Proc | undefined = processes(dev).find((x) => String(x.pid) === pid);
  if (!p) return []; // sonic-cli-sys.py: pid not found → prints nothing
  const now = Date.now();
  return [
    ...attrHeader(),
    `${L("Cpu Usage System", 20)}:${p.systemTicks}`,
    `${L("Cpu Usage User", 20)}:${p.userTicks}`,
    `${L("Cpu Utilization", 20)}:${p.cpuPct}`,
    `${L("Memory Usage", 20)}:${p.rssBytes}`,
    `${L("Memory Utilization", 20)}:${p.memPct}`,
    `${L("Name", 20)}:${p.name}`,
    ...(p.args.length ? [`${L("Args", 20)}:${p.args.join(", ")}`] : []),
    `${L("Pid", 20)}:${p.pid}`,
    `${L("Start Time", 20)}:${datetimeformat(dev, p.startMs)}`,
    `${L("Uptime", 20)}:${wdhm(now - p.startMs)}`,
  ];
}

function reservedVlans(dev: Device): string {
  const l = cpRunningLines(dev).map((x) => /^system vlan (\d+) reserve$/.exec(x.line.trim())).filter(Boolean).pop();
  const lo = l ? Number(l[1]) : 3967;
  return `system vlan reservation: ${lo}-${l ? lo + 127 : 4094}`;
}

// ---------------------------------------------------------------- users

interface User { name: string; role: string }

function users(dev: Device): User[] {
  const out: User[] = [{ name: "admin", role: "admin" }];
  for (const { line: l } of cpRunningLines(dev)) {
    const m = /^username\s+(\S+)(?:.*?\brole\s+(\S+))?/.exec(l.trim());
    if (!m) continue;
    const u = { name: m[1], role: m[2] ?? "operator" };
    const i = out.findIndex((x) => x.name === u.name);
    if (i >= 0) out[i] = u;
    else out.push(u);
  }
  return out;
}

function userTable(dev: Device): string[] {
  const d70 = "-".repeat(70);
  return [d70, `${L("User", 34)}Role(s)`, d70, ...users(dev).map((u) => `${L(u.name, 34)}${u.role}`)];
}

/** The learner's sonic-cli session, logged in on the console since boot (`who` line). */
function whoLine(dev: Device): string {
  const w = wallParts(dev, bootMs(dev));
  return `${L("admin", 8)} ${L("ttyS0", 12)} ${w.Y}-${w.M}-${w.D} ${w.h}:${w.m}`;
}

// ---------------------------------------------------------------- image

function imageList(): string[] {
  return [`Current: ${IMAGE}`, `Next: ${IMAGE}`, "", "", "Available: ", IMAGE];
}

const idleBlock = () => ["", DASH59, `${L("Global operation status", 25)}: GLOBAL_STATE_IDLE`, DASH59, ""];

function imageFirmware(): string[] {
  return [
    "",
    "Pending Firmware Upgrade(s)",
    "===========================",
    `${L("Name", 65)} ${L("Version", 15)} ${L("Date", 20)}`.trimEnd(),
    `${"-".repeat(65)} ${"-".repeat(15)} ${"-".repeat(20)}`,
    " ",
    "Past Firmware Upgrade(s)",
    "========================",
    `${L("Name", 65)} ${L("Version", 15)} ${L("Result", 8)} ${L("Date", 20)}`.trimEnd(),
    `${"-".repeat(65)} ${"-".repeat(15)} ${"-".repeat(8)} ${"-".repeat(20)}`,
    " ",
  ];
}

function patchList(history: boolean): string[] {
  if (history) {
    const d = "-".repeat(137);
    return ["", d, `${L("Id", 5)} ${L("Tag", 60)} ${L("State", 12)} ${L("Status", 12)} ${L("Start", 24)} End`, d, ""];
  }
  const d = "-".repeat(115);
  return ["", d, `${L("Id", 5)} ${L("Tag", 60)} ${L("Date", 30)} DependsOn`, d, ""];
}

// ---------------------------------------------------------------- database map

/** dockers/docker-database/database_config.json.j2:39-117 (single-ASIC, no chassis DBs); dict keyed by id → later name wins (FLEX_COUNTER_DB over PFC_WD_DB). */
const DATABASES: [number, string][] = [
  [0, "APPL_DB"], [1, "ASIC_DB"], [2, "COUNTERS_DB"], [3, "LOGLEVEL_DB"], [4, "CONFIG_DB"], [5, "FLEX_COUNTER_DB"],
  [6, "STATE_DB"], [7, "SNMP_OVERLAY_DB"], [8, "RESTAPI_DB"], [9, "GB_ASIC_DB"], [10, "GB_COUNTERS_DB"],
  [11, "GB_FLEX_COUNTER_DB"], [14, "APPL_STATE_DB"],
];

function databaseMap(): string[] {
  const d = "-".repeat(73);
  return [
    d,
    " ID             Name         Instance  TCP Port  Unix Socket Path",
    d,
    ...DATABASES.map(([id, name]) => `${String(id).padStart(3)} ${name.padStart(16)} ${"redis".padStart(16)} ${"6379".padStart(9)}  ${"/var/run/redis/redis.sock".padStart(16)}`),
  ];
}

// ---------------------------------------------------------------- swsslog

const SAI_APIS = [
  "ACL", "BRIDGE", "BUFFER", "FDB", "HASH", "HOSTIF", "LAG", "MIRROR", "NEIGHBOR", "NEXT_HOP", "NEXT_HOP_GROUP",
  "POLICER", "PORT", "QOS_MAP", "QUEUE", "ROUTE", "ROUTER_INTERFACE", "SAMPLEPACKET", "SCHEDULER",
  "SCHEDULER_GROUP", "STP", "SWITCH", "TUNNEL", "UDF", "VIRTUAL_ROUTER", "VLAN", "WRED",
];

/** LOGGER table keys (one per swss-common Logger user + SAI APIs), `swssloglevel -p`. */
function swssLogLevels(dev: Device): string[] {
  const levels: Record<string, string> = {};
  const running = featureRows(dev).filter((f) => f.state === "enabled" || f.state === "always_enabled");
  const swssUsers = ["orchagent", "portsyncd", "neighsyncd", "coppmgrd", "vlanmgrd", "intfmgrd", "portmgrd", "buffermgrd",
    "vrfmgrd", "nbrmgrd", "vxlanmgrd", "fdbsyncd", "syncd", "fpmsyncd", "teammgrd", "teamsyncd", "tlm_teamd", "natmgrd", "natsyncd", "macsecmgrd"];
  for (const f of running) for (const p of f.processes) if (swssUsers.includes(p)) levels[p] = "NOTICE";
  for (const api of SAI_APIS) levels[`SAI_API_${api}`] = "SAI_LOG_LEVEL_NOTICE";
  for (const { line: l } of cpRunningLines(dev)) {
    const m = /^swsslog loglevel (\S+) component (\S+)/.exec(l.trim());
    if (m && levels[m[2]] !== undefined) levels[m[2]] = m[1];
  }
  return Object.keys(levels).sort().map((k) => `${L(k, 30)}${levels[k]}`);
}

// ---------------------------------------------------------------- tech-support

interface TechState { file?: string }

/** A representative subset of show_techsupp_text_cmds.txt (BCM cli-bcm). */
const TECH_TERMINAL = ["show clock", "show version", "show uptime", "show users", "show image list", "show system status detail",
  "show reboot-cause", "show system processes cpu", "show system memory", "show interface status", "show running-configuration"];

function techSupport(dev: Device, sub: string, run: (cmd: string) => OutputLine[]): OutputLine[] {
  const st = featureState<TechState>(dev, "techsupport", () => ({}));
  if (sub === "terminal") {
    const out: OutputLine[] = [];
    for (const c of TECH_TERMINAL) out.push(line(""), line(`${dev.config.hostname}# ${c}`), ...run(c));
    return out;
  }
  if (sub === "status") return st.file ? lines(["Status: Completed", `File Name: ${st.file}`]) : [];
  if (sub === "cancel") return lines(["%Info: No tech-support collection is in progress"]);
  const w = wallParts(dev, Date.now());
  st.file = `/var/dump/sonic_dump_${dev.config.hostname}_${w.Y}${w.M}${w.D}_${w.h}${w.m}${w.s}.tar.gz`;
  return lines([`%Info: Tech-support collection started (${st.file}), please check "show tech-support status" for tech-support progress`]);
}

// ---------------------------------------------------------------- cable diagnostics

function cableDiag(dev: Device, kind: string, port?: string): string[] {
  const ports = dev.interfaces.filter((i) => i.name.startsWith("Eth") && !i.management && !i.logical && (!port || i.name === port));
  if (!ports.length) return [];
  if (kind === "report") {
    return [" ", "Interface    Type  Length      Result        Status      Timestamp", "------------ ----- ----------- ------------- ----------- -----------------------",
      ...ports.map((p) => L(p.name, 13).trimEnd())];
  }
  return [" ", "Interface     Type      Length", "------------  --------  -------------------------------", ...ports.map((p) => p.name)];
}

// ---------------------------------------------------------------- dispatcher

registerModal({
  id: "system-info-show",
  views: ["enable-view"],
  keywords: ["show"],
  run({ args, ctx, delegate }) {
    const dev = ctx.device;
    const k = args.map((t) => t.toLowerCase());
    const pipe = k.indexOf("|");
    if (pipe >= 0) k.length = pipe;
    const now = Date.now();
    const out = (t: string[]) => ({ output: lines(t) });
    // keyword containers with no ACTION in the XML (database.xml:12, image.xml:29/38, ptp.xml:188, …)
    const path = k.join(" ");
    if (BARE.includes(path)) return noAction();

    switch (k[0]) {
      case "system": {
        if (k[1] === undefined) return out(showSystem(dev));
        if (k[1] === "memory") return out(showMemory(dev));
        if (k[1] === "cpu") return out(showCpu(dev));
        if (k[1] === "processes") {
          if (k[2] === "pid") return k[3] ? out(showPid(dev, k[3])) : incomplete();
          return out(showProcesses(dev, k[2] ?? "default"));
        }
        if (k[1] === "status") return out(showStatus(dev, k[2] ?? "default"));
        if (k[1] === "config-update-time") return out([clockString(dev, bootMs(dev))]);
        if (k[1] === "vlan" && k[2] === "reserved") return out([reservedVlans(dev)]);
        return null;
      }
      case "uptime":
        return out([uptimeLine(dev, now, 1, (({ h, m, s }) => `${h}:${m}:${s}`)(wallParts(dev, now)))]);
      case "reboot-cause":
        return out(["Unknown"]);
      case "users":
        if (k[1] === undefined) return out([whoLine(dev)]);
        if (k[1] === "configured" || k[1] === "all") return out(userTable(dev));
        if (k[1] === "sshkey") return out(["No SSH keys configured"]);
        return null;
      case "image":
        if (k[1] === "list") return out(imageList());
        if (k[1] === "status") return out(idleBlock());
        if (k[1] === "firmware") return out(k[2] === "status" ? idleBlock() : imageFirmware());
        if (k[1] === "patch") {
          if (k[2] === "status") return out(idleBlock());
          if (k[2] === "list" || k[2] === "history") return out(patchList(k[2] === "history"));
        }
        return null;
      case "config-reload":
        if (k[1] !== "status") return null;
        return out(["-".repeat(54), "Config Reload Status", "-".repeat(54)]);
      case "database":
        return k[1] === "map" ? out(databaseMap()) : null;
      case "in-memory-logging": {
        const all = (peekSyslog(dev)?.lines ?? []).map((l) => formatSyslog(dev, l));
        if (k[1] === "count") return out([String(all.length)]);
        if (k[1] === "lines") return /^\d+$/.test(k[2] ?? "") ? out(Number(k[2]) ? all.slice(-Number(k[2])) : all) : incomplete();
        return out(all);
      }
      case "audit-log":
        return out([]); // sonic-auditlog get-auditlog: no REST/gNMI config operations have been audited on this box
      case "auditd-system":
        return k[1] === "log" ? out([]) : null; // kernel audit records exist only once audit rules are loaded
      case "swsslog-configuration":
        return out(swssLogLevels(dev));
      case "switch-profiles":
        return out(["No default configuration profiles found"]);
      case "histogram":
        if (k[1] !== "memory") return null;
        return out(histogram(dev, k[2] ?? "system"));
      case "tech-support": {
        const run = (cmd: string): OutputLine[] => {
          const a = cmd.split(" ").slice(1);
          return runModalHandlers({ ctx, view: "enable-view", head: "show", isNo: false, args: a, raw: cmd, delegate })?.output ?? delegate(cmd);
        };
        return { output: techSupport(dev, k[1] ?? "", run) };
      }
      case "techsupport-export": {
        const banner = "=".repeat(40);
        return out([banner, "Techsupport Export Configuration", banner]);
      }
      case "debug":
        return k[1] === "ptp" ? out([]) : null; // no PTP debug flags enabled
      case "error-database":
        return out([]); // ERROR_DB is empty: no orchagent programming failures
      case "cable-diagnostics": {
        if (k[1] !== "report" && k[1] !== "cable-length") return k[1] === undefined ? noAction() : null;
        return out(cableDiag(dev, k[1], k[2] ? ifArg(args.slice(2)).name : undefined));
      }
    }
    return null;
  },
});

/** show histogram memory system|docker|process: current RSS snapshot grouped like the histogram service's "list" op. */
function histogram(dev: Device, type: string): string[] {
  const procs = processes(dev);
  const w = wallParts(dev, Date.now());
  const ts = `${w.Y}-${w.M}-${w.D} ${w.h}:${w.m}:${w.s}`;
  const mb = (b: number) => (b / 1048576).toFixed(2);
  if (type === "docker") {
    const by = new Map<string, number>();
    for (const p of procs) if (p.container) by.set(p.container, (by.get(p.container) ?? 0) + p.rssBytes);
    return [`${L("Time", 21)}${L("Docker", 20)}RSS(MB)`, ...[...by].sort((a, b) => b[1] - a[1]).map(([n, b]) => `${L(ts, 21)}${L(n, 20)}${mb(b)}`)];
  }
  if (type === "process") {
    return [`${L("Time", 21)}${L("Process", 20)}${L("PID", 8)}RSS(MB)`, ...[...procs].sort((a, b) => b.rssBytes - a.rssBytes).map((p) => `${L(ts, 21)}${L(p.name, 20)}${L(p.pid, 8)}${mb(p.rssBytes)}`)];
  }
  const m = memory(dev, procs);
  return [`${L("Time", 21)}${L("Total(MB)", 12)}${L("Used(MB)", 12)}${L("Free(MB)", 12)}Buff/Cache(MB)`, `${L(ts, 21)}${L(mb(m.total), 12)}${L(mb(m.used), 12)}${L(mb(m.free), 12)}${mb(m.buffCache)}`];
}
