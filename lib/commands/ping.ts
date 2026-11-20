/**
 * ping (spec §16, §37). Output is formatted from the real simulated packet
 * journey; failures come with an educational explanation, never just "failed".
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { takeFlagValue, takeFlag, firstPositional } from "./parser";
import { vrfNames, vrfOf } from "../models/vrf";
import { NetInterface } from "../models/interface";
import { findInterface, isSwitch } from "../models/device";
import { longestPrefixMatch } from "../models/route";
import { isValidIpv4 } from "../models/ip";
import { PingFailure, PingReply } from "../engine";
import { formatRouteLine } from "./ip";

/** Linux host NICs and the SONiC management port: 1500; SONiC front-panel ports: 9100 (PORT.mtu default). */
const HOST_MTU = 1500;
const SWITCH_PORT_MTU = 9100;

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

      // Educational hint: did the user attempt to ping a switch's out-of-band management IP from a front-panel PC?
      const mgmtSwitch = Object.values(ctx.network.devices).find((d) =>
        d.interfaces.some((i) => i.management && i.ipv4.some((a) => a.address === dst)),
      );
      if (mgmtSwitch && dev.type === "pc") {
        out.push(muted(""));
        out.push(line(`Note: ${dst} is ${mgmtSwitch.name}'s out-of-band management IP (eth0).`, "heading"));
        out.push(muted("Switch management ports are isolated from front-panel data ports."));
        const peerPc = Object.values(ctx.network.devices).find(
          (d) => d.id !== dev.id && d.type === "pc" && d.interfaces.some((i) => i.ipv4.length > 0),
        );
        if (peerPc) {
          const peerIp = peerPc.interfaces[0]?.ipv4[0]?.address;
          if (peerIp) {
            out.push(line(`To ping the other host in this network, try:  ping ${peerIp}`, "success"));
          }
        }
      }
      break;
    }
    case "iface-down":
      out.push(muted("Reason: The outgoing interface is administratively down."));
      out.push(muted("Bring it up with:  ip link set <iface> up"));
      break;
    case "no-src-ip":
      out.push(muted("Reason: The outgoing interface has no IP address configured."));
      break;
    case "ttl-exceeded":
      out.push(muted("Reason: The TTL ran out on the way — a router answered ICMP Time Exceeded (raise -t, or look for a loop)."));
      break;
    case "net-unreachable":
      out.push(muted("Reason: A router on the path has no route to the destination (ICMP Destination Net Unreachable)."));
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
    case "ttl-exceeded":
      return err(`From ${r.fromIp} icmp_seq=${r.seq} Time to live exceeded`);
    case "net-unreachable":
      return err(`From ${r.fromIp} icmp_seq=${r.seq} Destination Net Unreachable`);
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
  usage: "ping [-c count] [-s size] [-t ttl] [-M do|want|dont] [-I iface|vrf] [-q] <destination>",
  help: [
    "PING",
    "",
    "Usage:",
    "  ping [-c count] [-s size] <destination>",
    "",
    "Options:",
    "  -c count  Number of packets to send (1-5000, default 4)",
    "  -s size   Number of data bytes to send (0-65507, default 56)",
    "  -t ttl    IP time to live (1-255, default 64)",
    "  -M do     Set DF: a probe larger than the egress MTU fails locally",
    "  -I name   Bind to an interface or a VRF device",
    "  -q        Quiet: print only the summary",
    "",
    "Purpose:",
    "  Tests IP reachability using ICMP Echo Request/Reply.",
    "",
    "Watch:",
    "  L2 Ethernet · ARP · L3 IP · ICMP · Routing · sFlow sampling",
  ],
  run(args, ctx): CommandResult {
    const a = [...args];
    const countStr = takeFlagValue(a, "-c");
    const count = countStr ? Math.max(1, Math.min(5000, parseInt(countStr, 10) || 4)) : 4;
    const sizeStr = takeFlagValue(a, "-s");
    const size = sizeStr ? Math.max(0, Math.min(65507, parseInt(sizeStr, 10) || 56)) : 56;
    const ttlStr = takeFlagValue(a, "-t");
    const ttl = ttlStr !== undefined ? parseInt(ttlStr, 10) : undefined;
    if (ttl !== undefined && !(ttl >= 1 && ttl <= 255)) return { output: [err(`ping: invalid argument: '${ttlStr}': out of range: 1 <= value <= 255`)] };
    const pmtu = takeFlagValue(a, "-M");
    if (pmtu !== undefined && !["do", "want", "dont", "probe"].includes(pmtu)) return { output: [err(`ping: invalid -M argument: ${pmtu}`)] };
    // Timing/output options the simulation has no use for: wait (-W), interval (-i), deadline (-w).
    for (const f of ["-W", "-i", "-w"]) takeFlagValue(a, f);
    const quiet = takeFlag(a, "-q");
    takeFlag(a, "-n");
    // `-I <VRF>` binds to the VRF device; `-I <interface>` binds to that port
    // (SO_BINDTODEVICE: only routes out of it, its address as source); KLISH `ping vrf <VRF>`.
    const bindArg = takeFlagValue(a, "-I");
    let vrf = bindArg;
    let oif: NetInterface | undefined;
    const vi = a.indexOf("vrf");
    if (vi >= 0 && a[vi + 1]) {
      vrf = a[vi + 1];
      a.splice(vi, 2);
    }
    if (vrf && !vrfNames(ctx.device).includes(vrf)) {
      oif = ctx.device.interfaces.find((i) => i.name === vrf);
      if (!oif) return { output: [err(`ping: ${vrf}: unknown VRF or interface`)] };
      vrf = vrfOf(ctx.device, oif);
    }
    const target = firstPositional(a);
    if (!target) return { output: [err("ping: usage: ping [-c count] [-s size] <destination>")] };

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

    // Egress the kernel would pick: its address is the source, its MTU caps a DF (-M do) probe.
    const table = oif ? ctx.device.routingTable.filter((r) => r.interfaceId === oif!.id) : ctx.device.routingTable;
    const route = longestPrefixMatch(table, dst, vrf ?? "default")?.route;
    const egress = route ? findInterface(ctx.device, route.interfaceId) : undefined;
    const bound = bindArg ? `from ${egress?.ipv4[0]?.address ?? "0.0.0.0"} ${bindArg}: ` : "";
    const head = line(`PING ${target} (${dst}) ${bound}${size}(${size + 28}) bytes of data.`);
    const mtu = egress ? (isSwitch(ctx.device.type) && !egress.management ? SWITCH_PORT_MTU : HOST_MTU) : 0;
    if (pmtu === "do" && egress && size + 28 > mtu) {
      const errs = Array.from({ length: Math.min(count, 20) }, () => err(`ping: local error: message too long, mtu=${mtu}`));
      return {
        output: [...pre, head, ...(quiet ? [] : errs), line(""), line(`--- ${dst} ping statistics ---`), line(`${count} packets transmitted, 0 received, +${count} errors, 100% packet loss`)],
        events: dnsEvents as never,
      };
    }

    const { value: summary, events: pingEvents } = ctx.runSim((sim) => sim.runPing(ctx.device.id, dst, { count, size, vrf, ttl, oif: oif?.id }));
    const events = [...(dnsEvents as never[]), ...(pingEvents ?? [])];
    const out: OutputLine[] = [...pre];
    out.push(head);

    // A missing route fails the same way for every probe — report it once.
    // iputils fails in connect() before printing the PING line.
    if (summary.replies.length > 0 && summary.replies.every((r) => r.reason === "no-route")) {
      out.splice(out.indexOf(head), 1);
      out.push(err("ping: connect: Network is unreachable"));
      out.push(line(""));
      out.push(...diagnose(ctx, dst, "no-route"));
      return { output: out, events };
    }

    if (quiet) {
      // -q: only the summary lines.
    } else if (count <= 20) {
      for (const r of summary.replies) {
        if (r.success) {
          out.push(line(`${r.bytes} bytes from ${r.fromIp}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs} ms`, "success"));
        } else {
          out.push(failureLine(r, ctx));
        }
      }
    } else {
      const firstFew = summary.replies.slice(0, 3);
      for (const r of firstFew) {
        if (r.success) {
          out.push(line(`${r.bytes} bytes from ${r.fromIp}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs} ms`, "success"));
        } else {
          out.push(failureLine(r, ctx));
        }
      }
      const skipped = count - 6;
      if (skipped > 0) {
        out.push(muted(`... [${skipped} probes transmitted in background] ...`));
      }
      const lastFew = summary.replies.slice(-3);
      for (const r of lastFew) {
        if (r.success) {
          out.push(line(`${r.bytes} bytes from ${r.fromIp}: icmp_seq=${r.seq} ttl=${r.ttl} time=${r.rttMs} ms`, "success"));
        } else {
          out.push(failureLine(r, ctx));
        }
      }
    }

    const loss = summary.transmitted
      ? Math.round(((summary.transmitted - summary.received) / summary.transmitted) * 100)
      : 100;
    // iputils counts ICMP errors (TTL exceeded, unreachable) separately: "+N errors".
    const errors = summary.replies.filter((r) => r.reason === "ttl-exceeded" || r.reason === "net-unreachable" || r.reason === "arp-failed").length;
    out.push(line(""));
    out.push(line(`--- ${dst} ping statistics ---`));
    out.push(line(`${summary.transmitted} packets transmitted, ${summary.received} received, ${errors ? `+${errors} errors, ` : ""}${loss}% packet loss`));
    const rtts = summary.replies.filter((r) => r.success).map((r) => r.rttMs ?? 0);
    if (rtts.length) {
      const avg = rtts.reduce((x, y) => x + y, 0) / rtts.length;
      const mdev = Math.sqrt(rtts.reduce((x, y) => x + (y - avg) ** 2, 0) / rtts.length);
      out.push(line(`rtt min/avg/max/mdev = ${[Math.min(...rtts), avg, Math.max(...rtts), mdev].map((v) => v.toFixed(3)).join("/")} ms`));
    }

    if (summary.received === 0) {
      out.push(line(""));
      out.push(...diagnose(ctx, dst, summary.replies[0]?.reason));
    }

    return { output: out, events };
  },
};
