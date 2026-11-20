/**
 * Deterministic host resource model of a simulated SONiC switch — what the
 * openconfig-system `state`, `memory`, `cpus` and `processes` containers report
 * (KLISH `show system …`, `show uptime`, `show users`).
 *
 * Processes are the box's real ones: a fixed set of host daemons plus, for every
 * RUNNING container of the FEATURE table (lib/protocols/cpu-features.ts), its
 * containerd-shim and the supervisord programs from the container's
 * supervisord.conf — so `config feature state lldp disabled` removes lldpd & co.
 * teamd runs one `teamd` instance per PortChannel. PIDs of containerised
 * programs reuse the syslog fakePid() (lib/control/syslog.ts) so the PID in
 * `show logging` ("teamd#teamd_PortChannel1[6830]") matches the process table.
 * RSS / %CPU are fixed per program (scaled by live table sizes where the real
 * daemon grows: bgpd/zebra with routes, orchagent/syncd with FDB+neighbours).
 *
 * Boot time: the first time anything asks, the earliest syslog line (the lab's
 * boot messages) or "now" — then frozen in features["system-boot"].
 */
import { Device } from "../models/device";
import { featureState } from "../models/feature-state";
import { featureRows, containerTimes } from "./cpu-features";
import { fakePid, peekSyslog } from "../control/syslog";

export const CPU_CORES = 4;
/** MemTotal of the simulated box (bytes). */
export const MEM_TOTAL = 16_457_830_400;
/** Kernel + page tables + slab not attributable to a process (bytes). */
const MEM_KERNEL = 1_181_220_864;
const BUFF_CACHE = 2_903_552_000;

export interface Proc {
  pid: number;
  name: string;
  /** container (FEATURE) the process runs in; "" = host */
  container: string;
  rssBytes: number;
  cpuPct: number;
  memPct: number;
  startMs: number;
  /** CPU time (ticks of 10ms) spent in user / kernel since start */
  userTicks: number;
  systemTicks: number;
  args: string[];
}

/** Boot time of the box (wall ms), frozen on first use. */
export function bootMs(device: Device): number {
  const st = featureState<{ atMs?: number }>(device, "system-boot", () => ({}));
  if (st.atMs === undefined) {
    const first = peekSyslog(device)?.lines[0]?.atMs;
    st.atMs = Math.min(first ?? Date.now(), Date.now());
  }
  return st.atMs;
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/** Typical resident size (KB) and %CPU of each program on an idle Broadcom box. */
const PROFILE: Record<string, [number, number]> = {
  systemd: [11_480, 0], kthreadd: [0, 0], "systemd-journald": [48_212, 0], "systemd-udevd": [7_904, 0],
  rsyslogd: [6_220, 0], cron: [2_896, 0], sshd: [7_452, 0], containerd: [47_116, 0], dockerd: [91_340, 0],
  monit: [3_212, 0], hostcfgd: [38_604, 0], caclmgrd: [36_980, 0], procdockerstatsd: [31_476, 0], featured: [30_112, 0],
  clish: [24_660, 0], "containerd-shim": [10_312, 0],
  supervisord: [22_120, 0], "redis-server": [17_892, 1], orchagent: [41_276, 1], syncd: [248_516, 2],
  zebra: [21_612, 0], bgpd: [24_904, 0], ospfd: [10_920, 0], bfdd: [8_120, 0], staticd: [7_208, 0], mgmtd: [9_316, 0],
  fpmsyncd: [14_552, 0], bgpcfgd: [44_780, 0], bgpmon: [33_420, 0], lldpd: [6_584, 0], "lldp-syncd": [35_916, 0],
  lldpmgrd: [31_208, 0], snmpd: [16_048, 0], "snmp-subagent": [58_332, 0], "rest-server": [96_204, 0],
  "gnmi-native": [61_772, 0], teamd: [6_840, 0], teammgrd: [9_116, 0], teamsyncd: [9_908, 0], tlm_teamd: [8_016, 0],
  xcvrd: [52_664, 0], psud: [34_208, 0], thermalctld: [36_516, 0], pcied: [29_948, 0], ledd: [28_712, 0], syseepromd: [29_108, 0],
};

const HOST: [string, number][] = [
  ["systemd", 1], ["kthreadd", 2], ["systemd-journald", 312], ["systemd-udevd", 338], ["rsyslogd", 612], ["cron", 640],
  ["sshd", 701], ["containerd", 733], ["dockerd", 905], ["monit", 1127], ["hostcfgd", 1190], ["caclmgrd", 1203],
  ["procdockerstatsd", 1215], ["featured", 1228], ["clish", 2481],
];

/** The live process table, sorted by PID. */
export function processes(device: Device, nowMs = Date.now()): Proc[] {
  const boot = bootMs(device);
  const used = new Set<number>();
  const take = (want: number): number => {
    let p = want;
    while (used.has(p)) p++;
    used.add(p);
    return p;
  };
  const routes = device.routingTable.length + device.routingTable6.length;
  const tables = device.macTable.length + device.arpTable.length + device.ndpTable.length;
  const grow = (name: string): number =>
    name === "bgpd" || name === "zebra" ? routes * 2 : name === "orchagent" || name === "syncd" ? tables + routes : 0;
  const out: Proc[] = [];
  const add = (name: string, container: string, pid: number, startMs: number, args: string[] = []) => {
    const [kb, cpu] = PROFILE[name] ?? [8_000 + (hash(name) % 24_000), 0];
    const rssBytes = (kb + grow(name)) * 1024;
    const upTicks = Math.max(0, Math.floor((nowMs - startMs) / 10));
    const busy = Math.floor((upTicks * Math.max(cpu, 0.05)) / 100);
    out.push({
      pid, name, container, rssBytes, cpuPct: cpu, memPct: Math.floor((rssBytes * 100) / MEM_TOTAL), startMs,
      userTicks: Math.floor((busy * 2) / 3), systemTicks: busy - Math.floor((busy * 2) / 3), args,
    });
  };
  for (const [name, pid] of HOST) add(name, "", take(pid), boot + (pid < 400 ? 0 : 4_000 + (pid % 97) * 50));
  const times = containerTimes(device);
  const lags = device.interfaces.filter((i) => /^PortChannel\d+$/.test(i.name)).map((i) => i.name);
  for (const f of featureRows(device)) {
    if (f.state !== "enabled" && f.state !== "always_enabled") continue;
    const start = Math.max(boot, times[f.name]?.startedMs ?? boot) + 20_000 + (hash(f.name) % 40) * 500;
    add("containerd-shim", "", take(fakePid(`containerd-shim#${f.name}`)), start, ["-namespace", "moby", "-id", f.name]);
    for (const p of f.processes) add(p, f.name, take(fakePid(`${f.name}#${p}`)), start + 1_000);
    if (f.name === "teamd") for (const lag of lags) add("teamd", "teamd", take(fakePid(`teamd#teamd_${lag}`)), start + 2_000, ["-r", "-t", lag]);
  }
  return out.sort((a, b) => a.pid - b.pid);
}

export interface MemInfo {
  total: number;
  used: number;
  free: number;
  buffCache: number;
}

export function memory(device: Device, procs = processes(device)): MemInfo {
  const used = MEM_KERNEL + procs.reduce((n, p) => n + p.rssBytes, 0);
  return { total: MEM_TOTAL, used, buffCache: BUFF_CACHE, free: MEM_TOTAL - used - BUFF_CACHE };
}

export interface CpuRow {
  /** "ALL" or the core number */
  cpu: string;
  kernel: number;
  user: number;
  idle: number;
}

/** Instantaneous per-core utilisation: the processes' %CPU spread over the cores. */
export function cpus(device: Device, procs = processes(device)): CpuRow[] {
  const user = procs.reduce((n, p) => n + p.cpuPct, 0);
  const kernel = Math.max(1, Math.round(user / 2));
  const rows: CpuRow[] = [{ cpu: "ALL", kernel, user, idle: Math.max(0, 100 - user - kernel) }];
  for (let c = 0; c < CPU_CORES; c++) {
    // syncd/orchagent are pinned by the scheduler to the low cores in practice; spread the rest.
    const u = c === 0 ? Math.ceil(user * 1.6) : c === 1 ? user : Math.floor(user / 2);
    const k = c === 0 ? kernel + 1 : kernel;
    rows.push({ cpu: String(c), kernel: k, user: u, idle: Math.max(0, 100 - u - k) });
  }
  return rows;
}

/** 1/5/15-minute load averages derived from the CPU busy fraction. */
export function loadAverage(device: Device, procs = processes(device)): [string, string, string] {
  const all = cpus(device, procs)[0];
  const busy = ((all.user + all.kernel) / 100) * CPU_CORES;
  return [busy * 1.12, busy * 1.05, busy].map((v) => v.toFixed(2)) as [string, string, string];
}

/** `uptime` (procps) line: " 10:26:34 up 3 days,  3:09,  1 user,  load average: 0.36, 0.33, 0.31". */
export function uptimeLine(device: Device, nowMs = Date.now(), users = 1, timeOfDay?: string): string {
  const secs = Math.max(0, Math.floor((nowMs - bootMs(device)) / 1000));
  const days = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  let up = days ? `${days} day${days === 1 ? "" : "s"}, ` : "";
  up += h ? `${String(h).padStart(2, " ")}:${String(m).padStart(2, "0")}` : `${m} min`;
  const [l1, l5, l15] = loadAverage(device);
  const now = new Date(nowMs);
  const tod = timeOfDay ?? [now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return ` ${tod} up ${up},  ${users} user${users === 1 ? "" : "s"},  load average: ${l1}, ${l5}, ${l15}`;
}
