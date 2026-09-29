/**
 * tcpdump (spec §19). Consumes the simulation's capture buffer (frames the
 * engine recorded on each interface) — it does not fabricate output. Because the
 * sim is turn-based, it shows frames captured by recent traffic on the interface.
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { takeFlagValue, takeFlag } from "./parser";
import { Frame } from "../models/packet";
import { CaptureRecord } from "../engine";
import { interfaceByName } from "../models/device";

function formatTime(ms: number): string {
  const ss = Math.floor(ms / 1000) % 60;
  const frac = ms % 1000;
  return `12:00:${String(ss).padStart(2, "0")}.${String(frac).padStart(3, "0")}`;
}

function ipLength(frame: Frame): number {
  const overhead = 14 + 4 + (frame.vlan ? 4 : 0) + 20;
  return Math.max(0, frame.meta.sizeBytes - overhead);
}

function describe(frame: Frame): string {
  if (frame.arp) return `${frame.meta.summary}, length 28`;
  if (frame.ipv4) {
    const { srcIp, dstIp } = frame.ipv4;
    if (frame.icmp) {
      const t = frame.icmp.type;
      const label =
        t === "echo-request"
          ? `ICMP echo request, id ${frame.icmp.identifier}, seq ${frame.icmp.sequence}`
          : t === "echo-reply"
            ? `ICMP echo reply, id ${frame.icmp.identifier}, seq ${frame.icmp.sequence}`
            : t === "time-exceeded"
              ? "ICMP time exceeded in-transit"
              : "ICMP destination unreachable";
      return `IP ${srcIp} > ${dstIp}: ${label}, length ${ipLength(frame)}`;
    }
    return `IP ${srcIp} > ${dstIp}: ${frame.ipv4.protocol}, length ${ipLength(frame)}`;
  }
  return frame.meta.summary;
}

function matches(frame: Frame, filter: { kind?: string; host?: string }): boolean {
  if (filter.host) {
    const h = filter.host;
    if (frame.ipv4 && (frame.ipv4.srcIp === h || frame.ipv4.dstIp === h)) return true;
    if (frame.arp && (frame.arp.senderIp === h || frame.arp.targetIp === h)) return true;
    return false;
  }
  switch (filter.kind) {
    case undefined:
      return true;
    case "icmp":
      return !!frame.icmp;
    case "arp":
      return !!frame.arp;
    case "ip":
      return !!frame.ipv4;
    case "tcp":
      return frame.ipv4?.protocol === "TCP";
    case "udp":
      return frame.ipv4?.protocol === "UDP";
    default:
      return true;
  }
}

export const tcpdumpCommand: CommandHandler = {
  name: "tcpdump",
  summary: "Print frames captured on an interface (from the sim event stream)",
  usage: "tcpdump [-i iface] [-e] [-c count] [icmp|arp|ip|tcp|udp | host <ip>]",
  help: [
    "TCPDUMP",
    "",
    "Usage:",
    "  tcpdump -i <iface> [-e] [-c count] [filter]",
    "",
    "Filters:",
    "  icmp | arp | ip | tcp | udp | host <ip>",
    "",
    "Purpose:",
    "  Prints frames the engine captured on the interface. Run a command that",
    "  generates traffic (e.g. ping) then inspect it here.",
  ],
  run(args, ctx: CommandContext): CommandResult {
    const a = [...args];
    const ifName = takeFlagValue(a, "-i");
    const withEther = takeFlag(a, "-e");
    takeFlag(a, "-n");
    const countStr = takeFlagValue(a, "-c");
    const limit = countStr ? parseInt(countStr, 10) || undefined : undefined;

    // Resolve interface (default: first interface with an address).
    let ifaceId: string | undefined;
    let resolvedName = ifName;
    if (ifName && ifName !== "any") {
      const iface = interfaceByName(ctx.device, ifName);
      if (!iface) return { output: [err(`tcpdump: ${ifName}: No such device exists`)] };
      ifaceId = iface.id;
    } else if (!ifName) {
      const first = ctx.device.interfaces.find((i) => i.ipv4.length) ?? ctx.device.interfaces[0];
      ifaceId = first?.id;
      resolvedName = first?.name;
    }

    // Parse the (single) filter expression from the remaining tokens.
    const positional = a.filter((t) => !t.startsWith("-"));
    let filter: { kind?: string; host?: string } = {};
    if (positional[0] === "host") filter = { host: positional[1] };
    else if (positional[0]) filter = { kind: positional[0] };

    const relevant = ctx.captures.filter((c: CaptureRecord) => {
      if (c.deviceId !== ctx.device.id) return false;
      if (ifaceId && c.interfaceId !== ifaceId) return false;
      return matches(c.frame, filter);
    });

    const out: OutputLine[] = [
      muted(`tcpdump: listening on ${resolvedName ?? "any"}, link-type EN10MB (Ethernet)`),
    ];
    if (relevant.length === 0) {
      out.push(muted("(no packets captured — generate some traffic, e.g. `ping`, then retry)"));
      return { output: out };
    }

    const shown = limit ? relevant.slice(0, limit) : relevant;
    for (const c of shown) {
      const prefix = withEther ? `${c.frame.ethernet.srcMac} > ${c.frame.ethernet.dstMac}, ` : "";
      out.push(line(`${formatTime(c.timeMs)} ${prefix}${describe(c.frame)}`));
    }
    out.push(muted(`${shown.length} packets captured`));
    return { output: out };
  },
};
