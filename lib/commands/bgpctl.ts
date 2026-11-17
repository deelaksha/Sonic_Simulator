/**
 * `bgp converge` — lab helper (not an FRR command). BGP normally runs by itself:
 * the bgpd daemon (lib/protocols/bgp-daemon.ts) opens TCP/179 sessions, keeps
 * them alive and exchanges UPDATEs on wall-clock timers. This command forces
 * every pending connect timer due and runs the daemons until nothing is due, so
 * sessions come up immediately instead of after the ConnectRetry interval.
 */
import { CommandHandler, CommandResult, line, muted } from "./types";
import { firstPositional } from "./parser";

export const bgpCommand: CommandHandler = {
  name: "bgp",
  summary: "Bring BGP sessions up now (forces connect timers; BGP otherwise runs continuously)",
  usage: "bgp converge",
  help: [
    "BGP",
    "",
    "Usage:",
    "  bgp converge",
    "",
    "BGP sessions start on their own once `router bgp <as>` + `neighbor <ip> remote-as <as>`",
    "are configured (TCP handshake → OPEN → KEEPALIVE → Established → UPDATE).",
    "`bgp converge` skips the ConnectRetry wait and runs the exchange right now.",
    "Then inspect with: show ip bgp summary · show ip bgp · show ip route.",
  ],
  run(args, ctx): CommandResult {
    if (firstPositional(args) !== "converge") {
      return { output: [muted("Usage: bgp converge — bring BGP sessions up now")] };
    }
    const { value: sum, events } = ctx.runSim((sim) => sim.runBgp());
    return {
      output: [
        line(`BGP: ${sum.routers} speaker(s), ${sum.sessions} session(s) Established, ${sum.routesInstalled} route(s) installed`, "success"),
        muted("Inspect: show ip bgp summary · show ip bgp · show ip route"),
      ],
      events,
    };
  },
};
