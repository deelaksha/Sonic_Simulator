/**
 * traceroute (spec §17). Sends probes with increasing TTL and prints the device
 * that answered at each hop — derived from real ICMP time-exceeded / echo-reply
 * packets produced by the router engine.
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err } from "./types";
import { takeFlagValue, firstPositional } from "./parser";
import { isValidIpv4 } from "../models/ip";

export const tracerouteCommand: CommandHandler = {
  name: "traceroute",
  aliases: ["tracepath"],
  summary: "Trace the L3 path to a destination using TTL",
  usage: "traceroute [-m maxhops] <destination>",
  help: [
    "TRACEROUTE",
    "",
    "Usage:",
    "  traceroute [-m maxhops] <destination>",
    "",
    "Purpose:",
    "  Discovers each router on the path by sending packets with TTL 1, 2, 3 ...",
    "  Every router that decrements TTL to zero returns ICMP Time Exceeded.",
  ],
  run(args, ctx: CommandContext): CommandResult {
    const a = [...args];
    const maxStr = takeFlagValue(a, "-m");
    const maxHops = maxStr ? Math.max(1, Math.min(64, parseInt(maxStr, 10) || 30)) : 30;
    const dst = firstPositional(a);
    if (!dst) return { output: [err("traceroute: usage: traceroute [-m maxhops] <destination>")] };
    if (!isValidIpv4(dst)) return { output: [err(`traceroute: ${dst}: Name or service not known`)] };

    const { value: trace, events } = ctx.runSim((sim) => sim.runTraceroute(ctx.device.id, dst, { maxHops }));
    const out: OutputLine[] = [line(`traceroute to ${dst} (${dst}), ${maxHops} hops max`)];
    for (const hop of trace.hops) {
      if (hop.fromIp) {
        out.push(line(`${String(hop.ttl).padStart(2)}  ${hop.fromIp}  ${hop.rttMs} ms`));
      } else {
        out.push(line(`${String(hop.ttl).padStart(2)}  * * *`));
      }
    }
    return { output: out, events };
  },
};
