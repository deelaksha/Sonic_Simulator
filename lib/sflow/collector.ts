/**
 * sFlow collector process on a simulated host (the sflowtool role). It binds a
 * UDP port; datagrams that actually arrive over the simulated wire are kept as
 * raw octets and decoded with the same sFlow v5 decoder a real collector uses.
 * Nothing here is synthesized — if no datagram reaches the host, nothing shows.
 */
import { Device } from "../models/device";
import { NetInterface } from "../models/interface";
import { Frame } from "../models/packet";
import { featureState, peekFeatureState } from "../models/feature-state";
import { SimContext } from "../engine/context";
import { decodeDatagram } from "./datagram";
import { DEFAULT_COLLECTOR_PORT } from "./agent";

export interface ReceivedDatagram {
  atMs: number;
  srcIp: string;
  srcPort: number;
  dstPort: number;
  ingress: string;
  bytes: number[];
}

export interface CollectorState {
  listening: boolean;
  port: number;
  datagrams: number;
  flowSamples: number;
  counterSamples: number;
  decodeErrors: number;
  /** Most recent datagrams (raw), newest last. */
  recent: ReceivedDatagram[];
}

const RECENT_CAP = 200;

export function peekCollector(device: Device): CollectorState | undefined {
  return peekFeatureState<CollectorState>(device, "sflow-collector");
}

export function collectorState(device: Device): CollectorState {
  return featureState<CollectorState>(device, "sflow-collector", () => ({
    listening: false,
    port: DEFAULT_COLLECTOR_PORT,
    datagrams: 0,
    flowSamples: 0,
    counterSamples: 0,
    decodeErrors: 0,
    recent: [],
  }));
}

export function startCollector(device: Device, port: number): void {
  const c = collectorState(device);
  c.listening = true;
  c.port = port;
}

export function stopCollector(device: Device): void {
  const c = peekCollector(device);
  if (c) c.listening = false;
}

export function resetCollector(device: Device): void {
  const c = peekCollector(device);
  if (!c) return;
  Object.assign(c, { datagrams: 0, flowSamples: 0, counterSamples: 0, decodeErrors: 0, recent: [] });
}

/** Returns true when a listening collector on this host consumed the datagram. */
export function receiveSflow(ctx: SimContext, device: Device, ingress: NetInterface, frame: Frame): boolean {
  const c = peekCollector(device);
  const udp = frame.udp;
  if (!c?.listening || !udp || !frame.ipv4 || !frame.sflow || udp.dstPort !== c.port) return false;
  if (!device.interfaces.some((i) => i.ipv4.some((a) => a.address === frame.ipv4!.dstIp))) return false;

  c.datagrams += 1;
  try {
    const d = decodeDatagram(frame.sflow.datagram);
    for (const s of d.samples) {
      if (s.kind === "flow") c.flowSamples += 1;
      else c.counterSamples += 1;
    }
  } catch {
    c.decodeErrors += 1;
  }
  c.recent.push({
    atMs: ctx.wallNow(),
    srcIp: frame.ipv4.srcIp,
    srcPort: udp.srcPort,
    dstPort: udp.dstPort,
    ingress: ingress.name,
    bytes: frame.sflow.datagram,
  });
  if (c.recent.length > RECENT_CAP) c.recent.splice(0, c.recent.length - RECENT_CAP);
  ctx.emit({
    type: "SFLOW_DATAGRAM",
    deviceId: device.id,
    deviceName: device.name,
    interfaceId: ingress.id,
    interfaceName: ingress.name,
    message: `${device.name}: collector received sFlow datagram from ${frame.ipv4.srcIp} (${frame.sflow.datagram.length} bytes)`,
    osiLayers: [7],
    frame,
  });
  return true;
}
