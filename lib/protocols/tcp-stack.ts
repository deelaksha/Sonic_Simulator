/**
 * Minimal host TCP stack (RFC 9293) used by every device's receive path via
 * receiveTrafficTcp (lib/protocols/traffic.ts). Segments are real checksummed
 * bytes (sendIpv4 → tcpSegment), so tcpdump / sFlow / the inspector see them.
 *
 *   - Listening sockets: `nc -l` listeners, plus the daemons `ss` already shows
 *     (sshd on TCP/22 on non-PC devices, nginx on TCP/80 on servers / http hosts).
 *   - 3-way handshake, ESTABLISHED, in-order data with seq/ack, FIN close
 *     (FIN-WAIT-1/2, CLOSE-WAIT, LAST-ACK, TIME-WAIT).
 *   - A segment for no socket gets a RST (RFC 9293 §3.10.7.1): ACK set →
 *     <SEQ=SEG.ACK><RST>; otherwise <SEQ=0><ACK=SEG.SEQ+SEG.LEN><RST,ACK>.
 *     An incoming RST is never answered.
 *
 * The engine delivers frames synchronously, so a whole exchange (SYN → SYN-ACK
 * → ACK → banner → …) completes inside the call that sent the first segment.
 * TCP/179 is left to the BGP daemon: only the legacy SYN → RST,ACK applies.
 */
import { Device, findInterface } from "../models/device";
import { primaryIpv4 } from "../models/interface";
import { Frame, TcpHeader } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { longestPrefixMatch } from "../models/route";
import { SimContext } from "../engine/context";
import { IpOutputResult } from "./ipv4";
import { sendIpv4, l4Payload } from "../control/packet";

export type TcpState =
  | "LISTEN"
  | "SYN-SENT"
  | "SYN-RECV"
  | "ESTABLISHED"
  | "FIN-WAIT-1"
  | "FIN-WAIT-2"
  | "CLOSE-WAIT"
  | "LAST-ACK"
  | "TIME-WAIT"
  | "CLOSED";

export interface TcpConn {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  state: TcpState;
  sndNxt: number;
  rcvNxt: number;
  /** Bytes received in order (application data). */
  rx: string;
  /** Peer sent RST. */
  reset?: boolean;
  /** Accepted by this listener port (passive open). */
  listenPort?: number;
}

/** An `nc -l` listener (TCP or UDP). */
export interface NcListener {
  proto: "tcp" | "udp";
  port: number;
  /** -k: keep listening after a session closes. */
  keep: boolean;
}

export interface TcpStackState {
  listeners: Record<string, NcListener>;
  conns: TcpConn[];
  /** Received-data log per "proto/port" (what `nc -l <port>` prints), kept after the listener exits. */
  inbox: Record<string, string[]>;
  nextPort: number;
}

const STATE_ID = "tcp-stack";
const SYN_WINDOW = 64240;
const WINDOW = 502; // 64240 >> 7 (Linux window scaling), as the BGP daemon shows
const MAX_CONNS = 64;
const BGP_PORT = 179;
export const SSH_BANNER = "SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3";

export function tcpStack(device: Device): TcpStackState {
  return featureState<TcpStackState>(device, STATE_ID, () => ({ listeners: {}, conns: [], inbox: {}, nextPort: 45000 }));
}

export function peekTcpStack(device: Device): TcpStackState | undefined {
  return peekFeatureState<TcpStackState>(device, STATE_ID);
}

const lkey = (proto: "tcp" | "udp", port: number) => `${proto}/${port}`;

/**
 * Built-in daemons listening on TCP: sshd on every managed (non-PC) device and
 * nginx on servers / http hosts, matching lib/commands/ss.ts. End-user PCs run
 * no sshd here, so traffic-generator SYNs to a PC's port 22 still get RST.
 */
function serviceOn(device: Device, port: number): "sshd" | "nginx" | undefined {
  if (port === 22 && device.type !== "pc") return "sshd";
  if (port === 80 && (device.type === "server" || device.type === "internet" || device.services.includes("http"))) return "nginx";
  return undefined;
}

/** Who listens on TCP `port` (nc listener or built-in daemon). */
export function tcpListenerOwner(device: Device, port: number): "nc" | "sshd" | "nginx" | undefined {
  if (peekTcpStack(device)?.listeners[lkey("tcp", port)]) return "nc";
  return serviceOn(device, port);
}

const bytes = (s: string) => Array.from(new TextEncoder().encode(s));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** Deterministic initial sequence number from the 4-tuple and the clock. */
function isn(localIp: string, lport: number, remoteIp: string, rport: number, now: number): number {
  let h = 0x811c9dc5;
  for (const c of `${localIp}:${lport}>${remoteIp}:${rport}@${now}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

function flagLetters(flags: string[]): string {
  return flags.filter((f) => f !== "ACK").join(",") + (flags.includes("ACK") ? (flags.length > 1 ? ",ACK" : "ACK") : "");
}

/** Send one segment on a connection and advance SND.NXT. */
function sendSeg(ctx: SimContext, device: Device, c: TcpConn, flags: string[], payload: number[] = []): IpOutputResult {
  const hdr: TcpHeader = {
    srcPort: c.localPort,
    dstPort: c.remotePort,
    seq: c.sndNxt >>> 0,
    ack: flags.includes("ACK") ? c.rcvNxt >>> 0 : 0,
    flags,
    window: flags.includes("SYN") ? SYN_WINDOW : WINDOW,
  };
  c.sndNxt = (c.sndNxt + payload.length + (flags.includes("SYN") ? 1 : 0) + (flags.includes("FIN") ? 1 : 0)) >>> 0;
  return sendIpv4(ctx, device, {
    src: c.localIp,
    dst: c.remoteIp,
    tcp: hdr,
    payload,
    summary: `TCP ${c.localPort} → ${c.remotePort} [${flagLetters(flags)}]${payload.length ? ` len ${payload.length}` : ""}`,
  });
}

/** RST for a segment that matches no socket (RFC 9293 §3.10.7.1). */
function sendReset(ctx: SimContext, device: Device, frame: Frame, segLen: number): void {
  const ip = frame.ipv4!;
  const t = frame.tcp!;
  const hasAck = t.flags.includes("ACK");
  const tcp: TcpHeader = hasAck
    ? { srcPort: t.dstPort, dstPort: t.srcPort, seq: t.ack >>> 0, ack: 0, flags: ["RST"], window: 0 }
    : {
        srcPort: t.dstPort,
        dstPort: t.srcPort,
        seq: 0,
        ack: (t.seq + segLen + (t.flags.includes("SYN") ? 1 : 0) + (t.flags.includes("FIN") ? 1 : 0)) >>> 0,
        flags: ["RST", "ACK"],
        window: 0,
      };
  sendIpv4(ctx, device, { src: ip.dstIp, dst: ip.srcIp, tcp, payload: [], summary: `TCP ${tcp.srcPort} → ${tcp.dstPort} [${flagLetters(tcp.flags)}]` });
}

function addConn(st: TcpStackState, c: TcpConn): void {
  st.conns.push(c);
  // Drop the oldest finished sockets beyond the table cap.
  while (st.conns.length > MAX_CONNS) {
    const i = st.conns.findIndex((x) => x.state === "TIME-WAIT" || x.state === "CLOSED");
    st.conns.splice(i >= 0 ? i : 0, 1);
  }
}

function log(st: TcpStackState, key: string, lineText: string): void {
  (st.inbox[key] ??= []).push(lineText);
}

/** Connection closed: an `nc -l` without -k exits after its session. */
function closed(st: TcpStackState, c: TcpConn): void {
  c.state = "CLOSED";
  if (c.listenPort !== undefined) {
    const k = lkey("tcp", c.listenPort);
    const l = st.listeners[k];
    if (l && !l.keep) delete st.listeners[k];
  }
  st.conns = st.conns.filter((x) => x !== c);
}

/** Application-level reaction to newly received data on a passive socket. */
function deliver(ctx: SimContext, device: Device, st: TcpStackState, c: TcpConn, data: string): void {
  c.rx += data;
  if (c.listenPort === undefined) return;
  const owner = tcpListenerOwner(device, c.listenPort);
  if (owner === "nc") {
    const k = lkey("tcp", c.listenPort);
    for (const l of data.replace(/\r?\n$/, "").split(/\r?\n/)) log(st, k, l);
  } else if (owner === "nginx") {
    const body = "<html><body><h1>Welcome to nginx!</h1></body></html>\n";
    sendSeg(ctx, device, c, ["PSH", "ACK"], bytes(`HTTP/1.1 200 OK\r\nServer: nginx\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
    c.state = "FIN-WAIT-1";
    sendSeg(ctx, device, c, ["FIN", "ACK"]);
  }
}

/**
 * TCP input for a segment addressed to this device. Returns true when the
 * stack consumed it (always, except TCP/179 non-SYN segments the BGP daemon owns).
 */
export function tcpInput(ctx: SimContext, device: Device, frame: Frame): boolean {
  const ip = frame.ipv4!;
  const t = frame.tcp!;
  const has = (f: string) => t.flags.includes(f);

  // BGP's own TCP lives in the BGP daemon; keep the legacy closed-port answer only.
  if (t.dstPort === BGP_PORT || t.srcPort === BGP_PORT) {
    if (has("SYN") && !has("ACK")) sendReset(ctx, device, frame, 0);
    return true;
  }

  const payload = l4Payload(frame) ?? new Uint8Array();
  const st = tcpStack(device);
  const c = st.conns.find((x) => x.localIp === ip.dstIp && x.localPort === t.dstPort && x.remoteIp === ip.srcIp && x.remotePort === t.srcPort);

  if (!c) {
    if (has("RST")) return true;
    if (has("SYN") && !has("ACK") && tcpListenerOwner(device, t.dstPort)) {
      const nc: TcpConn = {
        localIp: ip.dstIp,
        localPort: t.dstPort,
        remoteIp: ip.srcIp,
        remotePort: t.srcPort,
        state: "SYN-RECV",
        sndNxt: isn(ip.dstIp, t.dstPort, ip.srcIp, t.srcPort, ctx.now()),
        rcvNxt: (t.seq + 1) >>> 0,
        rx: "",
        listenPort: t.dstPort,
      };
      addConn(st, nc);
      sendSeg(ctx, device, nc, ["SYN", "ACK"]);
      return true;
    }
    sendReset(ctx, device, frame, payload.length);
    return true;
  }

  if (has("RST")) {
    c.reset = true;
    closed(st, c);
    return true;
  }

  if (c.state === "SYN-SENT") {
    if (has("SYN") && has("ACK") && t.ack === c.sndNxt) {
      c.rcvNxt = (t.seq + 1) >>> 0;
      c.state = "ESTABLISHED";
      sendSeg(ctx, device, c, ["ACK"]);
    } else if (has("ACK")) {
      sendReset(ctx, device, frame, payload.length);
    }
    return true;
  }

  if (c.state === "SYN-RECV") {
    if (!has("ACK") || t.ack !== c.sndNxt) return true;
    c.state = "ESTABLISHED";
    const owner = tcpListenerOwner(device, c.localPort);
    if (owner === "nc") log(st, lkey("tcp", c.localPort), `Connection received on ${c.remoteIp} ${c.remotePort}`);
    if (owner === "sshd") sendSeg(ctx, device, c, ["PSH", "ACK"], bytes(SSH_BANNER + "\r\n"));
  }

  // ACK processing for our FIN.
  if (has("ACK") && t.ack === c.sndNxt) {
    if (c.state === "FIN-WAIT-1") c.state = "FIN-WAIT-2";
    else if (c.state === "LAST-ACK") {
      closed(st, c);
      return true;
    }
  }

  // In-order data.
  if (payload.length > 0 && t.seq === c.rcvNxt && (c.state === "ESTABLISHED" || c.state === "FIN-WAIT-1" || c.state === "FIN-WAIT-2")) {
    c.rcvNxt = (c.rcvNxt + payload.length) >>> 0;
    if (!has("FIN")) sendSeg(ctx, device, c, ["ACK"]);
    deliver(ctx, device, st, c, text(payload));
  }

  if (has("FIN") && ((t.seq + payload.length) >>> 0) === c.rcvNxt) {
    c.rcvNxt = (c.rcvNxt + 1) >>> 0;
    if (c.state === "ESTABLISHED") {
      // The application (nc / daemon) closes on EOF: ACK and FIN together.
      // State first: the peer's ACK arrives synchronously inside sendSeg.
      c.state = "LAST-ACK";
      sendSeg(ctx, device, c, ["FIN", "ACK"]);
    } else if (c.state === "FIN-WAIT-1" || c.state === "FIN-WAIT-2") {
      c.state = "TIME-WAIT";
      sendSeg(ctx, device, c, ["ACK"]);
      if (c.listenPort !== undefined) closed(st, c);
    }
  }
  return true;
}

// --- Active-open API (nc client, port scan) ---

export type ConnectResult =
  | { ok: true; conn: TcpConn }
  | { ok: false; reason: "refused" | "timeout" | "no-route" | "arp-failed" | "no-src-ip" | "iface-down" };

/** Source address the kernel would pick for `dstIp` (egress interface's primary IPv4). */
export function sourceFor(device: Device, dstIp: string): { ip?: string; reason?: "no-route" | "iface-down" | "no-src-ip" } {
  const m = longestPrefixMatch(device.routingTable, dstIp);
  if (!m) return { reason: "no-route" };
  const egress = findInterface(device, m.route.interfaceId);
  if (!egress || egress.adminState !== "up") return { reason: "iface-down" };
  const a = primaryIpv4(egress)?.address;
  return a ? { ip: a } : { reason: "no-src-ip" };
}

export function allocPort(device: Device): number {
  const st = tcpStack(device);
  const p = st.nextPort;
  st.nextPort = p >= 60999 ? 32768 : p + 1;
  return p;
}

/** connect(): SYN → (SYN-ACK → ACK) | RST | nothing. */
export function tcpConnect(ctx: SimContext, device: Device, dstIp: string, dstPort: number): ConnectResult {
  const src = sourceFor(device, dstIp);
  if (!src.ip) return { ok: false, reason: src.reason! };
  const st = tcpStack(device);
  const lport = allocPort(device);
  const c: TcpConn = {
    localIp: src.ip,
    localPort: lport,
    remoteIp: dstIp,
    remotePort: dstPort,
    state: "SYN-SENT",
    sndNxt: isn(src.ip, lport, dstIp, dstPort, ctx.now()),
    rcvNxt: 0,
    rx: "",
  };
  addConn(st, c);
  const r = sendSeg(ctx, device, c, ["SYN"]);
  if (!r.ok) {
    st.conns = st.conns.filter((x) => x !== c);
    return { ok: false, reason: r.reason === "arp-failed" ? "arp-failed" : "no-route" };
  }
  if (c.state === "ESTABLISHED" || c.state === "CLOSE-WAIT" || c.state === "LAST-ACK") return { ok: true, conn: c };
  st.conns = st.conns.filter((x) => x !== c);
  return { ok: false, reason: c.reset ? "refused" : "timeout" };
}

/** write(): one PSH,ACK data segment. */
export function tcpSend(ctx: SimContext, device: Device, c: TcpConn, data: string): void {
  if (c.state !== "ESTABLISHED" && c.state !== "CLOSE-WAIT") return;
  sendSeg(ctx, device, c, ["PSH", "ACK"], bytes(data));
}

/** close(): FIN,ACK (active close) — the peer's FIN completes it to TIME-WAIT. */
export function tcpClose(ctx: SimContext, device: Device, c: TcpConn): void {
  if (c.state === "ESTABLISHED") {
    c.state = "FIN-WAIT-1";
    sendSeg(ctx, device, c, ["FIN", "ACK"]);
  } else if (c.state === "CLOSE-WAIT") {
    c.state = "LAST-ACK";
    sendSeg(ctx, device, c, ["FIN", "ACK"]);
  }
}

/** `nc -u -l` listener: log a datagram's payload. Returns true when a listener took it. */
export function udpListenerInput(device: Device, frame: Frame): boolean {
  const st = peekTcpStack(device);
  const port = frame.udp?.dstPort;
  if (!st || port === undefined || !st.listeners[lkey("udp", port)]) return false;
  const data = text(l4Payload(frame) ?? new Uint8Array());
  for (const l of data.replace(/\r?\n$/, "").split(/\r?\n/)) log(st, lkey("udp", port), l);
  return true;
}

export interface SocketRow {
  netid: "tcp" | "udp";
  state: string;
  local: string;
  peer: string;
  process: string;
}

/** Sockets owned by this stack (nc listeners + connections), for `ss -tan` / `netstat -tan`. */
export function tcpSockets(device: Device): SocketRow[] {
  const st = peekTcpStack(device);
  if (!st) return [];
  const rows: SocketRow[] = Object.values(st.listeners).map((l) => ({
    netid: l.proto,
    state: l.proto === "tcp" ? "LISTEN" : "UNCONN",
    local: `0.0.0.0:${l.port}`,
    peer: "0.0.0.0:*",
    process: "nc",
  }));
  for (const c of st.conns) {
    rows.push({ netid: "tcp", state: c.state === "ESTABLISHED" ? "ESTAB" : c.state, local: `${c.localIp}:${c.localPort}`, peer: `${c.remoteIp}:${c.remotePort}`, process: "nc" });
  }
  return rows;
}
