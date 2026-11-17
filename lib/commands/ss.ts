/**
 * Socket statistics command (`ss` / `netstat`) — Linux socket inspector.
 *
 * Displays active listening daemons and ports:
 *   - TCP 22: sshd
 *   - TCP 179: bgpd (when BGP is configured)
 *   - TCP 80: nginx / httpd (on servers/hosts)
 *   - UDP 53: dnsmasq (when DNS service is active)
 *   - UDP 67: dhcpd (when DHCP server / relay is active)
 *   - UDP 123: ntpd (when NTP is active)
 *   - UDP 161: snmpd (when SNMP agent is active)
 *   - UDP 3784: bfdd (when BFD is active)
 */
import { CommandHandler, CommandResult, OutputLine, line } from "./types";
import { Device, isSwitch, isRouter } from "../models/device";

interface SocketEntry {
  netid: "tcp" | "udp";
  state: "LISTEN" | "UNCONN" | "ESTAB";
  recvQ: number;
  sendQ: number;
  localAddr: string;
  localPort: number;
  peerAddr: string;
  peerPort: string;
  process: string;
  pid: number;
}

function getDeviceSockets(dev: Device): SocketEntry[] {
  const sockets: SocketEntry[] = [];
  const feats = dev.config.features ?? {};

  // Standard SSH daemon (active on all managed devices)
  sockets.push({
    netid: "tcp",
    state: "LISTEN",
    recvQ: 0,
    sendQ: 128,
    localAddr: "0.0.0.0",
    localPort: 22,
    peerAddr: "0.0.0.0",
    peerPort: "*",
    process: "sshd",
    pid: 614,
  });

  // BGP daemon (TCP 179)
  const bgpConfig = feats.bgp as { asn?: number; neighbors?: unknown[] } | undefined;
  if (bgpConfig?.asn || (bgpConfig?.neighbors && bgpConfig.neighbors.length > 0)) {
    sockets.push({
      netid: "tcp",
      state: "LISTEN",
      recvQ: 0,
      sendQ: 128,
      localAddr: "0.0.0.0",
      localPort: 179,
      peerAddr: "0.0.0.0",
      peerPort: "*",
      process: "bgpd",
      pid: 1042,
    });
  }

  // HTTP server (TCP 80 on servers or pc)
  if (dev.type === "server" || dev.services.includes("http") || dev.type === "internet") {
    sockets.push({
      netid: "tcp",
      state: "LISTEN",
      recvQ: 0,
      sendQ: 512,
      localAddr: "0.0.0.0",
      localPort: 80,
      peerAddr: "0.0.0.0",
      peerPort: "*",
      process: "nginx",
      pid: 890,
    });
  }

  // DNS server / resolver (UDP 53)
  if (dev.type === "dns-server" || dev.services.includes("dns") || feats.dns) {
    sockets.push({
      netid: "udp",
      state: "UNCONN",
      recvQ: 0,
      sendQ: 0,
      localAddr: "0.0.0.0",
      localPort: 53,
      peerAddr: "0.0.0.0",
      peerPort: "*",
      process: "dnsmasq",
      pid: 721,
    });
  }

  // DHCP server / relay (UDP 67)
  if (dev.type === "dhcp-server" || dev.services.includes("dhcp") || feats.dhcp_relay || feats.dhcp) {
    sockets.push({
      netid: "udp",
      state: "UNCONN",
      recvQ: 0,
      sendQ: 0,
      localAddr: "0.0.0.0",
      localPort: 67,
      peerAddr: "0.0.0.0",
      peerPort: "*",
      process: "dhcpd",
      pid: 815,
    });
  }

  // NTP daemon (UDP 123)
  if (dev.type === "ntp-server" || dev.services.includes("ntp") || feats.ntp) {
    sockets.push({
      netid: "udp",
      state: "UNCONN",
      recvQ: 0,
      sendQ: 0,
      localAddr: "0.0.0.0",
      localPort: 123,
      peerAddr: "0.0.0.0",
      peerPort: "*",
      process: "ntpd",
      pid: 933,
    });
  }

  // SNMP agent (UDP 161)
  if (feats.snmp || isSwitch(dev.type) || isRouter(dev.type)) {
    sockets.push({
      netid: "udp",
      state: "UNCONN",
      recvQ: 0,
      sendQ: 0,
      localAddr: "0.0.0.0",
      localPort: 161,
      peerAddr: "0.0.0.0",
      peerPort: "*",
      process: "snmpd",
      pid: 975,
    });
  }

  // BFD daemon (UDP 3784)
  if (feats.bfd) {
    sockets.push({
      netid: "udp",
      state: "UNCONN",
      recvQ: 0,
      sendQ: 0,
      localAddr: "0.0.0.0",
      localPort: 3784,
      peerAddr: "0.0.0.0",
      peerPort: "*",
      process: "bfdd",
      pid: 1104,
    });
  }

  return sockets;
}

export const ssCommand: CommandHandler = {
  name: "ss",
  aliases: ["netstat"],
  summary: "Display socket statistics and listening ports",
  usage: "ss [-t] [-u] [-l] [-n] [-p]",
  help: [
    "SS / NETSTAT",
    "",
    "Usage:",
    "  ss [-tulnp]",
    "  netstat -tuln",
    "",
    "Options:",
    "  -t        Show TCP sockets",
    "  -u        Show UDP sockets",
    "  -l        Show listening sockets",
    "  -n        Show numeric ports instead of names",
    "  -p        Show process information",
  ],
  run(args, ctx): CommandResult {
    let showTcp = true;
    let showUdp = true;
    let showProcess = true;

    // Parse options (e.g. -tuln or -t -u -l)
    const flags = args.filter((a) => a.startsWith("-")).join("");
    if (flags.includes("t") && !flags.includes("u")) {
      showTcp = true;
      showUdp = false;
    } else if (flags.includes("u") && !flags.includes("t")) {
      showTcp = false;
      showUdp = true;
    }

    const all = getDeviceSockets(ctx.device);
    const filtered = all.filter((s) => {
      if (s.netid === "tcp" && !showTcp) return false;
      if (s.netid === "udp" && !showUdp) return false;
      return true;
    });

    const out: OutputLine[] = [];
    const hdr =
      "Netid".padEnd(7) +
      "State".padEnd(9) +
      "Recv-Q".padEnd(8) +
      "Send-Q".padEnd(8) +
      "Local Address:Port".padEnd(23) +
      "Peer Address:Port".padEnd(20) +
      "Process";
    out.push(line(hdr));

    for (const s of filtered) {
      const netid = s.netid.padEnd(7);
      const state = s.state.padEnd(9);
      const rq = String(s.recvQ).padEnd(8);
      const sq = String(s.sendQ).padEnd(8);
      const local = `${s.localAddr}:${s.localPort}`.padEnd(23);
      const peer = `${s.peerAddr}:${s.peerPort}`.padEnd(20);
      const proc = `users:(("${s.process}",pid=${s.pid},fd=3))`;
      out.push(line(`${netid}${state}${rq}${sq}${local}${peer}${proc}`));
    }

    return { output: out };
  },
};

