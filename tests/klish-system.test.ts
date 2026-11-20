/**
 * KLISH `show` coverage for the system / QoS-buffer / platform family
 * (features/system-info-show.ts, qos-buffer-show.ts, event.ts, system-crm.ts,
 * usb.ts, threshold.ts): real template layouts rendered from live lab state.
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { setGrammar } from "../lib/sonic/grammar";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";
import { logEvent } from "../lib/control/syslog";

setGrammar(JSON.parse(readFileSync(join(process.cwd(), "data/sonic-cli-grammar.json"), "utf8")));

function lab(id: string, dev = "S1"): (cmd: string) => string {
  resetAll();
  S().loadFeatureLab(id);
  advance(5000);
  const d = byName(dev);
  return (cmd: string) => S().execCommand(d.id, cmd).output.map((o) => o.text).join("\n");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

const NOT_SIM = /not simulated/;

describe("show system …", () => {
  it("show system renders boot time, datetime and hostname", () => {
    const run = lab("lacp");
    const out = run("show system");
    expect(out).toMatch(/^-{59}\nAttribute {12}Value\/State\n-{59}/);
    expect(out).toMatch(/Boot Time {11}:\d\d:\d\d:\d\d/);
    expect(out).toMatch(/Current Datetime {4}:1970-01-01T00:16:45\+00:00/);
    expect(out).toContain(`Hostname            :${byName("S1").config.hostname}`);
  });

  it("show system processes lists the running containers' daemons with syslog-consistent PIDs", () => {
    const run = lab("lacp");
    const out = run("show system processes");
    expect(out).toMatch(/PID {12}%CPU {11}%MEMORY {8}MEM-USAGE\(Bytes\) {2}NAME/);
    for (const p of ["syncd", "orchagent", "bgpd", "lldpd", "teamd", "redis-server"]) expect(out).toMatch(new RegExp(`\\s${p}$`, "m"));
    // teamd_PortChannel1 logs as "teamd#teamd_PortChannel1[<pid>]" — the same PID owns the teamd process row
    const pid = /teamd#teamd_PortChannel1\[(\d+)\]/.exec(run("show logging"))?.[1];
    expect(pid).toBeDefined();
    expect(out).toMatch(new RegExp(`^${pid} +\\d+ +\\d+ +\\d+ +teamd$`, "m"));
    // sorted by PID by default; `cpu` sorts by %CPU descending (syncd is the busiest)
    const pids = out.split("\n").slice(3).map((l) => Number(l.split(/\s+/)[0]));
    expect(pids).toEqual([...pids].sort((a, b) => a - b));
    expect(run("show system processes cpu").split("\n")[3]).toMatch(/\ssyncd$/);
    expect(run("show system processes mem-usage").split("\n")[3]).toMatch(/\ssyncd$/);
  });

  it("disabling a feature stops its container's processes", () => {
    const run = lab("lacp");
    expect(run("show system processes")).toMatch(/\slldpd$/m);
    run("configure terminal");
    run("feature state lldp disabled");
    run("end");
    const out = run("show system processes");
    expect(out).not.toMatch(/\slldpd$/m);
    expect(out).toMatch(/\sorchagent$/m);
  });

  it("show system processes pid shows one process; unknown pid prints nothing", () => {
    const run = lab("lacp");
    const out = run("show system processes pid 1");
    expect(out).toContain("Name                :systemd");
    expect(out).toContain("Pid                 :1");
    expect(out).toMatch(/Start Time {10}:1970-01-01 00:16:40\+0000/);
    expect(run("show system processes pid 99999")).toBe("");
  });

  it("show system memory adds up and show system cpu follows the polling interval", () => {
    const run = lab("lacp");
    const mem = Object.fromEntries([...run("show system memory").matchAll(/^(\w[\w/]*) +:(\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
    expect(mem.Total).toBeGreaterThan(0);
    expect(mem.Used + mem.Free + mem["Buff/Cache"]).toBe(mem.Total);
    const cpu = run("show system cpu");
    expect(cpu).toMatch(/^Polling Interval: 120\.0 seconds\n-{70}\nCPU {17}%KERNEL {13}%USER {15}%IDLE/);
    expect(cpu).toMatch(/^CPU-ALL +\d+ +\d+ +\d+$/m);
    expect(cpu).toMatch(/^CPU-3 +\d+ +\d+ +\d+$/m);
    run("configure terminal");
    run("system resource-stats-polling-interval 30");
    run("end");
    expect(run("show system cpu")).toMatch(/^Polling Interval: 30\.0 seconds/);
  });

  it("show system status / config-update-time / vlan reserved", () => {
    const run = lab("lacp");
    expect(run("show system status brief")).toMatch(/^System is ready/);
    const st = run("show system status");
    expect(st).toMatch(/Service-Name +Service-Status +App-Ready-Status +Down-Reason/);
    expect(st).toMatch(/^swss +OK +OK +-$/m);
    expect(run("show system status detail")).toContain("AppStatus-UpdateTime");
    expect(run("show system config-update-time")).toMatch(/^Thu 01 Jan 1970 \d\d:\d\d:\d\d [AP]M UTC$/);
    expect(run("show system vlan reserved")).toBe("system vlan reservation: 3967-4094");
  });
});

describe("show uptime / users / reboot-cause / image / database", () => {
  it("renders the infra views", () => {
    const run = lab("lacp");
    expect(run("show uptime")).toMatch(/^ 00:16:45 up 0 min, {2}1 user, {2}load average: \d+\.\d\d, \d+\.\d\d, \d+\.\d\d$/);
    expect(run("show users")).toMatch(/^admin +ttyS0 +1970-01-01 00:16$/);
    expect(run("show users configured")).toMatch(/User {30}Role\(s\)\n-{70}\nadmin {29}admin/);
    expect(run("show users sshKey")).toBe("No SSH keys configured");
    expect(run("show reboot-cause")).toBe("Unknown");
  });

  it("show image list/status shows the one running image", () => {
    const run = lab("lacp");
    expect(run("show image list")).toBe("Current: SONiC-OS-Lab-Simulation\nNext: SONiC-OS-Lab-Simulation\n\n\nAvailable: \nSONiC-OS-Lab-Simulation");
    expect(run("show image status")).toContain("Global operation status  : GLOBAL_STATE_IDLE");
    expect(run("show image firmware")).toContain("Pending Firmware Upgrade(s)");
    expect(run("show image patch list")).toMatch(/Id {4}Tag/);
  });

  it("show database map lists the redis databases", () => {
    const run = lab("lacp");
    const out = run("show database map");
    expect(out).toContain(" ID             Name         Instance  TCP Port  Unix Socket Path");
    expect(out).toMatch(/^ {2}4 {8}CONFIG_DB {12}redis {6}6379 {2}\/var\/run\/redis\/redis\.sock$/m);
  });

  it("show in-memory-logging mirrors the syslog ring", () => {
    const run = lab("lacp");
    const n = Number(run("show in-memory-logging count"));
    expect(n).toBeGreaterThan(0);
    expect(run("show in-memory-logging").split("\n")).toHaveLength(n);
    expect(run("show in-memory-logging lines 2").split("\n")).toHaveLength(2);
  });

  it("show swsslog-configuration prints the LOGGER table like swssloglevel -p", () => {
    const run = lab("lacp");
    const out = run("show swsslog-configuration");
    expect(out).toMatch(/^orchagent {21}NOTICE$/m);
    expect(out).toMatch(/^SAI_API_PORT {18}SAI_LOG_LEVEL_NOTICE$/m);
  });

  it("tech-support: summary + status + terminal", () => {
    const run = lab("lacp");
    expect(run("show tech-support")).toMatch(/^%Info: Tech-support collection started \(\/var\/dump\/sonic_dump_/);
    expect(run("show tech-support status")).toMatch(/^Status: Completed\nFile Name: \/var\/dump\/sonic_dump_.*\.tar\.gz$/);
    const term = run("show tech-support terminal");
    expect(term).toContain("# show uptime");
    expect(term).toContain("Current: SONiC-OS-Lab-Simulation");
  });

  it("platform empties: usb, cable-diagnostics, error-database", () => {
    const run = lab("lacp");
    expect(run("show usb devices")).toMatch(/Device name {6}Manufacturer {5}Model Name/);
    expect(run("show usb partitions")).toMatch(/Device name {6}Mount Dir {8}Filesystem/);
    expect(run("show cable-diagnostics cable-length Ethernet 0")).toMatch(/Interface {5}Type {6}Length[\s\S]*\nEthernet0$/);
    expect(run("show error-database")).toBe("");
  });
});

describe("show event / alarm", () => {
  it("events derive from logged state changes (BGP adjacencies)", () => {
    const run = lab("bgp");
    const out = run("show event");
    expect(out).toMatch(/Id {11}Action {3}Severity {8}Name {27}Source {10}Timestamp {19}Description/);
    expect(out).toMatch(/^1 +- +INFORMATIONAL +BGP_NEIGHBOR_STATE_CHANGE +\d+\.\d+\.\d+\.\d+ +1970-01-01T\d\d:\d\d:\d\d\.\d{3}Z +BGP neighbor/m);
    expect(run("show event details")).toContain("Event Details - 1");
    expect(run("show event summary")).toMatch(/Total: +\d+/);
  });

  it("an unidirectional UDLD link raises an alarm; acknowledge hides it from `show alarm`", () => {
    const run = lab("lacp");
    const dev = byName("S1");
    logEvent(dev, Date.now(), "WARNING", "udld", "UDLD unidirectional link detected on Ethernet0 (no echo)");
    const al = run("show alarm");
    const id = /^(\d+) +MAJOR +UDLD_UNIDIRECTIONAL +Ethernet0/m.exec(al)?.[1];
    expect(id).toBeDefined();
    expect(run("show alarm summary")).toMatch(/Major: +1/);
    expect(run(`alarm acknowledge ${id}`)).toBe("");
    expect(run("show alarm")).toBe("");
    expect(run("show alarm acknowledged")).toContain("UDLD_UNIDIRECTIONAL");
    expect(run(`show alarm id ${id}`)).toMatch(/Acknowledged: +True/);
    // the store may have replaced the device object while running commands: log on the live one
    logEvent(byName("S1"), Date.now(), "INFO", "udld", "UDLD link on Ethernet0 is bidirectional (neighbor S2 Ethernet0)");
    expect(run("show alarm all")).toBe("");
  });
});

describe("show crm / hardware / threshold", () => {
  it("show crm resources counts the live tables against the VS SAI capacity", () => {
    const run = lab("bgp");
    const dev = byName("S1");
    const r = run("show crm resources ipv4 route");
    expect(r).toMatch(/^Resource Name {11}Used Count {4}Available Count\n-{20} {2}-{12} {2}-{17}/);
    expect(r).toMatch(new RegExp(`^ipv4_route +${dev.routingTable.length} +100000$`, "m"));
    const all = run("show crm resources all");
    expect(all).toMatch(new RegExp(`^ipv4_neighbor +${dev.arpTable.length} +4000$`, "m"));
    expect(all).toMatch(/^INGRESS  PORT {10}acl_table +0 +3$/m);
  });

  it("show hardware tcam allocation lists every feature per stage", () => {
    const run = lab("lacp");
    const out = run("show hardware tcam allocation ingress");
    expect(out).toMatch(/^Ingress:\n-{91}\nFeature/);
    expect(out).toMatch(/^ip-acl +- +-$/m);
    expect(out).not.toContain("Egress:");
  });

  it("show threshold breaches is empty; buffer-pool interface filter accepts `Ethernet 0`", () => {
    const run = lab("lacp");
    expect(run("show threshold breaches")).toBe("");
    run("configure terminal");
    run("interface Ethernet 0");
    run("threshold buffer-pool egress_lossy_pool unicast 50");
    run("end");
    expect(run("show threshold buffer-pool interface Ethernet 0")).toContain("Interface: Ethernet0  Pool: egress_lossy_pool");
  });
});

describe("show queue / priority-group / buffer / pfc", () => {
  it("queue counters per interface and per queue", () => {
    const run = lab("lacp");
    const all = run("show queue counters");
    expect(all).toMatch(/^-{161}\nPort {8}TxQ {2}Counter\/pkts/);
    expect(all).toMatch(/^Ethernet0 {3}UC0 {2}\d+/m);
    const one = run("show queue counters interface Ethernet 0 queue 3");
    expect(one.split("\n")).toHaveLength(4);
    expect(one).toMatch(/^UC3 {2}\d+ +\d+ +0\/s +0\/s +0\/s +\d+ +\d+$/m);
    const cpu = run("show queue counters interface CPU queue 23");
    expect(cpu).toMatch(/^MC23 \d+/m);
    expect(run("show queue wred-ecn counters interface Ethernet 0")).toMatch(/TxQ {2}WRED Drops\/Pkts/);
  });

  it("queue / PG watermark grids", () => {
    const run = lab("lacp");
    expect(run("show queue watermark unicast")).toMatch(/^Egress queue watermark per unicast queue:\n\n-{92}\nPort {8}UC0 {7}UC1/);
    expect(run("show queue persistent-watermark multicast interface Ethernet 1")).toMatch(/^Egress queue persistent watermark per multicast queue:\n\n-{80}\nMC8 {7}MC9/);
    expect(run("show queue watermark CPU")).toMatch(/^Egress queue watermark per CPU queue:\n-{67}\nTxQ {7}Bytes/);
    expect(run("show priority-group watermark shared interface Ethernet 0")).toMatch(/^Ingress shared pool watermark per PG:\n-{79}\nPG0 {7}PG1/);
    expect(run("show priority-group persistent-watermark headroom")).toMatch(/^Ingress headroom persistent watermark per PG:\n-{89}\nPort {8}PG0/);
  });

  it("buffer pools / profiles / per-interface bindings / pool watermarks", () => {
    const run = lab("lacp");
    expect(run("show buffer pool")).toContain("egress_lossy_pool:\n   size                      : 7326924\n   type                      : egress\n   mode                      : dynamic");
    expect(run("show buffer profile")).toContain("egress_lossless_profile:\n   pool                      : egress_lossless_pool");
    expect(run("show buffer interface Ethernet 0 priority-group")).toBe("Interface       priority-group  Profile\nEthernet0       0               ingress_lossy_profile");
    expect(run("show buffer-pool watermark")).toMatch(/^-{65}\nPool {26}Bytes \(Total\) {5}Bytes \(Multicast\)/);
    expect(run("show device watermark")).toMatch(/^Utilization \(Bytes\) {3}: \d+\nUtilization \(Percent\) : \d+$/);
  });

  it("show priority-flow-control watchdog follows the configured polling interval", () => {
    const run = lab("lacp");
    expect(run("show priority-flow-control watchdog")).toContain("Polling Interval:   : Not Configured (default 100ms)");
    run("configure terminal");
    run("priority-flow-control watchdog polling-interval 400");
    run("end");
    expect(run("show priority-flow-control")).toContain("Polling Interval:   : 400");
  });

  it("show service-policy CtrlPlane renders the CoPP policy", () => {
    const run = lab("lacp");
    const out = run("show service-policy CtrlPlane");
    expect(out).toMatch(/^CtrlPlane\n {2}Policy copp-system-policy type copp at ingress/);
    expect(out).toMatch(/Flow copp-system-lacp at priority 23 \(Active\)/);
  });
});

describe("no family command falls back to 'not simulated'", () => {
  it.each([
    "show system", "show system memory", "show system cpu", "show system processes mem-util", "show system status core",
    "show uptime", "show users all", "show reboot-cause", "show config-reload status", "show image firmware status",
    "show image patch status", "show image patch history", "show database map", "show in-memory-logging", "show audit-log",
    "show audit-log all", "show auditd-system log", "show event recent 5min", "show event severity warning", "show alarm detail",
    "show crm resources fdb", "show hardware tcam allocation", "show buffer interface Ethernet 0 queue", "show buffer-pool persistent-watermark percentage",
    "show device persistent-watermark", "show priority-group watermark percentage shared", "show queue watermark percentage unicast",
    "show queue persistent-watermark CPU", "show service-policy Switch", "show switch-profiles", "show techsupport-export",
    "show debug ptp", "show histogram memory system", "show threshold breaches", "show watermark", "show usb devices",
    "show cable-diagnostics report",
  ])("%s", (cmd) => {
    const run = lab("lacp");
    const out = run(cmd);
    expect(out).not.toMatch(NOT_SIM);
    expect(out).not.toMatch(/^% /);
  });
});
