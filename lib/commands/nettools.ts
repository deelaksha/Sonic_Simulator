/**
 * Classic terminal network tools — nc, hping3, arping, mtr — each driving REAL
 * packets through the simulation (host TCP stack in lib/protocols/tcp-stack.ts,
 * ARP frames, ICMP/TCP/UDP probes), so tcpdump, the timeline and counters see
 * every segment. Output follows OpenBSD netcat, hping3, iputils arping and mtr
 * report mode.
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { isValidIpv4 } from "../models/ip";
import { Device, findInterface, interfaceByName } from "../models/device";
import { NetInterface, primaryIpv4 } from "../models/interface";
import { longestPrefixMatch } from "../models/route";
import { SimEvent } from "../engine";
import { Frame } from "../models/packet";
import { ipOutput } from "../protocols/ipv4";
import { buildArpRequest } from "../protocols/arp";
import { sendIpv4 } from "../control/packet";
import { normalizeMac } from "../models/mac";
import {
  tcpStack,
  peekTcpStack,
  tcpConnect,
  tcpSend,
  tcpClose,
  tcpListenerOwner,
  allocPort,
  sourceFor,
  ConnectResult,
} from "../protocols/tcp-stack";

// --- shared helpers ---

interface Opts {
  o: Map<string, string | true>;
  pos: string[];
  bad?: string;
}

/** getopt(3)-style parse: clustered short flags (`-zv`), values attached or separate (`-c3`, `-c 3`), `--long[=v]`. */
function getopt(args: string[], valued: string, longValued: string[] = []): Opts {
  const o = new Map<string, string | true>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && a.length > 2) {
      const [k, v] = a.slice(2).split("=", 2);
      if (longValued.includes(k)) {
        const val = v ?? args[++i];
        if (val === undefined) return { o, pos, bad: `option '--${k}' requires an argument` };
        o.set(k, val);
      } else o.set(k, true);
    } else if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (valued.includes(ch)) {
          const val = a.length > j + 1 ? a.slice(j + 1) : args[++i];
          if (val === undefined) return { o, pos, bad: `option requires an argument -- '${ch}'` };
          o.set(ch, val);
          break;
        }
        o.set(ch, true);
      }
    } else pos.push(a);
  }
  return { o, pos };
}

const str = (o: Opts, k: string): string | undefined => {
  const v = o.o.get(k);
  return typeof v === "string" ? v : undefined;
};

const MAX_EVENTS = 2500;
function collect(into: SimEvent[], more: SimEvent[] | undefined): void {
  if (!more) return;
  for (const e of more) {
    if (into.length >= MAX_EVENTS) return;
    into.push(e);
  }
}

const validPort = (p: number) => Number.isInteger(p) && p >= 1 && p <= 65535;

const SERVICES: Record<number, string> = { 21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "domain", 80: "http", 123: "ntp", 161: "snmp", 179: "bgp", 443: "https", 6343: "sflow" };
const svc = (p: number) => SERVICES[p] ?? "*";

/** Egress interface + source IP for a destination (route lookup, as the kernel does). */
function egressFor(device: Device, dstIp: string): { iface?: NetInterface; ip?: string } {
  const m = longestPrefixMatch(device.routingTable, dstIp);
  const iface = m ? findInterface(device, m.route.interfaceId) : undefined;
  return { iface, ip: iface ? primaryIpv4(iface)?.address : undefined };
}

// --- nc ---

function connectError(host: string, port: number, proto: string, r: Exclude<ConnectResult, { ok: true }>): OutputLine {
  if (r.reason === "timeout") return err(`nc: connect to ${host} port ${port} (${proto}) timed out: Operation now in progress`);
  const why = r.reason === "refused" ? "Connection refused" : r.reason === "arp-failed" ? "No route to host" : "Network is unreachable";
  return err(`nc: connect to ${host} port ${port} (${proto}) failed: ${why}`);
}

/** "22", "20-25", "22,80,443" → port list (max 1024 ports). */
function parsePorts(spec: string): number[] | undefined {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return undefined;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (!validPort(a) || !validPort(b) || b < a) return undefined;
    for (let p = a; p <= b; p++) out.push(p);
  }
  return out.length && out.length <= 1024 ? out : undefined;
}

function ncListen(o: Opts, ctx: CommandContext): CommandResult {
  const proto = o.o.has("u") ? "udp" : "tcp";
  const portStr = str(o, "p") ?? o.pos[0];
  const dev = ctx.device;
  if (!portStr) {
    const st = peekTcpStack(dev);
    const ls = Object.values(st?.listeners ?? {});
    if (!ls.length) return { output: [muted("nc: no listeners on this host — start one with: nc -l <port>")] };
    return {
      output: ls.map((l) => line(`${l.proto} 0.0.0.0:${l.port}${l.keep ? " (-k)" : ""}  ${(st!.inbox[`${l.proto}/${l.port}`] ?? []).length} unread line(s)`)),
    };
  }
  const port = Number(portStr);
  if (!validPort(port)) return { output: [err(`nc: port number invalid: ${portStr}`)] };
  const key = `${proto}/${port}`;
  const st = tcpStack(dev);
  const listening = !!st.listeners[key];
  const unread = st.inbox[key] ?? [];

  if (o.o.has("stop")) {
    if (!listening && !unread.length) return { output: [err(`nc: no listener on ${proto} port ${port}`)] };
    delete st.listeners[key];
    delete st.inbox[key];
    return { output: [...unread.map((t) => line(t)), muted(`nc: listener on ${proto} port ${port} closed`)] };
  }

  // A listener already exists, or one has finished with data: show what arrived.
  if (listening || unread.length) {
    delete st.inbox[key];
    const out = unread.map((t) => line(t));
    if (listening) {
      if (!unread.length) out.push(muted(`nc: still listening on 0.0.0.0 ${port} (${proto}) — nothing received yet`));
    } else {
      out.push(muted(`nc: session ended; the listener on port ${port} has exited (use -k to keep listening)`));
    }
    return { output: out };
  }

  if (proto === "tcp" && (tcpListenerOwner(dev, port) || port === 179)) return { output: [err("nc: Address already in use")] };
  st.listeners[key] = { proto, port, keep: o.o.has("k") };
  return {
    output: [
      line(`Listening on 0.0.0.0 ${port}`),
      muted(`(runs in the background: \`nc -l ${port}\`${proto === "udp" ? " -u" : ""} again prints what was received, \`nc -l --stop ${port}\` closes it)`),
    ],
  };
}

function ncConnect(o: Opts, ctx: CommandContext): CommandResult {
  const [host, portSpec, ...msg] = o.pos;
  if (!host || !portSpec) return { output: [err("usage: nc [-uvz] [-l] [-k] [-p port] [host] [port] [message]")] };
  if (!isValidIpv4(host)) return { output: [err(`nc: getaddrinfo for host "${host}" port ${portSpec}: Name or service not known`)] };
  const verbose = o.o.has("v");
  const udp = o.o.has("u");
  const proto = udp ? "udp" : "tcp";
  const dev = ctx.device;
  const events: SimEvent[] = [];
  const out: OutputLine[] = [];

  if (o.o.has("z")) {
    const ports = parsePorts(portSpec);
    if (!ports) return { output: [err(`nc: port range not valid: ${portSpec}`)] };
    for (const port of ports) {
      if (udp) {
        // No ICMP port-unreachable is generated in the simulator: UDP always "succeeds", like nc -zu with no reply.
        const r = ctx.runSim((sim) => {
          const src = sourceFor(dev, host);
          if (!src.ip) return false;
          return sendIpv4(sim, dev, { src: src.ip, dst: host, udp: { sport: allocPort(dev), dport: port }, payload: [], summary: `UDP probe → ${port}` }).ok;
        });
        collect(events, r.events);
        if (verbose && r.value) out.push(line(`Connection to ${host} ${port} port [udp/${svc(port)}] succeeded!`, "success"));
        continue;
      }
      const r = ctx.runSim((sim) => {
        const c = tcpConnect(sim, dev, host, port);
        if (c.ok) tcpClose(sim, dev, c.conn);
        return c;
      });
      collect(events, r.events);
      if (r.value.ok) out.push(line(`Connection to ${host} ${port} port [tcp/${svc(port)}] succeeded!`, "success"));
      else if (verbose) out.push(connectError(host, port, "tcp", r.value));
    }
    return { output: out, events };
  }

  const port = Number(portSpec);
  if (!validPort(port)) return { output: [err(`nc: port number invalid: ${portSpec}`)] };
  const message = msg.length ? msg.join(" ") + "\n" : "";

  if (udp) {
    const r = ctx.runSim((sim) => {
      const src = sourceFor(dev, host);
      if (!src.ip) return { ok: false, reason: src.reason };
      return sendIpv4(sim, dev, {
        src: src.ip,
        dst: host,
        udp: { sport: allocPort(dev), dport: port },
        payload: Array.from(new TextEncoder().encode(message)),
        summary: `UDP → ${port} len ${message.length}`,
      });
    });
    if (!r.value.ok) return { output: [err(`nc: connect to ${host} port ${port} (udp) failed: Network is unreachable`)], events: r.events };
    if (verbose) out.push(line(`Connection to ${host} ${port} port [udp/${svc(port)}] succeeded!`, "success"));
    return { output: out, events: r.events };
  }

  const r = ctx.runSim((sim) => {
    const c = tcpConnect(sim, dev, host, port);
    if (!c.ok) return { c, rx: "" };
    if (message) tcpSend(sim, dev, c.conn, message);
    tcpClose(sim, dev, c.conn);
    return { c, rx: c.conn.rx };
  });
  if (!r.value.c.ok) return { output: [connectError(host, port, proto, r.value.c)], events: r.events };
  if (verbose) out.push(line(`Connection to ${host} ${port} port [tcp/${svc(port)}] succeeded!`, "success"));
  if (r.value.rx) for (const t of r.value.rx.replace(/\r?\n$/, "").split(/\r?\n/)) out.push(line(t));
  return { output: out, events: r.events };
}

export const ncCommand: CommandHandler = {
  name: "nc",
  aliases: ["netcat"],
  summary: "netcat: TCP/UDP connect, listen and port scan (real segments)",
  usage: "nc [-v] [-u] [-z] <host> <port|range> [message] | nc -l [-k] [-u] [-p] <port>",
  help: [
    "NC (OpenBSD netcat)",
    "",
    "Usage:",
    "  nc -l [-k] [-u] [-p] <port>       start a listener (runs in the background)",
    "  nc -l <port>                      again: print what the listener received",
    "  nc -l --stop <port>               close the listener",
    "  nc -l                             list this host's listeners",
    "  nc [-v] <host> <port> [message]   connect, send 'message\\n', print the reply, close",
    "  nc -zv <host> <port|lo-hi|a,b>    port scan (open / refused / timed out)",
    "  nc -u [-v] <host> <port> [msg]    send one UDP datagram",
    "",
    "A TCP listener without -k exits after its first session closes (OpenBSD nc).",
    "Received data is kept until read with `nc -l <port>`. sshd (22) and nginx",
    "(80, servers) also accept connections. Packets: SYN, SYN-ACK, ACK, PSH, FIN.",
  ],
  run(args, ctx): CommandResult {
    const o = getopt(args, "pwqs");
    if (o.bad) return { output: [err(`nc: ${o.bad}`)] };
    return o.o.has("l") ? ncListen(o, ctx) : ncConnect(o, ctx);
  },
};

// --- hping3 ---

const HPING_FLAGS: [string, string][] = [["F", "FIN"], ["S", "SYN"], ["R", "RST"], ["P", "PSH"], ["A", "ACK"], ["U", "URG"]];

/** hping3 prints reply flags in this order (waitpacket.c). */
function hpingFlags(flags: string[]): string {
  return ["RST", "SYN", "ACK", "FIN", "PSH", "URG"].filter((f) => flags.includes(f)).map((f) => (f === "RST" ? "R" : f[0])).join("");
}

/** IP total length of a reply (typed frames without bytes: ICMP echo mirrors the request size). */
function ipTotalLen(f: Frame, size: number): number {
  return f.rawL3 && f.rawL3.length >= 4 ? (f.rawL3[2] << 8) | f.rawL3[3] : 28 + size;
}

export const hping3Command: CommandHandler = {
  name: "hping3",
  aliases: ["hping"],
  summary: "Send crafted TCP/ICMP/UDP probes and show the replies",
  usage: "hping3 [-S|-A|-F|-R|-P|-U|-1|-2] [-p port] [-c count] [-i u<usec>|<sec>] [-s sport] [-d size] <host>",
  help: [
    "HPING3",
    "",
    "Usage:",
    "  hping3 [-S] [-A] [-F] [-R] [-P] [-U] -p <port> [-c count] <host>   TCP mode (default)",
    "  hping3 -1 [-c count] <host>                                     ICMP echo mode",
    "  hping3 -2 -p <port> [-c count] <host>                           UDP mode",
    "",
    "Options:",
    "  -c count   packets to send (default 4 in the simulator)",
    "  -i X       interval: X seconds, or uX microseconds",
    "  -s port    base source port (incremented per packet)",
    "  -d size    data bytes",
    "",
    "Closed port → flags=RA, listening port → flags=SA (the kernel then RSTs).",
    "--flood / --fast / --faster are not available in the simulator.",
  ],
  run(args, ctx): CommandResult {
    const o = getopt(args, "pcisd");
    if (o.bad) return { output: [err(`hping3: ${o.bad}`)] };
    for (const f of ["flood", "fast", "faster"]) if (o.o.has(f)) return { output: [err(`hping3: --${f} is not available in the simulator (use -c and -i)`)] };
    const host = o.pos[0];
    if (!host) return { output: [err("usage: hping3 host [options]  (try: hping3 --help)")] };
    if (!isValidIpv4(host)) return { output: [err(`hping3: unknown host ${host}`)] };
    const count = str(o, "c") !== undefined ? Number(str(o, "c")) : 4;
    if (!Number.isInteger(count) || count < 1 || count > 1000) return { output: [err("hping3: count must be 1-1000")] };
    const iv = str(o, "i");
    if (iv !== undefined && !/^u?\d+$/.test(iv)) return { output: [err(`hping3: invalid interval ${iv}`)] };
    const dport = str(o, "p") !== undefined ? Number(str(o, "p")) : 0;
    if (!Number.isInteger(dport) || dport < 0 || dport > 65535) return { output: [err("hping3: invalid destination port")] };
    const size = str(o, "d") !== undefined ? Number(str(o, "d")) : 0;
    if (!Number.isInteger(size) || size < 0 || size > 1400) return { output: [err("hping3: data size must be 0-1400")] };
    const mode = o.o.has("1") ? "icmp" : o.o.has("2") ? "udp" : "tcp";
    const flags = HPING_FLAGS.filter(([c]) => o.o.has(c)).map(([, n]) => n);

    const dev = ctx.device;
    const eg = egressFor(dev, host);
    if (!eg.iface || !eg.ip) return { output: [err(`hping3: ${host}: Network is unreachable`)] };
    const srcIp = eg.ip;
    const sbase = str(o, "s") !== undefined ? Number(str(o, "s")) : 1024 + (allocPort(dev) % 30000);
    const icmpId = (sbase * 7) & 0xffff;

    const head =
      mode === "icmp"
        ? `icmp mode set, 28 headers + ${size} data bytes`
        : mode === "udp"
          ? `udp mode set, 28 headers + ${size} data bytes`
          : `${flags.length ? HPING_FLAGS.filter(([, n]) => flags.includes(n)).map(([c]) => c).join("") + " set" : "NO FLAGS are set"}, 40 headers + ${size} data bytes`;
    const out: OutputLine[] = [line(`HPING ${host} (${eg.iface.name} ${host}): ${head}`)];
    const events: SimEvent[] = [];
    const rtts: number[] = [];

    for (let i = 0; i < count; i++) {
      const sport = (sbase + i) & 0xffff;
      const r = ctx.runSim((sim) => {
        const start = sim.wallNow();
        const data = new Array<number>(size).fill(0x58); // 'X', as hping pads
        if (mode === "icmp") {
          ipOutput(sim, dev, {
            srcIp,
            dstIp: host,
            ttl: 64,
            protocol: "ICMP",
            identification: i & 0xffff,
            icmp: { type: "echo-request", code: 0, identifier: icmpId, sequence: i },
            upperBytes: 8 + size,
            summary: `ICMP echo request id ${icmpId} seq ${i} (hping3)`,
          });
        } else if (mode === "udp") {
          sendIpv4(sim, dev, { src: srcIp, dst: host, udp: { sport, dport }, payload: data, summary: `UDP ${sport} → ${dport} (hping3)` });
        } else {
          sendIpv4(sim, dev, {
            src: srcIp,
            dst: host,
            tcp: { srcPort: sport, dstPort: dport, seq: (0x2a3b4c5d + i * 1000) >>> 0, ack: flags.includes("ACK") ? 0x1a2b3c4d : 0, flags, window: 512 },
            payload: data,
            summary: `TCP ${sport} → ${dport} [${flags.join(",") || "none"}] (hping3)`,
          });
        }
        const reply = sim.captures.find(
          (c) =>
            c.deviceId === dev.id &&
            c.dir === "rx" &&
            c.frame.ipv4?.srcIp === host &&
            (mode === "icmp"
              ? c.frame.icmp?.type === "echo-reply" && c.frame.icmp.identifier === icmpId && c.frame.icmp.sequence === i
              : mode === "tcp" && c.frame.tcp?.srcPort === dport && c.frame.tcp.dstPort === sport),
        );
        return reply ? { frame: reply.frame, rtt: reply.timeMs - start } : undefined;
      });
      collect(events, r.events);
      const rep = r.value;
      if (!rep) continue;
      rtts.push(rep.rtt);
      const f = rep.frame;
      const len = Math.max(46, ipTotalLen(f, size));
      if (mode === "icmp") {
        out.push(line(`len=${len} ip=${host} ttl=${f.ipv4!.ttl} id=${f.ipv4!.identification} icmp_seq=${i} rtt=${rep.rtt.toFixed(1)} ms`, "success"));
      } else {
        const t = f.tcp!;
        out.push(line(`len=${len} ip=${host} ttl=${f.ipv4!.ttl} DF id=${f.ipv4!.identification} sport=${t.srcPort} flags=${hpingFlags(t.flags)} seq=${i} win=${t.window} rtt=${rep.rtt.toFixed(1)} ms`, "success"));
      }
    }

    const loss = Math.round(((count - rtts.length) / count) * 100);
    const min = rtts.length ? Math.min(...rtts) : 0;
    const max = rtts.length ? Math.max(...rtts) : 0;
    const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : 0;
    out.push(line(""));
    out.push(line(`--- ${host} hping statistic ---`));
    out.push(line(`${count} packets transmitted, ${rtts.length} packets received, ${loss}% packet loss`));
    out.push(line(`round-trip min/avg/max = ${min.toFixed(1)}/${avg.toFixed(1)}/${max.toFixed(1)} ms`));
    return { output: out, events };
  },
};

// --- arping ---

export const arpingCommand: CommandHandler = {
  name: "arping",
  summary: "Send ARP requests to a neighbour (iputils arping, incl. -D DAD)",
  usage: "arping [-c count] [-I iface] [-D] [-f] [-b] <ip>",
  help: [
    "ARPING (iputils)",
    "",
    "Usage:",
    "  arping [-c count] [-I iface] [-D] [-f] [-b] <ip>",
    "",
    "Options:",
    "  -c count  probes to send (default 4 in the simulator)",
    "  -I iface  interface to send on (default: route to <ip>)",
    "  -D        duplicate address detection: sender IP 0.0.0.0; any reply = duplicate",
    "  -f        quit on first reply",
    "  -b        keep broadcasting (default: unicast once the MAC is known)",
  ],
  run(args, ctx): CommandResult {
    const o = getopt(args, "cIws");
    if (o.bad) return { output: [err(`arping: ${o.bad}`)] };
    const target = o.pos[0];
    if (!target) return { output: [err("arping: usage: arping [-c count] [-I iface] [-D] <ip>")] };
    if (!isValidIpv4(target)) return { output: [err(`arping: ${target}: Name or service not known`)] };
    const count = str(o, "c") !== undefined ? Number(str(o, "c")) : 4;
    if (!Number.isInteger(count) || count < 1 || count > 1000) return { output: [err("arping: invalid count")] };
    const dad = o.o.has("D");
    const dev = ctx.device;
    const ifName = str(o, "I");
    const iface = ifName ? interfaceByName(dev, ifName) : egressFor(dev, target).iface;
    if (!iface) return { output: [err(ifName ? `arping: Device ${ifName} not available.` : "arping: no route to host; specify the interface with -I")] };
    if (iface.adminState !== "up") return { output: [err(`arping: Interface "${iface.name}" is down`)] };
    const srcIp = dad ? "0.0.0.0" : primaryIpv4(iface)?.address;
    if (!srcIp) return { output: [err("arping: no source address in not-DAD mode")] };

    const out: OutputLine[] = [line(`ARPING ${target} from ${srcIp} ${iface.name}`)];
    const events: SimEvent[] = [];
    let sent = 0;
    let bcast = 0;
    let received = 0;
    let peerMac: string | undefined;
    for (let i = 0; i < count; i++) {
      const unicast = !!peerMac && !o.o.has("b") && !dad;
      const r = ctx.runSim((sim) => {
        const start = sim.wallNow();
        sim.transmit(dev.id, iface.id, buildArpRequest(iface.mac, srcIp, target, unicast ? peerMac : undefined));
        const rep = sim.captures.find(
          (c) => c.deviceId === dev.id && c.interfaceId === iface.id && c.dir === "rx" && c.frame.arp?.op === "reply" && c.frame.arp.senderIp === target && c.frame.arp.targetIp === srcIp,
        );
        return rep ? { mac: rep.frame.arp!.senderMac, rtt: rep.timeMs - start } : undefined;
      });
      collect(events, r.events);
      sent += 1;
      if (!unicast) bcast += 1;
      if (r.value) {
        received += 1;
        peerMac = r.value.mac;
        out.push(line(`Unicast reply from ${target} [${normalizeMac(r.value.mac).toUpperCase()}]  ${r.value.rtt.toFixed(3)}ms`, "success"));
        if (dad || o.o.has("f")) break;
      }
    }
    out.push(line(`Sent ${sent} probes (${bcast} broadcast(s))`));
    out.push(line(`Received ${received} response(s)`));
    if (dad && received) out.push(muted(`(duplicate address: ${target} is already in use on ${iface.name})`));
    return { output: out, events };
  },
};

// --- mtr ---

export const mtrCommand: CommandHandler = {
  name: "mtr",
  summary: "Traceroute + ping per hop (report mode)",
  usage: "mtr -r [-c count] [-n] [-m maxttl] <host>",
  help: [
    "MTR",
    "",
    "Usage:",
    "  mtr -r [-c count] [-n] [-m maxttl] <host>",
    "",
    "Runs <count> traceroute cycles (real TTL-limited ICMP probes) and prints",
    "per-hop loss and latency (Loss% Snt Last Avg Best Wrst StDev).",
    "The simulator always prints the report (-r); hops are shown numerically.",
  ],
  run(args, ctx): CommandResult {
    const o = getopt(args, "cmi", ["report-cycles", "max-ttl"]);
    if (o.bad) return { output: [err(`mtr: ${o.bad}`)] };
    const host = o.pos[0];
    if (!host) return { output: [err("mtr: usage: mtr -r [-c count] [-n] <host>")] };
    if (!isValidIpv4(host)) return { output: [err(`mtr: Failed to resolve host: ${host}: Name or service not known`)] };
    const cycles = Number(str(o, "c") ?? str(o, "report-cycles") ?? 10);
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 100) return { output: [err("mtr: count must be 1-100")] };
    const maxHops = Number(str(o, "m") ?? str(o, "max-ttl") ?? 30);
    if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 64) return { output: [err("mtr: max ttl must be 1-64")] };
    const dev = ctx.device;
    if (!longestPrefixMatch(dev.routingTable, host)) return { output: [err(`mtr: Failed to send probe: Network is unreachable`)] };

    const hops: { host?: string; snt: number; rtts: number[] }[] = [];
    const events: SimEvent[] = [];
    for (let c = 0; c < cycles; c++) {
      const r = ctx.runSim((sim) => sim.runTraceroute(dev.id, host, { maxHops }));
      collect(events, r.events);
      for (const h of r.value.hops) {
        const row = (hops[h.ttl - 1] ??= { snt: 0, rtts: [] });
        row.snt += 1;
        if (h.fromIp) {
          row.host ??= h.fromIp;
          row.rtts.push(h.rttMs ?? 0);
        }
      }
    }
    // Trailing silent hops: show one '???' line like mtr does once the path goes dark.
    let last = hops.length - 1;
    while (last > 0 && !hops[last].host && !hops[last - 1].host) last--;
    const rows = hops.slice(0, last + 1);

    const f1 = (n: number) => n.toFixed(1);
    const out: OutputLine[] = [
      line(`Start: ${new Date().toISOString().slice(0, 19)}+0000`),
      line(`HOST: ${dev.config.hostname}`.padEnd(34) + "Loss%".padStart(6) + "Snt".padStart(6) + "Last".padStart(7) + "Avg".padStart(6) + "Best".padStart(6) + "Wrst".padStart(6) + "StDev".padStart(6)),
    ];
    rows.forEach((h, i) => {
      const n = h.rtts.length;
      const loss = h.snt ? ((h.snt - n) / h.snt) * 100 : 100;
      const avg = n ? h.rtts.reduce((a, b) => a + b, 0) / n : 0;
      const sd = n ? Math.sqrt(h.rtts.reduce((a, b) => a + (b - avg) ** 2, 0) / n) : 0;
      out.push(
        line(
          `${String(i + 1).padStart(3)}.|-- ${(h.host ?? "???").padEnd(26)}` +
            `${f1(loss)}%`.padStart(6) +
            String(h.snt).padStart(6) +
            f1(n ? h.rtts[n - 1] : 0).padStart(7) +
            f1(avg).padStart(6) +
            f1(n ? Math.min(...h.rtts) : 0).padStart(6) +
            f1(n ? Math.max(...h.rtts) : 0).padStart(6) +
            f1(sd).padStart(6),
        ),
      );
    });
    return { output: out, events };
  },
};
