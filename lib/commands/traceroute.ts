/**
 * traceroute (spec §17). Sends probes with increasing TTL and prints the device
 * that answered at each hop — derived from real ICMP time-exceeded / echo-reply
 * packets produced by the router engine.
 *
 * Output follows Linux traceroute (traceroute.c): header "traceroute to X (X),
 * N hops max, 60 byte packets", hop lines "addr (addr)  t ms" (just "addr" with
 * -n), and "connect: Network is unreachable" when there is no route at all.
 * VRF: `-i <VRF>` (bind to the VRF device) or KLISH `traceroute vrf <VRF> ...`.
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { takeFlagValue, takeFlag, firstPositional } from "./parser";
import { isValidIpv4 } from "../models/ip";
import { longestPrefixMatch } from "../models/route";
import { vrfNames, vrfOf } from "../models/vrf";

export const tracerouteCommand: CommandHandler = {
  name: "traceroute",
  aliases: ["tracepath"],
  summary: "Trace the L3 path to a destination using TTL",
  usage: "traceroute [-n] [-m maxhops] [-i iface|vrf] <destination>",
  help: [
    "TRACEROUTE",
    "",
    "Usage:",
    "  traceroute [-n] [-m maxhops] [-i iface|vrf] <destination>",
    "",
    "Purpose:",
    "  Discovers each router on the path by sending packets with TTL 1, 2, 3 ...",
    "  Every router that decrements TTL to zero returns ICMP Time Exceeded.",
  ],
  run(args, ctx: CommandContext): CommandResult {
    const a = [...args];
    const maxStr = takeFlagValue(a, "-m");
    const maxHops = maxStr ? Math.max(1, Math.min(255, parseInt(maxStr, 10) || 30)) : 30;
    const numeric = takeFlag(a, "-n");
    for (const f of ["-w", "-q", "-p", "-s"]) takeFlagValue(a, f);
    let bind = takeFlagValue(a, "-i");
    const vi = a.indexOf("vrf");
    if (vi >= 0 && a[vi + 1]) {
      bind = a[vi + 1];
      a.splice(vi, 2);
    }
    let vrf: string | undefined;
    if (bind) {
      const iface = ctx.device.interfaces.find((i) => i.name === bind);
      if (vrfNames(ctx.device).includes(bind)) vrf = bind;
      else if (iface) vrf = vrfOf(ctx.device, iface);
      else return { output: [err(`traceroute: ${bind}: No such device`)] };
    }
    const target = firstPositional(a);
    if (!target) return { output: [err("traceroute: usage: traceroute [-n] [-m maxhops] <destination>")] };

    // Resolve a hostname through the configured nameserver first, like ping.
    let dst = target;
    const pre: OutputLine[] = [];
    let dnsEvents: unknown[] = [];
    if (!isValidIpv4(target)) {
      const dnsRun = ctx.runSim((sim) => sim.runDnsResolve(ctx.device.id, target));
      dnsEvents = dnsRun.events ?? [];
      if (!dnsRun.value.ok || !dnsRun.value.address) return { output: [err(`${target}: Name or service not known`), err("Cannot handle \"host\" cmdline arg `" + target + "' on position 1 (argc 1)")], events: dnsEvents as never };
      dst = dnsRun.value.address;
      pre.push(muted(`; resolved ${target} → ${dst} (DNS ${dnsRun.value.server})`));
    }

    const out: OutputLine[] = [...pre, line(`traceroute to ${target} (${dst}), ${maxHops} hops max, 60 byte packets`)];
    if (!longestPrefixMatch(ctx.device.routingTable, dst, vrf ?? "default")) {
      out.push(err("connect: Network is unreachable"));
      return { output: out, events: dnsEvents as never };
    }
    const { value: trace, events } = ctx.runSim((sim) => sim.runTraceroute(ctx.device.id, dst, { maxHops, vrf }));
    for (const hop of trace.hops) {
      if (hop.fromIp) {
        out.push(line(`${String(hop.ttl).padStart(2)}  ${numeric ? hop.fromIp : `${hop.fromIp} (${hop.fromIp})`}  ${(hop.rttMs ?? 0).toFixed(3)} ms`));
      } else {
        out.push(line(`${String(hop.ttl).padStart(2)}  * * *`));
      }
    }
    return { output: out, events: [...(dnsEvents as never[]), ...(events ?? [])] };
  },
};
