/**
 * SNMP control-plane daemon (registered with lib/control/daemon.ts).
 *
 *   SONiC switches / routers: snmpd on UDP 161 (+ snmp_linktrapd), see ./snmp-agent.ts.
 *   Any device: the net-snmp manager tools (snmpget, snmpwalk …) wait for the
 *     agent's Response on their ephemeral port; `snmptrapd` listens on UDP 162.
 *   tcpdump: the print-snmp.c style decode.
 */
import { registerDaemon } from "../control/daemon";
import { l4Payload, ownsAddress, sendIpv4 } from "../control/packet";
import { Device } from "../models/device";
import { Frame } from "../models/packet";
import { SimContext } from "../engine/context";
import { featureState, peekFeatureState } from "../models/feature-state";
import { PDU, SnmpMessage, SnmpValue, decodeMessage, encodeMessage, pduContentLength } from "./snmp-ber";
import { SNMPTRAP_PORT, SNMP_PORT, agentDue, agentListens, agentReceive, agentTick, isAgentDevice } from "./snmp-agent";
import { ensureAgent, peekAgent } from "./snmp-config";

// ------------------------------------------------------------------ manager side

/** A manager tool waiting for a Response (device.config.features["snmp-mgr"]). */
export interface ManagerState {
  pending?: { port: number; agentIp: string; agentPort: number };
  rx: number[][];
  seq: number;
}

export const managerState = (d: Device): ManagerState => featureState<ManagerState>(d, "snmp-mgr", () => ({ rx: [], seq: 0 }));

/** A notification snmptrapd received. */
export interface ReceivedTrap {
  timeMs: number;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  bytes: number[];
}

/** snmptrapd on a host (device.config.features.snmptrapd). */
export interface TrapdState {
  running: boolean;
  port: number;
  traps: ReceivedTrap[];
}

export const trapdState = (d: Device): TrapdState => featureState<TrapdState>(d, "snmptrapd", () => ({ running: false, port: SNMPTRAP_PORT, traps: [] }));
export const peekTrapd = (d: Device): TrapdState | undefined => peekFeatureState<TrapdState>(d, "snmptrapd");

const MAX_TRAPS = 500;

function receive(ctx: SimContext, device: Device, frame: Frame): boolean {
  const ip = frame.ipv4;
  const udp = frame.udp;
  if (!ip || !udp || !frame.rawL3 || !ownsAddress(device, ip.dstIp)) return false;

  const mgr = peekFeatureState<ManagerState>(device, "snmp-mgr");
  const p = mgr?.pending;
  if (p && udp.dstPort === p.port && udp.srcPort === p.agentPort && ip.srcIp === p.agentIp) {
    const payload = l4Payload(frame);
    if (payload) mgr.rx.push(Array.from(payload));
    return true;
  }

  const trapd = peekTrapd(device);
  if (trapd?.running && udp.dstPort === trapd.port) {
    const payload = l4Payload(frame);
    if (!payload) return true;
    let msg: SnmpMessage | undefined;
    try {
      msg = decodeMessage(payload);
    } catch {
      return true; // snmptrapd logs the parse error and drops it
    }
    if (msg.pdu.type !== PDU.TRAP2 && msg.pdu.type !== PDU.INFORM) return true;
    trapd.traps.push({ timeMs: ctx.wallNow(), srcIp: ip.srcIp, srcPort: udp.srcPort, dstIp: ip.dstIp, dstPort: udp.dstPort, bytes: Array.from(payload) });
    if (trapd.traps.length > MAX_TRAPS) trapd.traps.splice(0, trapd.traps.length - MAX_TRAPS);
    if (msg.pdu.type === PDU.INFORM) {
      // An InformRequest is acknowledged with a Response carrying the same varbinds.
      sendIpv4(ctx, device, {
        src: ip.dstIp,
        dst: ip.srcIp,
        udp: { sport: udp.dstPort, dport: udp.srcPort },
        payload: encodeMessage({ ...msg, pdu: { ...msg.pdu, type: PDU.RESPONSE } }),
        summary: `SNMP Inform ack to ${ip.srcIp}`,
      });
    }
    return true;
  }

  if (isAgentDevice(device)) {
    const rt = peekAgent(device) ?? ensureAgent(device, ctx.wallNow(), true);
    if (agentListens(rt, ip.dstIp, udp.dstPort)) {
      agentReceive(ctx, device, frame);
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ tcpdump

const PDU_NAMES: Record<number, string> = {
  [PDU.GET]: "GetRequest",
  [PDU.GETNEXT]: "GetNextRequest",
  [PDU.RESPONSE]: "GetResponse",
  [PDU.SET]: "SetRequest",
  [PDU.TRAP]: "Trap",
  [PDU.GETBULK]: "GetBulk",
  [PDU.INFORM]: "Inform",
  [PDU.TRAP2]: "V2Trap",
  [PDU.REPORT]: "Report",
};

const ERR_NAMES = [
  "noError", "tooBig", "noSuchName", "badValue", "readOnly", "genErr", "noAccess", "wrongType", "wrongLength",
  "wrongEncoding", "wrongValue", "noCreation", "inconsistentValue", "resourceUnavailable", "commitFailed",
  "undoFailed", "authorizationError", "notWritable", "inconsistentName",
];

function asn1(v: SnmpValue): string {
  switch (v.type) {
    case "integer":
    case "counter32":
    case "gauge32":
    case "timeticks":
      return String(v.value);
    case "counter64":
      return v.value.toString();
    case "string":
      return `"${v.value.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, "0")}`)).join("")}"`;
    case "oid":
      return "." + v.value.join(".");
    case "ipaddress":
      return v.value;
    case "null":
      return "";
    default:
      return `[${v.type}]`;
  }
}

/**
 * tcpdump print-snmp.c: snmp_print() starts with a space; the community is shown
 * only when it is not the default "public" (community_print); the PDU prints as
 * `Name(contents-length)`, then error-status/index (or N=/M= for GetBulk), then
 * each varbind as ` OID` (requests) or ` OID=value`. -v wraps it in
 * `{ SNMPv2c ... { ... R=<request-id> ... } }`.
 */
export function describeSnmp(frame: Frame, verbose: boolean): string | undefined {
  const udp = frame.udp;
  if (!udp || !frame.rawL3) return undefined;
  const ports = [SNMP_PORT, SNMPTRAP_PORT];
  if (!ports.includes(udp.srcPort) && !ports.includes(udp.dstPort)) return undefined;
  const payload = l4Payload(frame);
  if (!payload) return undefined;
  let m: SnmpMessage;
  let pduLen: number;
  try {
    m = decodeMessage(payload);
    pduLen = pduContentLength(payload);
  } catch {
    return undefined;
  }
  const p = m.pdu;
  let s = " ";
  if (verbose) s += `{ ${m.version === 0 ? "SNMPv1" : "SNMPv2c"} `;
  if (m.community !== "public") s += `C="${m.community}" `;
  if (verbose) s += "{ ";
  s += `${PDU_NAMES[p.type] ?? "?"}(${pduLen}) `;
  if (verbose) s += `R=${p.reqId} `;
  const isReq = p.type === PDU.GET || p.type === PDU.GETNEXT || p.type === PDU.GETBULK;
  if (p.type === PDU.GETBULK) s += ` N=${p.errStatus} M=${p.errIndex}`;
  else if (p.errStatus !== 0) s += ` ${ERR_NAMES[p.errStatus] ?? p.errStatus}${p.errIndex ? `@${p.errIndex}` : ""}`;
  for (const vb of p.varbinds) {
    s += " ." + vb.oid.join(".");
    if (!isReq) s += "=" + asn1(vb.value);
  }
  if (verbose) s += " } } ";
  return s;
}

registerDaemon({
  id: "snmp",
  nextDue: (device, now) => agentDue(device, now),
  tick: (ctx, device, now) => (isAgentDevice(device) ? agentTick(ctx, device, now) : false),
  receiveL3: (ctx, device, _ingress, frame) => receive(ctx, device, frame),
  describe: (frame, verbose) => describeSnmp(frame, verbose),
});
