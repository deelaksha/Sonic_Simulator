/**
 * PacketEngine — the integration seam between the simulator and an external
 * packet library. The simulator never hand-codes a protocol for traffic
 * generation: it asks the engine to build a layer stack into wire bytes and to
 * dissect bytes back into layers. The engine's own metadata (`describe`) drives
 * the UI field editor, so supporting another protocol needs no simulator code.
 *
 * The implementation here is Scapy running in Pyodide; it is reached through a
 * Transport (a Web Worker in the browser, an in-process Pyodide in tests).
 */

export interface LayerSpec {
  proto: string;
  /** Field values; a value of {proto, fields} builds a nested packet (e.g. DNS qd). */
  fields?: Record<string, FieldValue>;
}

export type FieldValue = string | number | boolean | null | LayerSpec | FieldValue[];

export interface ProtocolInfo {
  proto: string;
  name: string;
  module: string;
}

export interface FieldInfo {
  name: string;
  type: string;
  kind: "int" | "str" | "mac" | "ipv4" | "ipv6" | "flags" | "enum" | "packet" | "list";
  default: string | number | boolean | null;
  choices?: Record<string, string>;
  flags?: string[];
  packetClass?: string;
}

export interface Dissection {
  summary: string;
  layers: { proto: string; name: string; fields: { name: string; value: string }[] }[];
  /** Scapy show2() text. */
  show: string;
}

export interface BuiltPacket extends Dissection {
  bytes: Uint8Array;
}

export interface PacketEngine {
  readonly name: string;
  protocols(): Promise<{ protocols: ProtocolInfo[]; loadErrors: Record<string, string> }>;
  describe(proto: string): Promise<{ proto: string; name: string; fields: FieldInfo[] }>;
  build(stack: LayerSpec[]): Promise<BuiltPacket>;
  dissect(bytes: Uint8Array, first?: string): Promise<Dissection>;
}

/** Calls one Python function (JSON-string args) and returns its JSON string. */
export interface Transport {
  call(fn: "protocols" | "describe" | "build" | "dissect", args: string[]): Promise<string>;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

export class ScapyEngine implements PacketEngine {
  readonly name = "Scapy";
  constructor(private transport: Transport) {}

  async protocols(): ReturnType<PacketEngine["protocols"]> {
    return JSON.parse(await this.transport.call("protocols", []));
  }

  async describe(proto: string): ReturnType<PacketEngine["describe"]> {
    return JSON.parse(await this.transport.call("describe", [proto]));
  }

  async build(stack: LayerSpec[]): Promise<BuiltPacket> {
    const r = JSON.parse(await this.transport.call("build", [JSON.stringify(stack)]));
    return { summary: r.summary, layers: r.layers, show: r.show, bytes: fromHex(r.hex) };
  }

  async dissect(bytes: Uint8Array, first = "Ether"): Promise<Dissection> {
    return JSON.parse(await this.transport.call("dissect", [toHex(bytes), first]));
  }
}
