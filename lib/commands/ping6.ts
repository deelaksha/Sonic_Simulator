/**
 * ping6 (spec §40): ICMPv6 echo over the real IPv6 engine (NDP + routing). Mirrors
 * ping.ts but for v6; output/timing derive from the simulated packet journey.
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { takeFlagValue, firstPositional } from "./parser";
import { isValidIpv6 } from "../models/ipv6";
import { vrfNames } from "../models/vrf";
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
    const count = countStr ? Math.max(1, Math.min(5000, parseInt(countStr, 10) || 4)) : 4;
    // VRF: `ping6 -I Vrf-red …` (binds to the VRF device) or KLISH `ping6 vrf Vrf-red …`, as ping.ts.
    let vrf = takeFlagValue(a, "-I");
    const vi = a.indexOf("vrf");
    if (vi >= 0 && a[vi + 1]) {
      vrf = a[vi + 1];
      a.splice(vi, 2);
    }
    if (vrf && !vrfNames(ctx.device).includes(vrf)) return { output: [err(`ping6: ${vrf}: unknown VRF or interface`)] };
    const dst = firstPositional(a);
    if (!dst) return { output: [err("ping6: usage: ping6 [-c count] <ipv6-destination>")] };
    if (!isValidIpv6(dst)) return { output: [err(`ping6: ${dst}: invalid IPv6 address`)] };

    const { value: summary, events } = ctx.runSim((sim) => sim.runPing6(ctx.device.id, dst, { count, vrf }));
    const out: OutputLine[] = [line(`PING ${dst}(${dst}) 56 data bytes`)];

    if (count <= 20) {
      for (const r of summary.replies) {
        if (r.success) {
          out.push(line(`${r.bytes} bytes from ${r.fromIp}: icmp_seq=${r.seq} hlim=${r.ttl} time=${r.rttMs} ms`, "success"));
        } else {
          out.push(err(`icmp_seq=${r.seq} ${r.reason === "ndp-failed" ? "no neighbour (NDP failed)" : r.reason}`));
        }
      }
    } else {
      const firstFew = summary.replies.slice(0, 3);
      for (const r of firstFew) {
        if (r.success) {
          out.push(line(`${r.bytes} bytes from ${r.fromIp}: icmp_seq=${r.seq} hlim=${r.ttl} time=${r.rttMs} ms`, "success"));
        } else {
          out.push(err(`icmp_seq=${r.seq} ${r.reason === "ndp-failed" ? "no neighbour (NDP failed)" : r.reason}`));
        }
      }
      const skipped = count - 6;
      if (skipped > 0) {
        out.push(muted(`... [${skipped} probes transmitted in background] ...`));
      }
      const lastFew = summary.replies.slice(-3);
      for (const r of lastFew) {
        if (r.success) {
          out.push(line(`${r.bytes} bytes from ${r.fromIp}: icmp_seq=${r.seq} hlim=${r.ttl} time=${r.rttMs} ms`, "success"));
        } else {
          out.push(err(`icmp_seq=${r.seq} ${r.reason === "ndp-failed" ? "no neighbour (NDP failed)" : r.reason}`));
        }
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

/**
 * traceroute6 (iputils/traceroute layout): ICMPv6 echo probes with hop limit
 * 1, 2, 3 … through the real engine; each router whose hop limit expires
 * answers ICMPv6 Time Exceeded (RFC 4443 3.3), a router without a route
 * answers Destination Unreachable (printed !N, 3.1), the target answers the echo.
 */
export const traceroute6Command: CommandHandler = {
  name: "traceroute6",
  summary: "Trace the IPv6 path to a destination using the hop limit",
  usage: "traceroute6 [-m maxhops] <ipv6-destination>",
  help: [
    "TRACEROUTE6",
    "",
    "Usage:",
    "  traceroute6 [-m maxhops] <ipv6-destination>",
    "",
    "Purpose:",
    "  Discovers each router on the IPv6 path with hop limit 1, 2, 3 ...",
    "  Every router that decrements the hop limit to zero returns ICMPv6 Time Exceeded.",
  ],
  run(args, ctx): CommandResult {
    const a = [...args];
    const maxStr = takeFlagValue(a, "-m");
    const maxHops = maxStr ? Math.max(1, Math.min(64, parseInt(maxStr, 10) || 30)) : 30;
    const dst = firstPositional(a);
    if (!dst) return { output: [err("traceroute6: usage: traceroute6 [-m maxhops] <ipv6-destination>")] };
    if (!isValidIpv6(dst)) return { output: [err(`traceroute6: ${dst}: Name or service not known`)] };
    const out: OutputLine[] = [line(`traceroute to ${dst} (${dst}), ${maxHops} hops max, 80 byte packets`)];
    const allEvents: NonNullable<CommandResult["events"]> = [];
    for (let hl = 1; hl <= maxHops; hl++) {
      const { value: s, events } = ctx.runSim((sim) => sim.runPing6(ctx.device.id, dst, { count: 1, hopLimit: hl }));
      allEvents.push(...events);
      const r = s.replies[0];
      const hop = String(hl).padStart(2);
      if (r?.success) {
        out.push(line(`${hop}  ${r.fromIp} (${r.fromIp})  ${r.rttMs} ms`));
        break;
      }
      const start = events[0]?.timeMs ?? 0;
      const err6 = events.find((e) => (e.type === "ICMP_TIME_EXCEEDED" || e.type === "ICMP_UNREACHABLE") && e.deviceId === ctx.device.id && e.frame?.icmp6 && e.frame.ipv6);
      if (err6?.frame?.ipv6) {
        const from = err6.frame.ipv6.srcIp;
        const unreach = err6.frame.icmp6!.type === "dest-unreachable";
        out.push(line(`${hop}  ${from} (${from})  ${Math.max(0, err6.timeMs - start)} ms${unreach ? " !N" : ""}`));
        if (unreach) break;
        continue;
      }
      out.push(line(`${hop}  * * *`));
      if (r?.reason === "no-route") break;
    }
    return { output: out, events: allEvents };
  },
};
