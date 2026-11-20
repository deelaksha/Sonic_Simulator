/**
 * System-information Click `show` commands (sonic-utilities show/main.py and the
 * show/<group>.py files named below), rendered from the live simulated box:
 *
 *   show clock [timezones]              main.py:2139-2156   `date` / `timedatectl list-timezones`
 *   show uptime                         main.py:2130        `uptime -p`
 *   show boot                           main.py:2349        `sonic-installer list`
 *   show reboot-cause [all|history]     reboot_cause.py     previous-reboot-cause.json / STATE_DB REBOOT_CAUSE
 *   show processes cpu|memory|summary   processes.py        `top -bn 1 -o %CPU|%MEM` / `ps -eo pid,ppid,cmd,%mem,%cpu`
 *   show system-memory                  main.py:2161        `free -m`
 *   show system-health …                system_health.py    health_checker summary / monitor list, sysreadyshow
 *   show feature config [<name>]        feature.py:107      (status/autorestart live in ./services.ts)
 *   show kdump config|files|logging     kdump.py
 *   show techsupport                    main.py:1706        `generate_dump -v` (no archive is written)
 *   show ztp | line | serial_console | ssh | environment | banner | event-counters
 *   show warm_restart config|state      warm_restart.py
 *   show management_interface address | mgmt-vrf | dns   (group usage; `show dns nameserver` is ./dns.ts)
 *
 * Processes, memory, CPU and boot time come from lib/protocols/system-resources.ts
 * (the same model behind KLISH `show system …`); config tables come from the
 * config-plane store the KLISH modals write (clock, kdump, ztp, banner,
 * warm_restart) and the FEATURE table. Hardware-backed data a SONiC VS does not
 * have (consoles, sensors, crash dumps, DPUs) prints what VS prints.
 */
import { CommandContext, CommandResult, OutputLine, line, err, muted } from "../types";
import { SonicCmd, SonicFeatureModule, positional, clickGroup } from "./types";
import { Device } from "../../models/device";
import { peekFeatureState } from "../../models/feature-state";
import { cpGet } from "../sonic-cli/config-plane";
import { featureRows } from "../../protocols/cpu-features";
import { bootMs, processes, memory, cpus, uptimeLine, Proc, MEM_TOTAL } from "../../protocols/system-resources";
import { wallParts, IMAGE, showStatus } from "../sonic-cli/features/sysfmt";
import { isLinkLocal6 } from "../../models/ipv6";

const lines = (t: string[]): OutputLine[] => t.map((s) => line(s));
const R = (v: unknown, w: number) => String(v).padStart(w);

type Align = "left" | "right" | "center";

/**
 * python-tabulate "simple": width = max(header + 2, cells), multi-line cells, trailing
 * blanks trimmed; an all-numeric column is right-aligned (numalign) unless `align` is given.
 */
function tabulate(header: string[], rows: string[][], align?: Align): OutputLine[] {
  const numeric = (i: number) => rows.length > 0 && rows.every((r) => /^-?\d+(\.\d+)?$/.test(r[i]));
  const al = (i: number): Align => align ?? (numeric(i) ? "right" : "left");
  const cells = rows.map((r) => r.map((c) => c.split("\n")));
  const w = header.map((h, i) => Math.max(h.length + 2, ...cells.flatMap((r) => r[i].map((s) => s.length))));
  const pad = (s: string, i: number) => {
    const n = w[i] - s.length;
    if (al(i) === "right") return s.padStart(w[i]);
    if (al(i) === "center") return " ".repeat(Math.floor(n / 2)) + s + " ".repeat(n - Math.floor(n / 2));
    return s.padEnd(w[i]);
  };
  const fmt = (r: string[]) => r.map(pad).join("  ").trimEnd();
  const out = [fmt(header), w.map((n) => "-".repeat(n)).join("  ")];
  for (const r of cells) {
    const h = Math.max(...r.map((c) => c.length));
    for (let k = 0; k < h; k++) out.push(fmt(r.map((c) => c[k] ?? "")));
  }
  return lines(out);
}

/** Commands that `sudo` a helper are fine as admin; these check os.geteuid() themselves. */
function needRoot(ctx: CommandContext, cmd: string): CommandResult | null {
  if (ctx.privileged) return null;
  return { output: [line("Root privileges are required for this operation"), muted(`hint: the switch login is the unprivileged admin user — run: sudo show ${cmd}`)] };
}

// ---------------------------------------------------------------- clock / uptime / boot

/** Zone abbreviation for `date` (%Z). */
function tzAbbr(tz: string, ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return "UTC";
  }
}

/** coreutils `date`: "%a %b %e %H:%M:%S %Z %Y" in the configured timezone. */
function dateLine(dev: Device, ms: number): string {
  const w = wallParts(dev, ms);
  return `${w.wd} ${w.mon} ${R(Number(w.D), 2)} ${w.h}:${w.m}:${w.s} ${tzAbbr(w.tz, ms)} ${w.Y}`;
}

/** A short excerpt of `timedatectl list-timezones` (tzdata). */
const TIMEZONES = [
  "Africa/Cairo", "Africa/Johannesburg", "America/Chicago", "America/Los_Angeles", "America/New_York", "America/Sao_Paulo",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Shanghai", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney",
  "Europe/Berlin", "Europe/London", "Europe/Moscow", "Europe/Paris", "Pacific/Auckland", "UTC",
];

/** procps `uptime -p`: "up 1 week, 2 days, 3 hours, 4 minutes". */
function uptimePretty(dev: Device, nowMs: number): string {
  const mins = Math.floor(Math.max(0, nowMs - bootMs(dev)) / 60_000);
  const parts: [number, string][] = [[Math.floor(mins / 10_080), "week"], [Math.floor(mins / 1440) % 7, "day"], [Math.floor(mins / 60) % 24, "hour"]];
  const out = parts.filter(([n]) => n).map(([n, u]) => `${n} ${u}${n === 1 ? "" : "s"}`);
  const m = mins % 60;
  if (m || !out.length) out.push(`${m} minute${m === 1 ? "" : "s"}`);
  return `up ${out.join(", ")}`;
}

// ---------------------------------------------------------------- reboot-cause

/** process-reboot-cause history entry of this (only) boot; the name is its UTC gen_time. */
function rebootHistory(dev: Device): string[][] {
  const d = new Date(bootMs(dev));
  const p = (n: number) => String(n).padStart(2, "0");
  const name = `${d.getUTCFullYear()}_${p(d.getUTCMonth() + 1)}_${p(d.getUTCDate())}_${p(d.getUTCHours())}_${p(d.getUTCMinutes())}_${p(d.getUTCSeconds())}`;
  return [[name, "Unknown", "N/A", "N/A", "N/A"]];
}

// ---------------------------------------------------------------- processes / memory

/** /proc/<pid>/cmdline as ps/top print it. */
function cmdline(p: Proc): string {
  if (p.name === "systemd") return "/sbin/init";
  if (p.name === "kthreadd") return "[kthreadd]";
  if (p.name === "supervisord") return "/usr/bin/python3 /usr/local/bin/supervisord";
  if (p.name === "redis-server") return "/usr/bin/redis-server 127.0.0.1:6379";
  if (p.name === "containerd-shim") return ["/usr/bin/containerd-shim-runc-v2", ...p.args].join(" ");
  return [`/usr/bin/${p.name}`, ...p.args].join(" ");
}

/** Parent PIDs: host daemons hang off systemd, a container's supervisord off its shim, programs off supervisord. */
function parentPids(procs: Proc[]): Map<number, number> {
  const shim = new Map(procs.filter((p) => p.name === "containerd-shim").map((p) => [p.args[3], p.pid]));
  const sup = new Map(procs.filter((p) => p.container && p.name === "supervisord").map((p) => [p.container, p.pid]));
  return new Map(procs.map((p) => {
    if (p.pid <= 2) return [p.pid, 0];
    if (!p.container) return [p.pid, 1];
    return [p.pid, (p.name === "supervisord" ? shim.get(p.container) : sup.get(p.container)) ?? 1];
  }));
}

const pctMem = (p: Proc) => ((p.rssBytes * 100) / MEM_TOTAL).toFixed(1);

/** `ps -eo pid,ppid,cmd,%mem,%cpu` (procps-ng: PID/PPID width 7, CMD width 27). */
function psSummary(dev: Device): string[] {
  const procs = processes(dev);
  const pp = parentPids(procs);
  return [
    `${R("PID", 7)} ${R("PPID", 7)} ${"CMD".padEnd(27)} %MEM %CPU`,
    ...procs.map((p) => `${R(p.pid, 7)} ${R(pp.get(p.pid), 7)} ${cmdline(p).slice(0, 27).padEnd(27)} ${R(pctMem(p), 4)} ${R(p.cpuPct.toFixed(1), 4)}`),
  ];
}

/** Shared memory (tmpfs: /dev/shm, /run) of an idle box, bytes. */
const SHMEM = 102_760_448;
const MiB = 1_048_576;

/** `top -bn 1 -o %CPU|%MEM`: summary area + task list sorted on the field. */
function top(dev: Device, by: "cpu" | "mem"): string[] {
  const now = Date.now();
  const procs = processes(dev, now);
  const m = memory(dev, procs);
  const c = cpus(dev, procs)[0];
  const f1 = (n: number) => R(n.toFixed(1), 8);
  const sorted = [...procs].sort((a, b) => (by === "cpu" ? b.cpuPct - a.cpuPct : b.rssBytes - a.rssBytes));
  const time = (p: Proc) => {
    const cs = p.userTicks + p.systemTicks;
    return `${Math.floor(cs / 6000)}:${String(Math.floor((cs % 6000) / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
  };
  const row = (pid: string, user: string, pr: string, ni: string, virt: string, res: string, shr: string, s: string, cpu: string, mem: string, t: string, cmd: string) =>
    `${R(pid, 7)} ${user.padEnd(8)} ${R(pr, 3)} ${R(ni, 3)} ${R(virt, 7)} ${R(res, 6)} ${R(shr, 6)} ${s} ${R(cpu, 5)} ${R(mem, 5)} ${R(t, 9)} ${cmd}`;
  return [
    `top -${uptimeLine(dev, now)}`,
    `Tasks: ${R(procs.length, 3)} total,   0 running, ${R(procs.length, 3)} sleeping,   0 stopped,   0 zombie`,
    `%Cpu(s): ${R(c.user.toFixed(1), 4)} us, ${R(c.kernel.toFixed(1), 4)} sy,  0.0 ni, ${R(c.idle.toFixed(1), 4)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st`,
    `MiB Mem : ${f1(m.total / MiB)} total, ${f1(m.free / MiB)} free, ${f1(m.used / MiB)} used, ${f1(m.buffCache / MiB)} buff/cache`,
    `MiB Swap: ${f1(0)} total, ${f1(0)} free, ${f1(0)} used. ${f1((m.free + m.buffCache - SHMEM) / MiB)} avail Mem`,
    "",
    row("PID", "USER", "PR", "NI", "VIRT", "RES", "SHR", "S", "%CPU", "%MEM", "TIME+", "COMMAND"),
    ...sorted.map((p) => {
      const kb = Math.round(p.rssBytes / 1024);
      const virt = kb ? Math.round(kb * 2.6) + 12_000 : 0;
      return row(String(p.pid), "root", "20", "0", String(virt), String(kb), String(Math.round(kb * 0.55)), "S", p.cpuPct.toFixed(1), pctMem(p), time(p), p.name);
    }),
  ];
}

/** procps `free -m`. */
function freeM(dev: Device): string[] {
  const m = memory(dev);
  const mb = (b: number) => R(Math.floor(b / MiB), 11);
  return [
    "              total        used        free      shared  buff/cache   available",
    `${"Mem:".padEnd(7)} ${mb(m.total)} ${mb(m.used)} ${mb(m.free)} ${mb(SHMEM)} ${mb(m.buffCache)} ${mb(m.free + m.buffCache - SHMEM)}`,
    `${"Swap:".padEnd(7)} ${mb(0)} ${mb(0)} ${mb(0)}`,
  ];
}

// ---------------------------------------------------------------- system-health

interface HealthElem { name: string; status: string; type: string }

/**
 * health_checker stat on a VS: the System/Filesystem checks plus every critical
 * program of each running container (names with "-" → "_" as monit reports them).
 * VS has no PSU/fan/thermal objects, so the Hardware category is empty.
 */
function healthServices(dev: Device): HealthElem[] {
  const out: HealthElem[] = [
    { name: "sonic", status: "OK", type: "System" },
    { name: "root-overlay", status: "OK", type: "Filesystem" },
    { name: "var-log", status: "OK", type: "Filesystem" },
    { name: "rsyslog", status: "OK", type: "Process" },
  ];
  for (const f of featureRows(dev)) {
    if (f.state !== "enabled" && f.state !== "always_enabled") continue;
    for (const p of f.processes) {
      const name = p.replace(/-/g, "_");
      if (p !== "supervisord" && !out.some((e) => e.name === name)) out.push({ name, status: "OK", type: "Process" });
    }
  }
  return out;
}

function healthSummary(): string[] {
  return ["System status summary", "", "  System status LED  green", "  Services:", "    Status: OK", "  Hardware:", "    Status: OK"];
}

function healthMonitor(dev: Device): OutputLine[] {
  const rows = healthServices(dev).map((e) => [e.name, e.status, e.type]);
  return [line(""), line("System services and devices monitor list"), line(""), ...tabulate(["Name", "Status", "Type"], rows)];
}

function healthCmd(sub: "summary" | "detail" | "monitor-list"): SonicCmd["run"] {
  return (_a, ctx) => {
    const denied = needRoot(ctx, `system-health ${sub}`);
    if (denied) return denied;
    const dev = ctx.device;
    if (sub === "summary") return { output: lines(healthSummary()) };
    if (sub === "monitor-list") return { output: healthMonitor(dev) };
    // ignore list: the VS system_health_monitoring_config.json ignores nothing
    return { output: [...lines(healthSummary()), ...healthMonitor(dev), line(""), line("System services and devices ignore list"), line(""), ...tabulate(["Name", "Status", "Type"], [])] };
  };
}

// ---------------------------------------------------------------- feature / kdump

/** show feature config: FEATURE table State/AutoRestart and set_owner (init_cfg "local"). */
function featureConfig(args: string[], ctx: CommandContext): CommandResult {
  const name = positional(args)[0];
  let rows = featureRows(ctx.device);
  if (name) {
    rows = rows.filter((r) => r.name === name);
    if (!rows.length) return { output: [line(`Can not find feature ${name}`)] };
  }
  return { output: tabulate(["Feature", "State", "AutoRestart", "Owner"], rows.map((r) => [r.name, r.state, r.autoRestart, "local"])) };
}

/** sonic-kdump-config get_kdump_memory()/get_kdump_num_dumps() defaults. */
const KDUMP_MEMORY = "0M-2G:256M,2G-4G:320M,4G-8G:384M,8G-:448M";

function kdumpConfig(dev: Device): string[] {
  const st = cpGet(dev, "kdump") ?? {};
  const enabled = st.enabled === true;
  return [
    `Kdump administrative mode: ${enabled ? "Enabled" : "Disabled"}`,
    // the crash kernel is only loaded at boot, so a newly enabled kdump is not ready yet
    `Kdump operational mode: ${enabled ? "Ready after reboot" : "Not Ready"}`,
    `Kdump memory reservation: ${st.memory ?? KDUMP_MEMORY}`,
    `Maximum number of Kdump files: ${st.num_dumps ?? 3}`,
    "Kdump ssh connection string and ssh_path not found",
  ];
}

// ---------------------------------------------------------------- warm restart

/** WARM_RESTART timer field of each module (warm_restart.py tablelize). */
const WR_TIMER: Record<string, string> = { bgp: "bgp_timer", swss: "neighsyncd_timer", teamd: "teamsyncd_timer" };

function warmConfig(dev: Device): OutputLine[] {
  const st = cpGet(dev, "warm_restart") ?? {};
  const rows: string[][] = [];
  for (const m of ["bgp", "swss", "teamd", "system"]) {
    const timer = st[`${m}_timer`];
    const eoiu = m === "bgp" && st.bgp_eoiu !== undefined;
    const enable = st[`${m}_enable`] !== undefined;
    if (timer === undefined && !eoiu && !enable) continue;
    rows.push([m, enable ? "true" : "false", timer !== undefined ? WR_TIMER[m] : "NULL", timer !== undefined ? String(timer) : "NULL", eoiu ? "true" : "NULL"]);
  }
  return tabulate(["name", "enable", "timer_name", "timer_duration", "eoiu_enable"], rows);
}

/** Daemons that register with WarmStart; a cold boot leaves restore_count 0 and no state. */
const WARM_DAEMONS = ["orchagent", "neighsyncd", "vlanmgrd", "intfmgrd", "vrfmgrd", "nbrmgrd", "vxlanmgrd", "fdbsyncd", "syncd", "teammgrd", "teamsyncd", "fpmsyncd"];

function warmState(dev: Device): OutputLine[] {
  const running = new Set(processes(dev).map((p) => p.name));
  const rows = WARM_DAEMONS.filter((d) => running.has(d)).map((d) => [d, "0", ""]);
  return tabulate(["name", "restore_count", "state"], rows);
}

// ---------------------------------------------------------------- management

function mgmtAddress(dev: Device): string[] {
  const out: string[] = [];
  for (const m of dev.interfaces.filter((i) => i.management)) {
    const gw = dev.routingTable.find((r) => r.prefix === 0 && r.interfaceId === m.id && r.nextHop)?.nextHop ?? "";
    // MGMT_INTERFACE keys: eth0|<global address>
    const addrs = [...m.ipv4, ...m.ipv6.filter((a) => !isLinkLocal6(a.address))].map((a) => `${a.address}/${a.prefix}`);
    for (const a of addrs) out.push(`Management IP address = ${a}`, `Management Network Default Gateway = ${gw}`);
  }
  return out;
}

function mgmtVrfEnabled(dev: Device): boolean {
  return (peekFeatureState<{ vrfs?: { name: string }[] }>(dev, "vrf")?.vrfs ?? []).some((v) => v.name === "mgmt");
}

// ---------------------------------------------------------------- dispatch

const show: SonicCmd[] = [
  { path: ["clock"], summary: "Show date and time", run: (_a, ctx) => ({ output: [line(dateLine(ctx.device, Date.now()))] }) },
  { path: ["clock", "timezones"], summary: "List of available timezones", run: () => ({ output: lines(TIMEZONES) }) },
  { path: ["uptime"], summary: "Show system uptime", run: (_a, ctx) => ({ output: [line(uptimePretty(ctx.device, Date.now()))] }) },
  // proc.stdout.read() echoed with a trailing newline → blank last line
  { path: ["boot"], summary: "Show boot configuration", run: () => ({ output: lines([`Current: ${IMAGE}`, `Next: ${IMAGE}`, "Available: ", IMAGE, ""]) }) },

  // previous-reboot-cause.json of a first (cold) boot carries no cause → "Unknown"
  { path: ["reboot-cause"], summary: "Show cause of most recent reboot", run: () => ({ output: [line("Unknown")] }) },
  { path: ["reboot-cause", "all"], summary: "Show cause of most recent reboot (smartswitch only)", run: () => ({ output: [] }) },
  {
    path: ["reboot-cause", "history"],
    summary: "Show history of reboot-cause",
    run: (args, ctx) => {
      if (positional(args)[0]) return { output: [line("module option is supported only for smartswitch platform")] };
      return { output: tabulate(["Name", "Cause", "Time", "User", "Comment"], rebootHistory(ctx.device)) };
    },
  },

  clickGroup(["processes"], "Show process information", [["cpu", "Show processes CPU info"], ["memory", "Show processes memory info"], ["summary", "Show processes info"]]),
  { path: ["processes", "cpu"], summary: "Show processes CPU info", run: (_a, ctx) => ({ output: lines(top(ctx.device, "cpu")) }) },
  { path: ["processes", "memory"], summary: "Show processes memory info", run: (_a, ctx) => ({ output: lines(top(ctx.device, "mem")) }) },
  { path: ["processes", "summary"], summary: "Show processes info", run: (_a, ctx) => ({ output: lines(psSummary(ctx.device)) }) },
  { path: ["system-memory"], summary: "Show memory information", run: (_a, ctx) => ({ output: lines(freeM(ctx.device)) }) },

  clickGroup(["system-health"], "Show system-health information", [
    ["detail", "Show system-health detail information"],
    ["dpu", "Show system-health dpu information"],
    // Click 7 short help is cut at 78 - 6 - len("sysready-status") = 57 columns
    ["monitor-list", "Show system-health monitored services and devices name..."],
    ["summary", "Show system-health summary information"],
    ["sysready-status", "Show system-health system ready status"],
  ]),
  { path: ["system-health", "summary"], summary: "Show system-health summary information", run: healthCmd("summary") },
  { path: ["system-health", "detail"], summary: "Show system-health detail information", run: healthCmd("detail") },
  { path: ["system-health", "monitor-list"], summary: "Show system-health monitored services and devices", run: healthCmd("monitor-list") },
  {
    path: ["system-health", "sysready-status"],
    summary: "Show system-health system ready status",
    run: (args, ctx) => {
      const mode = positional(args)[0];
      return { output: lines(showStatus(ctx.device, mode === "brief" || mode === "detail" ? mode : "default")) };
    },
  },
  {
    path: ["system-health", "dpu"],
    summary: "Show system-health dpu information (smartswitch only)",
    run: (args) => {
      if (positional(args)[0]) return { output: [] }; // not a smartswitch: returns without output
      const p = "show system-health dpu";
      return { output: [line(`Usage: ${p} [OPTIONS] MODULE_NAME`), line(`Try "${p} -h" for help.`), line(""), err('Error: Missing argument "MODULE_NAME".')] };
    },
  },

  clickGroup(["feature"], "Show feature status", [["autorestart", "Show auto-restart state for a feature"], ["config", "Show feature config"], ["status", "Show feature state"]]),
  { path: ["feature", "config"], summary: "Show feature config", run: featureConfig },

  clickGroup(["kdump"], "Show kdump configuration, dump files and dmesg logs", [
    ["config", "Show the configuration of Linux kernel dump"],
    ["files", "Show kernel core dump and dmesg files"],
    ["logging", "Show last 10 lines of lastest kernel dmesg file"],
  ]),
  { path: ["kdump", "config"], summary: "Show the configuration of Linux kernel dump", run: (_a, ctx) => ({ output: lines(kdumpConfig(ctx.device)) }) },
  // no kernel crash has ever been captured: /var/crash is empty
  {
    path: ["kdump", "files"],
    summary: "Show kernel core dump and dmesg files",
    run: () => ({ output: tabulate(["Kernel core dump files", "Kernel dmesg files"], [["No kernel core dump file available!", "No kernel dmesg file available!"]], "center") }),
  },
  {
    path: ["kdump", "logging"],
    summary: "Show last lines of the latest kernel dmesg file",
    run: (args) => {
      const file = args.filter((a, i) => !a.startsWith("-") && !/^-(l|-lines)$/.test(args[i - 1] ?? ""))[0];
      return { output: [line(file ? `Invalid filename: '${file}'!` : "No kernel dmesg file available!")] };
    },
  },

  {
    path: ["techsupport"],
    summary: "Gather information for troubleshooting",
    run: (args, ctx) => {
      const w = wallParts(ctx.device, Date.now());
      const out = args.includes("--silent") ? [line("Techsupport is running with silent option. This command might take a long time.")] : [];
      out.push(
        line("Lock succesfully accquired and installed signal handlers"),
        muted("(generate_dump -v trace omitted: the simulator collects nothing and writes no archive)"),
        line(`/var/dump/sonic_dump_${ctx.device.config.hostname}_${w.Y}${w.M}${w.D}_${w.h}${w.m}${w.s}.tar.gz`),
      );
      return { output: out };
    },
  },

  {
    path: ["ztp"],
    summary: "Show Zero Touch Provisioning status",
    run: (_a, ctx) => {
      // same store as KLISH `ztp enable`; the image ships with ZTP enabled and the service idle
      const st = cpGet(ctx.device, "ztp") ?? {};
      const admin = st.adminMode === undefined ? true : Boolean(st.adminMode);
      return { output: lines([`ZTP Admin Mode : ${admin ? "True" : "False"}`, "ZTP Service    : Inactive", "ZTP Status     : Not Started"]) };
    },
  },
  // consutil: no CONSOLE_SWITCH|console_mgmt entry
  { path: ["line"], summary: "Show console lines", run: () => ({ output: [line("Console switch feature is disabled")] }) },
  {
    path: ["serial_console"],
    summary: "Show serial_console configuration",
    run: () => ({ output: tabulate(["inactivity-timeout", "sysrq-capabilities"], [["900 <default>", "disabled <default>"]]) }),
  },
  { path: ["ssh"], summary: "Show ssh configuration", run: () => ({ output: tabulate(["inactivity-timeout", "max-sessions"], [["900 <default>", "0 <default>"]]) }) },
  // `sensors` (lm-sensors) on a VM: no hwmon chips
  {
    path: ["environment"],
    summary: "Show environmentals (voltages, fans, temps)",
    run: () => ({ output: lines(["No sensors found!", "Make sure you loaded all the kernel drivers you need.", "Try sensors-detect to find out which these are."]) }),
  },
  {
    path: ["banner"],
    summary: "Show banner messages",
    run: (_a, ctx) => {
      // BANNER_MESSAGE|global from the KLISH `banner login|motd` store
      const st = cpGet(ctx.device, "banner") ?? {};
      const msg = (k: string) => String(st[k] ?? "").replace(/\\n/g, "\n");
      const state = st.login || st.motd ? "enabled" : "disabled";
      return { output: tabulate(["state", "login", "motd", "logout"], [[state, msg("login"), msg("motd"), ""]]) };
    },
  },
  { path: ["event-counters"], summary: "Show events counter", run: () => ({ output: lines(["No data available in COUNTERS_EVENTS", ""]) }) },

  clickGroup(["warm_restart"], "Show warm restart configuration and state", [["config", "Show warm restart config"], ["state", "Show warm restart state"]]),
  { path: ["warm_restart", "config"], summary: "Show warm restart config", run: (_a, ctx) => ({ output: warmConfig(ctx.device) }) },
  { path: ["warm_restart", "state"], summary: "Show warm restart state", run: (_a, ctx) => ({ output: warmState(ctx.device) }) },

  clickGroup(["management_interface"], "Show management interface parameters", [["address", "Show IP address configured for management interface"]]),
  { path: ["management_interface", "address"], summary: "Show IP address configured for management interface", run: (_a, ctx) => ({ output: lines(mgmtAddress(ctx.device)) }) },
  {
    path: ["mgmt-vrf"],
    summary: "Show management VRF attributes",
    run: (args, ctx) => {
      if (!mgmtVrfEnabled(ctx.device)) return { output: lines(["", "ManagementVRF : Disabled"]) };
      if (positional(args)[0] === "routes") return { output: lines(["", "Routes in Management VRF Routing Table:"]) };
      return { output: lines(["", "ManagementVRF : Enabled", "", "Management VRF interfaces in Linux:"]) };
    },
  },
  clickGroup(["dns"], "Show details of the static DNS configuration", [["nameserver", "Show static DNS configuration"]]),
];

export const sysinfoModule: SonicFeatureModule = {
  id: "system-info",
  config: [],
  show,
};
