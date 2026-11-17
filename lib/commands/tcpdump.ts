/**
 * tcpdump (spec §19) — a LIVE capture. Like the real tool it prints the
 * "listening on …" banner and then waits: the store keeps the session open and
 * streams every frame the simulation subsequently records on the interface
 * (rx and tx) that matches the pcap filter, until `-c N` packets or Ctrl+C.
 * Packets captured before tcpdump started are never shown.
 *
 * Line formats follow tcpdump 4.99 with -n (as captured on the live SONiC
 * switch, e.g. `eth0  Out IP a.p > b.6343: sFlowv5, IPv4 agent …`).
 */
import { CommandHandler, CommandContext, CommandResult, OutputLine, line, err, muted } from "./types";
import { Device, interfaceByName, isSwitch } from "../models/device";
import { Frame } from "../models/packet";
import { CaptureRecord } from "../engine";
import { compileFilter, BpfSyntaxError } from "./bpf";
import { frameToBytes, wireLength } from "../sflow/wire";
import { decodeDatagram } from "../sflow/datagram";
import { describeControl } from "../control/daemon";

/** Wall-clock HH:MM:SS.uuuuuu (sim clocks in the live store are epoch ms). */
export function tcpdumpTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000`;
}

const TCP_FLAG_CHARS: Record<string, string> = { SYN: "S", FIN: "F", RST: "R", PSH: "P", URG: "U", ACK: "." };

function etherPrefix(f: Frame): string {
  const len = wireLength(f);
  const src = f.ethernet.srcMac.toLowerCase();
  const dst = f.ethernet.dstMac.toLowerCase();
  const et = (t: string) =>
    t === "ARP" ? "ARP (0x0806)" : t === "IPv6" ? "IPv6 (0x86dd)" : t === "IPv4" ? "IPv4 (0x0800)" : f.ethernet.typeCode === 0x88cc ? "LLDP (0x88cc)" : `Unknown (0x${(f.ethernet.typeCode ?? 0).toString(16).padStart(4, "0")})`;
  if (f.vlan) return `${src} > ${dst}, ethertype 802.1Q (0x8100), length ${len}: vlan ${f.vlan.vlanId}, p ${f.vlan.priority}, ethertype ${et(f.ethernet.etherType)}, `;
  return `${src} > ${dst}, ethertype ${et(f.ethernet.etherType)}, length ${len}: `;
}

function sflowLines(f: Frame, verbose: boolean): { head: string; extra: string[] } {
  const bytes = f.sflow!.datagram;
  try {
    const d = decodeDatagram(bytes);
    if (!verbose) return { head: `sFlowv5, IPv4 agent ${d.agentIp}, agent-id ${d.subAgentId}, length ${bytes.length}`, extra: [] };
    const extra: string[] = [];
    for (const s of d.samples) {
      if (s.kind === "flow") {
        extra.push(
          `\texpanded flow sample (3), seqnum ${s.seq}, type ${s.dsClass}, idx ${s.dsIndex}, rate ${s.samplingRate}, pool ${s.samplePool}, drops ${s.drops}, input ${s.input} output ${s.output} records 1`,
        );
        if (s.header) extra.push(`\t    enterprise 0, Flow sample header (1) protocol ${s.header.protocol}, frame length ${s.header.frameLength}, header length ${s.header.bytes.length}`);
      } else {
        extra.push(`\texpanded counter sample (4), seqnum ${s.seq}, type ${s.dsClass}, idx ${s.dsIndex}, records ${(s.generic ? 1 : 0) + (s.portName !== undefined ? 1 : 0)}`);
        if (s.generic) {
          const g = s.generic;
          extra.push(`\t      ifindex ${g.ifIndex}, iftype ${g.ifType}, ifspeed ${g.ifSpeed}, ifstatus ${g.ifStatus}`);
          extra.push(`\t      In octets ${g.inOctets}, unicast pkts ${g.inUcast}, multicast pkts ${g.inMulticast}, broadcast pkts ${g.inBroadcast}`);
          extra.push(`\t      Out octets ${g.outOctets}, unicast pkts ${g.outUcast}, multicast pkts ${g.outMulticast}, broadcast pkts ${g.outBroadcast}`);
        }
      }
    }
    return {
      head: `sFlowv5, IPv4 agent ${d.agentIp}, agent-id ${d.subAgentId}, seqnum ${d.seq}, uptime ${d.uptimeMs}, samples ${d.samples.length}, length ${bytes.length}`,
      extra,
    };
  } catch {
    return { head: `sFlowv5 [|sflow]`, extra: [] };
  }
}

/** One tcpdump packet line (plus -v / -X continuation lines). */
export function formatPacket(f: Frame, opts: { showEther?: boolean; verbose?: boolean; hex?: boolean } = {}): string[] {
  let body: string;
  let extra: string[] = [];
  if (f.arp) {
    const a = f.arp;
    const what = a.op === "request" ? `Request who-has ${a.targetIp} tell ${a.senderIp}` : `Reply ${a.senderIp} is-at ${a.senderMac.toLowerCase()}`;
    body = opts.showEther ? `${what}, length 28` : `ARP, ${what}, length 28`;
  } else if (f.ipv4) {
    const ip = f.ipv4;
    const l4 = f.udp ?? f.tcp;
    const src = l4 ? `${ip.srcIp}.${l4.srcPort}` : ip.srcIp;
    const dst = l4 ? `${ip.dstIp}.${l4.dstPort}` : ip.dstIp;
    // IP total length from the header when the real bytes are known (min-frame padding is not payload).
    const ipLen = f.rawL3 && f.rawL3.length >= 4 ? (f.rawL3[2] << 8) | f.rawL3[3] : wireLength(f) - 14 - (f.vlan ? 4 : 0);
    let what: string;
    const control = describeControl(f, !!opts.verbose);
    if (control) {
      what = control;
    } else if (f.icmp) {
      const ic = f.icmp;
      const icmpLen = ipLen - 20;
      what =
        ic.type === "echo-request"
          ? `ICMP echo request, id ${ic.identifier}, seq ${ic.sequence}, length ${icmpLen}`
          : ic.type === "echo-reply"
            ? `ICMP echo reply, id ${ic.identifier}, seq ${ic.sequence}, length ${icmpLen}`
            : ic.type === "time-exceeded"
              ? `ICMP time exceeded in-transit, length ${icmpLen}`
              : `ICMP ${ip.dstIp} unreachable, length ${icmpLen}`;
    } else if (f.sflow) {
      const s = sflowLines(f, !!opts.verbose);
      what = s.head;
      extra = s.extra;
    } else if (f.udp) {
      what = `UDP, length ${f.udp.length - 8}`;
    } else if (f.tcp) {
      const t = f.tcp;
      const flags = t.flags.map((x) => TCP_FLAG_CHARS[x] ?? "").join("").replace(/^\.(.+)$/, "$1.");
      const payload = Math.max(0, ipLen - 40);
      what = `Flags [${flags || "none"}], seq ${t.seq}${t.flags.includes("ACK") ? `, ack ${t.ack}` : ""}, win ${t.window}, length ${payload}`;
    } else if (ip.protocol === "OTHER") {
      what = `ip-proto-${ip.protocolNumber ?? 0} ${ipLen - 20}`;
    } else {
      what = `${ip.protocol}, length ${ipLen - 20}`;
    }
    body = `${opts.showEther ? "" : "IP "}${src} > ${dst}: ${what}`;
  } else {
    body = describeControl(f, !!opts.verbose) ?? f.meta.summary;
  }
  // Packets built by the packet engine: -v adds the engine's full decode.
  if (opts.verbose && f.rawL3 && !f.sflow) extra.push(`\t[decoded] ${f.meta.summary}`);
  const out = [(opts.showEther ? etherPrefix(f) : "") + body, ...extra];
  if (opts.hex) out.push(...hexDump(f));
  return out;
}

/** `-X`: hex + ASCII of the packet from the network header (link header skipped). */
function hexDump(f: Frame): string[] {
  const all = frameToBytes(f);
  const bytes = all.slice(f.vlan ? 18 : 14);
  const out: string[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const words: string[] = [];
    for (let i = 0; i < chunk.length; i += 2) {
      words.push(Array.from(chunk.slice(i, i + 2), (b) => b.toString(16).padStart(2, "0")).join(""));
    }
    const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    out.push(`\t0x${off.toString(16).padStart(4, "0")}:  ${words.join(" ").padEnd(39)}  ${ascii}`);
  }
  return out;
}

/** Full capture line as tcpdump prints it for this session. */
export function formatCaptureRecord(
  rec: CaptureRecord,
  device: Device,
  opts: { showEther: boolean; verbose: boolean; hex: boolean; anyIface: boolean },
): string[] {
  const [first, ...rest] = formatPacket(rec.frame, opts);
  let prefix = `${tcpdumpTime(rec.timeMs)} `;
  if (opts.anyIface) {
    const name = device.interfaces.find((i) => i.id === rec.interfaceId)?.name ?? "?";
    const dst = rec.frame.ethernet.dstMac.toUpperCase();
    const dir = rec.dir === "tx" ? "Out" : dst === "FF:FF:FF:FF:FF:FF" ? "B" : parseInt(dst.slice(0, 2), 16) & 1 ? "M" : "In";
    prefix += `${name.padEnd(5)} ${dir.padEnd(3)} `;
  }
  return [prefix + first, ...rest];
}

const UNSUPPORTED = new Set(["-w", "-r", "-z", "-Z", "-F", "-C", "-G", "-W", "-V"]);
const VALUE_FLAGS = new Set(["-i", "-c", "-s", "-Q", "-B", "-y", "-j", "-E", "-T", "-M"]);

export const tcpdumpCommand: CommandHandler = {
  name: "tcpdump",
  summary: "Live packet capture on an interface (Ctrl+C to stop)",
  usage: "tcpdump [-i iface|any] [-nn] [-e] [-v] [-X] [-c count] [expression]",
  help: [
    "TCPDUMP",
    "",
    "Usage:",
    "  sudo tcpdump -i <iface|any> [-nn] [-e] [-v] [-X] [-c count] [expression]",
    "",
    "Runs until Ctrl+C (or -c packets) and prints every frame the simulator",
    "sends/receives on the interface from that moment on.",
    "",
    "Expression (pcap-filter subset):",
    "  icmp | arp | ip | tcp | udp | vlan [id]",
    "  [src|dst] host <ip>   [src|dst] net <cidr>",
    "  [tcp|udp] [src|dst] port <n>   portrange <a-b>",
    "  ether [src|dst] host <mac>   less <n>   greater <n>",
    "  combined with and / or / not and parentheses",
    "",
    "Examples:",
    "  sudo tcpdump -i Ethernet0 -nn",
    "  sudo tcpdump -i any -nn port 6343",
    "  sudo tcpdump -i Ethernet1 -nn -e 'udp and dst host 192.168.100.12'",
  ],
  run(args, ctx: CommandContext): CommandResult {
    let ifName: string | undefined;
    let count: number | undefined;
    let showEther = false;
    let verbose = false;
    let hex = false;
    let listIfaces = false;
    const filterTokens: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (!a.startsWith("-") || a === "-") {
        filterTokens.push(a);
        continue;
      }
      if (UNSUPPORTED.has(a)) return { output: [err(`tcpdump: option ${a} is not available in the simulator (no file system / exec)`)] };
      if (VALUE_FLAGS.has(a)) {
        const v = args[++i];
        if (v === undefined) return { output: [err(`tcpdump: option requires an argument -- '${a.slice(1)}'`)] };
        if (a === "-i") ifName = v;
        if (a === "-c") {
          if (!/^\d+$/.test(v) || Number(v) < 1) return { output: [err(`tcpdump: invalid packet count ${v}`)] };
          count = Number(v);
        }
        continue;
      }
      // Clustered boolean flags: -nn, -nnvX, -e, -l, -q, -t …
      for (const ch of a.slice(1)) {
        if (ch === "e") showEther = true;
        else if (ch === "v") verbose = true;
        else if (ch === "X" || ch === "x") hex = true;
        else if (ch === "D") listIfaces = true;
        else if (!"nlqtSpAKNOU#".includes(ch)) return { output: [err(`tcpdump: invalid option -- '${ch}'`)] };
      }
    }

    const dev = ctx.device;
    if (listIfaces) {
      const ifs = dev.interfaces.map((i, n) => line(`${n + 1}.${i.name} [${i.adminState === "up" ? "Up, Running" : "Down"}]`));
      return { output: [...ifs, line(`${ifs.length + 1}.any (Pseudo-device that captures on all interfaces) [Up, Running]`)] };
    }

    // SONiC switches log in as the unprivileged `admin` user.
    if (isSwitch(dev.type) && !ctx.privileged) {
      return {
        output: [
          err(`tcpdump: ${ifName ?? "eth0"}: You don't have permission to perform this capture on that device`),
          err("(socket: Operation not permitted)"),
          muted(`hint: the switch login is the unprivileged admin user — run: sudo tcpdump ${args.join(" ")}`),
        ],
      };
    }

    let interfaceIds: string[] | null = null;
    let resolved = ifName;
    const anyIface = ifName === "any";
    if (!anyIface) {
      const iface = ifName ? interfaceByName(dev, ifName) : (dev.interfaces.find((i) => i.ipv4.length && i.adminState === "up") ?? dev.interfaces[0]);
      if (!iface) {
        const names = dev.interfaces.map((i) => i.name);
        const joined = ifName && /^[A-Za-z]+$/.test(ifName) && /^\d+$/.test(filterTokens[0] ?? "") ? `${ifName}${filterTokens[0]}` : undefined;
        const hint = joined && names.includes(joined)
          ? `hint: Linux interface names have no space — use -i ${joined}`
          : `hint: interfaces on ${dev.name}: ${names.join(", ")}, any  (tcpdump -D)`;
        return { output: [err(`tcpdump: ${ifName}: No such device exists`), err("(No such device exists)"), muted(hint)] };
      }
      if (iface.adminState !== "up") return { output: [err(`tcpdump: ${iface.name}: That device is not up`)] };
      interfaceIds = [iface.id];
      resolved = iface.name;
    }

    const filter = filterTokens.join(" ");
    try {
      compileFilter(filter);
    } catch (e) {
      if (e instanceof BpfSyntaxError) return { output: [err(`tcpdump: ${e.message}`)] };
      throw e;
    }

    const banner: OutputLine[] = [];
    if (!verbose) banner.push(line("tcpdump: verbose output suppressed, use -v[v]... for full protocol decode"));
    banner.push(
      line(
        anyIface
          ? "listening on any, link-type LINUX_SLL2 (Linux cooked v2), snapshot length 262144 bytes"
          : `listening on ${resolved}, link-type EN10MB (Ethernet), snapshot length 262144 bytes`,
      ),
    );
    return {
      output: banner,
      liveCapture: { deviceId: dev.id, interfaceIds, filter, count, showEther, verbose, hex, anyIface },
    };
  },
};
