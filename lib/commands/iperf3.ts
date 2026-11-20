/**
 * `iperf3` on a host, backed by the flow-level QoS model (lib/protocols/qos-model.ts).
 *
 *   iperf3 -s [-p port]                      server: marks the host as listening
 *   iperf3 -c <ip> [-u] [-b rate] [-t secs] [-P n] [-S tos] [-l len] [-p port]
 *
 * TIMING: the client prints its whole report immediately. Each 1 s interval is
 * projected from the model with the flows that are active at that second (its
 * own streams plus any other iperf3 streams still running), so it shows the
 * bottleneck link, competing flows and QoS scheduling. The streams are then
 * registered as model flows that run for -t seconds of WALL time: the "qos"
 * daemon accounts them every 100 ms on queue / PFC / port / drop counters, and a
 * second iperf3 started meanwhile competes with them.
 *
 * Output layout follows iperf3 3.x (report headers "[ ID] Interval Transfer
 * Bitrate Retr" / "... Total Datagrams" / "... Jitter Lost/Total Datagrams",
 * sender/receiver summary lines, stream ids 5,7,9..., [SUM] with -P > 1). Bytes
 * use 1024 units, bitrates 1000 units (iperf3 unit_snprintf). TCP payload per
 * packet is the 1448 B MSS (-l only sets the write size); UDP -l is the datagram
 * size (default 1460). Default UDP rate 1 Mbit/s, -b 0 = unlimited.
 */
import { CommandContext, CommandHandler, CommandResult, OutputLine, err, line, muted } from "./types";
import { isHost } from "../models/device";
import { featureState, peekFeatureState } from "../models/feature-state";
import { interfaceByName } from "../models/device";
import {
  QosFlow,
  TCP_MSS,
  UDP_DEFAULT_LEN,
  L1_OVERHEAD,
  allFlows,
  computeRates,
  deviceOwningIp,
  flowStore,
  frameBytesFor,
  goodput,
  traceFlowPath,
} from "../protocols/qos-model";

interface ServerState {
  port: number;
  tests: number;
}

const DEFAULT_PORT = 5201;
const SEP = "- - - - - - - - - - - - - - - - - - - - - - - - -";

/** iperf3 unit_snprintf: adaptive unit, 4-wide number. */
function unit(value: number, bits: boolean): string {
  const k = bits ? 1000 : 1024;
  const names = bits ? ["bits", "Kbits", "Mbits", "Gbits", "Tbits"] : ["Bytes", "KBytes", "MBytes", "GBytes", "TBytes"];
  let v = value;
  let u = 0;
  while (v >= k && u < names.length - 1) {
    v /= k;
    u++;
  }
  const num = v < 9.995 ? v.toFixed(2) : v < 99.95 ? v.toFixed(1) : v.toFixed(0);
  return `${num.padStart(4)} ${names[u]}`;
}

const interval = (a: number, b: number) => `${a.toFixed(2).padStart(6)}-${b.toFixed(2).padEnd(6)} sec`;
const tag = (id: number | "SUM") => (id === "SUM" ? "[SUM]" : `[${String(id).padStart(3)}]`);
const pct = (lost: number, total: number) => {
  if (!total || !lost) return "0%";
  return `${Number(((lost * 100) / total).toPrecision(2))}%`;
};

function parseRate(tok: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([kKmMgGtT])?$/.exec(tok.split("/")[0]);
  if (!m) return null;
  const mul = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[(m[2] ?? "").toLowerCase() as "k"] ?? 1;
  return Number(m[1]) * mul;
}

interface Opts {
  server: boolean;
  client?: string;
  udp: boolean;
  rate?: number;
  time: number;
  parallel: number;
  tos: number;
  len?: number;
  port: number;
}

function parse(args: string[]): Opts | string {
  const o: Opts = { server: false, udp: false, time: 10, parallel: 1, tos: 0, port: DEFAULT_PORT };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => args[++i];
    switch (a) {
      case "-s":
      case "--server":
        o.server = true;
        break;
      case "-c":
      case "--client":
        o.client = val();
        if (!o.client) return "option requires an argument -- 'c'";
        break;
      case "-u":
      case "--udp":
        o.udp = true;
        break;
      case "-b":
      case "--bitrate":
      case "--bandwidth": {
        const r = parseRate(val() ?? "");
        if (r === null) return "invalid bitrate";
        o.rate = r;
        break;
      }
      case "-t":
      case "--time": {
        const t = Number(val());
        if (!Number.isFinite(t) || t <= 0 || t > 3600) return "test duration must be between 1 and 3600 seconds";
        o.time = t;
        break;
      }
      case "-P":
      case "--parallel": {
        const n = Number(val());
        if (!Number.isInteger(n) || n < 1 || n > 128) return "number of parallel streams must be 1-128";
        o.parallel = n;
        break;
      }
      case "-S":
      case "--tos": {
        const n = Number(val());
        if (!Number.isInteger(n) || n < 0 || n > 255) return "bad TOS value (0-255, decimal or 0x hex)";
        o.tos = n;
        break;
      }
      case "-l":
      case "--length": {
        const n = parseRate(val() ?? "");
        if (n === null || n < 16 || n > 65507) return "block size must be 16-65507 bytes";
        o.len = Math.floor(n);
        break;
      }
      case "-p":
      case "--port": {
        const n = Number(val());
        if (!Number.isInteger(n) || n < 1 || n > 65535) return "bad port number";
        o.port = n;
        break;
      }
      case "-i":
      case "--interval":
        val(); // reports are always per second
        break;
      default:
        return `unrecognized option '${a}'`;
    }
  }
  if (o.server && o.client) return "cannot be both server and client";
  if (!o.server && !o.client) return "parameter error - must either be a client (-c) or server (-s)";
  return o;
}

function runServer(o: Opts, ctx: CommandContext): CommandResult {
  const st = featureState<ServerState>(ctx.device, "iperf3-server", () => ({ port: o.port, tests: 0 }));
  st.port = o.port;
  return {
    output: [
      line("-----------------------------------------------------------"),
      line(`Server listening on ${o.port} (test #${st.tests + 1})`),
      line("-----------------------------------------------------------"),
      muted("(listening in the background; clients print the results)"),
    ],
  };
}

function runClient(o: Opts, ctx: CommandContext): CommandResult {
  const dstIp = o.client!;
  const now = Date.now();
  const net = ctx.network;
  const dst = deviceOwningIp(net, dstIp);
  const out: OutputLine[] = [line(`Connecting to host ${dstIp}, port ${o.port}`)];
  const srv = dst && peekFeatureState<ServerState>(dst, "iperf3-server");
  if (!dst || !srv || srv.port !== o.port) {
    out.push(err("iperf3: error - unable to connect to server - server may have stopped running or use a different port, firewall issue, etc.: Connection refused"));
    return { output: out };
  }
  // The control connection is TCP to the server port (also for -u tests).
  const hops = traceFlowPath(net, ctx.device.id, dstIp, { proto: "tcp", srcPort: 40000, dstPort: o.port });
  if (!hops) {
    // Routed but the SYN is filtered (ACL) → connect() times out; otherwise unreachable.
    const filtered = traceFlowPath(net, ctx.device.id, dstIp) !== null;
    out.push(err(filtered
      ? "iperf3: error - unable to connect to server - server may have stopped running or use a different port, firewall issue, etc.: Connection timed out"
      : "iperf3: error - unable to connect to server: No route to host"));
    return { output: out };
  }
  srv.tests += 1;
  const srcIface = interfaceByName(ctx.device, hops[0].outIf);
  const srcIp = srcIface?.ipv4[0]?.address ?? "0.0.0.0";
  const proto = o.udp ? "udp" : "tcp";
  const payload = o.udp ? (o.len ?? UDP_DEFAULT_LEN) : TCP_MSS;
  const rateBps = o.udp ? (o.rate ?? 1e6) : (o.rate ?? 0);
  const store = flowStore(ctx.device);
  const endMs = now + o.time * 1000;
  const mine: QosFlow[] = [];
  for (let n = 0; n < o.parallel; n++) {
    store.seq += 1;
    const id = 5 + 2 * n;
    mine.push({
      id: `${ctx.device.id}#${store.seq}`,
      stream: id,
      srcId: ctx.device.id,
      srcIp,
      srcPort: 40000 + ((store.seq * 7919 + [...ctx.device.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % 20000 + 20000) % 20000,
      dstId: dst.id,
      dstIp,
      dstPort: o.port,
      proto,
      rateBps,
      payload,
      frameBytes: frameBytesFor(proto, payload),
      dscp: o.tos >> 2,
      startMs: now,
      endMs,
      lastMs: now,
      hops,
      tracedMs: now,
      carry: hops.map(() => 0),
      dropCarry: hops.map(() => 0),
      sentPkts: 0,
      deliveredPkts: 0,
      lostPkts: 0,
    });
  }
  for (const f of mine) out.push(line(`${tag(f.stream)} local ${srcIp} port ${f.srcPort} connected to ${dstIp} port ${o.port}`));

  // Project each 1 s interval with the flows active at that second.
  const others = allFlows(net);
  const tot = mine.map(() => ({ bytes: 0, rx: 0, retr: 0, sent: 0, recv: 0 }));
  const rows: OutputLine[] = [];
  const pk = (f: QosFlow, wireBps: number, dur: number) => (wireBps * dur) / ((f.frameBytes + L1_OVERHEAD) * 8);
  for (let t0 = 0; t0 < o.time - 1e-9; t0 += 1) {
    const dur = Math.min(1, o.time - t0);
    const at = now + t0 * 1000;
    const active = [...others.filter((f) => f.startMs <= at && f.endMs > at && f.hops.length), ...mine];
    const res = computeRates(net, active);
    let sumB = 0;
    let sumR = 0;
    let sumD = 0;
    mine.forEach((f, n) => {
      const r = res.flows.get(f.id)!;
      if (o.udp) {
        const sent = Math.round(pk(f, r.sent, dur));
        const recv = Math.round(pk(f, r.rate, dur));
        const bytes = sent * f.payload;
        tot[n].sent += sent;
        tot[n].recv += recv;
        tot[n].bytes += bytes;
        tot[n].rx += recv * f.payload;
        sumB += bytes;
        sumD += sent;
        rows.push(line(`${tag(f.stream)} ${interval(t0, t0 + dur)}  ${unit(bytes, false)}  ${unit((bytes * 8) / dur, true)}/sec  ${sent}  `));
      } else {
        const bytes = (goodput(f, r.rate) * dur) / 8;
        const retr = Math.round(pk(f, r.hops.reduce((s, h) => s + h.drop, 0), dur));
        tot[n].bytes += bytes;
        tot[n].rx += bytes - retr * f.payload;
        tot[n].retr += retr;
        sumB += bytes;
        sumR += retr;
        rows.push(line(`${tag(f.stream)} ${interval(t0, t0 + dur)}  ${unit(bytes, false)}  ${unit((bytes * 8) / dur, true)}/sec  ${String(retr).padStart(3)}`));
      }
    });
    if (mine.length > 1) {
      rows.push(
        line(o.udp
          ? `${tag("SUM")} ${interval(t0, t0 + dur)}  ${unit(sumB, false)}  ${unit((sumB * 8) / dur, true)}/sec  ${sumD}  `
          : `${tag("SUM")} ${interval(t0, t0 + dur)}  ${unit(sumB, false)}  ${unit((sumB * 8) / dur, true)}/sec  ${String(sumR).padStart(3)}`),
      );
    }
    if (mine.length > 1 && t0 + 1 < o.time - 1e-9) rows.push(line(SEP));
  }
  out.push(line(o.udp ? "[ ID] Interval           Transfer     Bitrate         Total Datagrams" : "[ ID] Interval           Transfer     Bitrate         Retr"));
  out.push(...rows);
  out.push(line(SEP));
  out.push(line(o.udp ? "[ ID] Interval           Transfer     Bitrate         Jitter    Lost/Total Datagrams" : "[ ID] Interval           Transfer     Bitrate         Retr"));
  const T = o.time;
  const span = interval(0, T);
  const jitter = (n: number) => (tot[n].recv < tot[n].sent ? 0.05 : 0.005).toFixed(3);
  mine.forEach((f, n) => {
    const a = tot[n];
    if (o.udp) {
      out.push(line(`${tag(f.stream)} ${span}  ${unit(a.bytes, false)}  ${unit((a.bytes * 8) / T, true)}/sec  ${"0.000"} ms  0/${a.sent} (0%)  sender`));
      const lost = a.sent - a.recv;
      out.push(line(`${tag(f.stream)} ${span}  ${unit(a.rx, false)}  ${unit((a.rx * 8) / T, true)}/sec  ${jitter(n)} ms  ${lost}/${a.sent} (${pct(lost, a.sent)})  receiver`));
    } else {
      out.push(line(`${tag(f.stream)} ${span}  ${unit(a.bytes, false)}  ${unit((a.bytes * 8) / T, true)}/sec  ${String(a.retr).padStart(3)}             sender`));
      out.push(line(`${tag(f.stream)} ${span}  ${unit(a.rx, false)}  ${unit((a.rx * 8) / T, true)}/sec                  receiver`));
    }
  });
  if (mine.length > 1) {
    const s = tot.reduce((x, a) => ({ bytes: x.bytes + a.bytes, rx: x.rx + a.rx, retr: x.retr + a.retr, sent: x.sent + a.sent, recv: x.recv + a.recv }), { bytes: 0, rx: 0, retr: 0, sent: 0, recv: 0 });
    if (o.udp) {
      const lost = s.sent - s.recv;
      out.push(line(`${tag("SUM")} ${span}  ${unit(s.bytes, false)}  ${unit((s.bytes * 8) / T, true)}/sec  0.000 ms  0/${s.sent} (0%)  sender`));
      out.push(line(`${tag("SUM")} ${span}  ${unit(s.rx, false)}  ${unit((s.rx * 8) / T, true)}/sec  ${(lost ? 0.05 : 0.005).toFixed(3)} ms  ${lost}/${s.sent} (${pct(lost, s.sent)})  receiver`));
    } else {
      out.push(line(`${tag("SUM")} ${span}  ${unit(s.bytes, false)}  ${unit((s.bytes * 8) / T, true)}/sec  ${String(s.retr).padStart(3)}             sender`));
      out.push(line(`${tag("SUM")} ${span}  ${unit(s.rx, false)}  ${unit((s.rx * 8) / T, true)}/sec                  receiver`));
    }
  }
  out.push(line(""), line("iperf Done."));
  out.push(muted(`(streams keep running on the simulated network for ${T}s — watch show queue counters / show interfaces counters)`));
  store.flows.push(...mine);
  return { output: out };
}


export const iperf3Command: CommandHandler = {
  name: "iperf3",
  summary: "network throughput test (flow-level bandwidth/QoS model)",
  usage: "iperf3 -s | iperf3 -c <host> [-u] [-b rate] [-t secs] [-P n] [-S tos] [-l len] [-p port]",
  help: [
    "IPERF3",
    "",
    "Usage: iperf3 [-s|-c host] [options]",
    "  -s, --server              run in server mode (listens in the background)",
    "  -c, --client <host>       run in client mode, connecting to <host>",
    "  -u, --udp                 use UDP rather than TCP",
    "  -b, --bitrate #[KMG]      target bitrate (UDP default 1 Mbit/sec, TCP unlimited; 0 = unlimited)",
    "  -t, --time #              time in seconds to transmit for (default 10 secs)",
    "  -P, --parallel #          number of parallel client streams to run",
    "  -S, --tos N               set the IP type of service (DSCP = TOS >> 2), e.g. -S 0xb8 = EF",
    "  -l, --length #[KMG]       length of buffer (UDP datagram size, default 1460)",
    "  -p, --port #              server port to listen on/connect to (default 5201)",
    "",
    "Throughput comes from the flow-level model: bottleneck link speed, competing",
    "streams and the switch QoS (DSCP->TC->queue, DWRR/strict scheduler, WRED, PFC).",
    "The report prints at once; the streams then run for -t seconds of wall time.",
  ],
  run(args, ctx): CommandResult {
    if (!isHost(ctx.device.type)) return { output: [err("iperf3: command not found (run it on a host)")] };
    if (args.includes("-h") || args.includes("--help")) return { output: iperf3Command.help.map((t) => line(t)) };
    const o = parse(args);
    if (typeof o === "string") return { output: [err(`iperf3: ${o}`), muted(`Usage: ${iperf3Command.usage}`)] };
    return o.server ? runServer(o, ctx) : runClient(o, ctx);
  },
};
