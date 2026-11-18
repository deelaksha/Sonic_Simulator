/**
 * vrrp — report every VRRP group's LIVE roles (from the running VRRP daemon,
 * lib/protocols/vrrp-daemon.ts) and have each current Master re-announce its
 * VIP with a gratuitous ARP, so the result is visible in the packet timeline.
 * Failover itself is driven by the daemon's timers, not by this command.
 */
import { CommandHandler, CommandResult, OutputLine, line, muted } from "./types";

export const vrrpCommand: CommandHandler = {
  name: "vrrp",
  summary: "Show live VRRP roles and re-announce each Master (gratuitous ARP)",
  usage: "vrrp",
  help: [
    "VRRP",
    "",
    "Usage:",
    "  vrrp",
    "",
    "Lists each VRRP group with the live Master/Backup role of every router (the",
    "protocol runs continuously: advertisements every interval, Backup takes over",
    "after Master_Down_Interval), and has each current Master send a gratuitous ARP",
    "for its virtual IP. Shut the Master's interface, wait ~3-4 s, run it again.",
  ],
  run(_args, ctx): CommandResult {
    const { value: status, events } = ctx.runSim((sim) => sim.runVrrp());
    if (!status.length) return { output: [muted("No VRRP groups configured on this network")] };
    const out: OutputLine[] = [];
    for (const s of status) {
      out.push(line(`VIP ${s.vip} (VRID ${s.vrid}) — Master: ${s.master ?? "none (all routers down)"}`, "heading"));
      for (const r of s.roles) {
        out.push(line(`  ${r.device.padEnd(8)} ${r.role.padEnd(8)} priority ${r.priority}`, r.role === "Master" ? "success" : undefined));
      }
    }
    return { output: out, events };
  },
};
