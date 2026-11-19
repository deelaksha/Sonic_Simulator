/**
 * traffic / iperf3 / hping3 command.
 * Allows generating high-volume traffic (UDP, TCP, ICMP) with custom payload data
 * from any host (or switch with routed interface) across the simulated network.
 * Every packet passes through route lookup, ARP resolution, switch forwarding,
 * interface byte counters, and switch sFlow packet sampling (1:rate).
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { takeFlag, takeFlagValue, firstPositional } from "./parser";
import { isValidIpv4 } from "../models/ip";
import { TrafficSpec, TrafficProtocol, sendTrafficPacket, SendFailure } from "../protocols/traffic";
import { peekFeatureState } from "../models/feature-state";
import { SflowRuntime } from "../sflow/agent";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function diagnoseFailure(reason?: SendFailure): string {
  switch (reason) {
    case "no-route":
      return "No route to destination network.";
    case "arp-failed":
      return "Destination MAC could not be resolved (ARP timeout).";
    case "iface-down":
      return "The outgoing interface is administratively down.";
    case "no-src-ip":
      return "The outgoing interface has no configured IP address.";
    default:
      return "Packet delivery failed.";
  }
}

export const trafficCommand: CommandHandler = {
  name: "traffic",
  aliases: ["iperf"],
  summary: "Generate high-volume network traffic (UDP/TCP/ICMP) with payload data",
  usage: "traffic [-c count] [-s size] [-p udp|tcp|icmp] [-P port] <destination>",
  help: [
    "TRAFFIC / IPERF3 / HPING3",
    "",
    "Usage:",
    "  traffic [-c count] [-s size] [-p udp|tcp|icmp] [-P port] <destination>",
    "  iperf -c <destination> [-n count] [-l size] [-u] [-p port]",
    "  traffic [-c count] [-d size] [--udp | --icmp | --syn] <destination>",
    "  (iperf3 and hping3 are separate commands)",
    "",
    "Options:",
    "  -c, -n count   Number of packets to transmit (1-100000, default 1000)",
    "  -s, -l, -d     Application payload data bytes per packet (0-9000, default 1400)",
    "  -p proto       Protocol: udp (default), tcp, or icmp",
    "  -u             Use UDP protocol (iperf3 compatibility)",
    "  --udp          Use UDP mode (hping3 compatibility)",
    "  --icmp         Use ICMP mode (hping3 compatibility)",
    "  --syn, --tcp   Use TCP SYN mode (hping3 compatibility)",
    "  -P, -p port    Destination port number (default 5201)",
    "",
    "Purpose:",
    "  Generates high-volume traffic flows across the data plane.",
    "  Used to test throughput, interface byte counters, and sFlow packet sampling (1:256).",
  ],
  run(args, ctx): CommandResult {
    const a = [...args];

    // Detect format style based on flags
    const cVal = takeFlagValue(a, "-c");
    let countStr = takeFlagValue(a, "-n") ?? takeFlagValue(a, "--count");
    let target: string | undefined;

    if (cVal) {
      if (/^\d+$/.test(cVal)) {
        countStr = cVal;
      } else {
        target = cVal; // iperf3 -c <host>
      }
    }

    // Packet count
    const count = countStr ? Math.max(1, Math.min(100000, parseInt(countStr, 10) || 1000)) : 1000;

    // Payload size
    const lVal = takeFlagValue(a, "-l");
    const dVal = takeFlagValue(a, "-d");
    const sVal = takeFlagValue(a, "-s") ?? takeFlagValue(a, "--size");
    const sizeStr = sVal ?? lVal ?? dVal;
    const size = sizeStr ? Math.max(0, Math.min(9000, parseInt(sizeStr, 10) || 1400)) : 1400;

    // Protocol flags
    let protocol: TrafficProtocol = "udp";
    const protoArg = takeFlagValue(a, "-p") ?? takeFlagValue(a, "--proto");
    const isUdp = takeFlag(a, "-u") || takeFlag(a, "--udp");
    const isIcmp = takeFlag(a, "--icmp");
    const isTcp = takeFlag(a, "--tcp") || takeFlag(a, "--syn");

    if (isIcmp || protoArg === "icmp") protocol = "icmp";
    else if (isTcp || protoArg === "tcp") protocol = "tcp";
    else if (isUdp || protoArg === "udp") protocol = "udp";
    else if (protoArg && !["udp", "tcp", "icmp"].includes(protoArg)) {
      // ProtoArg might have been a port if hping/iperf passed -p <port>
      const portNum = parseInt(protoArg, 10);
      if (!isNaN(portNum) && portNum > 0 && portNum <= 65535) {
        // Was port
      } else {
        return { output: [err(`traffic: invalid protocol '${protoArg}' (must be udp, tcp, or icmp)`)] };
      }
    }

    // Port flag
    const portStr = takeFlagValue(a, "-P") ?? (!isNaN(parseInt(protoArg ?? "", 10)) ? protoArg : takeFlagValue(a, "-p"));
    const dstPort = portStr ? Math.max(1, Math.min(65535, parseInt(portStr, 10) || 5201)) : 5201;
    const srcPort = 40000 + (Math.floor(Math.random() * 10000));

    // Target host
    if (!target) target = firstPositional(a);
    if (!target) {
      return {
        output: [
          err("traffic: missing destination host/IP"),
          muted("Usage: traffic [-c count] [-s size] [-p udp|tcp|icmp] <destination>"),
        ],
      };
    }

    // Identify output format style
    const isIperfStyle = Boolean(cVal && !/^\d+$/.test(cVal)) || Boolean(lVal) || takeFlag(a, "-u");
    const isHpingStyle = Boolean(dVal) || isIcmp || isTcp || takeFlag(a, "--udp");

    let dstIp = target;
    const pre: OutputLine[] = [];
    if (!isValidIpv4(target)) {
      const dnsRun = ctx.runSim((sim) => sim.runDnsResolve(ctx.device.id, target));
      if (!dnsRun.value.ok || !dnsRun.value.address) {
        return { output: [err(`traffic: ${target}: Name or service not known`)] };
      }
      dstIp = dnsRun.value.address;
      pre.push(muted(`; resolved ${target} → ${dstIp}`));
    }

    const spec: TrafficSpec = {
      srcDeviceId: ctx.device.id,
      dstIp,
      protocol,
      srcPort,
      dstPort,
      size,
      count,
      intervalMs: 0,
      continuous: false,
    };

    // Helper to count switch sFlow samples
    const getSflowSamples = (devices: Record<string, import("../models/device").Device>) => {
      let totalSamples = 0;
      let totalPortPackets = 0;
      for (const dev of Object.values(devices)) {
        const rt = peekFeatureState<SflowRuntime>(dev, "sflow-agent");
        if (rt) {
          totalSamples += rt.stats.flowSamples;
          totalPortPackets += rt.stats.sampledPortPackets;
        }
      }
      return { totalSamples, totalPortPackets };
    };

    // Run traffic generation
    const { value: simResult, events } = ctx.runSim((sim) => {
      const beforeSflow = getSflowSamples(sim.state.devices);
      let sent = 0;
      let failed = 0;
      let lastFailure: SendFailure | undefined;

      for (let seq = 1; seq <= count; seq++) {
        sim.resetSteps(); // Reset hop runaway guard per packet
        const r = sendTrafficPacket(sim, ctx.device, spec, seq);
        if (r.ok) sent++;
        else {
          failed++;
          lastFailure = r.reason;
        }
      }

      const afterSflow = getSflowSamples(sim.state.devices);
      const newSamples = Math.max(0, afterSflow.totalSamples - beforeSflow.totalSamples);

      return { sent, failed, lastFailure, newSamples };
    });

    const newSamples = simResult.newSamples;

    const out: OutputLine[] = [...pre];
    const totalPayloadBytes = simResult.sent * size;
    const headerOverhead = protocol === "udp" ? 42 : protocol === "tcp" ? 54 : 42; // L2 (14) + IP (20) + L4
    const totalWireBytes = simResult.sent * (size + headerOverhead);

    if (simResult.sent === 0 && simResult.failed > 0) {
      out.push(err(`Traffic generation failed: 0/${count} packets transmitted.`));
      out.push(muted(`Reason: ${diagnoseFailure(simResult.lastFailure)}`));
      return { output: out, events };
    }

    if (isIperfStyle) {
      out.push(line(`Connecting to host ${target} (${dstIp}), port ${dstPort}`));
      out.push(line(`[ ID] Interval           Transfer     Bitrate         Total Datagrams`));
      out.push(
        line(
          `[  5] 0.00-1.00 sec      ${formatBytes(totalPayloadBytes).padEnd(12)} ${(
            (totalPayloadBytes * 8) /
            (1024 * 1024)
          ).toFixed(1)} Mbits/sec  ${simResult.sent}`,
        ),
      );
      out.push(muted(`- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -`));
      out.push(
        line(
          `[ ID] Interval           Transfer     Bitrate         Jitter    Lost/Total Datagrams`,
        ),
      );
      const lossPct = count > 0 ? Math.round((simResult.failed / count) * 100) : 0;
      out.push(
        line(
          `[  5] 0.00-1.00 sec      ${formatBytes(totalPayloadBytes).padEnd(12)} ${(
            (totalPayloadBytes * 8) /
            (1024 * 1024)
          ).toFixed(1)} Mbits/sec  0.02 ms   ${simResult.failed}/${count} (${lossPct}%)`,
          lossPct === 0 ? "success" : "normal",
        ),
      );
      out.push(line(`[  5] Sent ${simResult.sent} datagrams (${size} bytes/datagram)`));
    } else if (isHpingStyle) {
      out.push(line(`HPING ${target} (${dstIp}): ${protocol} mode, ${headerOverhead} headers + ${size} data bytes`));
      out.push(line(`--- ${target} hping statistic ---`));
      const lossPct = count > 0 ? Math.round((simResult.failed / count) * 100) : 0;
      out.push(line(`${count} packets transmitted, ${simResult.sent} packets received, ${lossPct}% packet loss`, lossPct === 0 ? "success" : "normal"));
      out.push(muted(`round-trip min/avg/max = 1.1/2.8/4.5 ms`));
    } else {
      out.push(line(`Starting traffic stream: ${count} packets of ${size} bytes (${protocol.toUpperCase()}) → ${target} (${dstIp}:${dstPort})`));
      out.push(muted(`... transmitting data stream across network data plane ...`));
      out.push(line(""));
      out.push(line("Traffic transmission summary:", "heading"));
      out.push(line(`  Packets transmitted : ${simResult.sent} / ${count} (${Math.round((simResult.sent / count) * 100)}% delivery)`, "success"));
      out.push(line(`  Payload data sent   : ${totalPayloadBytes.toLocaleString()} bytes (${formatBytes(totalPayloadBytes)})`));
      out.push(line(`  Total wire bytes    : ${totalWireBytes.toLocaleString()} bytes (${formatBytes(totalWireBytes)} with Ethernet/IP headers)`));
    }

    if (newSamples > 0) {
      out.push(line(""));
      out.push(line(`sFlow Telemetry: ${newSamples} flow samples captured by switch agent!`, "success"));
      out.push(muted(`View detailed sampled packet headers in the sFlow tab or run 'show sflow' on the switch.`));
    } else if (count >= 100) {
      out.push(line(""));
      out.push(muted(`Note: If sFlow is configured (e.g. rate 1:256), flow samples are exported to configured collectors.`));
    }

    return { output: out, events };
  },
};
