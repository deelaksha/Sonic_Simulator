/**
 * Interface-argument parsing shared by the L2/interface `show` handlers.
 *
 * KLISH accepts an interface as one or two words ("Ethernet0" / "Ethernet 0",
 * "Vlan 10", "PortChannel 1", "Management 0") and, for the *_RANGE ptypes,
 * an id list ("Ethernet 0-2,4"). parseIf() normalises all of these.
 */
import { Device, interfaceByName } from "../../../models/device";
import { NetInterface } from "../../../models/interface";
import { natCompare } from "../../sonic/counters";
import { expandVlanSpec } from "../util";

export type IfType = "Ethernet" | "PortChannel" | "Vlan" | "Loopback" | "Management";

const TYPES: Record<string, IfType> = {
  ethernet: "Ethernet", eth: "Ethernet",
  portchannel: "PortChannel", po: "PortChannel",
  vlan: "Vlan",
  loopback: "Loopback", lo: "Loopback",
  management: "Management", mgmt: "Management",
};

export interface IfArg {
  type: IfType;
  /** undefined = every interface of the type (the bare keyword form). */
  ids?: number[];
  /** tokens left after the interface (sub-keywords such as vlan-mappings). */
  rest: string[];
}

/** Parse "Ethernet 0" / "Ethernet0" / "Ethernet 0-2,4" / "Vlan" at tokens[0..]. */
export function parseIf(tokens: string[]): IfArg | null {
  const t0 = tokens[0];
  if (!t0) return null;
  const m = /^([A-Za-z]+)([\d,-]*)$/.exec(t0);
  if (!m) return null;
  const type = TYPES[m[1].toLowerCase()];
  if (!type) return null;
  let spec = m[2];
  let used = 1;
  if (!spec && /^\d[\d,-]*$/.test(tokens[1] ?? "")) {
    spec = tokens[1];
    used = 2;
  }
  if (!spec) return { type, rest: tokens.slice(used) };
  const ids = expandVlanSpec(spec);
  if (!ids) return null;
  return { type, ids, rest: tokens.slice(used) };
}

/** The device's management port (eth0), shown by KLISH as Management0. */
export const mgmtPort = (d: Device): NetInterface | undefined => d.interfaces.find((i) => i.management);

/** KLISH display name: the management port is "Management0". */
export const displayName = (i: NetInterface): string => (i.management ? "Management0" : i.name);

/** All interfaces of a type, natural order. */
export function ifacesOfType(d: Device, type: IfType): NetInterface[] {
  if (type === "Management") return d.interfaces.filter((i) => i.management);
  return d.interfaces
    .filter((i) => !i.management && i.name.startsWith(type) && !i.name.includes("."))
    .sort((a, b) => natCompare(a.name, b.name));
}

/** Resolve an IfArg to existing interfaces (missing ids are skipped). */
export function resolveIf(d: Device, a: IfArg): NetInterface[] {
  if (!a.ids) return ifacesOfType(d, a.type);
  const out: NetInterface[] = [];
  for (const id of a.ids) {
    const i = a.type === "Management" ? (id === 0 ? mgmtPort(d) : undefined) : interfaceByName(d, `${a.type}${id}`);
    if (i) out.push(i);
  }
  return out;
}

/** "Ethernet 0" → "Ethernet0" (first id), for single-interface commands. */
export function ifName(a: IfArg | null): string | undefined {
  if (!a || !a.ids?.length) return undefined;
  return `${a.type}${a.ids[0]}`;
}
