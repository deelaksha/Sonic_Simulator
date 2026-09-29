/**
 * ping6 (spec §40): ICMPv6 echo over the real IPv6 engine (NDP + routing). Mirrors
 * ping.ts but for v6; output/timing derive from the simulated packet journey.
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { takeFlagValue, firstPositional } from "./parser";
import { isValidIpv6 } from "../models/ipv6";
import { PingFailure } from "../engine";

function diagnose(ctx: CommandContext, dst: string, reason?: PingFailure): OutputLine[] {
  const out = [line("PING6 FAILED", "heading")];
  switch (reason) {
    case "no-route":
      out.push(muted("Reason: No IPv6 route to destination (need a connected prefix or default via)."));
      break;
    case "ndp-failed":
      out.push(muted("Reason: Neighbour could not be resolved (NDP). The target did not answer the Neighbor Solicitation."));
      break;
    case "no-src-ip":
      out.push(muted("Reason: The outgoing interface has no IPv6 address."));
      break;
    default:
      out.push(muted("Reason: No ICMPv6 echo reply received."));
  }
  return out;
}

export const ping6Command: CommandHandler = {
  name: "ping6",
  summary: "Test IPv6 reachability using ICMPv6 Echo (NDP + routing)",
  usage: "ping6 [-c count] <ipv6-destination>",
  help: [
    "PING6",
    "",
    "Usage:",
    "  ping6 [-c count] <ipv6-destination>",
    "",
    "Purpose:",
    "  Tests IPv6 reachability using ICMPv6 Echo. Watch: NDP (NS/NA) · IPv6 · ICMPv6",
    "  (IPv6 uses Neighbor Discovery, not ARP).",
  ],
  run(args, ctx): CommandResult {
    const a = [...args];
    const countStr = takeFlagValue(a, "-c");
    const count = countStr ? Math.max(1, Math.min(20, parseInt(countStr, 10) || 4)) : 4;
    const dst = firstPositional(a);
    if (!dst) return { output: [err("ping6: usage: ping6 [-c count] <ipv6-destination>")] };
    if (!isValidIpv6(dst)) return { output: [err(`ping6: ${dst}: invalid IPv6 address`)] };

    const { value: summary, events } = ctx.runSim((sim) => sim.runPing6(ctx.device.id, dst, { count }));
    const out: OutputLine[] = [line(`PING ${dst}(${dst}) 56 data bytes`)];
    for (const r of summary.replies) {
      if (r.success) {
        out.push(line(`${r.bytes} bytes from ${r.fromIp}: icmp_seq=${r.seq} hlim=${r.ttl} time=${r.rttMs} ms`, "success"));
      } else {
        out.push(err(`icmp_seq=${r.seq} ${r.reason === "ndp-failed" ? "no neighbour (NDP failed)" : r.reason}`));
      }
    }
    const loss = summary.transmitted
      ? Math.round(((summary.transmitted - summary.received) / summary.transmitted) * 100)
      : 100;
    out.push(line(""));
    out.push(line(`--- ${dst} ping6 statistics ---`));
    out.push(line(`${summary.transmitted} packets transmitted, ${summary.received} received, ${loss}% packet loss`));
    if (summary.received === 0) {
      out.push(line(""));
      out.push(...diagnose(ctx, dst, summary.replies[0]?.reason));
    }
    return { output: out, events };
  },
};
