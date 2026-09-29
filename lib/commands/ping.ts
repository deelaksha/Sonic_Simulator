/**
 * ping (spec §16, §37). Output is formatted from the real simulated packet
 * journey; failures come with an educational explanation, never just "failed".
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { takeFlagValue, firstPositional } from "./parser";
import { isValidIpv4 } from "../models/ip";
import { PingFailure, PingReply } from "../engine";
import { formatRouteLine } from "./ip";

function diagnose(ctx: CommandContext, dst: string, reason?: PingFailure): OutputLine[] {
  const out: OutputLine[] = [line("PING FAILED", "heading")];
  const dev = ctx.device;
  switch (reason) {
    case "no-route":
      out.push(muted("Reason: No route to destination."));
      out.push(muted(`${dev.name} routing table:`));
      if (dev.routingTable.length === 0) out.push(muted("  (empty)"));
      for (const r of dev.routingTable) out.push(muted("  " + formatRouteLine(dev, r)));
      out.push(muted(`No matching route for: ${dst}`));
      break;
    case "arp-failed": {
      out.push(muted("Reason: Destination MAC could not be resolved (ARP)."));
      const incomplete = dev.arpTable.filter((e) => e.state === "incomplete");
      if (incomplete.length) {
        for (const e of incomplete) out.push(muted(`  ARP: ${e.ip} → INCOMPLETE`));
      } else {
        out.push(muted(`  ARP: ${dst} → INCOMPLETE`));
      }
      out.push(muted("The next hop did not answer ARP — check its IP/subnet, cabling, and that it is up."));
      break;
    }
    case "iface-down":
      out.push(muted("Reason: The outgoing interface is administratively down."));
      out.push(muted("Bring it up with:  ip link set <iface> up"));
      break;
    case "no-src-ip":
      out.push(muted("Reason: The outgoing interface has no IP address configured."));
      break;
    default:
      out.push(muted("Reason: No ICMP echo reply received (request timed out)."));
      out.push(muted("The request left this host but nothing returned — check the destination and the return path."));
  }
  return out;
}

function failureLine(r: PingReply, ctx: CommandContext): OutputLine {
  switch (r.reason) {
    case "arp-failed":
      return err(`From ${primarySrc(ctx)} icmp_seq=${r.seq} Destination Host Unreachable`);
    case "timeout":
      return muted(`Request timeout for icmp_seq ${r.seq}`);
    default:
      return err(`icmp_seq=${r.seq} failed (${r.reason})`);
  }
}

function primarySrc(ctx: CommandContext): string {
  for (const i of ctx.device.interfaces) if (i.ipv4[0]) return i.ipv4[0].address;
  return ctx.device.name;
}

export const pingCommand: CommandHandler = {
  name: "ping",
  summary: "Test IP reachability using ICMP Echo Request/Reply",
  usage: "ping [-c count] <destination>",
  help: [
    "PING",
    "",
    "Usage:",
    "  ping [-c count] <destination>",
    "",
    "Purpose:",
    "  Tests IP reachability using ICMP Echo Request/Reply.",
    "",
    "Watch:",
    "  L2 Ethernet · ARP · L3 IP · ICMP · Routing",
  ],
  run(args, ctx): CommandResult {
    const a = [...args];
    const countStr = takeFlagValue(a, "-c");
    const count = countStr ? Math.max(1, Math.min(20, parseInt(countStr, 10) || 4)) : 4;
    const target = firstPositional(a);
    if (!target) return { output: [err("ping: usage: ping [-c count] <destination>")] };

    // Resolve a hostname to an IP via DNS first (like a real host), then ping it.
    let dst = target;
    const pre: OutputLine[] = [];
    let dnsEvents: unknown[] = [];
    if (!isValidIpv4(target)) {
      const dnsRun = ctx.runSim((sim) => sim.runDnsResolve(ctx.device.id, target));
      dnsEvents = dnsRun.events ?? [];
      if (!dnsRun.value.ok || !dnsRun.value.address) {
        return { output: [err(`ping: ${target}: Name or service not known`)], events: dnsEvents as never };
      }
      dst = dnsRun.value.address;
      pre.push(muted(`; resolved ${target} → ${dst} (DNS ${dnsRun.value.server})`));
    }

    const { value: summary, events: pingEvents } = ctx.runSim((sim) => sim.runPing(ctx.device.id, dst, { count }));
    const events = [...(dnsEvents as never[]), ...(pingEvents ?? [])];
    const out: OutputLine[] = [...pre];
    out.push(line(`PING ${target} (${dst}) 56(84) bytes of data.`));

    // A missing route fails the same way for every probe — report it once.
    if (summary.replies.length > 0 && summary.replies.every((r) => r.reason === "no-route")) {
      out.push(err("connect: Network is unreachable"));
      out.push(line(""));
      out.push(...diagnose(ctx, dst, "no-route"));
      return { output: out, events };
    }

    for (const r of summary.replies) {
      if (r.success) {
        out.push(line(`${r.bytes} bytes from ${r.fromIp}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs} ms`, "success"));
      } else {
        out.push(failureLine(r, ctx));
      }
    }

    const loss = summary.transmitted
      ? Math.round(((summary.transmitted - summary.received) / summary.transmitted) * 100)
      : 100;
    out.push(line(""));
    out.push(line(`--- ${dst} ping statistics ---`));
    out.push(line(`${summary.transmitted} packets transmitted, ${summary.received} received, ${loss}% packet loss`));

    if (summary.received === 0) {
      out.push(line(""));
      out.push(...diagnose(ctx, dst, summary.replies[0]?.reason));
    }

    return { output: out, events };
  },
};
