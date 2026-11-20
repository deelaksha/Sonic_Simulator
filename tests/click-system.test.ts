/**
 * Click `show` system-information commands (lib/commands/sonic/sysinfo.ts and the
 * platform additions in platform.ts): sonic-utilities headers/messages rendered
 * from the live lab switch (processes, uptime, FEATURE table, config-plane state).
 */
import "../lib/commands/sonic-cli/features";
import "../lib/labs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetAll } from "./helpers";
import { S, advance, byName } from "./control-helpers";
import { processes } from "../lib/protocols/system-resources";

/** Load a lab, drop S1 from KLISH to bash, return a runner for that shell. */
function bash(): (cmd: string) => string {
  resetAll();
  S().loadFeatureLab("lacp");
  advance(5000);
  const id = byName("S1").id;
  S().execCommand(id, "exit");
  return (cmd: string) => S().execCommand(id, cmd).output.map((o) => o.text).join("\n");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("clock / uptime / boot / reboot-cause", () => {
  it("show clock prints `date` in the configured timezone; timezones lists tzdata names", () => {
    const run = bash();
    expect(run("show clock")).toBe("Thu Jan  1 00:16:45 UTC 1970");
    expect(run("show clock timezones").split("\n")).toContain("Asia/Kolkata");
  });

  it("show uptime follows the sim clock (uptime -p)", () => {
    const run = bash();
    expect(run("show uptime")).toBe("up 0 minutes");
    advance(2 * 3600_000 + 5 * 60_000, 60_000);
    expect(run("show uptime")).toBe("up 2 hours, 5 minutes");
  });

  it("show boot lists the running image (sonic-installer list)", () => {
    expect(bash()("show boot")).toMatch(/^Current: SONiC-OS-Lab-Simulation\nNext: SONiC-OS-Lab-Simulation\nAvailable: \nSONiC-OS-Lab-Simulation/);
  });

  it("show reboot-cause / history / all on a cold-booted non-smartswitch", () => {
    const run = bash();
    expect(run("show reboot-cause")).toBe("Unknown");
    expect(run("show reboot-cause all")).toBe("");
    const h = run("show reboot-cause history").split("\n");
    expect(h[0]).toMatch(/^Name +Cause +Time +User +Comment$/);
    expect(h[2]).toMatch(/^\d{4}_\d\d_\d\d_\d\d_\d\d_\d\d  Unknown  N\/A +N\/A +N\/A$/);
    expect(run("show reboot-cause history DPU0")).toBe("module option is supported only for smartswitch platform");
  });
});

describe("processes / system-memory", () => {
  it("show processes is a Click group without a default command", () => {
    const out = bash()("show processes");
    expect(out).toMatch(/^Usage: show processes \[OPTIONS\] COMMAND \[ARGS\]\.\.\.\n\n {2}Show process information/);
    expect(out).toMatch(/Commands:\n {2}cpu +Show processes CPU info\n {2}memory +Show processes memory info\n {2}summary +Show processes info/);
  });

  it("show processes summary lists the live process table (ps -eo pid,ppid,cmd,%mem,%cpu)", () => {
    const run = bash();
    const out = run("show processes summary").split("\n");
    expect(out[0]).toBe("    PID    PPID CMD                         %MEM %CPU");
    expect(out[1]).toMatch(/^ {6}1 {7}0 \/sbin\/init/);
    const orch = processes(byName("S1")).find((p) => p.name === "orchagent")!;
    expect(out.some((l) => l.startsWith(`${String(orch.pid).padStart(7)} `) && l.includes("/usr/bin/orchagent"))).toBe(true);
    // disabling a feature removes its daemons from the table
    run("sudo config feature state lldp disabled");
    expect(run("show processes summary")).not.toContain("/usr/bin/lldpd");
  });

  it("show processes cpu|memory render top's batch output sorted on the field", () => {
    const run = bash();
    const cpu = run("show processes cpu").split("\n");
    expect(cpu[0]).toMatch(/^top - 00:16:45 up 0 min, {2}1 user, {2}load average: /);
    expect(cpu[1]).toMatch(/^Tasks: +\d+ total/);
    expect(cpu[2]).toMatch(/^%Cpu\(s\): /);
    expect(cpu[3]).toMatch(/^MiB Mem : +15695\.4 total/);
    expect(cpu[6]).toBe("    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND");
    expect(cpu[7]).toMatch(/ syncd$/); // syncd is the busiest process
    const mem = run("show processes memory").split("\n");
    expect(mem[7]).toMatch(/ syncd$/); // and the largest
  });

  it("show system-memory is free -m of the simulated box", () => {
    const out = bash()("show system-memory").split("\n");
    expect(out[0]).toBe("              total        used        free      shared  buff/cache   available");
    expect(out[1]).toMatch(/^Mem: +15695 +\d+ +\d+ +\d+ +\d+ +\d+$/);
    expect(out[2]).toMatch(/^Swap: +0 +0 +0$/);
  });
});

describe("system-health", () => {
  it("bare group prints Click usage with the truncated short help", () => {
    const out = bash()("show system-health");
    expect(out).toContain("Usage: show system-health [OPTIONS] COMMAND [ARGS]...");
    expect(out).toContain("  monitor-list     Show system-health monitored services and devices name...");
  });

  it("summary/detail/monitor-list need root and list the running containers' programs", () => {
    const run = bash();
    expect(run("show system-health summary")).toMatch(/^Root privileges are required for this operation/);
    expect(run("sudo show system-health summary")).toBe(
      "System status summary\n\n  System status LED  green\n  Services:\n    Status: OK\n  Hardware:\n    Status: OK",
    );
    const mon = run("sudo show system-health monitor-list");
    expect(mon).toMatch(/^\nSystem services and devices monitor list\n\nName +Status +Type\n/);
    expect(mon).toMatch(/^orchagent +OK +Process$/m);
    expect(mon).toMatch(/^lldp_syncd +OK +Process$/m);
    expect(mon).toMatch(/^var-log +OK +Filesystem$/m);
    run("sudo config feature state lldp disabled");
    expect(run("sudo show system-health monitor-list")).not.toMatch(/^lldpd /m);
    expect(run("sudo show system-health detail")).toMatch(/System services and devices ignore list\n\nName +Status +Type\n-+ +-+ +-+$/);
  });

  it("sysready-status [brief|detail] is sysreadyshow; dpu on a non-smartswitch", () => {
    const run = bash();
    const st = run("show system-health sysready-status");
    expect(st).toMatch(/^System is ready\n\nService-Name +Service-Status +App-Ready-Status +Down-Reason\n/);
    expect(st).toMatch(/^swss +OK +OK +-$/m);
    expect(run("show system-health sysready-status brief")).toBe("System is ready\n");
    expect(run("show system-health sysready-status detail")).toContain("AppStatus-UpdateTime");
    expect(run("show system-health dpu")).toContain('Error: Missing argument "MODULE_NAME".');
    expect(run("show system-health dpu DPU0")).toBe("");
  });
});

describe("feature / kdump / warm_restart", () => {
  it("show feature is a group; feature config follows the FEATURE table", () => {
    const run = bash();
    expect(run("show feature")).toMatch(/^Usage: show feature \[OPTIONS\] COMMAND/);
    run("sudo config feature state nat enabled");
    const cfg = run("show feature config");
    expect(cfg).toMatch(/^Feature +State +AutoRestart +Owner\n/);
    expect(cfg).toMatch(/^nat +enabled +enabled +local$/m);
    expect(cfg).toMatch(/^database +always_enabled +always_enabled +local$/m);
    expect(run("show feature config nope")).toBe("Can not find feature nope");
    // consistent with the existing status view
    expect(run("show feature status nat")).toMatch(/^nat +enabled +enabled$/m);
  });

  it("show kdump config reflects the KLISH kdump store over the sonic-kdump-config defaults", () => {
    const run = bash();
    expect(run("show kdump config")).toBe(
      [
        "Kdump administrative mode: Disabled",
        "Kdump operational mode: Not Ready",
        "Kdump memory reservation: 0M-2G:256M,2G-4G:320M,4G-8G:384M,8G-:448M",
        "Maximum number of Kdump files: 3",
        "Kdump ssh connection string and ssh_path not found",
      ].join("\n"),
    );
    const id = byName("S1").id;
    S().execCommand(id, "sonic-cli");
    for (const c of ["configure terminal", "kdump enable", "kdump num-dumps 5", "end", "exit"]) S().execCommand(id, c);
    const out = run("show kdump config");
    expect(out).toContain("Kdump administrative mode: Enabled");
    expect(out).toContain("Kdump operational mode: Ready after reboot");
    expect(out).toContain("Maximum number of Kdump files: 5");
    expect(run("show kdump files")).toMatch(/Kernel core dump files +Kernel dmesg files\n-+ +-+\nNo kernel core dump file available! +No kernel dmesg file available!/);
    expect(run("show kdump logging")).toBe("No kernel dmesg file available!");
  });

  it("show warm_restart state/config", () => {
    const run = bash();
    const st = run("show warm_restart state");
    expect(st).toMatch(/^name +restore_count +state\n/);
    expect(st).toMatch(/^orchagent +0$/m);
    expect(run("show warm_restart config")).toBe(
      "name    enable    timer_name    timer_duration    eoiu_enable\n------  --------  ------------  ----------------  -------------",
    );
  });
});

describe("misc system groups", () => {
  it("show techsupport prints the archive name without collecting anything", () => {
    expect(bash()("show techsupport")).toMatch(/Lock succesfully accquired and installed signal handlers[\s\S]*\/var\/dump\/sonic_dump_S1_19700101_001645\.tar\.gz$/);
  });

  it("serial_console / ssh / banner / line / environment / event-counters / ztp", () => {
    const run = bash();
    expect(run("show serial_console")).toBe("inactivity-timeout    sysrq-capabilities\n--------------------  --------------------\n900 <default>         disabled <default>");
    expect(run("show ssh")).toBe("inactivity-timeout    max-sessions\n--------------------  --------------\n900 <default>         0 <default>");
    expect(run("show banner")).toMatch(/^state +login +motd +logout\n/);
    expect(run("show line")).toBe("Console switch feature is disabled");
    expect(run("show environment")).toMatch(/^No sensors found!/);
    expect(run("show event-counters")).toBe("No data available in COUNTERS_EVENTS\n");
    expect(run("show ztp")).toMatch(/^ZTP Admin Mode : True/);
  });

  it("management_interface / mgmt-vrf / dns", () => {
    const run = bash();
    expect(run("show management_interface")).toMatch(/^Usage: show management_interface \[OPTIONS\] COMMAND \[ARGS\]\.\.\./);
    const eth0 = byName("S1").interfaces.find((i) => i.management)!.ipv4[0];
    expect(run("show management_interface address")).toContain(`Management IP address = ${eth0.address}/${eth0.prefix}`);
    expect(run("show mgmt-vrf")).toBe("\nManagementVRF : Disabled");
    expect(run("show dns")).toMatch(/^Usage: show dns \[OPTIONS\] COMMAND[\s\S]*nameserver +Show static DNS configuration/);
    expect(run("show dns bogus")).toContain('Error: No such command "bogus".');
  });
});

describe("platform (show/platform.py on a VS)", () => {
  it("bare group, fan/voltage/current/pcieinfo/firmware", () => {
    const run = bash();
    const usage = run("show platform");
    expect(usage).toMatch(/^Usage: show platform \[OPTIONS\] COMMAND \[ARGS\]\.\.\./);
    for (const c of ["current", "fan", "firmware", "pcieinfo", "voltage"]) expect(usage).toMatch(new RegExp(`^  ${c} `, "m"));
    expect(run("show platform fan")).toBe("Fan Not detected\n");
    expect(run("show platform voltage")).toBe("Sensor not detected");
    expect(run("show platform current")).toBe("Sensor not detected");
    expect(run("show platform pcieinfo")).toBe(`${"=".repeat(30)}Display PCIe Device${"=".repeat(31)}`);
    expect(run("show platform firmware")).toMatch(/^Usage: fwutil show \[OPTIONS\] COMMAND/);
  });
});
