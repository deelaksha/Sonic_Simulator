/**
 * `ospf converge` — a lab helper (documented as app-required, spec §63) that runs
 * one OSPF convergence cycle across the topology: routers exchange Hellos, form
 * adjacencies, and SPF installs routes. Real FRR converges continuously; in this
 * turn-based sim you trigger a cycle. Output/events feed the timeline + inspector.
 */
import { CommandHandler, CommandResult, line, muted } from "./types";
import { firstPositional } from "./parser";

export const ospfCommand: CommandHandler = {
  name: "ospf",
  summary: "Run an OSPF convergence cycle (Hello → adjacency → SPF)",
  usage: "ospf converge",
  help: [
    "OSPF",
    "",
    "Usage:",
    "  ospf converge",
    "",
    "Runs one OSPF convergence cycle across all routers that have OSPF configured",
    "(`config router ospf network <cidr> area <id>`): sends Hellos, forms",
    "adjacencies, and installs SPF routes so traffic can cross the routers.",
    "Then inspect with: show ip ospf neighbor · show ip route.",
  ],
  run(args, ctx): CommandResult {
    if (firstPositional(args) !== "converge") {
      return { output: [muted("Usage: ospf converge — run one OSPF convergence cycle")] };
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
