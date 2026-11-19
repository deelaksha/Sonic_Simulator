/**
 * UDLD — UniDirectional Link Detection (RFC 5171) on the KLISH config of
 * features/udld.ts ("cp_udld": global `udld enable|aggressive|message-time|
 * multiplier`, per-port `udld enable|aggressive`; klish-xml/udld.xml: UDLD runs
 * on a port once it is enabled globally AND on the interface; defaults message
 * time 1 s, multiplier 3).
 *
 * Wire format (RFC 5171 §3): 802.3 frame to 01:00:0C:CC:CC:CC, LLC AA-AA-03,
 * SNAP OUI 00-00-0C PID 0x0111; header Ver 1 (3 bits) | Opcode (5 bits:
 * 1 Probe, 2 Echo, 3 Flush), Flags (RT 0x01, RSY 0x02), 16-bit checksum (IP
 * style over the UDLD PDU), then TLVs (16-bit type, 16-bit length incl. the
 * 4-byte header): 1 Device-ID, 2 Port-ID, 3 Echo (32-bit count + pairs of
 * 16-bit-length-prefixed device/port ids), 4 Message Interval (8 bit, s),
 * 5 Timeout Interval (8 bit, s), 6 Device Name, 7 Sequence Number (32 bit).
 * CoPP traps the frame to the CPU (lib/protocols/cpu-traps.ts "udld"); a
 * bridge never forwards it (link-local control, lib/control/daemon.ts).
 *
 * Detection (RFC 5171 §4-§5): every message time a Probe carrying the Echo
 * list (the neighbours heard on that port) is sent; a new neighbour is answered
 * with an Echo at once. A port is Bidirectional once the neighbour echoes our
 * own device/port id. It is Unidirectional — and err-disabled (cause udld,
 * lib/protocols/errdisable.ts) — when the neighbour's echo list is non-empty
 * without us, when a neighbour that did echo us stops doing so, or when a
 * neighbour heard for a whole timeout (message time x multiplier) never echoes
 * us. A neighbour not heard for the timeout ages out; in aggressive mode losing
 * a Bidirectional neighbour err-disables the port too (§5.2), in normal mode
 * the port becomes Undetermined.
 *
 * Simulator choices: Device-ID = the system MAC in Cisco dotted form
 * (udld.xml examples "3c2c.992d.8201"); the flags field carries RT on Probes.
 */
import { registerDaemon } from "../control/daemon";
import { transmitL2 } from "../control/packet";
import { logEvent } from "../control/syslog";
import { cpGet, cpList } from "../commands/sonic-cli/config-plane";
import { Device, isSwitch, interfaceByName } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { normalizeMac } from "../models/mac";
import { inetChecksum } from "../sflow/wire";
import { SimContext } from "../engine/context";
import { systemMac } from "./lacp-daemon";
import { errdisablePort, isErrdisabled } from "./errdisable";

export const UDLD_MAC = "01:00:0C:CC:CC:CC";
const SNAP = [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x01, 0x11];
const OP = { PROBE: 1, ECHO: 2, FLUSH: 3 } as const;
const OP_NAME: Record<number, string> = { 1: "Probe", 2: "Echo", 3: "Flush" };
const TLV = { DEVICE_ID: 1, PORT_ID: 2, ECHO: 3, MSG_INTERVAL: 4, TIMEOUT: 5, DEVICE_NAME: 6, SEQ: 7 } as const;
export const DEFAULT_MSG_TIME = 1;
export const DEFAULT_MULTIPLIER = 3;

export type UdldStatus = "Bidirectional" | "Unidirectional" | "Undetermined";

export interface UdldNeighbor {
  deviceId: string;
  portId: string;
  name: string;
  msgTime: number;
  timeout: number;
  firstSeen: number;
  lastSeen: number;
  /** The neighbour has echoed our device/port id at least once. */
  echoedUs: boolean;
}

export interface UdldPort {
  status: UdldStatus;
  neighbors: Record<string, UdldNeighbor>;
  nextTx: number;
  seq: number;
  tx: number;
  rx: number;
  err: number;
}

export interface UdldState {
  ports: Record<string, UdldPort>;
}

export interface UdldPdu {
  op: number;
  flags: number;
  deviceId: string;
  portId: string;
  echo: [string, string][];
  msgTime: number;
  timeout: number;
  name: string;
  seq: number;
}

export function peekUdld(device: Device): UdldState | undefined {
  return peekFeatureState<UdldState>(device, "udld");
}

/** Cisco dotted form of the system MAC, e.g. 3c2c.992d.8201. */
export function udldDeviceId(device: Device): string {
  const h = normalizeMac(systemMac(device)).replace(/:/g, "").toLowerCase();
  return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8, 12)}`;
}

export function udldTimers(device: Device): { msgTime: number; multiplier: number } {
  const g = cpGet(device, "udld") ?? {};
  return { msgTime: (g.msg_time as number | undefined) ?? DEFAULT_MSG_TIME, multiplier: (g.multiplier as number | undefined) ?? DEFAULT_MULTIPLIER };
}

function portCfg(device: Device, name: string): Record<string, unknown> | undefined {
  return cpList(device, "udld", "ports").find((p) => p.ifname === name);
}

export function aggressive(device: Device, name: string): boolean {
  const p = portCfg(device, name);
  return p?.aggressive === true || (p?.aggressive === undefined && cpGet(device, "udld")?.aggressive === true);
}

/** UDLD runs on a port: enabled globally and on the port, port up. */
function runsOn(device: Device, iface: NetInterface): boolean {
  return (
    isSwitch(device.type) &&
    cpGet(device, "udld")?.enable === true &&
    portCfg(device, iface.name)?.admin_enable === true &&
    iface.adminState === "up" &&
    iface.operState === "up"
  );
}

// --- wire ---------------------------------------------------------------------

const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const tlv = (type: number, value: number[]) => [...u16(type), ...u16(4 + value.length), ...value];

export function encodeUdld(p: UdldPdu): number[] {
  const echo = [...u32(p.echo.length), ...p.echo.flatMap(([d, port]) => [...u16(d.length), ...str(d), ...u16(port.length), ...str(port)])];
  const pdu = [
    (1 << 5) | (p.op & 0x1f),
    p.flags & 0xff,
    0,
    0,
    ...tlv(TLV.DEVICE_ID, str(p.deviceId)),
    ...tlv(TLV.PORT_ID, str(p.portId)),
    ...tlv(TLV.ECHO, echo),
    ...tlv(TLV.MSG_INTERVAL, [p.msgTime & 0xff]),
    ...tlv(TLV.TIMEOUT, [p.timeout & 0xff]),
    ...tlv(TLV.DEVICE_NAME, str(p.name)),
    ...tlv(TLV.SEQ, u32(p.seq)),
  ];
  const ck = inetChecksum(pdu);
  pdu[2] = ck >> 8;
  pdu[3] = ck & 0xff;
  return [...SNAP, ...pdu];
}

/** LLC/SNAP payload → PDU (undefined if not UDLD or the checksum is bad). */
export function decodeUdld(payload: number[]): UdldPdu | undefined {
  if (payload.length < SNAP.length + 4 || SNAP.some((b, i) => payload[i] !== b)) return undefined;
  const b = payload.slice(SNAP.length);
  if (b[0] >> 5 !== 1 || inetChecksum(b) !== 0) return undefined;
  const p: UdldPdu = { op: b[0] & 0x1f, flags: b[1], deviceId: "", portId: "", echo: [], msgTime: 0, timeout: 0, name: "", seq: 0 };
  const text = (a: number[]) => String.fromCharCode(...a);
  for (let off = 4; off + 4 <= b.length; ) {
    const type = (b[off] << 8) | b[off + 1];
    const len = (b[off + 2] << 8) | b[off + 3];
    if (len < 4 || off + len > b.length) return undefined;
    const v = b.slice(off + 4, off + len);
    if (type === TLV.DEVICE_ID) p.deviceId = text(v);
    else if (type === TLV.PORT_ID) p.portId = text(v);
    else if (type === TLV.MSG_INTERVAL) p.msgTime = v[0];
    else if (type === TLV.TIMEOUT) p.timeout = v[0];
    else if (type === TLV.DEVICE_NAME) p.name = text(v);
    else if (type === TLV.SEQ) p.seq = ((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0;
    else if (type === TLV.ECHO) {
      const n = ((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0;
      let o = 4;
      for (let i = 0; i < n && o + 2 <= v.length; i++) {
        const dl = (v[o] << 8) | v[o + 1];
        const d = text(v.slice(o + 2, o + 2 + dl));
        o += 2 + dl;
        const pl = (v[o] << 8) | v[o + 1];
        p.echo.push([d, text(v.slice(o + 2, o + 2 + pl))]);
        o += 2 + pl;
      }
    }
    off += len;
  }
  return p;
}

// --- protocol -----------------------------------------------------------------

function portState(device: Device, name: string, now: number): UdldPort {
  const st = featureState<UdldState>(device, "udld", () => ({ ports: {} }));
  return (st.ports[name] ??= { status: "Undetermined", neighbors: {}, nextTx: now, seq: 0, tx: 0, rx: 0, err: 0 });
}

function send(ctx: SimContext, device: Device, iface: NetInterface, ps: UdldPort, op: number): void {
  const { msgTime, multiplier } = udldTimers(device);
  ps.seq += 1;
  ps.tx += 1;
  const payload = encodeUdld({
    op,
    flags: op === OP.PROBE ? 0x01 : 0,
    deviceId: udldDeviceId(device),
    portId: iface.name,
    echo: Object.values(ps.neighbors).map((n) => [n.deviceId, n.portId]),
    msgTime,
    timeout: msgTime * multiplier,
    name: device.config.hostname,
    seq: ps.seq,
  });
  transmitL2(ctx, device, iface, UDLD_MAC, payload.length, payload, `UDLD ${OP_NAME[op]}`);
}

function unidirectional(ctx: SimContext, device: Device, iface: NetInterface, ps: UdldPort, now: number, why: string): void {
  ps.status = "Unidirectional";
  logEvent(device, now, "WARNING", "udld", `UDLD unidirectional link detected on ${iface.name} (${why})`);
  errdisablePort(ctx, device, iface, "udld", now);
}

function receive(ctx: SimContext, device: Device, iface: NetInterface, frame: Frame): void {
  if (!runsOn(device, iface)) return;
  const now = ctx.wallNow();
  const ps = portState(device, iface.name, now);
  const pdu = frame.rawL3 && decodeUdld(frame.rawL3);
  if (!pdu) {
    ps.err += 1;
    return;
  }
  ps.rx += 1;
  if (pdu.op === OP.FLUSH) {
    delete ps.neighbors[`${pdu.deviceId}|${pdu.portId}`];
    return;
  }
  const key = `${pdu.deviceId}|${pdu.portId}`;
  const isNew = !ps.neighbors[key];
  const n = (ps.neighbors[key] ??= {
    deviceId: pdu.deviceId, portId: pdu.portId, name: pdu.name, msgTime: pdu.msgTime, timeout: pdu.timeout, firstSeen: now, lastSeen: now, echoedUs: false,
  });
  Object.assign(n, { name: pdu.name, msgTime: pdu.msgTime, timeout: pdu.timeout, lastSeen: now });
  const me = udldDeviceId(device);
  if (pdu.echo.some(([d, p]) => d === me && p === iface.name)) {
    n.echoedUs = true;
    if (ps.status !== "Bidirectional") logEvent(device, now, "INFO", "udld", `UDLD link on ${iface.name} is bidirectional (neighbor ${pdu.name} ${pdu.portId})`);
    ps.status = "Bidirectional";
  } else if (pdu.echo.length > 0 || n.echoedUs) {
    unidirectional(ctx, device, iface, ps, now, `neighbor ${pdu.name} ${pdu.portId} does not echo us`);
    return;
  }
  if (isNew) send(ctx, device, iface, ps, OP.ECHO); // RFC 5171 §4.2: answer a new neighbour at once
}

function configuredPorts(device: Device): NetInterface[] {
  if (!isSwitch(device.type) || cpGet(device, "udld")?.enable !== true) return [];
  return cpList(device, "udld", "ports")
    .filter((p) => p.admin_enable === true)
    .map((p) => interfaceByName(device, String(p.ifname)))
    .filter((i): i is NetInterface => !!i);
}

function nextDue(device: Device, now: number): number | undefined {
  let due: number | undefined;
  const at = (t: number) => (due = due === undefined ? t : Math.min(due, t));
  const st = peekUdld(device);
  const active = new Set<string>();
  for (const iface of configuredPorts(device)) {
    if (!runsOn(device, iface)) continue;
    active.add(iface.name);
    const ps = st?.ports[iface.name];
    if (!ps) {
      at(now);
      continue;
    }
    at(ps.nextTx);
    for (const n of Object.values(ps.neighbors)) {
      at(n.lastSeen + n.timeout * 1000);
      if (!n.echoedUs) at(n.firstSeen + udldTimeoutMs(device));
    }
  }
  // Ports whose state must be reset (disabled / down, not err-disabled).
  for (const [name, ps] of Object.entries(st?.ports ?? {})) {
    if (!active.has(name) && !(isErrdisabled(device, name) && ps.status === "Unidirectional" && Object.keys(ps.neighbors).length === 0)) at(now);
  }
  return due;
}

const udldTimeoutMs = (device: Device) => {
  const t = udldTimers(device);
  return t.msgTime * t.multiplier * 1000;
};

function tick(ctx: SimContext, device: Device, now: number): boolean {
  let changed = false;
  const st = featureState<UdldState>(device, "udld", () => ({ ports: {} }));
  const active = new Set<string>();
  for (const iface of configuredPorts(device)) {
    if (!runsOn(device, iface)) continue;
    active.add(iface.name);
    const ps = portState(device, iface.name, now);
    for (const [key, n] of Object.entries(ps.neighbors)) {
      if (now >= n.lastSeen + n.timeout * 1000) {
        delete ps.neighbors[key];
        changed = true;
        if (ps.status === "Bidirectional" && aggressive(device, iface.name)) {
          unidirectional(ctx, device, iface, ps, now, `neighbor ${n.name} ${n.portId} aged out (aggressive mode)`);
          return true;
        }
        if (Object.keys(ps.neighbors).length === 0) ps.status = "Undetermined";
      } else if (!n.echoedUs && now >= n.firstSeen + udldTimeoutMs(device)) {
        unidirectional(ctx, device, iface, ps, now, `neighbor ${n.name} ${n.portId} never echoed us`);
        return true;
      }
    }
    if (now >= ps.nextTx) {
      send(ctx, device, iface, ps, OP.PROBE);
      ps.nextTx = now + udldTimers(device).msgTime * 1000;
    }
  }
  for (const [name, ps] of Object.entries(st.ports)) {
    if (active.has(name)) continue;
    if (isErrdisabled(device, name)) {
      if (Object.keys(ps.neighbors).length) {
        ps.neighbors = {};
        changed = true;
      }
      continue;
    }
    delete st.ports[name]; // disabled, link down or recovered: start over
    changed = true;
  }
  return changed;
}

registerDaemon({
  id: "udld",
  nextDue,
  tick,
  // Link-local control path (lib/engine/simulation.ts): already trapped to the CPU.
  receiveL2(ctx, device, iface, frame) {
    if (normalizeMac(frame.ethernet.dstMac) !== UDLD_MAC) return false;
    if (isSwitch(device.type)) receive(ctx, device, iface, frame);
    return true;
  },
  describe(frame, verbose) {
    if (normalizeMac(frame.ethernet.dstMac) !== UDLD_MAC || !frame.rawL3) return undefined;
    const p = decodeUdld(frame.rawL3);
    if (!p) return undefined;
    // tcpdump print-udld.c layout.
    const flags = [p.flags & 1 ? "RT" : "", p.flags & 2 ? "RSY" : ""].filter(Boolean).join(", ") || "none";
    const head = `UDLDv1, Code ${OP_NAME[p.op] ?? "Reserved"} message (${p.op}), Flags [${flags}] (0x${p.flags.toString(16).padStart(2, "0")}), length ${frame.rawL3.length - SNAP.length}`;
    if (!verbose) return head;
    const echo = p.echo.map(([d, port]) => `${d}/${port}`).join(", ") || "none";
    return [head, `\tDevice-ID ${p.deviceId}, Port-ID ${p.portId}, Echo [${echo}]`, `\tMessage Interval ${p.msgTime}s, Timeout Interval ${p.timeout}s, Device Name ${p.name}, Sequence ${p.seq}`].join("\n");
  },
});

