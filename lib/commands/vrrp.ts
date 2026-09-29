/**
 * vrrp — run the VRRP election and advertise (gratuitous ARP) for the current
 * master(s). Emits packets/events (VRRP_MASTER, VRRP_FAILOVER, the gratuitous
 * ARP flood) so the failover is visible in the packet timeline: run it, shut the
 * master, run it again → the timeline shows the backup taking over.
 */
import { CommandHandler, CommandResult, OutputLine, line, muted } from "./types";

export const vrrpCommand: CommandHandler = {
  name: "vrrp",
  summary: "Run VRRP election + advertise the master (shows failover in the timeline)",
  usage: "vrrp",
  help: [
    "VRRP",
    "",
    "Usage:",
    "  vrrp",
    "",
    "Runs the VRRP master election and has each current Master send a gratuitous",
    "ARP for its virtual IP. Watch the packet timeline: after you shut the current",
    "master's interface, running `vrrp` again shows the VRRP_FAILOVER event and the",
    "backup announcing the virtual MAC as it takes over.",
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
