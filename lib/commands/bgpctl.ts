/**
 * `bgp converge` — a lab helper (documented as app-required, spec §63) that opens
 * BGP sessions to configured neighbors and exchanges routes in one cycle. Real
 * FRR maintains sessions continuously; here you trigger a convergence.
 */
import { CommandHandler, CommandResult, line, muted } from "./types";
import { firstPositional } from "./parser";

export const bgpCommand: CommandHandler = {
  name: "bgp",
  summary: "Run a BGP convergence cycle (OPEN → Established → route exchange)",
  usage: "bgp converge",
  help: [
    "BGP",
    "",
    "Usage:",
    "  bgp converge",
    "",
    "Opens BGP sessions to every configured neighbor (`config router bgp <as>` +",
    "`neighbor <ip> remote-as <as>` + `network <cidr>`), establishes them, and",
    "installs learned prefixes. Then inspect with: show ip bgp summary · show ip route.",
  ],
  run(args, ctx): CommandResult {
    if (firstPositional(args) !== "converge") {
      return { output: [muted("Usage: bgp converge — run one BGP convergence cycle")] };
    }
    const { value: sum, events } = ctx.runSim((sim) => sim.runBgp());
    return {
      output: [
        line(
          `BGP converged: ${sum.routers} router(s), ${sum.sessions} session(s) Established, ${sum.routesInstalled} route(s) installed`,
          "success",
        ),
        muted("Inspect: show ip bgp summary · show ip route · then ping across the ASes"),
      ],
      events,
    };
  },
};
