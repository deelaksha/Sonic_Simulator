/**
 * `ospf converge` — a lab helper (app-specific, spec §63). OSPF runs on its own
 * (lib/protocols/ospf-daemon.ts: Hello timers, dead/wait timers, real packets);
 * this command just fast-forwards it: every speaker sends immediate Hello rounds
 * and expired Wait timers trigger DR/BDR election, so adjacencies reach Full and
 * SPF installs routes now instead of after 10-40 s. Events feed the timeline.
 */
import { CommandHandler, CommandResult, line, muted } from "./types";
import { firstPositional } from "./parser";

export const ospfCommand: CommandHandler = {
  name: "ospf",
  summary: "Converge OSPF now (immediate Hellos → adjacency → SPF)",
  usage: "ospf converge",
  help: [
    "OSPF",
    "",
    "Usage:",
    "  ospf converge",
    "",
    "OSPF converges by itself (Hello every 10 s, Full after the second Hello;",
    "40 s Wait timer on broadcast networks). This fast-forwards it: every OSPF",
    "router/switch sends immediate Hellos and Wait timers expire, so adjacencies",
    "reach Full and SPF installs routes right away.",
    "Then inspect with: show ip ospf neighbor · show ip route.",
  ],
  run(args, ctx): CommandResult {
    if (firstPositional(args) !== "converge") {
      return { output: [muted("Usage: ospf converge — converge OSPF now (immediate Hellos)")] };
    }
    const { value: sum, events } = ctx.runSim((sim) => sim.runOspf());
    return {
      output: [
        line(
          `OSPF converged: ${sum.routers} router(s), ${sum.adjacencies} adjacency(ies) Full, ${sum.routesInstalled} route(s) installed`,
          "success",
        ),
        muted("Inspect: show ip ospf neighbor · show ip ospf route · show ip route · then ping across the routers"),
      ],
      events,
    };
  },
};
